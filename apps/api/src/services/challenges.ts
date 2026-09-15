/**
 * Writing challenges: the brief, the places writers take in it, and the board
 * that ranks what they submitted.
 *
 * Three things are decided here and nowhere else:
 *
 * - **A challenge's state is derived, never stored.** "Upcoming", "active" and
 *   "past" are the three positions `now()` can hold against `startAt` and
 *   `endAt`. A status column would be a second answer to the same question,
 *   and the two would disagree the first time a job failed to run.
 * - **Entering and submitting are separate.** `enterChallenge` takes a place;
 *   `updateEntry` attaches the story. That is why `ChallengeEntry.storyId` is
 *   nullable, and why the page's two stats mean different things --
 *   participants are entries, submissions are entries with a story on them.
 * - **The leaderboard ranks in SQL, by one documented rule.** `RANKING` below
 *   is the only place that rule exists.
 *
 * Every function takes the caller's id explicitly -- the routes resolve it
 * once through `middleware/current-user.ts` -- so nothing here reaches for
 * ambient request state. Privilege is asked of `services/roles.ts`, which owns
 * the admin flag.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { uniqueSlug } from "../lib/slug.js";
import { assertAdmin } from "./roles.js";
import { getStoriesByIds, toIso, type Page, type Story } from "./stories.js";

/* Shapes returned to the client ----------------------------------------- */

/**
 * The four-field summary every list endpoint on Scribe returns for a person --
 * the same one clubs, channels, comments and profiles agreed on. Never the
 * whole user row.
 */
export interface ChallengeUser {
  id: string;
  username: string;
  /** Absent for password signups, where the UI falls back to the username. */
  displayName: string | null;
  avatarUrl: string | null;
}

export const CHALLENGE_STATES = ["upcoming", "active", "past"] as const;

export type ChallengeState = (typeof CHALLENGE_STATES)[number];

export interface Challenge {
  id: string;
  slug: string;
  title: string;
  /** The brief, rendered as the challenge's pull quote. */
  prompt: string;
  description: string | null;
  wordTarget: number | null;
  /** Derived from the window against `now()`; there is no status column. */
  state: ChallengeState;
  startsAt: string;
  endsAt: string;
  /** Writers who have taken a place, whether or not they have submitted. */
  participantCount: number;
  /**
   * Places with a story attached. Deliberately *not* filtered by whether that
   * story is published, which is what the leaderboard counts: this is what
   * writers did, the board is what readers can see.
   */
  entryCount: number;
  createdAt: string;
  updatedAt: string;
  /** Null only if the hosting account has since been deleted. */
  host: ChallengeUser | null;
}

/** The caller's own place in a challenge. Nobody else's is ever returned. */
export interface ChallengeEntry {
  id: string;
  challengeId: string;
  /** Null until a story is attached. */
  story: Story | null;
  /** The entrant's own note to the host. */
  note: string | null;
  submittedAt: string;
  updatedAt: string;
}

export interface ChallengeDetail extends Challenge {
  /** Null when anonymous, or when the caller has not entered. */
  entry: ChallengeEntry | null;
}

/** One ranked row of a challenge's board. */
export interface LeaderboardRow {
  rank: number;
  entryId: string;
  submittedAt: string;
  /** What `RANKING` scored: the stars the story has been given, summed. */
  score: number;
  ratingCount: number;
  ratingAverage: number | null;
  user: ChallengeUser;
  story: Story;
}

/** Challenges split by the only thing that separates them: the clock. */
export interface ChallengeBoard {
  active: Challenge[];
  upcoming: Challenge[];
  past: Challenge[];
}

export interface ChallengeInput {
  title: string;
  prompt: string;
  description?: string | null | undefined;
  wordTarget?: number | null | undefined;
  startsAt: string;
  endsAt: string;
}

export interface EntryInput {
  storyId?: string | null | undefined;
  note?: string | null | undefined;
}

export const MAX_PAGE_SIZE = 48;

