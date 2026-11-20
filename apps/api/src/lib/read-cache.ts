/**
 * A short-lived, in-process memo for the public reads every reader repeats:
 * story lists, a story's page, the catalogue.
 *
 * **Why it exists.** The load test (docs/LOAD-TESTING.md) found the API
 * CPU-bound in its own process long before Postgres was busy, and the profile
 * put most of that CPU in the ORM decoding rows -- about eight queries'
 * worth for one page of stories. The same page, asked for by a hundred
 * readers in a minute, was decoded a hundred times. A hit here answers from
 * memory without touching the database or the ORM.
 *
 * **Why in-process rather than Redis.** A hit is a map lookup instead of a
 * network round trip and a JSON parse, and the deployment's Redis is a small
 * free instance already holding sessions and the job queue. The cost is that
 * each API instance has its own copy: `invalidateReadCache()` clears this
 * process only, so with more than one instance a change reaches the others
 * when their entries expire. The TTL is therefore the real staleness bound,
 * and is short for that reason.
 *
 * **What is safe to put here.** Only values that are the same for every
 * caller who is served them -- the routes decide that, not this file (see
 * `seesPublicView` in routes/stories.ts). Values are shared between requests,
 * so a caller must never mutate one; the routes copy before annotating.
 *
 * **Properties worth relying on.**
 * - *Single flight.* Concurrent misses on one key share one load, so a cold
 *   key under load costs one query, not one per waiting request.
 * - *Failures are not cached.* A rejected load -- a 404, a database error --
 *   is dropped as it settles, and the next caller tries again.
 * - *Invalidation cannot be undone by a slow load.* Clearing removes in-flight
 *   entries too, so a load that read the row before a write committed is
 *   never stored after it.
 *
 * `READ_CACHE_SECONDS` sets the TTL (default 30); `0` turns the cache off,
 * which the test suite does so fixtures written straight to the database are
 * seen at once.
 */

const DEFAULT_TTL_SECONDS = 30;

/** Bounds memory: a page of stories is a few kilobytes, so this is a few MB at worst. */
const MAX_ENTRIES = 1_000;

interface Entry {
  value: Promise<unknown>;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

/** Read per call, so a test can switch the cache on for itself. */
function ttlMs(): number {
  const raw = process.env["READ_CACHE_SECONDS"]?.trim();
  const seconds = raw ? Number(raw) : DEFAULT_TTL_SECONDS;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/**
 * `load()`'s result for `key`, from memory while it is fresh.
 *
 * The key must name everything the value depends on -- the route and every
 * parameter -- because two calls with one key get one answer.
 */
export function readThrough<T>(key: string, load: () => Promise<T>): Promise<T> {
  const ttl = ttlMs();
  if (ttl === 0) return load();

  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now) {
    // Re-inserting moves the key to the back, so eviction drops the least
    // recently used entry rather than the oldest.
    entries.delete(key);
    entries.set(key, hit);
    return hit.value as Promise<T>;
  }

  const entry: Entry = { value: load(), expiresAt: now + ttl };
  entries.set(key, entry);
  entry.value.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });

  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }

  return entry.value as Promise<T>;
}

/**
 * Forgets everything. Called after a write that changes what the public
 * sees has committed -- never inside its transaction, or a read between the
 * clear and the commit would store the old row for a full TTL.
 */
export function invalidateReadCache(): void {
  entries.clear();
}

/** For tests and the health check: how many keys are held. */
export function readCacheSize(): number {
  return entries.size;
}
