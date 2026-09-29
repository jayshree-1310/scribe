/**
 * Splitting a chapter into the pieces that get embedded.
 *
 * A chapter is the natural unit of this corpus and the wrong unit for
 * retrieval, in both directions. It is too long: one vector for four thousand
 * words is an average of everything that happens in them, and an average is
 * close to nothing in particular, so a search for the scene where the lamp
 * goes out matches the chapter about as well as every other chapter. And it is
 * too coarse to answer with: a reader asking a question wants the passage, not
 * a pointer to eleven pages.
 *
 * So chapters are split into overlapping windows of a few paragraphs, and the
 * window is what carries a vector.
 *
 * **This lives in its own file because it is a pure function, and the only
 * part of Task AI 7 that can be tested without a database or a model.** The
 * numbers below are the entire tuning surface of retrieval quality; they
 * deserve a test that reads like a specification rather than being buried in
 * the service that calls them.
 *
 * ## The numbers, and why
 *
 * - **Paragraph boundaries, never a fixed character stride.** A paragraph is
 *   the smallest unit of this material that means something on its own;
 *   cutting mid-sentence produces vectors for half-thoughts, which retrieve
 *   badly and read worse when quoted back to somebody. See `paragraphsOf`
 *   below for why the split is not quite the one the reader page uses.
 * - **~1200 characters a window** (`CHUNK_TARGET_CHARS`), which is roughly 300
 *   tokens: two or three paragraphs of prose. Small enough that the vector is
 *   about one thing, large enough that the one thing has context. Well inside
 *   `nomic-embed-text`'s window, so the size is a retrieval-quality choice
 *   rather than a limit imposed by the model.
 * - **~250 characters of overlap** (`CHUNK_OVERLAP_CHARS`). Without it, a
 *   moment that straddles a window boundary is half in each and whole in
 *   neither, and the query that describes it matches neither well. Overlap is
 *   duplicated storage bought to stop boundaries falling exactly where the
 *   interesting sentence is.
 * - **A paragraph longer than `CHUNK_MAX_CHARS` is split on sentence
 *   boundaries**, because some authors write a page without a blank line and a
 *   window has to be bounded regardless.
 *
 * The function is deterministic: the same text always produces the same
 * chunks, with the same hashes, in the same order. That is what makes
 * re-embedding unchanged prose a no-op rather than a coin toss.
 */

import { createHash } from "node:crypto";

/** The size a window is packed up to, in characters. */
export const CHUNK_TARGET_CHARS = 1200;

/**
 * The longest a single indivisible unit may be before it is split by sentence.
 *
 * Above the target rather than equal to it so that an ordinary long paragraph
 * stays whole -- splitting one at exactly the target would cut a great many
 * paragraphs for no gain.
 */
export const CHUNK_MAX_CHARS = 2000;

/** How much of the previous window is repeated at the start of the next. */
export const CHUNK_OVERLAP_CHARS = 250;

/**
 * The bound a chunk is guaranteed to respect.
 *
 * Not `CHUNK_TARGET_CHARS`: a window opens with its overlap and then always
 * takes at least one unit, so an oversized unit following an overlap produces
 * the worst case. Stated as a constant because the test asserts on it and a
 * bound nobody can name is a bound nobody checks.
 */
export const CHUNK_HARD_MAX_CHARS = CHUNK_MAX_CHARS + CHUNK_OVERLAP_CHARS;

export interface Chunk {
  /** Position within the chapter, from 0. Windows are contiguous and ordered. */
  ordinal: number;
  text: string;
  /** SHA-256 of `text`: the identity an embedding is cached against. */
  hash: string;
}

/**
 * Paragraphs, split on **any** run of newlines.
 *
 * `paragraphsOf` in `apps/web/src/types/stories.ts` splits on `\n{2,}` --
 * blank lines -- and this deliberately does not, because the corpus disagrees
 * with it. `seed:stories` joins its paragraphs with a blank line, but chapters
 * written through the editor separate them with a single newline, and in the
 * seeded serial that is most of them: one chapter of nine thousand characters
 * contains 459 newlines and not one blank line, because every line of dialogue
 * is its own paragraph.
 *
 * Splitting on blank lines only would therefore treat those chapters as one
 * enormous paragraph and fall through to `sentencePieces`, which cuts at two
 * thousand characters wherever that lands. Measured on the seeded corpus that
 * was 66 of 161 windows chopped at exactly the limit rather than at a
 * boundary -- which is the difference between a passage you can quote back to
 * a reader and a fragment starting mid-scene.
 *
 * A single newline is a paragraph break in this data. Treating it as one is
 * strictly better for chunking, and costs nothing elsewhere: nothing here
 * renders prose. (The reader page splitting the other way is why those
 * chapters display as one block -- a rendering bug, and not this file's to
 * fix.)
 */
