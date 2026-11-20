/**
 * A small load generator for the API: N concurrent virtual readers replaying a
 * weighted mix of the requests a reading platform actually gets, for a fixed
 * time, then a latency table per endpoint.
 *
 *   pnpm --filter api load:test                       # against the local dev API
 *   pnpm --filter api load:test -- --concurrency 50 --duration 30
 *   pnpm --filter api load:test -- --base https://staging.example/api
 *   pnpm --filter api load:test -- --user <auth.user id>   # adds the signed-in mix
 *   pnpm --filter api load:test -- --token <access token> # the same, for a production build
 *
 * It exists to answer "where does it saturate, and on what" with numbers, so
 * capacity work fixes measured bottlenecks rather than suspected ones. No
 * dependency: built-in `fetch`, and a closed loop (each virtual reader waits
 * for its answer before asking again), which is how real browsers behave and
 * why throughput here is a measure of the server, not of the generator.
 *
 * `--user` sends the `X-Scribe-User-Id` dev header, which only a development
 * API started with `ALLOW_DEV_USER_HEADER=true` honours. A production build
 * ignores it, so against one pass `--token`, an access token for a user of
 * that database (docs/LOAD-TESTING.md shows how to mint one). Either way, a
 * signed-in run sends the identity on *every* request, as the web app does --
 * which is what decides whether a request may be served from the read cache. Pointed at anything
 * other than localhost without `--yes`, the script refuses: it is a load
 * test, and run against a live service it is indistinguishable from an attack
 * on it.
 *
 * Views and chapter reads are recorded as they would be for a real reader, so
 * their write cost is part of what is measured. They deduplicate per visitor
 * per day, so a run adds at most one row per story and chapter for the
 * machine it runs on.
 */

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:1303/api" },
    concurrency: { type: "string", default: "20" },
    duration: { type: "string", default: "20" },
    user: { type: "string" },
    token: { type: "string" },
    yes: { type: "boolean", default: false },
  },
});

const BASE = args.base.replace(/\/$/, "");
const CONCURRENCY = Number(args.concurrency);
const DURATION_MS = Number(args.duration) * 1000;

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(BASE + "/") && !args.yes) {
  console.error(`Refusing to load-test ${BASE} without --yes: it is not localhost.`);
  process.exit(1);
}

/* Fixtures: real slugs, so every request resolves rather than 404ing ------ */

