/**
 * Public comments on one paragraph of a chapter.
 *
 * A paragraph thread is an ordinary `engagement.Comment` -- replies, likes,
 * reports, moderation, notifications and rate limits all come with it -- that
 * also carries `paragraphStart` and `paragraphText`: where its paragraph's
 * line began in the chapter and what the line said. This module owns the two
 * things that makes new: what counts as a paragraph, and finding one again
 * after the author has edited the chapter.
 *
 * **A paragraph is one rendered line of prose.** The web renderer
 * (`apps/web/src/lib/chapter-markdown.tsx`) draws each non-blank line of a
 * prose run as its own block -- a paragraph, a list item or a block quote --
 * and headings and attachment tokens are not prose anyone comments on. The
 * rules in `commentableParagraphs` mirror the renderer's line for line, and
 * `apps/web/src/lib/chapter-paragraphs.ts` is the client's copy; the two must
 * agree on where every paragraph starts, since that offset is what the reader
 * posts and what the counts are keyed by.
 *
 * **Anchored on the text**, as highlights are (`services/highlights.ts`),
 * because authors edit chapters after readers have commented. Every read
 * re-finds each thread's line: at its stored offset if it is still there, else
 * the identical line nearest it, else -- unlike a highlight -- the most
 * similar line, if one is similar enough. A highlight is a few exact words and
 * a near match would paint a note over a sentence that now means something
 * else; a paragraph is long enough that a typo fix should not orphan its
 * conversation, and a rewrite still falls well under the bar. A thread whose
 * paragraph is gone is kept, and shown again if the paragraph comes back.
 */

import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { findVisibleChapterText } from "./stories.js";

const CHAPTER_NOT_FOUND = "That chapter could not be found.";

/* Paragraphs ------------------------------------------------------------- */

export interface Paragraph {
  /** Where the line begins in `chapter.content`. */
  start: number;
  end: number;
  /** The line as written, trailing whitespace removed. */
  text: string;
}

/** A run that is nothing but an attachment token renders as the attachment. */
const MEDIA_TOKEN = /^\[media:[\w-]+\]$/;

/**
 * Every line of the chapter a reader can comment on, in reading order.
 *
 * Runs are split on blank lines and trimmed, exactly as the web's
 * `paragraphsOf` does; a run that is only a media token is an attachment;
 * within a run each non-blank line is a block, and the two heading prefixes
 * the renderer knows (`# `, `## `) are left out.
 */
export function commentableParagraphs(content: string): Paragraph[] {
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = 0;
  for (const separator of content.matchAll(/\n{2,}/g)) {
    runs.push({ start: runStart, end: separator.index });
    runStart = separator.index + separator[0].length;
  }
  runs.push({ start: runStart, end: content.length });

  const paragraphs: Paragraph[] = [];
  for (const run of runs) {
    const raw = content.slice(run.start, run.end);
    const trimmed = raw.trim();
    if (trimmed.length === 0 || MEDIA_TOKEN.test(trimmed)) continue;

    let offset = run.start + (raw.length - raw.trimStart().length);
    for (const rawLine of trimmed.split("\n")) {
      const line = rawLine.trimEnd();
      const heading = line.startsWith("# ") || line.startsWith("## ");
      if (line.trim().length > 0 && !heading) {
        paragraphs.push({ start: offset, end: offset + line.length, text: line });
      }
      offset += rawLine.length + 1;
    }
  }
  return paragraphs;
}

/* Anchoring -------------------------------------------------------------- */

/** Below this many words a line is too short to match on anything but itself. */
const FUZZY_MIN_WORDS = 5;

