/**
 * Keeping a ranked list from being ten of the same thing.
 *
 * A score ranks stories one at a time and has no idea what else is on the
 * shelf. Left alone, a reader who likes one prolific author gets that author's
 * whole back catalogue, and one who shelved a single space opera gets twelve
 * more -- each individually the right answer and collectively a worse rail
 * than five varied ones. Content similarity makes this sharper, not better:
 * near-identical stories score near-identically, so they arrive together.
 *
 * This is a selection pass over the ranking, kept apart from it on purpose.
 * The score in `recommendations.ts` is still one SQL statement and still says
 * how good each story is; this only decides which of the best ones share a
 * page. It is pure, so the caps are tested without a database.
 *
 * **A cap decides order, never whether the rail is full.** A story over a cap
 * is held back, not thrown away, and the held stories fill whatever space is
 * left in the order they were ranked. On a small corpus -- one author, one
 * genre -- every cap is exceeded and the result is simply the ranking, which
 * is better than a half-empty shelf explaining itself with a rule.
 */

/** Stories by one author on one page. */
export const MAX_PER_AUTHOR = 2;

/**
 * The share of a page one genre may take.
 *
 * Half, not less: a reader who named Fantasy asked for Fantasy, and the cap is
 * there to leave room for something else, not to overrule them. The best
 * stories of the genre still come first, because the pass walks the ranking in
 * order and the cap only bites once they are placed.
 */
export const MAX_GENRE_SHARE = 0.5;

/** Below this a genre cap is one story, which is a ban rather than a cap. */
const MIN_PER_GENRE = 2;

export function maxPerGenre(limit: number): number {
  return Math.max(MIN_PER_GENRE, Math.ceil(limit * MAX_GENRE_SHARE));
}

/** What the pass needs to know about an item, and nothing else. */
export interface DiversityKey {
  authorId: string;
  genreIds: string[];
}

/**
 * The first `limit` items of `ranked` that fit under the caps, in ranked
 * order, topped up from the ones held back if that leaves room.
 *
 * Greedy, front to back: an item is taken unless its author or any one of its
 * genres is already at its cap. "Any one" because a story tagged Fantasy and
 * Adventure is a Fantasy story to a reader looking at a shelf full of them. An
 * item with no genres can only be held by its author.
 *
 * Deterministic: the same ranking in gives the same page out.
 */
export function diversify<T>(
  ranked: T[],
  limit: number,
  keyOf: (item: T) => DiversityKey,
): T[] {
  const genreCap = maxPerGenre(limit);
  const byAuthor = new Map<string, number>();
  const byGenre = new Map<string, number>();

  const picked: T[] = [];
  const held: T[] = [];

  for (const item of ranked) {
    if (picked.length >= limit) break;

    const { authorId, genreIds } = keyOf(item);
    const fits =
      (byAuthor.get(authorId) ?? 0) < MAX_PER_AUTHOR &&
      genreIds.every((genreId) => (byGenre.get(genreId) ?? 0) < genreCap);

    if (!fits) {
      held.push(item);
      continue;
    }

    picked.push(item);
    byAuthor.set(authorId, (byAuthor.get(authorId) ?? 0) + 1);
    for (const genreId of genreIds) {
      byGenre.set(genreId, (byGenre.get(genreId) ?? 0) + 1);
    }
  }

  return [...picked, ...held.slice(0, Math.max(0, limit - picked.length))];
}