/**
 * Challenges shown per group by `GET /api/challenges`.
 *
 * The endpoint answers all three groups at once rather than paginating one,
 * because the page's tabs show a count for each and three totals cannot be
 * read off one page. Safe because the set is small and curated -- only an
 * admin can create a challenge -- and bounded here rather than trusted to
 * stay that way.
 */
const GROUP_LIMIT = 24;

const CHALLENGE_NOT_FOUND = "That challenge could not be found.";

const ENTRY_NOT_FOUND = "That entry could not be found.";

/* Helpers ---------------------------------------------------------------- */

/** `now()` in the spelling the timestamp codec writes. */
function now(): Temporal.Instant {
  return Temporal.Now.instant();
}

/** These columns are never null; the epoch fallback keeps one bad row local. */
function isoOf(value: unknown): string {
  return toIso(value) ?? new Date(0).toISOString();
}

function toDate(value: unknown): Date {
  return new Date(isoOf(value));
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toPage<T>(items: T[], page: number, limit: number, total: number): Page<T> {
  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasMore: page * limit < total,
  };
}

function toUser(row: {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}): ChallengeUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
  };
}

/** The user summaries for a set of ids, in one query rather than one per row. */
async function usersByIds(ids: string[]): Promise<Map<string, ChallengeUser>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const rows = await db.orm.auth.User.select(
    "id",
    "username",
    "displayName",
    "avatarUrl",
  )
    .where((user) => user.id.in(unique))
    .all();

  return new Map(rows.map((row) => [row.id, toUser(row)]));
}

interface ChallengeRow {
  id: string;
  slug: string;
  title: string;
  prompt: string;
  description: string | null;
  wordTarget: number | null;
  hostId: string;
  startAt: unknown;
  endAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

function challengesBase() {
  return db.orm.challenges.WritingChallenge.select(
    "id",
    "slug",
    "title",
    "prompt",
    "description",
    "wordTarget",
    "hostId",
    "startAt",
    "endAt",
    "createdAt",
    "updatedAt",
  );
}

/**
 * Where a challenge sits relative to the clock.
 *
 * The window is inclusive at both ends: a challenge is active on the day it
 * opens and on the day it closes. `enterChallenge` asks the same question of
 * the same function, so "the page says active" and "the API let me in" cannot
 * come apart.
 */
function stateOf(row: { startAt: unknown; endAt: unknown }, at: Date): ChallengeState {
  if (at < toDate(row.startAt)) return "upcoming";
  if (at > toDate(row.endAt)) return "past";
  return "active";
}

/* Reads ------------------------------------------------------------------ */

/**
 * Participant and submission counts for a batch of challenges.
 *
 * Two grouped aggregates rather than a count per challenge, and grouped in SQL
 * rather than by hydrating entries and counting them in JS -- a popular
 * challenge's entries are exactly the set that would be most expensive to
 * load, and these two numbers are all the card needs.
 */
async function entryCounts(
  challengeIds: string[],
): Promise<Map<string, { participants: number; submissions: number }>> {
  const counts = new Map<string, { participants: number; submissions: number }>();
  if (challengeIds.length === 0) return counts;

  const [places, submitted] = await Promise.all([
    db.orm.challenges.ChallengeEntry.where((entry) =>
      entry.challengeId.in(challengeIds),
    )
      .groupBy("challengeId")
      .aggregate((aggregate) => ({ total: aggregate.count() })),
    db.orm.challenges.ChallengeEntry.where((entry) =>
      entry.challengeId.in(challengeIds),
    )
      .where((entry) => entry.storyId.isNotNull())
      .groupBy("challengeId")
      .aggregate((aggregate) => ({ total: aggregate.count() })),
  ]);

  for (const group of places) {
    counts.set(group.challengeId, { participants: group.total, submissions: 0 });
  }
  for (const group of submitted) {
    const held = counts.get(group.challengeId);
    if (held) held.submissions = group.total;
  }

  return counts;
}

/** Turns rows into the client shape, gathering hosts and counts once for all. */
async function hydrate(rows: ChallengeRow[], at: Date): Promise<Challenge[]> {
  if (rows.length === 0) return [];

  const [hosts, counts] = await Promise.all([
    usersByIds(rows.map((row) => row.hostId)),
    entryCounts(rows.map((row) => row.id)),
  ]);

  return rows.map((row) => {
    const totals = counts.get(row.id);

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      prompt: row.prompt,
      description: row.description,
      wordTarget: row.wordTarget,
      state: stateOf(row, at),
      startsAt: isoOf(row.startAt),
      endsAt: isoOf(row.endAt),
      participantCount: totals?.participants ?? 0,
      entryCount: totals?.submissions ?? 0,
      createdAt: isoOf(row.createdAt),
      updatedAt: isoOf(row.updatedAt),
      host: hosts.get(row.hostId) ?? null,
    };
  });
}