/** How alike two lines' words must be for one to stand in for the other. */
const FUZZY_THRESHOLD = 0.6;

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/** The Dice coefficient of two lines' words, counted with repeats. */
function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);

  let shared = 0;
  for (const word of b) {
    const left = counts.get(word) ?? 0;
    if (left > 0) {
      shared += 1;
      counts.set(word, left - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * Where a thread's paragraph is now, as the start of a current paragraph, or
 * null when no paragraph in the chapter is it any more.
 */
export function anchorParagraph(
  paragraphs: readonly Paragraph[],
  text: string,
  start: number,
): number | null {
  const atStart = paragraphs.find((paragraph) => paragraph.start === start);
  if (atStart && atStart.text === text) return atStart.start;

  const nearest = (candidates: readonly Paragraph[]): Paragraph | undefined =>
    candidates.reduce<Paragraph | undefined>(
      (best, paragraph) =>
        best === undefined ||
        Math.abs(paragraph.start - start) < Math.abs(best.start - start)
          ? paragraph
          : best,
      undefined,
    );

  const exact = nearest(paragraphs.filter((paragraph) => paragraph.text === text));
  if (exact) return exact.start;

  const words = wordsOf(text);
  if (words.length < FUZZY_MIN_WORDS) return null;

  let bestScore = FUZZY_THRESHOLD;
  let best: Paragraph[] = [];
  for (const paragraph of paragraphs) {
    const candidate = wordsOf(paragraph.text);
    if (candidate.length < FUZZY_MIN_WORDS) continue;
    const score = similarity(words, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = [paragraph];
    } else if (score === bestScore && best.length > 0) {
      best.push(paragraph);
    }
  }
  return nearest(best)?.start ?? null;
}

/* Reads ------------------------------------------------------------------ */

interface ThreadRow {
  id: string;
  paragraphStart: number | null;
  paragraphText: string | null;
}

/**
 * The chapter's visible paragraph threads, each with where its paragraph is
 * now (null when it is gone). One anchoring pass per distinct stored line,
 * since a busy paragraph has many threads and they all stored the same one.
 */
async function anchoredThreads(
  chapterId: string,
  content: string,
): Promise<Map<string, number | null>> {
  const rows: ThreadRow[] = await db.orm.engagement.Comment.select(
    "id",
    "paragraphStart",
    "paragraphText",
  )
    .where((row) => row.chapterId.eq(chapterId))
    .where((row) => row.parentId.isNull())
    .where((row) => row.paragraphStart.isNotNull())
    // Hidden by a moderator is gone, as everywhere else comments are read.
    .where((row) => row.hiddenAt.isNull())
    .all();

  const paragraphs = commentableParagraphs(content);
  const memo = new Map<string, number | null>();
  const anchored = new Map<string, number | null>();

  for (const row of rows) {
    if (row.paragraphStart === null || row.paragraphText === null) continue;
    const key = `${row.paragraphStart}\u0000${row.paragraphText}`;
    if (!memo.has(key)) {
      memo.set(key, anchorParagraph(paragraphs, row.paragraphText, row.paragraphStart));
    }
    anchored.set(row.id, memo.get(key) ?? null);
  }
  return anchored;
}

/** The chapter's text, if the caller may read it, or a 404. */
async function readableContent(
  chapterId: string,
  viewerId: string | null,
): Promise<string> {
  const chapter = await findVisibleChapterText(chapterId, viewerId);
  if (!chapter) throw HttpError.notFound(CHAPTER_NOT_FOUND);
  return chapter.content;
}

/**
 * The paragraph threads on the paragraph that now starts at `start`, for the
 * comment list to page through. Empty when there are none.
 */
export async function threadIdsOnParagraph(
  chapterId: string,
  viewerId: string | null,
  start: number,
): Promise<string[]> {
  const content = await readableContent(chapterId, viewerId);
  const anchored = await anchoredThreads(chapterId, content);
  return [...anchored].flatMap(([id, at]) => (at === start ? [id] : []));
}

/** The paragraph a new thread is being posted on, or null when none starts there. */
export async function paragraphForPost(
  chapterId: string,
  viewerId: string,
  start: number,
): Promise<Paragraph | null> {
  const content = await readableContent(chapterId, viewerId);
  return commentableParagraphs(content).find((paragraph) => paragraph.start === start) ?? null;
}

export interface ParagraphCount {
  /** The paragraph's start in the chapter as it is now. */
  start: number;
  /** Visible comments on it: threads and their visible replies. */
  count: number;
}

export interface ParagraphCommentSummary {
  /** Only paragraphs with at least one comment, in reading order. */
  paragraphs: ParagraphCount[];
  /**
   * Where the comment named by `focus` sits now -- a thread, or a reply's
   * thread -- so a link to it can open its paragraph. Null when none was
   * asked for, or it is not a paragraph comment shown in this chapter.
   */
  focus: number | null;
}

/**
 * How many comments each paragraph of a chapter has, which is what the reader
 * draws its paragraph markers from. Counts only: the threads themselves are
 * listed one paragraph at a time, when a reader opens one.
 */
export async function paragraphCommentSummary(
  chapterId: string,
  viewerId: string | null,
  focusCommentId?: string,
): Promise<ParagraphCommentSummary> {
  const content = await readableContent(chapterId, viewerId);
  const anchored = await anchoredThreads(chapterId, content);

  const threadIds = [...anchored.keys()];
  const replies = new Map<string, number>();
  if (threadIds.length > 0) {
    const grouped = await db.orm.engagement.Comment.where((row) =>
      row.parentId.in(threadIds),
    )
      .where((row) => row.hiddenAt.isNull())
      .groupBy("parentId")
      .aggregate((aggregate) => ({ total: aggregate.count() }));
    for (const group of grouped) {
      if (group.parentId !== null) replies.set(group.parentId, group.total);
    }
  }

  const counts = new Map<number, number>();
  for (const [id, start] of anchored) {
    if (start === null) continue;
    counts.set(start, (counts.get(start) ?? 0) + 1 + (replies.get(id) ?? 0));
  }

  let focus: number | null = null;
  if (focusCommentId !== undefined) {
    focus = anchored.get(focusCommentId) ?? null;
    if (focus === null && !anchored.has(focusCommentId)) {
      const reply = await db.orm.engagement.Comment.select("parentId")
        .where((row) => row.id.eq(focusCommentId))
        .where((row) => row.hiddenAt.isNull())
        .first();
      if (reply?.parentId) focus = anchored.get(reply.parentId) ?? null;
    }
  }

  return {
    paragraphs: [...counts]
      .map(([start, count]) => ({ start, count }))
      .sort((a, b) => a.start - b.start),
    focus,
  };
}
