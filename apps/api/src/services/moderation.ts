/**
 * Reporting, and what a moderator does about a report.
 *
 * Four decisions are written into this file and nowhere else.
 *
 * - **There is one staff flag, and it is `auth.User.isAdmin`.** Read through
 *   `assertAdmin` in `services/roles.ts`, the same call `services/challenges.ts`
 *   makes. Splitting it into `MODERATOR` and `ADMIN` was on the table and is
 *   not done, because the two would have identical powers *here*: the same
 *   person triages the queue, hides the comment and suspends the account, and
 *   an enum whose values differ in nothing is exactly the second notion of
 *   staff that `services/roles.ts` exists to prevent. The day hiding a comment
 *   and suspending an account want different people, that is a migration on
 *   one column and a second assert in this file -- and nothing else changes,
 *   because nothing else reads the flag.
 *
 * - **Content is hidden, never deleted.** `hiddenAt` on
 *   `engagement.Comment`, `clubs.ClubDiscussion` and `channels.ChannelPost`;
 *   null means visible. A moderator acting on a false report is one `DISMISS`
 *   away from undoing it, which is the whole argument for a column over a
 *   `DELETE`. The price is that *every* public read path has to filter, and
 *   the list of them is below.
 *
 * - **A hidden row's notifications are deleted, not blanked.**
 *   `notifications.Notification.excerpt` is a copy taken at fan-out time, so
 *   hiding the comment it quotes does not touch it -- the abusive reply is
 *   still sitting in the bell of the person it was aimed at, which is the
 *   reader who least needs to see it again. Blanking leaves a row saying
 *   somebody replied to you and showing nothing, pointing at a comment that no
 *   longer renders: an artefact worse than its absence. So the copies go.
 *   `DISMISS` does not bring them back, deliberately -- re-announcing a
 *   week-old reply is not a correction, and the notification's job (telling
 *   somebody at the time) is long over. Rows written before the `sourceType` /
 *   `sourceId` columns landed carry null and cannot be found; see the
 *   migration's header.
 *
 * - **Suspension stops writing, not reading.** `auth.User.suspendedAt`, read
 *   only through `assertNotSuspended` in `services/roles.ts`. The write seams
 *   that call it are exactly these four:
 *
 *       services/engagement.ts  createComment
 *       services/clubs.ts       createDiscussion
 *       services/channels.ts    createPost
 *       services/moderation.ts  createReport
 *
 *   A fifth surface that accepts user-written text joins that list. Nothing
 *   enforces that it does, which is the honest state of it: the alternative
 *   was an async check in `requireUser`, paid for by every request in the app
 *   to answer a question four of them ask.
 *
 * **Every public read path that had to learn about `hiddenAt`**, audited when
 * this landed, and the place to add to when a new one appears:
 *
 *     services/engagement.ts  commentsBase        the comment list and replies
 *     services/engagement.ts  hydrateComments     a thread's reply count
 *     services/engagement.ts  createComment       the parent a reply attaches to
 *     services/clubs.ts       listDiscussions     the thread list and replies
 *     services/clubs.ts       hydrateDiscussions  a thread's reply count
 *     services/clubs.ts       hydrate             a club card's discussionCount
 *     services/clubs.ts       createDiscussion    the parent a reply attaches to
 *     services/channels.ts    postsBase           the channel feed
 *     services/channels.ts    hydrate             a channel card's postCount
 *     services/analytics.ts   loadTotals          an author's comment count
 *     services/gamification.ts metricsFor         commentsPosted and clubPosts
 *
 * The counts are on that list for the same reason the lists are: a card
 * reading "12 discussions" above a list of eleven is a moderation bug that
 * looks like a pagination bug. The two badge metrics are there because credit
 * for something that was taken down is credit for nothing.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { assertAdmin, assertNotSuspended } from "./roles.js";
import { toIso } from "./stories.js";

/* Shapes returned to the client ------------------------------------------ */

export const REPORT_TARGETS = [
  "COMMENT",
  "CLUB_DISCUSSION",
  "CHANNEL_POST",
] as const;

export type ReportTarget = (typeof REPORT_TARGETS)[number];