/**
 * Every challenge, split by state.
 *
 * Each group is ordered by what a reader of that group wants first: the
 * active ones by what closes soonest, the upcoming by what opens soonest, and
 * the past by what ended most recently. `id` breaks every tie so two
 * challenges sharing a date cannot swap places between requests.
 */
export async function listChallenges(): Promise<ChallengeBoard> {
  const at = new Date();
  const instant = Temporal.Instant.from(at.toISOString());

  const [active, upcoming, past] = await Promise.all([
    challengesBase()
      .where((challenge) => challenge.startAt.lte(instant))
      .where((challenge) => challenge.endAt.gte(instant))
      .orderBy([
        (challenge) => challenge.endAt.asc(),
        (challenge) => challenge.id.asc(),
      ])
      .limit(GROUP_LIMIT)
      .all(),
    challengesBase()
      .where((challenge) => challenge.startAt.gt(instant))
      .orderBy([
        (challenge) => challenge.startAt.asc(),
        (challenge) => challenge.id.asc(),
      ])
      .limit(GROUP_LIMIT)
      .all(),
    challengesBase()
      .where((challenge) => challenge.endAt.lt(instant))
      .orderBy([
        (challenge) => challenge.endAt.desc(),
        (challenge) => challenge.id.desc(),
      ])
      .limit(GROUP_LIMIT)
      .all(),
  ]);

  // One hydrate pass over all three groups, so the host and count queries are
  // issued once rather than three times.
  const hydrated = await hydrate(
    [...active, ...upcoming, ...past] as ChallengeRow[],
    at,
  );

  return {
    active: hydrated.slice(0, active.length),
    upcoming: hydrated.slice(active.length, active.length + upcoming.length),
    past: hydrated.slice(active.length + upcoming.length),
  };
}

/**
 * One challenge by slug or by id.
 *
 * Both work for the reason `services/clubs.ts` gives: the app addresses
 * challenges by slug, while everything the API itself returns carries ids. The
 * id branch is only attempted for something shaped like a UUID -- comparing an
 * arbitrary string against a `uuid` column is a Postgres error, not a miss.
 */
async function findChallengeRow(slugOrId: string): Promise<ChallengeRow | null> {
  const bySlug = await challengesBase()
    .where((challenge) => challenge.slug.eq(slugOrId))
    .first();
  if (bySlug) return bySlug as ChallengeRow;

  if (!UUID.test(slugOrId)) return null;

  const byId = await challengesBase()
    .where((challenge) => challenge.id.eq(slugOrId))
    .first();

  return (byId as ChallengeRow | undefined) ?? null;
}

async function requireChallengeRow(slugOrId: string): Promise<ChallengeRow> {
  const row = await findChallengeRow(slugOrId);
  if (!row) throw HttpError.notFound(CHALLENGE_NOT_FOUND);

  return row;
}

interface EntryRow {
  id: string;
  challengeId: string;
  userId: string;
  storyId: string | null;
  note: string | null;
  submittedAt: unknown;
  updatedAt: unknown;
}

