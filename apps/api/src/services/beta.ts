/**
 * Beta readers: an author shares unpublished chapters with readers they chose,
 * through a private link, and hears back privately.
 *
 * **The link is the invitation.** A story has at most one (`beta.Link`). A
 * signed-in reader who opens it joins (`beta.Reader`) and can then read the
 * story's unpublished chapters through the ordinary story endpoints -- the
 * rule itself lives with every other visibility rule, in `services/stories.ts`
 * (`StoryAccess`). Revoking the link removes everyone who joined through it;
 * the author can also remove one reader at a time, and a reader can leave.
 *
 * **Feedback is private.** A beta reader's notes on a chapter are read by the
 * author and by the reader who wrote them, nobody else. They are kept after
 * the chapter is published and after the reader leaves or is removed: they
 * are the author's notes now, and the author decides when they go. Feedback
 * is not a comment and never becomes one -- comments, likes and ratings stay
 * closed on unpublished work, because they are public.
 *
 * Every function takes the caller's id explicitly, as `services/highlights.ts`
 * does, so nothing here can act for the wrong user.
 */

import { randomBytes } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { assertStoryOwned } from "./authoring.js";
import { notify } from "./notifications.js";
import { assertNotSuspended } from "./roles.js";
import {
  findVisibleChapterText,
  findVisibleStoryId,
  getBetaStoryCard,
  toIso,
  type Story,
} from "./stories.js";

/** Longest piece of feedback, in characters. */
export const FEEDBACK_LIMIT = 4000;

/** Longest passage feedback may quote. The same cap as a highlight's. */
export const FEEDBACK_QUOTE_LIMIT = 2000;

/**
 * Most notes one reader may leave on one chapter. Far past anything written
 * by hand; it is here so a script cannot fill an author's inbox.
 */
export const FEEDBACK_PER_CHAPTER = 100;

const STORY_NOT_FOUND = "That story could not be found.";
const CHAPTER_NOT_FOUND = "That chapter could not be found.";
const INVITE_NOT_FOUND =
  "That invite link is not valid. It may have been turned off by the author.";
const FEEDBACK_NOT_FOUND = "That feedback could not be found.";

/* Shapes returned to the client ------------------------------------------ */

export interface BetaPerson {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface BetaLink {
  token: string;
  createdAt: string;
}

export interface BetaReaderSummary {
  user: BetaPerson;
  joinedAt: string;
  /** Notes this reader has left on the story, kept or not. */
  feedbackCount: number;
}

/** What the author manages on the beta page. */
export interface BetaOverview {
  storyId: string;
  link: BetaLink | null;
  readers: BetaReaderSummary[];
}

/** What somebody holding an invite link is shown before joining. */
export interface BetaInvite {
  story: Story;
  /** The caller wrote the story: there is nothing to join. */
  isAuthor: boolean;
  /** The caller is already a beta reader of it. */
  joined: boolean;
}

export interface BetaFeedback {
  id: string;
  storyId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  /** Whether the chapter is published now, not when this was written. */
  chapterPublished: boolean;
  body: string;
  /** The passage it is about, as the chapter read when it was written. */
  quote: string | null;
  reader: BetaPerson;
  /** Written by the caller, who may edit it. */
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

/* Helpers ---------------------------------------------------------------- */

function iso(value: unknown): string {
  return toIso(value) ?? new Date(0).toISOString();
}

/** 144 bits, URL-safe: a link that cannot be guessed, short enough to paste. */
function newToken(): string {
  return randomBytes(18).toString("base64url");
}

async function peopleByIds(ids: string[]): Promise<Map<string, BetaPerson>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const rows = await db.orm.auth.User.select("id", "username", "displayName", "avatarUrl")
    .where((user) => user.id.in(unique))
    .all();