function paragraphsOf(content: string): string[] {
  return content
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Sentence-sized pieces of an over-long paragraph, each within `CHUNK_MAX_CHARS`.
 *
 * The split is after `.`, `!`, `?` or a closing quote following one, then
 * whitespace. Deliberately naive: it mis-splits "Mrs. Dalloway", and the cost
 * of that is one window boundary in an unusual place rather than a wrong
 * answer. A real sentence tokeniser is a dependency and a behaviour change
 * across versions, for a case that only arises in paragraphs over two thousand
 * characters.
 *
 * A single "sentence" still over the limit -- no punctuation at all -- is cut
 * at the limit, because something has to be.
 */
function sentencePieces(paragraph: string): string[] {
  const sentences = paragraph.split(/(?<=[.!?]["'”’]?)\s+/);
  const pieces: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.length > 0) pieces.push(current);
    current = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > CHUNK_MAX_CHARS) {
      flush();
      for (let at = 0; at < sentence.length; at += CHUNK_MAX_CHARS) {
        pieces.push(sentence.slice(at, at + CHUNK_MAX_CHARS));
      }
      continue;
    }

    const joined = current.length === 0 ? sentence : `${current} ${sentence}`;
    if (joined.length > CHUNK_MAX_CHARS) {
      flush();
      current = sentence;
    } else {
      current = joined;
    }
  }

  flush();
  return pieces;
}

/** The indivisible units a chapter is packed from, in order. */
function unitsOf(content: string): string[] {
  return paragraphsOf(content).flatMap((paragraph) =>
    paragraph.length > CHUNK_MAX_CHARS
      ? sentencePieces(paragraph)
      : [paragraph],
  );
}

/**
 * The trailing units of a closed window that open the next one.
 *
 * Never all of them: a window whose overlap was its whole content would make
 * the next window start where this one did, and the loop would not advance.
 * That is the one way this function could hang, so it is ruled out here rather
 * than guarded against later.
 */
function overlapUnits(units: string[]): string[] {
  const carried: string[] = [];
  let length = 0;

  for (let at = units.length - 1; at > 0; at -= 1) {
    const unit = units[at] as string;
    const added = length === 0 ? unit.length : length + 2 + unit.length;
    if (added > CHUNK_OVERLAP_CHARS) break;

    carried.unshift(unit);
    length = added;
  }

  return carried;
}

const hashOf = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * A chapter's body as ordered, overlapping, hashed windows.
 *
 * Empty in, empty out: a chapter with no prose has nothing to retrieve, and
 * returning a single empty chunk would put a vector for the empty string in
 * the index, which is near enough to everything.
 */
export function chunkChapter(content: string): Chunk[] {
  const units = unitsOf(content);
  if (units.length === 0) return [];

  const chunks: Chunk[] = [];

  let window: string[] = [];
  /** How many of `window`'s leading units were carried over as overlap. */
  let carried = 0;
  let length = 0;

  const emit = (): void => {
    const text = window.join("\n\n");
    chunks.push({ ordinal: chunks.length, text, hash: hashOf(text) });
  };

  for (const unit of units) {
    const added = window.length === 0 ? unit.length : length + 2 + unit.length;

    /**
     * `window.length > carried` is the condition that stops a window made
     * entirely of carried overlap from being emitted on its own -- which would
     * be a chunk duplicating the tail of the one before it, and which happens
     * whenever the overlap plus the next paragraph already exceeds the target.
     * Such a window simply takes the oversized unit and runs long instead;
     * `CHUNK_HARD_MAX_CHARS` is that case.
     */
    if (added > CHUNK_TARGET_CHARS && window.length > carried) {
      emit();
      window = overlapUnits(window);
      carried = window.length;
      length = window.reduce((total, part) => total + part.length + 2, -2);
    }

    window.push(unit);
    length = window.length === 1 ? unit.length : length + 2 + unit.length;
  }

  // The last window is emitted without carrying its overlap anywhere -- unless
  // it holds nothing but overlap, which cannot happen after the loop above but
  // is cheap to rule out rather than reason about.
  if (window.length > carried) emit();

  return chunks;
}
