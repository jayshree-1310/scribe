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
 * - **It is generated lazily, by the first reader who asks.** Generating on
 *   publish would spend a model call on every chapter, including the ones
 *   nobody ever asks to be caught up on. So the first reader to press
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
 *
 * It is also the **map** step of the story summary (`summaries.ts`, Task AI
 * 6): a story is summarised from these per-chapter summaries, never from its
 * chapter bodies. `ensureChapterSummary` is the shared entry point.
 */

import { createHash } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { HttpError } from "../../lib/http-error.js";
import { db } from "../../prisma/db.js";
import { findPreviousVisibleChapter } from "../stories.js";
import { sectionsOf } from "./bible-facts.js";
import {
  RECAP_PROMPT,
  RECAP_PROMPT_VERSION,
  RECAP_SYSTEM_PROMPT,
  recapMessage,
} from "./prompts/recap.js";
import {
  SECTION_COMBINE_PROMPT,
  SECTION_COMBINE_SYSTEM_PROMPT,
  sectionCombineMessage,
} from "./prompts/summary.js";
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
 * How much of a chapter one model call reads.
 *
 * In characters, like the assistant's budgets and for the same reason -- there
 * is no tokeniser here. Roughly 6000 tokens at four characters to a token,
 * which is a long chapter and still inside the context window of the small
 * local models this is built against.
 *
 * A chapter longer than this is **map-reduced** (Task AI 6): split at
 * paragraph boundaries into sections of at most this size, each summarised on
 * its own, and the section summaries combined into the chapter's recap. Only a
 * chapter longer than `MAX_SECTIONS` sections is still cut, and the
 * `truncated` flag says so.
 */
export const CHAPTER_LIMIT = 24000;

/** Eight sections is ~190k characters -- a novella in one chapter. */
export const MAX_SECTIONS = 8;

