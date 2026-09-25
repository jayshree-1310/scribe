/**
 * "Previously in this story": a short recap of the chapter before this one.
 *
 * Scribe is a serial. An author publishes chapter eleven, then chapter twelve
 * a fortnight later, and the reader who arrives for twelve last read eleven
 * two weeks ago -- which is long enough to have lost the name of whoever
 * knocked on the last page. That gap is the entire feature. It is also why the
 * recap describes the **previous** chapter rather than the story so far: the
 * thing the reader has forgotten is the one they are continuing from, and a
 * synopsis of everything would spoil a first-time reader and bore a returning
 * one.
 *
 * Two design decisions worth stating, because both look like shortcuts and
 * neither is:
 *
 * - **It is generated lazily, by the first reader who asks.** There is no job
 *   runner in this repo (Task AI 20), and the alternative -- generating on
 *   publish -- would spend tens of seconds of CPU on every chapter, including
 *   the ones nobody ever asks to be caught up on. So the first reader to press
 *   the button pays for it and everybody after them gets a cache hit. What
 *   makes that acceptable is that it is a *button*, not an automatic panel: a
 *   reader binge-reading straight through never triggers a model call at all.
 *
 * - **The content hash, not a timestamp, decides staleness.** `updatedAt` on a
 *   chapter moves when an author fixes a typo, retitles it, or saves without
 *   changing a word; none of those is worth tens of seconds of regeneration,
 *   and a recap written from the same prose is the same recap. Hashing the
 *   body means an edit that could change the summary invalidates it and an
 *   edit that could not does not -- and, importantly, the invalidation needs
 *   no cooperation from the editing code. `services/authoring.ts` does not
 *   know this feature exists, and must not have to.
 *
 * The recap is always labelled as machine-written where it is shown. It is a
 * paraphrase of somebody's fiction by a model that has read one chapter of it.
 */

import { createHash } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { HttpError } from "../../lib/http-error.js";
import { db } from "../../prisma/db.js";
import { findPreviousVisibleChapter } from "../stories.js";
import { RECAP_PROMPT_VERSION, RECAP_SYSTEM_PROMPT, recapMessage } from "./prompts/recap.js";
import { aiProvider } from "./provider.js";

/** Keyed on in every usage record this feature produces. */
const FEATURE = "recap.chapter";

/**
 * Two or three sentences, so the cap is generous rather than tight: a model
 * that runs long gets cut off mid-sentence, which reads worse than a recap one
 * sentence over. The prompt does the shaping; this only stops a runaway.
 */
const MAX_TOKENS = 400;

/**
 * How much of a chapter reaches the model.
 *
 * In characters, like the assistant's budgets and for the same reason -- there
 * is no tokeniser here. Roughly 6000 tokens at four characters to a token,
 * which is a long chapter and still inside the context window of the small
 * local models this is built against.
 *
 * A chapter longer than this is summarised from its opening. That is a real
 * limitation and it is the honest one to accept here: the alternative is
 * map-reduce over a chapter's sections, which is worth building when there are
 * chapters that need it, and is a different task. The `truncated` flag on the
 * result records when it happened rather than hiding it.
 */
export const CHAPTER_LIMIT = 24000;

export interface ChapterRecap {
  /** The chapter being recapped -- the one *before* the one being read. */
  chapterNumber: number;
  chapterTitle: string;
  /** Generated. Labelled as such wherever it is rendered. */
  text: string;
  generatedAt: string | null;
  /** True when the chapter was longer than `CHAPTER_LIMIT` and was cut. */
  truncated: boolean;
}

/**
 * What a reader is told when there is nothing to show.
 *
 * `available: false` is not an error: the first chapter of a story has no
 * previous chapter, and neither does the first *visible* chapter for a reader
 * looking at a story whose early chapters are unpublished drafts. The reader
 * sees no card at all, which is correct.
 */
export interface RecapStatus {
  available: boolean;
  /** Null until somebody has generated it. */
  recap: ChapterRecap | null;
}

/**
 * A generation attempt, plus what it cost.
 *
 * `tokensUsed` is zero on a cache hit, which is the number the route wants:
 * it charges the caller's daily budget with it, and a reader who was served
 * from the table spent nothing and is charged nothing. Returning it rather
 * than charging in here keeps the service free of the request's concerns --
 * the same split every other feature in this directory uses.
 */
export interface RecapGeneration extends RecapStatus {
  tokensUsed: number;
}

/* Staleness -------------------------------------------------------------- */

/**
 * The identity of a chapter body, for cache purposes.
 *
 * SHA-256 of the exact text sent to the model -- which is the truncated text,
 * not the full body. That matters: if the limit above ever changes, every
 * recap written under the old one hashes differently and regenerates, rather
 * than a longer chapter keeping a summary of its first two-thirds forever.
 */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The text that actually reaches the model, and whether it was cut. */
function toPrompt(content: string): { text: string; truncated: boolean } {
  if (content.length <= CHAPTER_LIMIT) {
    return { text: content, truncated: false };
  }
  return { text: content.slice(0, CHAPTER_LIMIT), truncated: true };
}

/* Reading ---------------------------------------------------------------- */

/**
 * The chapter a recap is *about*: the one before the one being read, as this
 * particular caller sees the story.
 *
 * Resolved through `stories.ts` rather than by querying chapters here, because
 * "which chapter comes before this one, for this viewer" already has an answer
 * there and it is not `number - 1` -- an unpublished chapter in the middle of
 * a story is invisible to everybody but its author. A second implementation
 * would be a second thing to get wrong, and the way it would be wrong is by
 * recapping a draft to a stranger.
 */