function entriesBase() {
  return db.orm.challenges.ChallengeEntry.select(
    "id",
    "challengeId",
    "userId",
    "storyId",
    "note",
    "submittedAt",
    "updatedAt",
  );
}

/**
 * The caller's own entry, with its story resolved *as them* -- so a writer who
 * attached a draft sees the title they attached, and the page can tell them it
 * is not on the board yet.
 */
async function toEntry(row: EntryRow): Promise<ChallengeEntry> {
  const stories =
    row.storyId === null
      ? new Map<string, Story>()
      : await getStoriesByIds([row.storyId], row.userId);

  return {
    id: row.id,
    challengeId: row.challengeId,
    story: row.storyId === null ? null : (stories.get(row.storyId) ?? null),
    note: row.note,
    submittedAt: isoOf(row.submittedAt),
    updatedAt: isoOf(row.updatedAt),
  };
}

async function findEntry(
  challengeId: string,
  userId: string,
): Promise<EntryRow | null> {
  const row = await entriesBase()
    .where((entry) => entry.challengeId.eq(challengeId))
    .where((entry) => entry.userId.eq(userId))
    .first();

  return (row as EntryRow | undefined) ?? null;
}

/** One challenge, plus the caller's own place in it when they have one. */
export async function getChallenge(
  slugOrId: string,
  viewerId: string | null,
): Promise<ChallengeDetail> {
  const row = await requireChallengeRow(slugOrId);

  const [challenge] = await hydrate([row], new Date());
  if (!challenge) throw HttpError.notFound(CHALLENGE_NOT_FOUND);

  const mine = viewerId === null ? null : await findEntry(row.id, viewerId);

  return { ...challenge, entry: mine === null ? null : await toEntry(mine) };
}

/* The leaderboard -------------------------------------------------------- */

/**
 * How a challenge is ranked. The single place the rule exists.
 *
 * **score = the sum of the star ratings the entry's story has been given.**
 *
 * `engagement.Rating` is the only real signal a reader leaves on a story, so
 * it is what the board is built from. Summing rather than averaging is
 * deliberate: a mean lets a story with one five-star rating beat one with
 * fifty fours, and a challenge is won by reaching readers as well as by
 * pleasing the few who arrived. The sum is monotone in both halves -- more
 * ratings and better ratings each raise it -- and needs no invented prior to
 * make it behave, which a Bayesian average would.
 *
 * What it is *not*: a vote. The mock carried a `voteCount` with nothing behind
 * it; there is no ballot in the contract and inventing one to fill a column
 * was the wrong place to start. If challenges ever want real voting, that is a
 * table and a migration, and this function is where the rule changes.
 *
 * Ties break by rating count, then by who submitted first, then by entry id,
 * so the order is total: two entries can never swap places between requests,
 * which is what makes paging through a board safe.
 *
 * Only entries whose story is *listed* are ranked, and the board is built
 * anonymously -- `getStoriesByIds(…, null)` -- so every viewer sees the same
 * ranks. Resolving stories as the caller would put an author's own draft on
 * the board for them alone and shift everybody below it by one.
 */
interface RankedRow {
  entryId: string;
  userId: string;
  storyId: string;
  submittedAt: unknown;
  score: unknown;
  votes: number;
  rank: number;
  total: number;
}

