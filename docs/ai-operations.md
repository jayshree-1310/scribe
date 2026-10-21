# Running the AI features

Task AI 20. This is what to check when an AI feature misbehaves, how to work
the background queue, and how to turn a feature off without a deploy. It is
written for whoever is on call.

The commands assume the repo root. On the deployed instance, run them in its
shell with the same environment as the API.

## When something is wrong: check in this order

1. **`GET /health`.** It always answers 200 with `status: "ok"` while the API
   itself is up. AI never fails it, by design. Look at `ai`:
   - `provider`, `model` and `configured`: what is selected, and whether its
     credential is present. `configured: false` means a missing `AI_API_KEY`,
     and every AI route answers 503 until it is set.
   - `status.chat` and `status.embed` give `ok`, `degraded` (with `lastError`)
     or `unknown`. They come from the most recent call of that kind in the
     last five minutes, so no probe is spent on a health check.

   `degraded` with `service_unavailable` means the provider is unreachable.
   With `too_many_requests` it is rate-limiting us. With `upstream_error` it
   answered with something unusable.
2. **The spend view** (`/admin/ai-spend`, administrators). Errors, latency
   p50/p95, tokens and calls by feature, model and caller. A feature whose
   errors or p95 jumped is the place to look. A single caller at the top of
   "heaviest callers" is usually a loop.
3. **The operations view.** `GET /api/ai/admin/ops`, or
   `pnpm --filter api ai:ops status`, shows queue counts, the last 20
   dead-lettered jobs with their error codes, and which features are switched
   off.
4. **The logs, by request id.** Every request's log line has `req.id`. Every
   AI call it caused logs an `AI call` line with `ai.requestId` set to the
   same value, and every job it queued logs with `job.requestId`. Search for
   the id to see one user action end to end: the request, each provider call
   with tokens and outcome, and the jobs. No line carries prompt or reply
   text (`docs/ai-security.md` §6).
5. **`pnpm --filter api ai:eval`.** If answers got *worse* rather than failing,
   this is the comparison. It compares against the last run and names the
   cases that regressed.

## Turning a feature off without a deploy

```bash
pnpm --filter api ai:ops off assist         # all eight assistant actions
pnpm --filter api ai:ops off assist.continue # just one
pnpm --filter api ai:ops on assist
```

The same switch is available to an administrator as `PUT /api/ai/admin/switches`
with body `{ "feature": "assist", "enabled": false }`.

- **Prefixes.** A feature id or prefix, as the usage view names it: `ask.book`,
  `recap`, `explain`, `scribble`, `agent`, `generate`, `bible.extract`,
  `continuity.check`, `moderation.classify`.
- **Speed.** It takes effect within ten seconds on every instance, because
  each caches the list that long.
- **What it covers.** It stops chat completions — every feature that writes
  text. It does not stop embeddings. Semantic search keeps working; to stop
  that, point `AI_EMBED_*` elsewhere or stop the embedder, and search falls
  back to keywords.
- **Failure.** If Redis is unreachable the switches read as all on, rather
  than turning everything off with it.

## The background queue

`lib/jobs.ts` is a Redis-backed queue. Its worker runs inside the API process
when `AI_JOBS=on` (the default), started by `server.ts`. There are four job
types (`services/ai/jobs.ts`):

| Job | Queued by | What it does |
| --- | --- | --- |
| `embed.chapter` | Publishing a chapter or a story; editing a published chapter's text (debounced by chapter, a minute after the last save) | Embeds the chapter for search, if it is published and its story is listed |
| `bible.read` | `POST /api/ai/bible/:storyId/read` (the author) | Reads every stale chapter into the story bible, as the author, against their budget |
| `usage.prune` | The worker, once a day | Deletes `ai.UsageEvent` rows past `AI_USAGE_RETENTION_DAYS` |
| `summary.story` | A reader opening a story whose summary at their chapter is missing or stale; the author's Regenerate | Writes the story-so-far summary up to that chapter, reusing every chapter summary that is still current |

**Retries.** A failing job is retried on a doubling delay (5s, 10s, 20s … at
most ten minutes), up to its type's attempt limit: 4 for embedding, 3 for a
bible reading, 2 for the prune. After that it is **dead-lettered**. Every
handler is idempotent, so a retry or a recovered job running twice writes
nothing twice:

- embedding and the bible skip input whose hash has not changed;
- the prune is a `DELETE` by date.

**Status.** The person who queued a job can read it at `GET /api/ai/jobs/:id`:
status, attempts, an error code and a small result. Anybody else gets a 404.
Finished jobs are kept a day, dead ones a week.

```bash
pnpm --filter api ai:ops status          # counts, dead letters, switches
pnpm --filter api ai:ops retry <job-id>  # a dead job, with fresh attempts
pnpm --filter api ai:ops purge           # drop every dead job
pnpm --filter api ai:ops drain           # run everything queued, now, in this shell
```

An administrator can also retry a dead job with
`POST /api/ai/admin/jobs/:id/retry`.

**Draining before maintenance.** Set `AI_JOBS=off` and restart, so no worker
takes new jobs. Then run `ai:ops drain` to finish what is queued. Jobs left
in Redis are not lost; they run when a worker next starts.

**One worker.** Claiming a job is atomic, so two instances can share a queue.
Start-up recovery is not: a worker starting up puts back any job still marked
running, which is correct only when it is the only worker. Run more than one
instance against the same queue only with `AI_JOBS=off` on all but one.

`AI_JOBS_QUEUE` names the queue (default `jobs`). Environments sharing a Redis
must use different names. The test suite uses its own, so a dev server's
worker never takes test jobs.

## How each feature degrades

With the provider down, unconfigured or switched off, the app stays fully
usable: reading, writing, publishing, comments, clubs, search. What changes:

| Feature | What a person sees | Held by |
| --- | --- | --- |
| `/health` | Still 200 / `ok`; `ai.status.chat` is `degraded` | `ai-ops.test.ts` |
| Chapter recap | The "Previously" card is absent (a failed load is silent); pressing "Recap" shows an error | `RecapCard.tsx` |
| Writing assistant, explain, Ask This Book, Scribble, the agent, generation | The panel shows the server's message in place of an answer; nothing else on the page changes | each route returns 503 with a message; the panels render it |
| Search | Falls back to keyword search and says so: "Searching by meaning is unavailable right now, so these match on title and author only." | `ai-search.test.ts` |
| Comment moderation | The comment posts; the check is recorded as `UNCHECKED`, and `moderation:pending` re-checks it later | `ai-moderation.test.ts` |
| Continuity check | The chapter saves (200); the check is recorded as failed and the previous findings stand | `ai-continuity.test.ts` |
| Story bible | Refresh reports the failure; facts already read stay | `ai-bible.test.ts` |
| "The story so far" | The card says it is being written, then "No summary yet" if the job keeps failing; a failed load hides the card. The job retries, then dead-letters | `StorySummaryCard.tsx`; `ai-summaries.test.ts` |
| Embedding on publish | The chapter publishes; the job retries, then dead-letters, and `ai:ops retry` or `seed:embeddings` catches it up | `ai-ops.test.ts` |
| A switched-off feature | 503, "This AI feature is switched off for now. Everything else still works." | `ai-ops.test.ts` |

## Configuration in one place

| Variable | Default | |
| --- | --- | --- |
| `AI_JOBS` | `on` | Run the worker and queue background AI work |
| `AI_JOBS_QUEUE` | `jobs` | The queue's Redis key prefix |
| `AI_USAGE_RETENTION_DAYS` | `90` | Usage rows older than this are pruned daily |
| `AI_BASELINE_REQUEST_LIMIT` | `300` | Requests per user per ten minutes, across all AI routes |
| `AI_DAILY_TOKEN_BUDGET` | `200000` | Tokens per user per rolling day |
| `AI_FEATURE_MODELS` | — | Route a feature to another model |
| `AI_RESULT_CACHE_SECONDS` | `86400` | How long explanations are reused |
| `AI_LOG_CONTENT` | `off` | Debug-only prompt logging; ignored in production |
| `AI_INPUT_USD_PER_MTOK`, `AI_OUTPUT_USD_PER_MTOK` | — | Prices, for spend in dollars |