export interface ChapterRecap {
  /** The chapter being recapped -- the one *before* the one being read. */
  chapterNumber: number;
  chapterTitle: string;
  /** Generated. Labelled as such wherever it is rendered. */
  text: string;
  generatedAt: string | null;
  /** True when the chapter was longer than `MAX_SECTIONS` sections and was cut. */
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
 * The identity of a chapter summary's *input*, for cache purposes: the
 * chapter body, plus the versions of the prompts that read it and the section
 * size. A summary is current only while all of those are what wrote it -- so
 * an edit to the prose, a new prompt version (Task AI 17's whole recovery
 * path) or a different section size each regenerate it, and nothing else does.
 *
 * Version 1 of this hashed the body alone, so a prompt bump left old recaps
 * in place; those rows hash differently now and regenerate once.
 */
export function chapterSummaryHash(content: string): string {
  return createHash("sha256")
    .update(
      `recap@${RECAP_PROMPT_VERSION}|sections@${SECTION_COMBINE_PROMPT.version}|${CHAPTER_LIMIT}x${MAX_SECTIONS}|`,
    )
    .update(content)
    .digest("hex");
}

/** The chapter as the model will read it: one section, or several. */
function toSections(content: string): { sections: string[]; truncated: boolean } {
  if (content.length <= CHAPTER_LIMIT) return { sections: [content], truncated: false };
  return sectionsOf(content, CHAPTER_LIMIT, MAX_SECTIONS);
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

  const { truncated } = toSections(previous.content);
  const stored = await storedRecap(previous.id, chapterSummaryHash(previous.content));

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
  prompt: { id: string; version: number },
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
      promptId: prompt.id,
      promptVersion: prompt.version,
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
      promptId: prompt.id,
      promptVersion: prompt.version,
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

export interface ChapterSummary {
  /** Generated. */
  text: string;
  generatedAt: string | null;
  /** True only for a chapter longer than `MAX_SECTIONS` sections. */
  truncated: boolean;
  /** Zero when the stored summary was current and no model was asked. */
  tokensUsed: number;
  /** Model calls made: 0 on a cache hit, 1 for a short chapter, n+1 for n sections. */
  calls: number;
}

/**
 * A chapter's summary: the stored one when it is current, otherwise written
 * now -- in one call, or by map-reduce over its sections when it is long.
 *
 * The map step of the story summary and the whole of the reader's recap.
 * `force` rewrites a current summary, for an author who wants different
 * wording; nothing else does, which is the point of the hash.
 *
 * Takes the chapter rather than an id: the caller has already decided this
 * viewer may see it, and this function has no opinion about visibility.
 */
export async function ensureChapterSummary(
  chapter: { id: string; title: string; content: string },
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ChapterSummary> {
  const hash = chapterSummaryHash(chapter.content);
  const { sections, truncated } = toSections(chapter.content);

  if (!options.force) {
    const stored = await storedRecap(chapter.id, hash);
    if (stored) {
      return { text: stored.text, generatedAt: toIsoInstant(stored.updatedAt), truncated, tokensUsed: 0, calls: 0 };
    }
  }

  let tokensUsed = 0;
  let calls = 0;
  let model = "";
  const ask = async (system: string, content: string, feature: string) => {
    const completion = await aiProvider().complete({
      feature,
      system,
      messages: [{ role: "user", content }],
      maxTokens: MAX_TOKENS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    tokensUsed += completion.usage.inputTokens + completion.usage.outputTokens;
    calls += 1;
    model = completion.usage.model;
    const text = completion.text.trim();
    /**
     * An empty reply is not stored. Caching it would mean one bad call left a
     * chapter permanently blank -- the hash would match forever and nothing
     * would ever try again.
     */
    if (text.length === 0) throw HttpError.upstream("The recap came back empty. Please try again.");
    return text;
  };

  let text: string;
  if (sections.length === 1) {
    text = await ask(RECAP_SYSTEM_PROMPT, recapMessage(chapter.title, sections[0] ?? ""), FEATURE);
  } else {
    // Map: each section on its own, under the recap's rules.
    const parts: string[] = [];
    for (const [index, section] of sections.entries()) {
      parts.push(
        await ask(
          RECAP_SYSTEM_PROMPT,
          recapMessage(`${chapter.title} (part ${index + 1} of ${sections.length})`, section),
          `${FEATURE}.section`,
        ),
      );
    }
    // Reduce: the section summaries -- never the sections -- into one recap.
    text = await ask(
      SECTION_COMBINE_SYSTEM_PROMPT,
      sectionCombineMessage({ chapterTitle: chapter.title, parts }),
      `${FEATURE}.combine`,
    );
  }

  await store(
    chapter.id,
    text,
    hash,
    model,
    sections.length === 1
      ? { id: RECAP_PROMPT.id, version: RECAP_PROMPT_VERSION }
      : { id: SECTION_COMBINE_PROMPT.id, version: SECTION_COMBINE_PROMPT.version },
  );

  return { text, generatedAt: toIsoInstant(Temporal.Now.instant()), truncated, tokensUsed, calls };
}

/**
 * Writes the recap for the chapter before `chapterNumber`, or returns the
 * stored one when it is still current.
 *
 * The cache check is inside `ensureChapterSummary` rather than only in the
 * route, because that is the function that spends money and the check that
 * stops it spending money belongs beside it. A caller who presses the button
 * twice makes one model call.
 */
export async function generateChapterRecap(
  slugOrId: string,
  chapterNumber: number,
  viewerId: string | null,
  signal?: AbortSignal,
): Promise<RecapGeneration> {
  const previous = await subjectChapter(slugOrId, chapterNumber, viewerId);
  if (!previous) return { available: false, recap: null, tokensUsed: 0 };

  const summary = await ensureChapterSummary(previous, signal ? { signal } : {});

  return {
    available: true,
    tokensUsed: summary.tokensUsed,
    recap: {
      chapterNumber: previous.number,
      chapterTitle: previous.title,
      text: summary.text,
      generatedAt: summary.generatedAt,
      truncated: summary.truncated,
    },
  };
}

/** Exported for the route's usage accounting; see `recordTokenUsage`. */
export { FEATURE as RECAP_FEATURE };