  return new Map(rows.map((row) => [row.id, row]));
}

async function isReader(storyId: string, userId: string): Promise<boolean> {
  const row = await db.orm.beta.Reader.select("userId")
    .where((reader) => reader.storyId.eq(storyId))
    .where((reader) => reader.userId.eq(userId))
    .first();
  return row !== null && row !== undefined;
}

async function linkOf(storyId: string): Promise<BetaLink | null> {
  const row = await db.orm.beta.Link.select("token", "createdAt")
    .where((link) => link.storyId.eq(storyId))
    .first();
  return row ? { token: row.token, createdAt: iso(row.createdAt) } : null;
}

/* Author ----------------------------------------------------------------- */

/** The story's link and who has joined, for its author. */
export async function getOverview(userId: string, storyId: string): Promise<BetaOverview> {
  await assertStoryOwned(userId, storyId);

  const [link, readers, counts] = await Promise.all([
    linkOf(storyId),
    db.orm.beta.Reader.select("userId", "joinedAt")
      .where((reader) => reader.storyId.eq(storyId))
      .orderBy((reader) => reader.joinedAt.asc())
      .all(),
    db.orm.beta.Feedback.where((feedback) => feedback.storyId.eq(storyId))
      .groupBy("userId")
      .aggregate((aggregate) => ({ total: aggregate.count() })),
  ]);

  const people = await peopleByIds(readers.map((reader) => reader.userId));
  const countByUser = new Map(counts.map((row) => [row.userId, row.total]));

  return {
    storyId,
    link,
    readers: readers.flatMap((reader) => {
      const user = people.get(reader.userId);
      if (!user) return [];
      return [
        {
          user,
          joinedAt: iso(reader.joinedAt),
          feedbackCount: countByUser.get(reader.userId) ?? 0,
        },
      ];
    }),
  };
}

/**
 * The story's invite link, made if it has none. Asking twice returns the same
 * link: an author pressing the button again should not break the one they
 * already sent.
 *
 * Not gated on suspension: sharing a draft with chosen readers publishes
 * nothing (see `routes/suspension.test.ts`).
 */
export async function createLink(userId: string, storyId: string): Promise<BetaLink> {
  await assertStoryOwned(userId, storyId);

  const existing = await linkOf(storyId);
  if (existing) return existing;

  const plan = db.raw.sql`
    INSERT INTO "beta"."link" ("storyId", "token", "createdAt")
    VALUES (${storyId}, ${newToken()}, now())
    ON CONFLICT ("storyId") DO NOTHING
  `.affectedCount().build();
  await db.runtime().query(plan);

  // Two presses at once: whichever insert won, both answer with it.
  const link = await linkOf(storyId);
  if (!link) throw new Error("beta: link insert left no row");
  return link;
}

/**
 * Turns the link off and removes every reader who joined through it, in one
 * transaction: a revoked link that left its readers in would not be revoked.
 * Their feedback stays; see the header.
 */
export async function revokeLink(userId: string, storyId: string): Promise<void> {
  await assertStoryOwned(userId, storyId);

  await db.transaction(async (tx) => {
    await tx.query(
      db.raw.sql`DELETE FROM "beta"."link" WHERE "storyId" = ${storyId}`.affectedCount().build(),
    );
    await tx.query(
      db.raw.sql`DELETE FROM "beta"."reader" WHERE "storyId" = ${storyId}`.affectedCount().build(),
    );
  });
}

/** Removes one reader. Removing somebody who is not there is not an error. */
export async function removeReader(
  userId: string,
  storyId: string,
  readerId: string,
): Promise<void> {
  await assertStoryOwned(userId, storyId);

  await db.orm.beta.Reader.where((reader) => reader.storyId.eq(storyId))
    .where((reader) => reader.userId.eq(readerId))
    .delete();
}

/* Joining ---------------------------------------------------------------- */

async function storyIdForToken(token: string): Promise<string> {
  const row = await db.orm.beta.Link.select("storyId")
    .where((link) => link.token.eq(token))
    .first();
  if (!row) throw HttpError.notFound(INVITE_NOT_FOUND);
  return row.storyId;
}

/** What an invite link leads to, for the page that offers to join. */
export async function previewInvite(token: string, userId: string): Promise<BetaInvite> {
  const storyId = await storyIdForToken(token);

  // A taken-down story has no card, and the link leads nowhere while it is down.
  const story = await getBetaStoryCard(storyId);
  if (!story) throw HttpError.notFound(INVITE_NOT_FOUND);

  const isAuthor = story.author.id === userId;
  return {
    story,
    isAuthor,
    joined: !isAuthor && (await isReader(storyId, userId)),
  };
}

/**
 * Joins the beta the link belongs to and returns the story's slug, for the
 * client to open. Joining twice is joining once. The author opening their own
 * link joins nothing and is simply sent to the story.
 *
 * Not gated on suspension: it is membership, and carries no text.
 */
export async function joinBeta(token: string, userId: string): Promise<{ slug: string }> {
  const invite = await previewInvite(token, userId);
  if (invite.isAuthor || invite.joined) return { slug: invite.story.slug };

  const plan = db.raw.sql`
    INSERT INTO "beta"."reader" ("storyId", "userId", "joinedAt")
    VALUES (${invite.story.id}, ${userId}, now())
    ON CONFLICT ("storyId", "userId") DO NOTHING
  `.affectedCount().build();
  await db.runtime().query(plan);

  return { slug: invite.story.slug };
}

/** A beta reader leaving on their own. Their feedback stays with the author. */
export async function leaveBeta(userId: string, storyId: string): Promise<void> {
  await db.orm.beta.Reader.where((reader) => reader.storyId.eq(storyId))
    .where((reader) => reader.userId.eq(userId))
    .delete();
}

/* Feedback --------------------------------------------------------------- */

interface FeedbackRow {
  id: string;
  storyId: string;
  chapterId: string;
  userId: string;
  body: string;
  quote: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

const FEEDBACK_FIELDS = [
  "id",
  "storyId",
  "chapterId",
  "userId",
  "body",
  "quote",
  "createdAt",
  "updatedAt",
] as const;

async function hydrateFeedback(
  rows: FeedbackRow[],
  viewerId: string,
): Promise<BetaFeedback[]> {
  if (rows.length === 0) return [];

  const chapterIds = [...new Set(rows.map((row) => row.chapterId))];
  const [chapters, people] = await Promise.all([
    db.orm.content.Chapter.select("id", "chapterNumber", "title", "publishedAt")
      .where((chapter) => chapter.id.in(chapterIds))
      .all(),
    peopleByIds(rows.map((row) => row.userId)),
  ]);
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));