interface StoryCard {
  slug: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(BASE + path);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

const { items: stories } = await getJson<{ items: StoryCard[] }>("/stories?limit=20&sort=trending");
if (stories.length === 0) {
  console.error("No listed stories to read; seed some first (pnpm --filter api seed:stories).");
  process.exit(1);
}
const { items: books } = await getJson<{ items: { id: string }[] }>("/books?limit=20");

const chaptersBySlug = new Map<string, number[]>();
for (const story of stories) {
  const { chapters } = await getJson<{ chapters: { number: number }[] }>(`/stories/${story.slug}/chapters`);
  chaptersBySlug.set(
    story.slug,
    chapters.map((chapter) => chapter.number),
  );
}
const readable = stories.filter((story) => (chaptersBySlug.get(story.slug) ?? []).length > 0);

/* The mix ------------------------------------------------------------------ */

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!;

interface Endpoint {
  /** The label results are grouped under. */
  name: string;
  weight: number;
  path: () => string;
  signedIn?: boolean;
}

/**
 * Weighted towards reading, because that is what a reading platform serves:
 * a chapter body and the story page around it far outnumber browsing, and
 * browsing outnumbers everything personal.
 */
const ENDPOINTS: Endpoint[] = [
  { name: "GET /stories/:slug/chapters/:n", weight: 30, path: () => {
    const story = pick(readable);
    return `/stories/${story.slug}/chapters/${pick(chaptersBySlug.get(story.slug)!)}`;
  } },
  { name: "GET /stories/:slug", weight: 15, path: () => `/stories/${pick(stories).slug}` },
  { name: "GET /stories/:slug/chapters", weight: 10, path: () => `/stories/${pick(stories).slug}/chapters` },
  { name: "GET /stories (trending)", weight: 10, path: () => "/stories?sort=trending&limit=20" },
  { name: "GET /stories (newest, deep page)", weight: 3, path: () => `/stories?sort=newest&limit=20&page=${1 + Math.floor(Math.random() * 5)}` },
  { name: "GET /stories?search=", weight: 4, path: () => `/stories?search=${pick(["the", "night", "love", "war", "a"])}&limit=20` },
  { name: "GET /stories/:slug/related", weight: 8, path: () => `/stories/${pick(stories).slug}/related` },
  { name: "GET /stories/genres", weight: 3, path: () => "/stories/genres" },
  { name: "GET /books", weight: 5, path: () => "/books?limit=20" },
  ...(books.length > 0
    ? [{ name: "GET /books/:id", weight: 3, path: () => `/books/${pick(books).id}` }]
    : []),
  { name: "GET /recommendations", weight: 6, signedIn: true, path: () => "/recommendations?limit=12" },
  { name: "GET /notifications", weight: 4, signedIn: true, path: () => "/notifications?limit=20" },
];

const identity: Record<string, string> = args.token
  ? { Authorization: `Bearer ${args.token}` }
  : args.user
    ? { "X-Scribe-User-Id": args.user }
    : {};
const signedIn = Object.keys(identity).length > 0;

const active = ENDPOINTS.filter((endpoint) => !endpoint.signedIn || signedIn);
const totalWeight = active.reduce((sum, endpoint) => sum + endpoint.weight, 0);

function choose(): Endpoint {
  let roll = Math.random() * totalWeight;
  for (const endpoint of active) {
    roll -= endpoint.weight;
    if (roll < 0) return endpoint;
  }
  return active[active.length - 1]!;
}

/* The run ------------------------------------------------------------------ */

interface Tally {
  latencies: number[];
  errors: number;
  statuses: Map<number, number>;
}

const results = new Map<string, Tally>();
const tally = (name: string): Tally => {
  let entry = results.get(name);
  if (!entry) {
    entry = { latencies: [], errors: 0, statuses: new Map() };
    results.set(name, entry);
  }
  return entry;
};

async function virtualReader(deadline: number): Promise<void> {
  while (performance.now() < deadline) {
    const endpoint = choose();
    const entry = tally(endpoint.name);
    const started = performance.now();
    try {
      const response = await fetch(BASE + endpoint.path(), {
        headers: identity,
        signal: AbortSignal.timeout(30_000),
      });
      await response.arrayBuffer();
      entry.statuses.set(response.status, (entry.statuses.get(response.status) ?? 0) + 1);
      if (!response.ok) entry.errors += 1;
    } catch {
      entry.errors += 1;
    }
    entry.latencies.push(performance.now() - started);
  }
}

console.log(
  `Load test: ${CONCURRENCY} concurrent readers for ${DURATION_MS / 1000}s against ${BASE}` +
    `${signedIn ? " (signed in, signed-in mix included)" : ""}; ${stories.length} stories, ${readable.length} with chapters.`,
);

const started = performance.now();
const deadline = started + DURATION_MS;
await Promise.all(Array.from({ length: CONCURRENCY }, () => virtualReader(deadline)));
const elapsedSeconds = (performance.now() - started) / 1000;

/* The report --------------------------------------------------------------- */

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

const rows = [...results.entries()]
  .map(([name, entry]) => {
    const sorted = [...entry.latencies].sort((a, b) => a - b);
    return {
      endpoint: name,
      requests: sorted.length,
      errors: entry.errors,
      "p50 ms": Math.round(percentile(sorted, 50)),
      "p95 ms": Math.round(percentile(sorted, 95)),
      "p99 ms": Math.round(percentile(sorted, 99)),
      "max ms": Math.round(sorted[sorted.length - 1] ?? 0),
      statuses: [...entry.statuses.entries()].map(([status, count]) => `${status}×${count}`).join(" "),
    };
  })
  .sort((a, b) => b["p95 ms"] - a["p95 ms"]);

const all = [...results.values()].flatMap((entry) => entry.latencies).sort((a, b) => a - b);
const errors = [...results.values()].reduce((sum, entry) => sum + entry.errors, 0);

console.table(rows);
console.log(
  `Overall: ${all.length} requests in ${elapsedSeconds.toFixed(1)}s = ${(all.length / elapsedSeconds).toFixed(1)} req/s, ` +
    `p50 ${Math.round(percentile(all, 50))}ms, p95 ${Math.round(percentile(all, 95))}ms, ` +
    `p99 ${Math.round(percentile(all, 99))}ms, ${errors} errors (${((errors / Math.max(1, all.length)) * 100).toFixed(2)}%).`,
);
