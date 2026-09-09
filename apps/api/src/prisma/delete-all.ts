/**
 * `db.orm.<Model>.where(...).delete()` removes **one** row per call, even when
 * the predicate matches many, and answers `null` once nothing is left. Any
 * "delete every row matching this" therefore has to loop, which is easy to get
 * wrong silently — the first call succeeds and the leftovers only surface later
 * as a foreign-key violation.
 *
 * `deleteAll` does that loop once, in one place.
 */

/** The part of an ORM collection this helper needs. */
interface Deletable {
  delete: () => PromiseLike<unknown>;
}

/**
 * Deletes every row the collection matches, and returns how many went.
 *
 * `build` is called afresh for each round rather than a single collection
 * being reused, because a built query result is single-consumption.
 *
 * `limit` is a runaway guard: hitting it means far more rows matched than any
 * caller here intends, so it throws rather than looping on.
 */
export async function deleteAll(
  build: () => Deletable,
  limit = 10_000,
): Promise<number> {
  let removed = 0;

  while (removed < limit) {
    const deleted = await build().delete();
    if (deleted === null || deleted === undefined) return removed;
    removed += 1;
  }

  throw new Error(`deleteAll removed ${limit} rows without exhausting the match`);
}
