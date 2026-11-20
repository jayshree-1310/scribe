/**
 * Highlights and margin notes: passages a reader marked, with an optional
 * private note, and the anonymous count an author sees of which passages were
 * marked most.
 *
 * **Offsets in, text stored.** A highlight is made the way "Explain this
 * passage" is asked: the client sends a chapter id and a `[start, end)` pair
 * into the stored chapter (`lib/chapter-selection.ts` in the web app maps the
 * reader's selection there), and the server cuts the quote out of the chapter
 * itself. So `quote` is always the author's words, never text a request
 * supplied.
 *
 * **Re-anchored on every read.** Authors edit chapters that readers have
 * highlighted. Each read looks for `quote` at the stored offsets, then at the
 * occurrence nearest them, and reports the highlight as gone when the passage
 * is no longer in the chapter at all. Nothing is rewritten or deleted when
 * that happens: the note is the reader's own writing, so it stays listed (as
 * "no longer in the chapter") until they delete it, and an author who puts the
 * passage back brings the highlight back with it.
 *
 * **Private.** A note is read by its writer and nobody else; there is no route
 * that returns another reader's. The author's view (`highlightSummary`) is
 * counts of distinct readers per paragraph -- never who, never a note, and
 * never the author's own highlights, which would only count them twice.
 *
 * Every function takes the reader's id explicitly, as `services/library.ts`
 * does, so a highlight can never be read or written for the wrong user.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import {
  findVisibleChapterIds,
  findVisibleChapterText,
  findVisibleStoryId,
  toIso,
} from "./stories.js";

/** Longest passage one highlight may cover, in characters of source text. */
export const HIGHLIGHT_LIMIT = 2000;

/** Longest private note. */
export const NOTE_LIMIT = 1000;

/**
 * Most highlights one reader may keep in one chapter. Far past anything a
 * person does by hand; it is here so a script cannot fill the table.
 */
export const HIGHLIGHTS_PER_CHAPTER = 200;

/** Most passages the author's view lists. */
const SUMMARY_PASSAGES = 10;

/**
 * Most highlight rows the author's view reads per story, newest first. The
 * re-anchoring needs the rows, not counts, so this bounds the work on a story
 * with an enormous readership; past it the view describes recent highlighting.
 */
const SUMMARY_ROW_CAP = 20_000;

const NOT_FOUND = "That highlight could not be found.";
const CHAPTER_NOT_FOUND = "That chapter could not be found.";