export const REPORT_REASONS = [
  "SPAM",
  "HARASSMENT",
  "HATE",
  "SEXUAL",
  "VIOLENCE",
  "SPOILER",
  "OTHER",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ["OPEN", "RESOLVED"] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_ACTIONS = ["DISMISS", "HIDE", "SUSPEND"] as const;

export type ReportAction = (typeof REPORT_ACTIONS)[number];

/** The same four fields every other author summary in the app carries. */
export interface ModerationUser {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * What was reported, as it stands *now*.
 *
 * Read back rather than copied onto the report, unlike a notification's
 * excerpt: a moderator has to judge the text that is live, and a frozen copy
 * would have them hiding something the author edited an hour ago. The
 * consequence is the null below.
 */
export interface ReportedContent {
  type: ReportTarget;
  id: string;
  /** The body, cut to `EXCERPT_LENGTH`. */
  excerpt: string;
  hidden: boolean;
  author: ModerationUser;
  /** Where to go and read it in context, as a web-app path. */
  href: string;
}

export interface Report {
  id: string;
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  /** What the reporter typed, or null when they only picked a reason. */
  details: string | null;
  status: ReportStatus;
  /** Null while open. */
  action: ReportAction | null;
  /** The moderator's own note. Never shown to the reporter. */
  note: string | null;
  reporter: ModerationUser;
  resolvedBy: ModerationUser | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Null when the row this report names is gone -- its author deleted it, or
   * it went with the story it was on. The report is kept either way: it is a
   * record of somebody asking, and a queue that lost rows whenever content
   * was deleted would hide exactly the accounts worth noticing.
   */
  target: ReportedContent | null;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export const MAX_PAGE_SIZE = 100;

export const DETAILS_MAX_LENGTH = 1000;

export const NOTE_MAX_LENGTH = 1000;

/** How much of a reported body a moderator sees in the queue. */
const EXCERPT_LENGTH = 400;

const REPORT_NOT_FOUND = "That report could not be found.";

const TARGET_NOT_FOUND = "That content could not be found.";

/* Helpers ---------------------------------------------------------------- */

/** `now()` in the spelling the timestamp codec writes. */
function now(): Temporal.Instant {
  return Temporal.Now.instant();
}

/** These columns are never null; the epoch fallback keeps one bad row local. */
function isoOf(value: unknown): string {
  return toIso(value) ?? new Date(0).toISOString();
}

function emptyPage<T>(page: number, limit: number): Page<T> {
  return { items: [], page, limit, total: 0, totalPages: 0, hasMore: false };
}

function excerptOf(body: string): string {
  return body.length <= EXCERPT_LENGTH ? body : body.slice(0, EXCERPT_LENGTH);
}

async function usersByIds(ids: string[]): Promise<Map<string, ModerationUser>> {
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

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
      },
    ]),
  );
}

/* Resolving a target ------------------------------------------------------ */

/**
 * One row of reported content, whatever table it is in.
 *
 * `authorId` is who gets suspended, which is not always the column called
 * `userId`: a channel post has no author of its own, because only the
 * channel's owner may write one.
 */
interface TargetRow {
  type: ReportTarget;
  id: string;
  body: string;
  authorId: string;
  hidden: boolean;
  href: string;
}

/**
 * Loads one target, or null when there is no such row.
 *
 * One query per report rather than a batched read, because the two callers
 * want one: `createReport` is validating a single id, and `resolveReport` is
 * acting on a single id. The queue's own hydration batches instead -- see
 * `loadTargets`.
 */
async function loadTarget(
  type: ReportTarget,
  id: string,
): Promise<TargetRow | null> {
  const [row] = await loadTargets(type, [id]);
  return row ?? null;
}

/**
 * Loads a page's worth of targets of one type.
 *
 * Three shapes of row and one shape out, so the queue can draw a comment, a
 * club thread and a channel post with the same component. The extra reads are
 * what make `href` and `authorId` answerable: a comment's link needs its
 * story's slug and, when it has one, its chapter's number, and a channel post
 * has no author column of its own because only the channel's owner may write
 * one.
 *
 * Batched by id rather than joined in SQL, the way `usersByIds` above is: two
 * small keyed reads cost less than one statement this file would then be the
 * only place in the app to hand-write.
 */
