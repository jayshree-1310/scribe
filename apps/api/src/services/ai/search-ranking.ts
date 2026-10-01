/**
 * The arithmetic of hybrid search, with no database and no model in sight.
 *
 * `search.ts` does the retrieving; this file decides what the retrieved rows
 * *mean* -- which passages count, how passages become stories, and how two
 * rankings that measure different things become one. It is split out for the
 * reason `chunking.ts` is: these few functions are the whole tuning surface of
 * result quality, and they deserve tests that read like a specification
 * rather than being buried in a service that needs Postgres to run.
 */

/** One retrieved window, as the vector query returns it. */
export interface PassageHit {
  storyId: string;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  text: string;
  /** Cosine similarity to the query, 1 being identical direction. */
  similarity: number;
}

/** A story's place in the semantic ranking, with the passages that put it there. */
export interface StoryHit {
  storyId: string;
  /** The best passage's similarity; what the story is ranked by. */
  similarity: number;
  /** Best first, at most `PASSAGES_PER_STORY`, never two from one chapter. */
  passages: PassageHit[];
}

/**
 * How many passages a result carries.
 *
 * Two, because one is what a card has room to show and the second is what
 * tells a reader whether the match was a single line or a thread through the
 * book. More would be a reading list, not a search result.
 */
export const PASSAGES_PER_STORY = 2;

/**
 * Turns passage hits, nearest first, into a story ranking.
 *
 * A story is as relevant as its *best* passage, not its average: a novel with
 * one devastating chapter about grief is a good answer to "grief" however many
 * chapters it spends on other things, and averaging would rank it below a
 * short story that mentions sadness throughout.
 *
 * Two rules about which passages are kept:
 *
 * - **Below `minSimilarity` is not a hit.** Nearest-neighbour search always
 *   returns neighbours, however far away; the floor is what makes "nothing
 *   matched" a possible answer. See `AiEmbedConfig.searchMinSimilarity`.
 * - **One passage per chapter.** Windows overlap (`chunking.ts`), so the two
 *   nearest passages are very often neighbouring windows of one scene -- the
 *   same sentences quoted twice. A second passage from another chapter tells
 *   the reader something; a second from the same one does not.
 */
export function rankStories(
  hits: PassageHit[],
  minSimilarity: number,
): StoryHit[] {
  const byStory = new Map<string, StoryHit>();

  // Sorted here rather than trusted: the index scan is allowed to return rows
  // slightly out of order (`relaxed_order`, see `search.ts`).
  const ordered = [...hits].sort(
    (a, b) =>
      b.similarity - a.similarity ||
      a.chapterId.localeCompare(b.chapterId),
  );

  for (const hit of ordered) {
    if (hit.similarity < minSimilarity) break;

    const story = byStory.get(hit.storyId);
    if (!story) {
      byStory.set(hit.storyId, {
        storyId: hit.storyId,
        similarity: hit.similarity,
        passages: [hit],
      });
      continue;
    }

    if (story.passages.length >= PASSAGES_PER_STORY) continue;
    if (story.passages.some((kept) => kept.chapterId === hit.chapterId)) continue;
    story.passages.push(hit);
  }

  // Map insertion order is best-passage order, because `ordered` is.
  return [...byStory.values()];
}

/* Fusion ----------------------------------------------------------------- */

/**
 * The reciprocal-rank-fusion constant.
 *
 * 60 is the value from the paper that introduced the method (Cormack, Clarke
 * and Büttcher, 2009) and the one nearly every implementation uses. It decides
 * how flat the curve is: small values make first place worth far more than
 * fifth, large ones make every appearance worth about the same. At 60, being
 * first in one list (1/61) is worth less than being fifth in both (2/65),
 * which is the property hybrid search exists to have.
 */
export const RRF_K = 60;

export interface FusedHit {
  id: string;
  score: number;
  /** 1-based position in each input list, or null where it did not appear. */
  ranks: (number | null)[];
}

/**
 * Reciprocal-rank fusion: `score = Σ 1 / (k + rank)` over every list an item
 * appears in.
 *
 * **Why ranks and not scores.** The two inputs measure different things on
 * different scales. Keyword search has no relevance score at all here -- it is
 * an `ilike` match ordered by popularity -- and cosine similarity is a number
 * whose meaningful range differs per model. Any formula that adds a similarity
 * to a keyword score has to invent an exchange rate between them, and every
 * such rate is wrong somewhere. Ranks need no exchange rate: first is first in
 * any list. That is why this is the honest default rather than merely the
 * popular one.
 *
 * What it rewards is agreement. An item both lists found outranks one only a
 * single list found, unless the single list put it far higher -- which is
 * exactly "a keyword-and-meaning match above either alone".
 *
 * Ties break on the best rank the item achieved anywhere, then on id, so the
 * order is deterministic and a page boundary cannot shuffle between requests.
 */
export function fuseRankings(lists: string[][], k = RRF_K): FusedHit[] {
  const fused = new Map<string, FusedHit>();

  lists.forEach((list, listIndex) => {
    list.forEach((id, position) => {
      const rank = position + 1;
      let hit = fused.get(id);
      if (!hit) {
        hit = { id, score: 0, ranks: lists.map(() => null) };
        fused.set(id, hit);
      }
      // A list naming an item twice is a bug upstream; count its best rank.
      if (hit.ranks[listIndex] !== null) return;
      hit.ranks[listIndex] = rank;
      hit.score += 1 / (k + rank);
    });
  });

  const bestRank = (hit: FusedHit) =>
    Math.min(...hit.ranks.map((rank) => rank ?? Number.POSITIVE_INFINITY));

  return [...fused.values()].sort(
    (a, b) =>
      b.score - a.score ||
      bestRank(a) - bestRank(b) ||
      a.id.localeCompare(b.id),
  );
}

/* Excerpts --------------------------------------------------------------- */

/** About two lines of a card: enough to recognise the scene, not to read it. */
export const EXCERPT_CHARS = 280;

/**
 * The part of a passage worth showing under a result.
 *
 * A window is ~1200 characters (`chunking.ts`) and a card has room for a
 * fraction of that, so something has to choose which fraction. When a query
 * word appears in the passage, the excerpt is centred on it -- the reader can
 * see why it matched. When none does, which is the whole point of semantic
 * search, there is no honest way to point at the sentence that matched: the
 * vector is of the window, not of any sentence in it. So the excerpt is the
 * window's opening, which is at least where its context starts.
 *
 * Cut on word boundaries, with an ellipsis wherever text was dropped, so an
 * excerpt never claims to be the whole passage.
 */
export function excerptOf(text: string, query: string, max = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;

  const lower = flat.toLowerCase();

  /*
   * Longest query word first, because length is the cheapest proxy for being
   * distinctive: in "a girl who can rewind time", anchoring on whichever word
   * appears earliest centres the excerpt on "who" or "can", while "rewind" is
   * the one a reader would recognise. Four letters minimum keeps the short
   * function words out without a stop-word list to maintain; numbers are
   * exempt, because "1947" or "11" is about as distinctive as a query gets.
   */
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 || /\d/u.test(word))
    .sort((a, b) => b.length - a.length);

  let anchor = -1;
  for (const word of words) {
    anchor = lower.indexOf(word);
    if (anchor !== -1) break;
  }

  // A third of the budget before the match, so it reads as mid-sentence
  // context rather than as the first word of the excerpt.
  let start = anchor === -1 ? 0 : Math.max(0, anchor - Math.floor(max / 3));
  let end = Math.min(flat.length, start + max);
  start = Math.max(0, end - max);

  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space !== -1 && space < end) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > start) end = space;
  }

  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