async function rankEntries(
  challengeId: string,
  limit: number,
  offset: number,
): Promise<RankedRow[]> {
  const plan = db.raw.sql`
    WITH scored AS (
      SELECT e."id"          AS "entryId",
             e."userId"      AS "userId",
             e."storyId"     AS "storyId",
             e."submittedAt" AS "submittedAt",
             r."score"       AS "score",
             r."votes"       AS "votes"
        FROM challenges."challengeEntry" AS e
        JOIN content."story" AS s
          ON s."id" = e."storyId"
         AND s."listedAt" IS NOT NULL
        CROSS JOIN LATERAL (
              SELECT COALESCE(SUM(rt."rating"), 0) AS "score",
                     COUNT(*)::int                 AS "votes"
                FROM engagement."rating" AS rt
               WHERE rt."storyId" = e."storyId"
             ) AS r
       WHERE e."challengeId" = ${challengeId}
    )
    SELECT "entryId", "userId", "storyId", "submittedAt", "score", "votes",
           (ROW_NUMBER() OVER (
              ORDER BY "score" DESC, "votes" DESC, "submittedAt" ASC, "entryId" ASC
            ))::int AS "rank",
           (COUNT(*) OVER ())::int AS "total"
      FROM scored
     ORDER BY "rank"
     LIMIT ${limit} OFFSET ${offset}
  `.returnsRow({
    entryId: "pg/text@1",
    userId: "pg/text@1",
    storyId: "pg/text@1",
    submittedAt: "pg/timestamptz-temporal@1",
    score: "pg/numeric@1",
    votes: "pg/int4@1",
    rank: "pg/int4@1",
    total: "pg/int4@1",
  }).build();

  return (await db.runtime().query(plan)) as RankedRow[];
}

/**
 * How many entries the board holds.
 *
 * Only needed when a page came back empty: every ranked row carries
 * `COUNT(*) OVER ()`, so the ordinary path already knows the total and this
 * costs nothing. Without it a page past the end would report a total of zero
 * and tell the caller the board is empty when it is not.
 */
async function countRankable(challengeId: string): Promise<number> {
  const plan = db.raw.sql`
    SELECT COUNT(*)::int AS "total"
      FROM challenges."challengeEntry" AS e
      JOIN content."story" AS s
        ON s."id" = e."storyId"
       AND s."listedAt" IS NOT NULL
     WHERE e."challengeId" = ${challengeId}
  `.returnsRow({ total: "pg/int4@1" }).build();

  const [row] = (await db.runtime().query(plan)) as { total: number }[];
  return row?.total ?? 0;
}

/** `numeric` decodes to a decimal string, because a float would lie about it. */
function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function listLeaderboard(
  slugOrId: string,
  query: { page: number; limit: number },
): Promise<Page<LeaderboardRow>> {
  const challenge = await requireChallengeRow(slugOrId);

  const rows = await rankEntries(
    challenge.id,
    query.limit,
    (query.page - 1) * query.limit,
  );

  // `COUNT(*) OVER ()` rides along on every row, so the ordinary path already
  // knows the total; only an empty page has to ask for it.
  if (rows.length === 0) {
    return toPage<LeaderboardRow>(
      [],
      query.page,
      query.limit,
      await countRankable(challenge.id),
    );
  }

  const total = rows[0]?.total ?? 0;

  const [users, stories] = await Promise.all([
    usersByIds(rows.map((row) => row.userId)),
    getStoriesByIds(
      rows.map((row) => row.storyId),
      null,
    ),
  ]);

  const items = rows
    .map((row) => {
      // A vanished account or story drops out rather than failing the whole
      // page, the way `services/users.ts` drops a follower whose account is
      // gone. The ranks either side keep their numbers, which is honest: the
      // row was ranked, it just cannot be rendered.
      const user = users.get(row.userId);
      const story = stories.get(row.storyId);
      if (!user || !story) return null;

      const ratingCount = row.votes;

      return {
        rank: row.rank,
        entryId: row.entryId,
        submittedAt: isoOf(row.submittedAt),
        score: toNumber(row.score),
        ratingCount,
        ratingAverage:
          ratingCount === 0 ? null : toNumber(row.score) / ratingCount,
        user,
        story,
      };
    })
    .filter((row): row is LeaderboardRow => row !== null);

  return toPage(items, query.page, query.limit, total);
}

/* Entering --------------------------------------------------------------- */

/**
 * The window guard both writes share.
 *
 * Submissions close with the challenge, and so does everything that changes
 * one: swapping a story, editing a note, withdrawing. A board that can still
 * change after it closed is not a result, and "you had until the deadline" is
 * the rule the page already states.
 *
 * 409 rather than 400: nothing about the request is malformed, the challenge
 * is simply not in a state that accepts it.
 */