  return rows
    .flatMap((row) => {
      const chapter = chapterById.get(row.chapterId);
      const reader = people.get(row.userId);
      if (!chapter || !reader) return [];
      return [
        {
          id: row.id,
          storyId: row.storyId,
          chapterId: row.chapterId,
          chapterNumber: chapter.chapterNumber,
          chapterTitle: chapter.title,
          chapterPublished: chapter.publishedAt !== null && chapter.publishedAt !== undefined,
          body: row.body,
          quote: row.quote,
          reader,
          mine: row.userId === viewerId,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        },
      ];
    })
    .sort(
      (a, b) =>
        a.chapterNumber - b.chapterNumber || a.createdAt.localeCompare(b.createdAt),
    );
}

/**
 * Feedback on one story, in reading order: all of it for the author, and the
 * caller's own notes for anybody else who can still see the story.
 */
export async function listFeedback(
  userId: string,
  storySlugOrId: string,
): Promise<BetaFeedback[]> {
  const storyId = await findVisibleStoryId(storySlugOrId, userId, { beta: true });
  if (storyId === null) throw HttpError.notFound(STORY_NOT_FOUND);

  const story = await db.orm.content.Story.select("authorId")
    .where((row) => row.id.eq(storyId))
    .first();
  if (!story) throw HttpError.notFound(STORY_NOT_FOUND);

  let query = db.orm.beta.Feedback.select(...FEEDBACK_FIELDS).where((row) =>
    row.storyId.eq(storyId),
  );
  if (story.authorId !== userId) {
    query = query.where((row) => row.userId.eq(userId));
  }

  return hydrateFeedback(await query.all(), userId);
}

export interface FeedbackInput {
  chapterId: string;
  body: string;
  /** A passage, as offsets into the stored chapter; both or neither. */
  start?: number | undefined;
  end?: number | undefined;
}

function normaliseBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) throw HttpError.badRequest("Write something first.");
  if (trimmed.length > FEEDBACK_LIMIT) {
    throw HttpError.badRequest(`Keep feedback under ${FEEDBACK_LIMIT} characters.`);
  }
  return trimmed;
}

