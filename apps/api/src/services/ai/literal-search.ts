/**
 * Finding a passage by its words, for text that is deliberately not embedded.
 *
 * Only published chapters of listed stories are embedded (`jobs.ts`): the
 * cheapest way to keep a draft out of search is to keep it out of the index.
 * That leaves the one person entitled to read a draft -- its author, asking
 * the assistant in the editor -- with a search that cannot see most of what
 * they are writing. This is that author's search: their own chapters, read
 * through `listMyChapters`, matched on the words of the question. No index,
 * no vector, nothing stored, so nothing here can leak a draft to anyone else.
 *
 * Deliberately simple, and pure so it is tested on its own:
 *
 * - **Terms** are the question's words of three letters or more, minus a short
 *   stop list, reduced to a stem by dropping a plural or verb ending -- so
 *   "eye" finds "eyes" and "knocked" finds "knock". A prefix match, not a
 *   linguist.
 * - **A passage is a paragraph**, scored by how many *different* terms it
 *   contains, ties broken by reading order. A paragraph matching one common
 *   word is a weak hit; one matching every term is the answer.
 */

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "that", "this", "what",
  "who", "whom", "whose", "which", "when", "where", "why", "how", "does", "did",
  "has", "have", "had", "her", "his", "hers", "him", "she", "they", "them",
  "their", "its", "from", "about", "into", "than", "then", "there", "any",
  "all", "you", "your", "our", "can", "could", "would", "should", "will",
  "say", "said", "says", "tell", "story", "chapter", "chapters", "mention",
  "mentioned", "described", "describe",
]);

/** The stem a word is matched by: lowercased, a common ending dropped. */
export function stem(word: string): string {
  const lower = word.toLowerCase();
  for (const ending of ["ing", "ed", "es", "s"]) {
    if (lower.length - ending.length >= 3 && lower.endsWith(ending)) {
      return lower.slice(0, -ending.length);
    }
  }
  return lower;
}

/** The distinct stems a question is searched by. */
export function termsOf(query: string): string[] {
  const words = query.toLowerCase().match(/\p{L}[\p{L}'’]*/gu) ?? [];
  const stems = words
    .map((word) => word.replace(/['’]s?$/u, ""))
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
    .map(stem);
  return [...new Set(stems)];
}

export interface LiteralChapter {
  chapterNumber: number;
  chapterTitle: string;
  content: string;
}

export interface LiteralHit {
  chapterNumber: number;
  chapterTitle: string;
  /** The matching paragraph, as written. */
  text: string;
  /** How many distinct terms it contains. */
  score: number;
}

/**
 * The paragraphs of `chapters` that contain the query's terms, best first.
 * Empty when the query has no usable terms or nothing contains one.
 */
export function literalSearch(
  chapters: readonly LiteralChapter[],
  query: string,
  limit: number,
): LiteralHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];

  const hits: (LiteralHit & { order: number })[] = [];
  let order = 0;

  for (const chapter of chapters) {
    for (const paragraph of chapter.content.split(/\n\s*\n/)) {
      order += 1;
      const text = paragraph.trim();
      if (text === "") continue;

      const words = new Set((text.toLowerCase().match(/\p{L}+/gu) ?? []));
      let score = 0;
      for (const term of terms) {
        for (const word of words) {
          if (word.startsWith(term)) {
            score += 1;
            break;
          }
        }
      }

      if (score > 0) {
        hits.push({
          chapterNumber: chapter.chapterNumber,
          chapterTitle: chapter.chapterTitle,
          text,
          score,
          order,
        });
      }
    }
  }

  return hits
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ order: _order, ...hit }) => hit);
}