function assertOpen(row: ChallengeRow, at: Date): void {
  const state = stateOf(row, at);

  if (state === "upcoming") {
    throw HttpError.conflict("That challenge has not opened yet.");
  }
  if (state === "past") {
    throw HttpError.conflict("That challenge has closed.");
  }
}

const ALREADY_ENTERED = "You have already entered that challenge.";

/**
 * Takes a place in a challenge.
 *
 * Not idempotent, unlike joining a club: entering twice is a duplicate, and
 * the page has a distinct thing to say about it rather than a button to
 * redraw. `@@unique([challengeId, userId])` is what actually enforces that;
 * the read below is what turns the constraint into a sentence, and the catch
 * is what keeps a double-tapped button -- two requests that both pass the read
 * before either writes -- answering 409 rather than 500.
 */
export async function enterChallenge(
  userId: string,
  slugOrId: string,
): Promise<ChallengeEntry> {
  const challenge = await requireChallengeRow(slugOrId);
  assertOpen(challenge, new Date());

  if (await findEntry(challenge.id, userId)) {
    throw HttpError.conflict(ALREADY_ENTERED);
  }

  const timestamp = now();

  try {
    const created = await db.orm.challenges.ChallengeEntry.select(
      "id",
      "challengeId",
      "userId",
      "storyId",
      "note",
      "submittedAt",
      "updatedAt",
    ).create({
      challengeId: challenge.id,
      userId,
      storyId: null,
      note: null,
      submittedAt: timestamp,
      updatedAt: timestamp,
    });

    return await toEntry(created as EntryRow);
  } catch (error) {
    // Only a lost race is turned into a 409; anything else is a real fault and
    // must keep its own error rather than be reported as the caller's mistake.
    if (await findEntry(challenge.id, userId)) {
      throw HttpError.conflict(ALREADY_ENTERED);
    }

    throw error;
  }
}

/** The caller's own entry, or a 403/404 saying which it is. */
async function requireOwnEntry(
  userId: string,
  entryId: string,
): Promise<EntryRow> {
  const row = await entriesBase()
    .where((entry) => entry.id.eq(entryId))
    .first();

  if (!row) throw HttpError.notFound(ENTRY_NOT_FOUND);

  if ((row as EntryRow).userId !== userId) {
    throw HttpError.forbidden("That entry is not yours.");
  }

  return row as EntryRow;
}

/**
 * Attaches, swaps or clears the story on an entry, and edits its note.
 *
 * The story must be the caller's own: a writing challenge is entered with
 * something you wrote, and without this check anybody could enter somebody
 * else's story and take their ranking. A draft is allowed -- it simply does
 * not appear on the board until it is published, which the detail page says.
 *
 * Every field is optional, so a caller can change the note without resending
 * the story; `storyId: null` clears it, which is why the route's schema makes
 * it nullable rather than merely optional.
 */
export async function updateEntry(
  userId: string,
  entryId: string,
  input: EntryInput,
): Promise<ChallengeEntry> {
  const entry = await requireOwnEntry(userId, entryId);

  const challenge = await requireChallengeRow(entry.challengeId);
  assertOpen(challenge, new Date());

  if (input.storyId !== undefined && input.storyId !== null) {
    const story = await db.orm.content.Story.select("id", "authorId", "source")
      .where((row) => row.id.eq(input.storyId as string))
      .first();

    if (!story) throw HttpError.notFound("That story could not be found.");

    if (story.authorId !== userId) {
      throw HttpError.forbidden("You can only enter a story you wrote.");
    }

    // A catalogue edition has a real author column and is nobody's entry: it
    // was imported, not written on Scribe. The same `source` filter the
    // profile's story count applies, and for the same reason.
    if (story.source !== "SCRIBE") {
      throw HttpError.badRequest("Only a story written on Scribe can be entered.");
    }
  }

  await db.orm.challenges.ChallengeEntry.where((row) => row.id.eq(entry.id)).update({
    ...(input.storyId === undefined ? {} : { storyId: input.storyId }),
    ...(input.note === undefined ? {} : { note: input.note }),
    updatedAt: now(),
  });

  const fresh = await requireOwnEntry(userId, entryId);
  return toEntry(fresh);
}