/**
 * Leaves feedback on a chapter the caller is beta-reading.
 *
 * Only a beta reader of the story may: a reader of a published chapter who
 * was never invited has comments for that, and the author has the editor.
 * Guarded on suspension -- it is text that reaches somebody else.
 */
export async function createFeedback(
  userId: string,
  input: FeedbackInput,
): Promise<BetaFeedback> {
  const chapter = await findVisibleChapterText(input.chapterId, userId, { beta: true });
  if (chapter === null) throw HttpError.notFound(CHAPTER_NOT_FOUND);

  if (!(await isReader(chapter.storyId, userId))) {
    throw HttpError.forbidden("Only the story's beta readers can leave feedback.");
  }
  await assertNotSuspended(userId);

  const body = normaliseBody(input.body);

  let quote: string | null = null;
  if (input.start !== undefined || input.end !== undefined) {
    const { start, end } = input;
    if (
      start === undefined ||
      end === undefined ||
      start < 0 ||
      end <= start ||
      end > chapter.content.length
    ) {
      throw HttpError.badRequest("That passage is not in this chapter.");
    }
    if (end - start > FEEDBACK_QUOTE_LIMIT) {
      throw HttpError.badRequest("That passage is too long to quote.");
    }
    quote = chapter.content.slice(start, end);
    if (quote.trim().length === 0) {
      throw HttpError.badRequest("That passage is not in this chapter.");
    }
  }

  const { total } = await db.orm.beta.Feedback.where((row) => row.userId.eq(userId))
    .where((row) => row.chapterId.eq(chapter.id))
    .aggregate((aggregate) => ({ total: aggregate.count() }));
  if (total >= FEEDBACK_PER_CHAPTER) {
    throw HttpError.conflict(
      "You have left as much feedback on this chapter as Scribe keeps. Remove some to add more.",
    );
  }

  const created = await db.orm.beta.Feedback.create({
    storyId: chapter.storyId,
    chapterId: chapter.id,
    userId,
    body,
    quote,
  });

  notify({ event: "beta-feedback", actorId: userId, feedbackId: created.id });

  const [feedback] = await hydrateFeedback([await feedbackRow(created.id)], userId);
  if (!feedback) throw HttpError.notFound(FEEDBACK_NOT_FOUND);
  return feedback;
}

async function feedbackRow(id: string): Promise<FeedbackRow> {
  const row = await db.orm.beta.Feedback.select(...FEEDBACK_FIELDS)
    .where((feedback) => feedback.id.eq(id))
    .first();
  if (!row) throw HttpError.notFound(FEEDBACK_NOT_FOUND);
  return row;
}

/**
 * Rewrites the caller's own feedback, while they are still a beta reader of
 * the story. Somebody else's is a 404: its existence is private too.
 */
export async function updateFeedback(
  userId: string,
  id: string,
  body: string,
): Promise<BetaFeedback> {
  const row = await feedbackRow(id);
  if (row.userId !== userId || !(await isReader(row.storyId, userId))) {
    throw HttpError.notFound(FEEDBACK_NOT_FOUND);
  }
  await assertNotSuspended(userId);

  await db.orm.beta.Feedback.where((feedback) => feedback.id.eq(id)).update({
    body: normaliseBody(body),
    updatedAt: Temporal.Now.instant(),
  });

  const [feedback] = await hydrateFeedback([await feedbackRow(id)], userId);
  if (!feedback) throw HttpError.notFound(FEEDBACK_NOT_FOUND);
  return feedback;
}

/** Deletes feedback: its writer's to delete, and the story author's. */
export async function deleteFeedback(userId: string, id: string): Promise<void> {
  const row = await feedbackRow(id);

  if (row.userId !== userId) {
    const story = await db.orm.content.Story.select("authorId")
      .where((story) => story.id.eq(row.storyId))
      .first();
    if (story?.authorId !== userId) throw HttpError.notFound(FEEDBACK_NOT_FOUND);
  }

  await db.orm.beta.Feedback.where((feedback) => feedback.id.eq(id)).delete();
}