async function loadTargets(
  type: ReportTarget,
  ids: string[],
): Promise<TargetRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];

  if (type === "COMMENT") {
    const rows = await db.orm.engagement.Comment.select(
      "id",
      "content",
      "userId",
      "storyId",
      "chapterId",
      "hiddenAt",
    )
      .where((row) => row.id.in(unique))
      .all();

    if (rows.length === 0) return [];

    const stories = await db.orm.content.Story.select("id", "slug")
      .where((row) => row.id.in(rows.map((comment) => comment.storyId)))
      .all();
    const slugs = new Map(stories.map((story) => [story.id, story.slug]));

    const chapterIds = rows.flatMap((row) =>
      row.chapterId === null ? [] : [row.chapterId],
    );
    const chapters =
      chapterIds.length === 0
        ? []
        : await db.orm.content.Chapter.select("id", "chapterNumber")
            .where((row) => row.id.in(chapterIds))
            .all();
    const numbers = new Map(
      chapters.map((chapter) => [chapter.id, chapter.chapterNumber]),
    );

    return rows.flatMap((row) => {
      const slug = slugs.get(row.storyId);
      // A comment whose story is gone is a comment nobody can reach, so it
      // reads as gone here too rather than as a target with a broken link.
      if (slug === undefined) return [];

      const chapterNumber =
        row.chapterId === null ? undefined : numbers.get(row.chapterId);

      return [
        {
          type,
          id: row.id,
          body: row.content,
          authorId: row.userId,
          hidden: row.hiddenAt !== null && row.hiddenAt !== undefined,
          href:
            chapterNumber === undefined
              ? `/story/${slug}`
              : `/read/${slug}/${chapterNumber}`,
        },
      ];
    });
  }

  if (type === "CLUB_DISCUSSION") {
    const rows = await db.orm.clubs.ClubDiscussion.select(
      "id",
      "body",
      "userId",
      "clubId",
      "hiddenAt",
    )
      .where((row) => row.id.in(unique))
      .all();

    if (rows.length === 0) return [];

    const clubs = await db.orm.clubs.BookClub.select("id", "slug")
      .where((row) => row.id.in(rows.map((item) => item.clubId)))
      .all();
    const slugs = new Map(clubs.map((club) => [club.id, club.slug]));

    return rows.flatMap((row) => {
      const slug = slugs.get(row.clubId);
      if (slug === undefined) return [];

      return [
        {
          type,
          id: row.id,
          body: row.body,
          authorId: row.userId,
          hidden: row.hiddenAt !== null && row.hiddenAt !== undefined,
          href: `/clubs/${slug}`,
        },
      ];
    });
  }

  const rows = await db.orm.channels.ChannelPost.select(
    "id",
    "title",
    "content",
    "channelId",
    "hiddenAt",
  )
    .where((row) => row.id.in(unique))
    .all();

  if (rows.length === 0) return [];

  const channels = await db.orm.channels.BroadcastChannel.select(
    "id",
    "slug",
    "authorId",
  )
    .where((row) => row.id.in(rows.map((post) => post.channelId)))
    .all();
  const owners = new Map(channels.map((channel) => [channel.id, channel]));

  return rows.flatMap((row) => {
    const channel = owners.get(row.channelId);
    if (channel === undefined) return [];

    return [
      {
        type,
        id: row.id,
        // The headline and the body, because a post's title is often the
        // whole of what was objected to.
        body: `${row.title}\n${row.content}`,
        authorId: channel.authorId,
        hidden: row.hiddenAt !== null && row.hiddenAt !== undefined,
        href: `/channels/${channel.slug}`,
      },
    ];
  });
}

/* Hiding and restoring ---------------------------------------------------- */

/**
 * Sets or clears `hiddenAt` on one row, whichever table it is in.
 *
 * A switch rather than three exported functions, so the only way to hide
 * something is to name one of the three types the contract allows -- the
 * compiler then refuses a fourth surface that forgot to add its table here.
 */