export interface Highlight {
  id: string;
  storyId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  /** Where the passage sits in the chapter's current text. */
  start: number;
  end: number;
  quote: string;
  note: string | null;
  /**
   * False when the author has since removed the passage. `start`/`end` are
   * then the stored offsets and mean nothing; the reader is shown the quote
   * and the note and offered a delete.
   */
  found: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HighlightedPassage {
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  /** The span readers in this paragraph marked most often, markers removed. */
  quote: string;
  /** Distinct readers who highlighted anything in the paragraph. */
  readers: number;
}

export interface HighlightSummary {
  /** Distinct readers with at least one highlight in the story. */
  readers: number;
  /** Highlights across the story, including any whose passage is gone. */
  highlights: number;
  passages: HighlightedPassage[];
}

/* Anchoring -------------------------------------------------------------- */

/**
 * Where `quote` sits in `content` now: at `start` if it is still there, else
 * the occurrence nearest `start`, else null.
 *
 * Exact text, deliberately. A fuzzier match would survive more edits, and in
 * exchange it would sometimes paint a reader's note over a sentence the author
 * rewrote to mean something else -- a worse failure than "this passage has
 * changed", which at least tells the truth.
 */
export function anchor(
  content: string,
  quote: string,
  start: number,
): { start: number; end: number } | null {
  if (quote.length === 0) return null;
  if (content.startsWith(quote, start)) {
    return { start, end: start + quote.length };
  }

  let best: number | null = null;
  let index = content.indexOf(quote);
  while (index !== -1) {
    if (best === null || Math.abs(index - start) < Math.abs(best - start)) {
      best = index;
    }
    index = content.indexOf(quote, index + 1);
  }

  return best === null ? null : { start: best, end: best + quote.length };
}

/**
 * The quote as a reader sees it: emphasis markers out, whitespace collapsed.
 * For the author's view, which shows passages as text rather than painting
 * them over the chapter.
 */
function plain(quote: string): string {
  return quote.replace(/[*_]/g, "").replace(/\s+/g, " ").trim();
}

/** Where the line holding `offset` begins -- a paragraph, as the renderer draws one. */
function lineStart(content: string, offset: number): number {
  return content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/* Reader ----------------------------------------------------------------- */

interface HighlightRow {
  id: string;
  storyId: string;
  chapterId: string;
  start: number;
  end: number;
  quote: string;
  note: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

const ROW_FIELDS = [
  "id",
  "storyId",
  "chapterId",
  "start",
  "end",
  "quote",
  "note",
  "createdAt",
  "updatedAt",
] as const;

/** Rows with their chapter and their current place in it. */
async function hydrate(rows: HighlightRow[]): Promise<Highlight[]> {
  const chapterIds = [...new Set(rows.map((row) => row.chapterId))];
  if (chapterIds.length === 0) return [];

  const chapters = await db.orm.content.Chapter.select(
    "id",
    "chapterNumber",
    "title",
    "content",
  )
    .where((chapter) => chapter.id.in(chapterIds))
    .all();
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));

  return rows
    .flatMap((row) => {
      const chapter = byId.get(row.chapterId);
      if (!chapter) return [];

      const placed = anchor(chapter.content, row.quote, row.start);
      return [
        {
          id: row.id,
          storyId: row.storyId,
          chapterId: row.chapterId,
          chapterNumber: chapter.chapterNumber,
          chapterTitle: chapter.title,
          start: placed?.start ?? row.start,
          end: placed?.end ?? row.end,
          quote: row.quote,
          note: row.note,
          found: placed !== null,
          createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
          updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
        },
      ];
    })
    .sort(
      (a, b) =>
        a.chapterNumber - b.chapterNumber ||
        a.start - b.start ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

/**
 * The reader's highlights in one story, in reading order.
 *
 * Only in chapters they may read *now*: a chapter the author unpublished, or a
 * moderator took down, drops out of the list the way it drops out of the
 * story, and comes back if it does.
 */
export async function listHighlights(
  userId: string,
  storySlugOrId: string,
): Promise<Highlight[]> {
  const storyId = await findVisibleStoryId(storySlugOrId, userId);
  if (storyId === null) throw HttpError.notFound("That story could not be found.");

  const rows = await db.orm.engagement.Highlight.select(...ROW_FIELDS)
    .where((row) => row.userId.eq(userId))
    .where((row) => row.storyId.eq(storyId))
    .all();

  const visible = await findVisibleChapterIds(
    [...new Set(rows.map((row) => row.chapterId))],
    userId,
  );

  return hydrate(rows.filter((row) => visible.has(row.chapterId)));
}

export interface HighlightInput {
  chapterId: string;
  start: number;
  end: number;
  note?: string | null | undefined;
}

/** Trimmed, and null when nothing is left -- an empty note is no note. */
function normaliseNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > NOTE_LIMIT) {
    throw HttpError.badRequest(`Keep the note under ${NOTE_LIMIT} characters.`);
  }
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Highlights a passage of a chapter the reader may read.
 *
 * Highlighting the same span twice returns the highlight already there rather
 * than stacking a second one on it; a double tap is not two highlights. Not
 * gated on suspension: it is reading state that nobody else sees, like a
 * shelf (see `routes/suspension.test.ts`).
 */
export async function createHighlight(
  userId: string,
  input: HighlightInput,
): Promise<Highlight> {
  const chapter = await findVisibleChapterText(input.chapterId, userId);
  if (chapter === null) throw HttpError.notFound(CHAPTER_NOT_FOUND);

  if (input.start < 0 || input.end <= input.start || input.end > chapter.content.length) {
    throw HttpError.badRequest("That passage is not in this chapter.");
  }
  if (input.end - input.start > HIGHLIGHT_LIMIT) {
    throw HttpError.badRequest("That passage is too long to highlight.");
  }

  const quote = chapter.content.slice(input.start, input.end);
  if (quote.trim().length === 0) {
    throw HttpError.badRequest("That passage is not in this chapter.");
  }
  const note = normaliseNote(input.note);

  const mine = db.orm.engagement.Highlight.where((row) => row.userId.eq(userId)).where(
    (row) => row.chapterId.eq(chapter.id),
  );

  const existing = await mine
    .select("id")
    .where((row) => row.start.eq(input.start))
    .where((row) => row.end.eq(input.end))
    .first();
  if (existing) {
    if (note !== null) return updateHighlight(userId, existing.id, note);
    return getHighlight(userId, existing.id);
  }

  const { total } = await mine.aggregate((aggregate) => ({ total: aggregate.count() }));
  if (total >= HIGHLIGHTS_PER_CHAPTER) {
    throw HttpError.conflict(
      "You have highlighted as much of this chapter as Scribe keeps. Remove one to add another.",
    );
  }

  const created = await db.orm.engagement.Highlight.create({
    userId,
    storyId: chapter.storyId,
    chapterId: chapter.id,
    start: input.start,
    end: input.end,
    quote,
    note,
  });

  return getHighlight(userId, created.id);
}

async function ownRow(userId: string, id: string): Promise<HighlightRow> {
  const row = await db.orm.engagement.Highlight.select(...ROW_FIELDS)
    .where((highlight) => highlight.id.eq(id))
    .where((highlight) => highlight.userId.eq(userId))
    .first();

  // Somebody else's highlight is a 404, not a 403: its existence is private too.
  if (!row) throw HttpError.notFound(NOT_FOUND);
  return row;
}

async function getHighlight(userId: string, id: string): Promise<Highlight> {
  const [highlight] = await hydrate([await ownRow(userId, id)]);
  if (!highlight) throw HttpError.notFound(NOT_FOUND);
  return highlight;
}

/** Sets or clears the note. The passage itself cannot be moved; make another. */
export async function updateHighlight(
  userId: string,
  id: string,
  note: string | null,
): Promise<Highlight> {
  await ownRow(userId, id);

  await db.orm.engagement.Highlight.where((row) => row.id.eq(id)).update({
    note: normaliseNote(note),
    updatedAt: Temporal.Now.instant(),
  });

  return getHighlight(userId, id);
}

export async function deleteHighlight(userId: string, id: string): Promise<void> {
  await ownRow(userId, id);
  await db.orm.engagement.Highlight.where((row) => row.id.eq(id)).delete();
}

/* Author ----------------------------------------------------------------- */

/**
 * Which passages of a story readers highlight most, for its author.
 *
 * Grouped by paragraph rather than by exact span: two readers who marked
 * "the lamp went cold" and "the lamp went cold, and she knew" were struck by
 * the same line, and counting them apart would rank neither. Each paragraph
 * counts distinct readers and is shown by the span marked most often in it.
 * Highlights whose passage the author has since removed are left out -- there
 * is nothing left to point at.
 *
 * The caller checks that `authorId` wrote `storyId`; see `getStoryAnalytics`.
 */
export async function highlightSummary(
  storyId: string,
  authorId: string,
): Promise<HighlightSummary> {
  const totalsPlan = db.raw.sql`
    SELECT COUNT(*)::int                AS "highlights",
           COUNT(DISTINCT "userId")::int AS "readers"
      FROM "engagement"."highlight"
     WHERE "storyId" = ${storyId} AND "userId" <> ${authorId}
  `.returnsRow({ highlights: "pg/int4@1", readers: "pg/int4@1" }).build();

  const [totals, rows] = await Promise.all([
    db.runtime().query(totalsPlan).then(
      (result) => result as unknown as Array<{ highlights: number; readers: number }>,
    ),
    db.orm.engagement.Highlight.select("userId", "chapterId", "start", "quote")
      .where((row) => row.storyId.eq(storyId))
      .where((row) => row.userId.neq(authorId))
      .orderBy((row) => row.createdAt.desc())
      .limit(SUMMARY_ROW_CAP)
      .all(),
  ]);

  const summary = {
    readers: totals[0]?.readers ?? 0,
    highlights: totals[0]?.highlights ?? 0,
  };
  if (rows.length === 0) return { ...summary, passages: [] };

  const chapterIds = [...new Set(rows.map((row) => row.chapterId))];
  const chapters = await db.orm.content.Chapter.select(
    "id",
    "chapterNumber",
    "title",
    "content",
  )
    .where((chapter) => chapter.id.in(chapterIds))
    .all();
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));