const subjectChapter = findPreviousVisibleChapter;

/** The stored row for a chapter, if it is still current. */
async function storedRecap(
  chapterId: string,
  hash: string,
): Promise<{ text: string; updatedAt: unknown } | null> {
  const row = await db.orm.ai.ChapterSummary.select(
    "text",
    "contentHash",
    "updatedAt",
  )
    .where((summary) => summary.chapterId.eq(chapterId))
    .first();

  if (!row) return null;
  // A stale row is treated as absent rather than shown with a caveat. It
  // describes prose that is no longer there.
  if (row.contentHash !== hash) return null;

  return { text: row.text, updatedAt: row.updatedAt };
}

/**
 * What to show above chapter `chapterNumber`, without generating anything.
 *
 * Deliberately never calls a model. The reader page requests this on every
 * chapter open, and a read path that can cost thirty seconds of CPU is a read
 * path that will eventually be called from somewhere that cannot wait.
 * Generating is `generateChapterRecap`, and it is behind a button.
 */
export async function getChapterRecap(
  slugOrId: string,
  chapterNumber: number,
  viewerId: string | null,
): Promise<RecapStatus> {
  const previous = await subjectChapter(slugOrId, chapterNumber, viewerId);
  if (!previous) return { available: false, recap: null };

  const { text, truncated } = toPrompt(previous.content);
  const stored = await storedRecap(previous.id, contentHash(text));

  if (!stored) return { available: true, recap: null };

  return {
    available: true,
    recap: {
      chapterNumber: previous.number,
      chapterTitle: previous.title,
      text: stored.text,
      generatedAt: toIsoInstant(stored.updatedAt),
      truncated,
    },
  };
}

/** Matches `toIso` in `stories.ts`; duplicated rather than widening that API. */
function toIsoInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Temporal.Instant) return value.toString();
  return String(value);
}

/* Writing ---------------------------------------------------------------- */

/**
 * Stores a freshly written recap, tolerating a second writer.
 *
 * Two readers can open a cold chapter at the same moment and both generate.
 * The unique index on `chapterId` is the arbiter, and the loser simply
 * overwrites: both wrote a recap of identical text with the same prompt, so
 * neither result is better and there is nothing to reconcile. What must not
 * happen is a 500 for the second reader, who has a perfectly good recap in
 * hand.
 */
async function store(
  chapterId: string,
  text: string,
  hash: string,
  model: string,
): Promise<void> {
  const timestamp = Temporal.Now.instant();

  const existing = await db.orm.ai.ChapterSummary.select("id")
    .where((summary) => summary.chapterId.eq(chapterId))
    .first();

  if (existing) {
    await db.orm.ai.ChapterSummary.where((summary) =>
      summary.id.eq(existing.id),
    ).update({
      text,
      contentHash: hash,
      model,
      promptVersion: RECAP_PROMPT_VERSION,
      updatedAt: timestamp,
    });
    return;
  }

  try {
    await db.orm.ai.ChapterSummary.create({
      chapterId,
      text,
      contentHash: hash,
      model,
      promptVersion: RECAP_PROMPT_VERSION,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // Somebody got there between the select and the insert. Theirs is as good
    // as ours; leave it.
  }
}

/** Postgres reports a unique-constraint breach as SQLSTATE 23505. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as {
    code?: unknown;
    sqlState?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505" || candidate.sqlState === "23505") return true;

  return candidate.cause !== undefined && isUniqueViolation(candidate.cause);
}

/**
 * Writes the recap for the chapter before `chapterNumber`, or returns the
 * stored one when it is still current.
 *
 * The cache check happens here as well as in `getChapterRecap` rather than
 * only in the route, because this is the function that spends money and the
 * check that stops it spending money belongs beside it. A caller who presses
 * the button twice makes one model call.
 */
export async function generateChapterRecap(
  slugOrId: string,
  chapterNumber: number,
  viewerId: string | null,
  signal?: AbortSignal,
): Promise<RecapGeneration> {
  const previous = await subjectChapter(slugOrId, chapterNumber, viewerId);
  if (!previous) return { available: false, recap: null, tokensUsed: 0 };

  const { text: source, truncated } = toPrompt(previous.content);
  const hash = contentHash(source);

  const stored = await storedRecap(previous.id, hash);
  if (stored) {
    return {
      available: true,
      tokensUsed: 0,
      recap: {
        chapterNumber: previous.number,
        chapterTitle: previous.title,
        text: stored.text,
        generatedAt: toIsoInstant(stored.updatedAt),
        truncated,
      },
    };
  }

  const completion = await aiProvider().complete({
    feature: FEATURE,
    system: RECAP_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: recapMessage(previous.title, source) },
    ],
    maxTokens: MAX_TOKENS,
    ...(signal ? { signal } : {}),
  });

  const recapText = completion.text.trim();

  /**
   * An empty reply is not stored. Caching it would mean one bad call left a
   * chapter permanently blank -- the hash would match forever and nothing
   * would ever try again.
   */
  if (recapText.length === 0) {
    throw HttpError.upstream("The recap came back empty. Please try again.");
  }

  await store(previous.id, recapText, hash, completion.usage.model);

  return {
    available: true,
    tokensUsed: completion.usage.inputTokens + completion.usage.outputTokens,
    recap: {
      chapterNumber: previous.number,
      chapterTitle: previous.title,
      text: recapText,
      generatedAt: toIsoInstant(Temporal.Now.instant()),
      truncated,
    },
  };
}

/** Exported for the route's usage accounting; see `recordTokenUsage`. */
export { FEATURE as RECAP_FEATURE };