async function setHidden(
  type: ReportTarget,
  id: string,
  hiddenAt: Temporal.Instant | null,
): Promise<void> {
  switch (type) {
    case "COMMENT":
      await db.orm.engagement.Comment.where((row) => row.id.eq(id)).update({
        hiddenAt,
      });
      return;
    case "CLUB_DISCUSSION":
      await db.orm.clubs.ClubDiscussion.where((row) => row.id.eq(id)).update({
        hiddenAt,
      });
      return;
    case "CHANNEL_POST":
      await db.orm.channels.ChannelPost.where((row) => row.id.eq(id)).update({
        hiddenAt,
      });
      return;
  }
}

/**
 * Hides a row and deletes every notification that quoted it.
 *
 * The sweep is the point: see the module header for why the copies go rather
 * than being blanked. One statement, keyed on the index
 * `notification_sourceType_sourceId_idx`, so a comment nobody was notified
 * about costs an index probe and no rows.
 */
async function hideContent(type: ReportTarget, id: string): Promise<void> {
  await setHidden(type, id, now());

  const plan = db.raw.sql`
    DELETE FROM "notifications"."notification"
     WHERE "sourceType" = ${type}
       AND "sourceId" = ${id}
  `
    .affectedCount()
    .build();

  await db.runtime().query(plan);
}

/* Reports ----------------------------------------------------------------- */

export interface ReportInput {
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  details?: string | undefined;
}

/**
 * Files a report.
 *
 * The target has to be one the reporter can actually see: an id that names
 * nothing, or something already hidden, answers 404 rather than confirming
 * that a hidden row exists. Reporting your own post is refused -- deleting it
 * is right there, and the queue is for things you cannot fix yourself.
 *
 * **One open report per reporter per target**, which is not a unique index
 * because it cannot be: a target resolved today may legitimately be reported
 * again tomorrow, and no constraint can say "unique only while open". The
 * insert is therefore an `INSERT ... SELECT ... WHERE NOT EXISTS`, which two
 * requests arriving in the same instant can both pass -- read-committed shows
 * neither the other's uncommitted row. The leftover is one duplicate row in
 * the queue, and `resolveReport` sweeps every open report on a target rather
 * than only the one it was handed, so resolving either clears both. That is
 * the right behaviour regardless of the race: a moderator who has looked at a
 * comment has looked at it for everybody who reported it.
 */
export async function createReport(
  userId: string,
  input: ReportInput,
): Promise<Report> {
  // The fourth write seam a suspension stops. A suspended account filing
  // reports is the one that matters most here: somebody just told they may not
  // post has an obvious next move, and it is this queue.
  await assertNotSuspended(userId);

  const target = await loadTarget(input.targetType, input.targetId);

  // Hidden reads as absent here exactly as it does on every public list.
  if (!target || target.hidden) throw HttpError.notFound(TARGET_NOT_FOUND);

  if (target.authorId === userId) {
    throw HttpError.badRequest("You cannot report your own post.");
  }

  const details = input.details?.trim();

  const plan = db.raw.sql`
    INSERT INTO "moderation"."report"
      ("id", "reporterId", "targetType", "targetId", "reason", "details",
       "status", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, ${userId}, ${input.targetType},
           ${input.targetId}, ${input.reason},
           NULLIF(${details ?? ""}::text, ''), 'OPEN', now(), now()
     WHERE NOT EXISTS (
       SELECT 1
         FROM "moderation"."report" AS existing
        WHERE existing."reporterId" = ${userId}
          AND existing."targetType" = ${input.targetType}
          AND existing."targetId" = ${input.targetId}
          AND existing."status" = 'OPEN'
     )
    RETURNING "id"
  `
    .returnsRow({ id: "pg/text@1" })
    .build();

  const [inserted] = await db.runtime().query(plan);

  // No row means the `NOT EXISTS` matched: this reporter already has one open
  // against this target. 409 rather than a silent success, so the UI can say
  // "you have already reported this" instead of implying a second one landed.
  if (!inserted) {
    throw HttpError.conflict("You have already reported this. We are looking.");
  }

  const report = await findReport(inserted.id);
  if (!report) throw HttpError.notFound(REPORT_NOT_FOUND);

  return report;
}