  interface Paragraph {
    chapterId: string;
    offset: number;
    readers: Set<string>;
    spans: Map<string, Set<string>>;
  }
  const paragraphs = new Map<string, Paragraph>();

  for (const row of rows) {
    const chapter = byId.get(row.chapterId);
    if (!chapter) continue;
    const placed = anchor(chapter.content, row.quote, row.start);
    if (!placed) continue;

    const offset = lineStart(chapter.content, placed.start);
    const key = `${row.chapterId}:${offset}`;
    let paragraph = paragraphs.get(key);
    if (!paragraph) {
      paragraph = { chapterId: row.chapterId, offset, readers: new Set(), spans: new Map() };
      paragraphs.set(key, paragraph);
    }

    paragraph.readers.add(row.userId);
    const span = plain(row.quote);
    const markers = paragraph.spans.get(span) ?? new Set<string>();
    markers.add(row.userId);
    paragraph.spans.set(span, markers);
  }

  const passages = [...paragraphs.values()]
    .map((paragraph) => {
      const chapter = byId.get(paragraph.chapterId)!;
      const [quote] = [...paragraph.spans.entries()].sort(
        ([aText, a], [bText, b]) => b.size - a.size || aText.length - bText.length,
      )[0]!;
      return {
        chapterId: paragraph.chapterId,
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.title,
        quote,
        readers: paragraph.readers.size,
        offset: paragraph.offset,
      };
    })
    .sort(
      (a, b) =>
        b.readers - a.readers || a.chapterNumber - b.chapterNumber || a.offset - b.offset,
    )
    .slice(0, SUMMARY_PASSAGES)
    .map(({ offset: _offset, ...passage }) => passage);

  return { ...summary, passages };
}