/**
 * Withdraws from a challenge.
 *
 * Only while the window is open, for the reason `assertOpen` gives: a closed
 * board is a result, and a row leaving it afterwards would renumber everybody
 * below. Deliberately not idempotent about a missing row -- unlike unfollowing
 * a stranger, "withdraw an entry that is not there" is a client bug worth
 * surfacing rather than a state the UI can reach twice.
 */
export async function withdrawEntry(
  userId: string,
  entryId: string,
): Promise<void> {
  const entry = await requireOwnEntry(userId, entryId);

  const challenge = await requireChallengeRow(entry.challengeId);
  assertOpen(challenge, new Date());

  await db.orm.challenges.ChallengeEntry.where((row) =>
    row.id.eq(entry.id),
  ).delete();
}

/* Hosting (administrators only) ------------------------------------------ */

/** Both writes validate the window the same way, so one cannot drift. */
function parseWindow(startsAt: string, endsAt: string): {
  start: Temporal.Instant;
  end: Temporal.Instant;
} {
  const start = new Date(startsAt);
  const end = new Date(endsAt);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw HttpError.badRequest("Give the challenge a start and an end date.");
  }
  if (end <= start) {
    throw HttpError.badRequest("A challenge has to end after it starts.", {
      endsAt: "The end date must be after the start date.",
    });
  }

  return {
    start: Temporal.Instant.from(start.toISOString()),
    end: Temporal.Instant.from(end.toISOString()),
  };
}

/**
 * Creates a challenge. Administrators only -- `services/roles.ts` owns that
 * question, and this is one of the two callers.
 */
export async function createChallenge(
  userId: string,
  input: ChallengeInput,
): Promise<ChallengeDetail> {
  await assertAdmin(userId);

  const { start, end } = parseWindow(input.startsAt, input.endsAt);
  const timestamp = now();

  const challengeId = await db.transaction(async (tx) => {
    const slug = await uniqueSlug(input.title, async (candidate) => {
      const taken = await tx.orm.challenges.WritingChallenge.select("id")
        .where((challenge) => challenge.slug.eq(candidate))
        .first();
      return taken !== undefined && taken !== null;
    });

    const created = await tx.orm.challenges.WritingChallenge.select("id").create({
      title: input.title,
      slug,
      prompt: input.prompt,
      description: input.description ?? null,
      wordTarget: input.wordTarget ?? null,
      hostId: userId,
      startAt: start,
      endAt: end,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    return created.id;
  });

  return getChallenge(challengeId, userId);
}

/**
 * Edits a challenge. Administrators only.
 *
 * The slug is *not* re-derived from a new title: every link that has been
 * shared addresses the challenge by it, which is the whole reason a slug
 * exists rather than a title in the URL. The same rule stories and clubs
 * follow.
 */
export async function updateChallenge(
  userId: string,
  slugOrId: string,
  input: Partial<ChallengeInput>,
): Promise<ChallengeDetail> {
  await assertAdmin(userId);

  const challenge = await requireChallengeRow(slugOrId);

  // A window is only re-validated when one of its ends moves, and then against
  // the other end as it will be, not as it was.
  const movesWindow =
    input.startsAt !== undefined || input.endsAt !== undefined;
  const window = movesWindow
    ? parseWindow(
        input.startsAt ?? isoOf(challenge.startAt),
        input.endsAt ?? isoOf(challenge.endAt),
      )
    : null;

  await db.orm.challenges.WritingChallenge.where((row) =>
    row.id.eq(challenge.id),
  ).update({
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.wordTarget === undefined ? {} : { wordTarget: input.wordTarget }),
    ...(window === null ? {} : { startAt: window.start, endAt: window.end }),
    updatedAt: now(),
  });

  return getChallenge(challenge.id, userId);
}