interface ReportRow {
  id: string;
  reporterId: string;
  targetType: string;
  targetId: string;
  reason: string;
  details: string | null;
  status: string;
  action: string | null;
  note: string | null;
  resolvedById: string | null;
  resolvedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

function reportsBase() {
  return db.orm.moderation.Report.select(
    "id",
    "reporterId",
    "targetType",
    "targetId",
    "reason",
    "details",
    "status",
    "action",
    "note",
    "resolvedById",
    "resolvedAt",
    "createdAt",
    "updatedAt",
  );
}

async function findReport(id: string): Promise<Report | null> {
  const row = await reportsBase()
    .where((report) => report.id.eq(id))
    .first();

  if (!row) return null;

  const [report] = await hydrateReports([row as ReportRow]);
  return report ?? null;
}

/**
 * Attaches each report's reporter, resolver and target.
 *
 * Grouped by target type, so a page of fifty mixed reports costs three target
 * queries and one user query rather than fifty of each.
 */
async function hydrateReports(rows: ReportRow[]): Promise<Report[]> {
  if (rows.length === 0) return [];

  const targets = new Map<string, TargetRow>();

  for (const type of REPORT_TARGETS) {
    const ids = rows
      .filter((row) => row.targetType === type)
      .map((row) => row.targetId);

    for (const target of await loadTargets(type, ids)) {
      targets.set(`${type}:${target.id}`, target);
    }
  }

  const users = await usersByIds([
    ...rows.map((row) => row.reporterId),
    ...rows.flatMap((row) => (row.resolvedById ? [row.resolvedById] : [])),
    ...[...targets.values()].map((target) => target.authorId),
  ]);

  return rows
    .map((row) => {
      // A report whose reporter was deleted drops out rather than failing the
      // whole page, the way `services/library.ts` drops a vanished book. The
      // *target* going is different and expected -- see `Report.target`.
      const reporter = users.get(row.reporterId);
      if (!reporter) return null;

      const target = targets.get(`${row.targetType}:${row.targetId}`);
      const author = target ? users.get(target.authorId) : undefined;

      return {
        id: row.id,
        targetType: row.targetType as ReportTarget,
        targetId: row.targetId,
        reason: row.reason as ReportReason,
        details: row.details,
        status: row.status as ReportStatus,
        action: row.action === null ? null : (row.action as ReportAction),
        note: row.note,
        reporter,
        resolvedBy:
          row.resolvedById === null
            ? null
            : (users.get(row.resolvedById) ?? null),
        resolvedAt: toIso(row.resolvedAt),
        createdAt: isoOf(row.createdAt),
        updatedAt: isoOf(row.updatedAt),
        target:
          target && author
            ? {
                type: target.type,
                id: target.id,
                excerpt: excerptOf(target.body),
                hidden: target.hidden,
                author,
                href: target.href,
              }
            : null,
      };
    })
    .filter((report): report is Report => report !== null);
}

export interface ReportQuery {
  /** Undefined lists both. The queue's default is `OPEN`; the route sets it. */
  status?: ReportStatus | undefined;
  targetType?: ReportTarget | undefined;
  reason?: ReportReason | undefined;
  page: number;
  limit: number;
}

/**
 * The moderation queue. Administrators only.
 *
 * Newest first with `id` as the tie-breaker, the same ordering every other
 * paginated list in the app uses and for the same reason: two reports filed in
 * the same millisecond must not be able to swap places between pages and show
 * one of them twice.
 */
export async function listReports(
  callerId: string,
  query: ReportQuery,
): Promise<Page<Report>> {
  await assertAdmin(callerId);

  let collection = reportsBase();

  if (query.status !== undefined) {
    const status = query.status;
    collection = collection.where((row) => row.status.eq(status));
  }
  if (query.targetType !== undefined) {
    const targetType = query.targetType;
    collection = collection.where((row) => row.targetType.eq(targetType));
  }
  if (query.reason !== undefined) {
    const reason = query.reason;
    collection = collection.where((row) => row.reason.eq(reason));
  }

  const totals = await collection.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));

  if (totals.total === 0) return emptyPage(query.page, query.limit);

  const rows = await collection
    .orderBy([(row) => row.createdAt.desc(), (row) => row.id.desc()])
    .offset((query.page - 1) * query.limit)
    .limit(query.limit)
    .all();

  const items = await hydrateReports(rows as ReportRow[]);
  const total = totals.total;

  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.ceil(total / query.limit),
    hasMore: query.page * query.limit < total,
  };
}

export interface ResolveInput {
  action: ReportAction;
  note?: string | undefined;
}

/**
 * Closes a report, and does the thing it was closed with.
 *
 * The three actions, and what each one means:
 *
 * - `HIDE` hides the content and deletes the notifications that copied it.
 * - `SUSPEND` does all of that *and* stops the author posting. Never one
 *   without the other: suspending somebody over a post left standing says the
 *   post was fine and the person was not, which is not a judgement this queue
 *   is for.
 * - `DISMISS` is the undo. It restores content an earlier call hid, and lifts
 *   a suspension *this same report* imposed -- knowable, because the report
 *   records the action it took. It deliberately does not lift a suspension
 *   some other report imposed: that call was made about other content and is
 *   not this one's to reverse.
 *
 * Re-resolving an already-resolved report is therefore allowed and is the
 * documented path back from a wrong call. It overwrites `resolvedBy` and
 * `resolvedAt`, so the queue records the current judgement rather than a
 * history of them; a history is an append-only second table and nobody has
 * asked for one.
 *
 * Every *open* report on the same target is closed alongside, with the same
 * action and resolver. Ten people reporting one comment is one decision.
 */
export async function resolveReport(
  callerId: string,
  reportId: string,
  input: ResolveInput,
): Promise<Report> {
  await assertAdmin(callerId);

  const report = await reportsBase()
    .where((row) => row.id.eq(reportId))
    .first();

  if (!report) throw HttpError.notFound(REPORT_NOT_FOUND);

  const targetType = report.targetType as ReportTarget;
  const target = await loadTarget(targetType, report.targetId);

  if (input.action !== "DISMISS" && !target) {
    // Nothing to hide and nobody to suspend: the row went before a moderator
    // got to it. Dismissing still works, which is how such a report is closed.
    throw HttpError.notFound(
      "That content no longer exists, so it can only be dismissed.",
    );
  }

  if (input.action === "SUSPEND" && target) {
    await assertSuspendable(target.authorId);
  }

  const timestamp = now();

  if (input.action === "HIDE" || input.action === "SUSPEND") {
    await hideContent(targetType, report.targetId);
  } else if (target?.hidden) {
    await setHidden(targetType, report.targetId, null);
  }

  if (input.action === "SUSPEND" && target) {
    await db.orm.auth.User.where((user) => user.id.eq(target.authorId)).update({
      suspendedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  // The undo half of a suspension: only for the report that imposed it.
  if (input.action === "DISMISS" && report.action === "SUSPEND" && target) {
    await db.orm.auth.User.where((user) => user.id.eq(target.authorId)).update({
      suspendedAt: null,
      updatedAt: timestamp,
    });
  }

  const note = input.note?.trim();

  /**
   * One statement for the report itself and every other open report on the
   * same target. `OR` rather than two updates, so a moderator cannot see a
   * half-resolved queue between them.
   */
  const plan = db.raw.sql`
    UPDATE "moderation"."report"
       SET "status" = 'RESOLVED',
           "action" = ${input.action},
           "note" = NULLIF(${note ?? ""}::text, ''),
           "resolvedById" = ${callerId},
           "resolvedAt" = now(),
           "updatedAt" = now()
     WHERE "id" = ${reportId}
        OR ("targetType" = ${report.targetType}
            AND "targetId" = ${report.targetId}
            AND "status" = 'OPEN')
  `
    .affectedCount()
    .build();

  await db.runtime().query(plan);

  const resolved = await findReport(reportId);
  if (!resolved) throw HttpError.notFound(REPORT_NOT_FOUND);

  return resolved;
}

/**
 * Refuses to suspend an administrator.
 *
 * A guard rather than a rule about who reports whom: the queue is reachable by
 * every administrator, and one of them locking the others out -- deliberately
 * or by mis-clicking a row -- is the failure that has no in-app way back.
 * Lifting an administrator's account is a database statement either way, so
 * this only ever refuses something that would have needed one.
 */
async function assertSuspendable(userId: string): Promise<void> {
  const row = await db.orm.auth.User.select("isAdmin")
    .where((user) => user.id.eq(userId))
    .first();

  if (row?.isAdmin === true) {
    throw HttpError.conflict(
      "An administrator cannot be suspended from the moderation queue.",
    );
  }
}
