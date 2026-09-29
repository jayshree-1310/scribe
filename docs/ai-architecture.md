# AI architecture

How an AI request flows through Scribe, what each layer is responsible for, and
what a new AI feature has to add. Written for the state after Tasks AI 0
through AI 5 of `AI-BACKLOG.md`, the reader half of Task AI 6, and Task AI 7:
the module and the provider seam exist, a model can be asked for a shape
rather than for prose that looks like one, every long answer streams, and five
features are built on that — Scribble, the chapter recap and passage
explanations for readers; the idea studio and the writing assistant for
authors — plus `/api/ai/chat`, which is the bare path underneath them and the
one the `/ai-lab` workbench drives.

Task AI 7 adds the first thing here that no user can see: the corpus is
embedded into a `pgvector` table, which is what Tasks AI 8 onward read. It has
no route and no UI, and the section on it below is about cost rather than
about features.

## The path

```
browser
  → POST /api/ai/…                       routes/ai.ts
      requireUser, rate limit, zod-validated body
  → a feature function                   services/ai/<feature>.ts
      builds the prompt from services/ai/prompts/
  → aiProvider()                         services/ai/provider.ts
      retries transient failures, records usage
  → the implementation                   services/ai/ollama.ts
      HTTP to the model server
  → back up, validated                   zod, before anything is stored
  → response / SSE stream
```

**SSE headers are flushed late, on purpose.** `POST /api/ai/scribble/stream`
writes nothing until the intent call and retrieval have both succeeded, because
every provider-availability failure is raised by that first call. Committing to
`200 text/event-stream` before it would turn a real 503 into a fake success
carrying an error frame, and the status table below would stop being true.
After the first byte, `errorHandler` can no longer answer -- it returns early on
`headersSent` -- so a mid-stream failure is reported as an `error` frame, and a
stream that ends without its terminal `done` is a failure the client must treat
as one.

Every arrow is a place something can be rejected, and the rejections are the
design. A model call is the least interesting part of an AI feature.

## Files

| File | Responsibility |
| --- | --- |
| `services/ai/types.ts` | The seam. `AiProvider`, `AiRequest`, `AiUsage`, `AiStreamEvent`. No provider or SDK type appears here, which is what makes the model swappable. |
| `services/ai/config.ts` | Reads `AI_*` from the environment. Never throws at import; `isAiConfigured()` reports a missing credential. |
| `services/ai/ollama.ts` | The default implementation: plain HTTP to a local Ollama server, no SDK, no key. Maps transport and protocol failures onto `HttpError`. |
| `services/ai/provider.ts` | Constructs the provider (once), wraps it with retry and usage policy, and hands it out via `aiProvider()`. The only place a client is built. `aiEmbedder()` is the same for embeddings, and a second accessor because it is a second service. |
| `services/ai/usage.ts` | Where usage records go. Logs today; Task AI 18 swaps the sink for one that also persists. |
| `services/ai/budget.ts` | The per-user token ceiling `config.ts` reads. Checked before a call, charged after one. Not a second limiter: the read side *is* `isRateLimited`. |
| `services/ai/chat.ts` | Task AI 1's feature: a prompt in, a reply out, streamed or not. The only AI call with nothing around it, which is what makes it the thing to test a provider with. |
| `services/ai/prompts/chat.ts` | The one prompt that says what Scribe is. Its load-bearing rule is the one forbidding catalogue facts: chat has no retrieval to be right from. |
| `services/ai/json-schema.ts` | Derives the JSON schema sent to a provider from a zod schema, pruned to the keyword subset every provider accepts. |
| `services/ai/structured.ts` | `completeStructured`: constrain, validate, repair once, then fail. Written over whichever provider is configured, so no implementation implements it. |
| `services/ai/schemas.ts` | The shapes generative features ask for — story idea, character profile, chapter outline. Zod only; the wire schema is derived. |
| `services/ai/assist.ts` | Task AI 3's feature: eight transformations of a selected passage. Owns the context window and the reply cleanup, and deliberately cannot write to a chapter. |
| `services/ai/assist-types.ts` | The action enum and the input shape, split out so `prompts/assist/` can name an action without an import cycle. |
| `services/ai/prompts/assist/` | One system prompt, one instruction per action. The instructions are data, so Task AI 17 can version them individually. |
| `services/ai/generate.ts` | Task AI 5's feature: premises, characters and chapter outlines as validated objects, with the refinement conversation held server-side in Redis. |
| `services/ai/generate-types.ts` | The shapes generation passes between its parts, split out so `prompts/` can render a brief without an import cycle. |
| `services/ai/prompts/generate.ts` | The three generation prompts and the refinement one. Short, because the *shape* is described by the schema, not here. |
| `services/ai/testing.ts` | `fakeAiProvider()` — records what it was sent, returns scripted replies. Every AI test uses it. |
| `services/ai/scribble.ts` | Task AI 1.5's feature: interpret a request into filters, retrieve with the existing services, narrate the rows. The model never produces a book; see the file header. |
| `services/ai/scribble-types.ts` | The shapes Scribble's stages pass between them, split out so `prompts/` can render a candidate without an import cycle. |
| `services/ai/json-stream.ts` | Reads the narration call's JSON object incrementally, so a `pick` can be sent the moment it closes. A byte-wise scanner, because a delta can split mid-uuid or mid-escape. |
| `services/ai/prompts/scribble.ts` | Both of Scribble's prompts. Built from server-derived values only — no caller text is ever concatenated into system text. |
| `services/ai/recap.ts` | The reader's "previously in this story": a summary of the *previous* chapter, cached on a hash of that chapter's body. The only AI feature that stores what it generates. |
| `services/ai/prompts/recap.ts` | The recap prompt, and `RECAP_PROMPT_VERSION` — the first prompt version that is actually written onto a stored row. |
| `services/ai/explain.ts` | "What does this mean?": a reader's highlighted passage explained. Guarded by *visibility* rather than ownership, and takes offsets rather than prose. |
| `services/ai/prompts/explain.ts` | Three modes — explain, simplify, define — over one system prompt whose load-bearing rule forbids guessing at what the reader has not reached. |
| `services/ai/chunking.ts` | A chapter as overlapping, hashed windows. Pure and deterministic — the one part of retrieval testable with no database and no model, which is why it is its own file. |
| `services/ai/embeddings.ts` | Task AI 7: turns chapters into vectors and, mostly, declines to. Owns the `vector(768)` column, which the contract cannot describe, through the raw-SQL lane. |
| `scripts/seed-embeddings.ts` | `seed:embeddings` — the only thing that fills the table. Re-runnable, and free over a corpus that has not changed. |

## Rules that the code enforces

**The provider is constructed in exactly one place.** `aiProvider()` in
`provider.ts`. A route, service or script that builds its own client bypasses
retries, usage recording and the configuration check at once, so nothing else
imports an implementation.

**A missing configuration is a 503, not a crash.** `lib/jwt.ts` throws at
import when its secrets are absent, because the app is useless without auth.
AI is different: the app has to boot and serve every other route on a machine
with no model server, which is the normal state of this repo. So AI failures
are runtime responses:

| Situation | Status | Code |
| --- | --- | --- |
| Provider needs a key and has none | 503 | `service_unavailable` |
| Model server unreachable (container not running) | 503 | `service_unavailable` |
| Model not pulled | 503 | `service_unavailable` |
| Model server busy | 429 | `too_many_requests` |
| Model server timed out | 504 | `upstream_error` |
| Model answered, unusably | 502 | `upstream_error` |

The two 503s name the fix in the message — `docker compose --profile ai up -d
ollama`, or `ollama pull <model>` — because "an unexpected error occurred" is
not actionable and this failure is nearly always local setup.

**A provider's own message is never forwarded.** It can quote the prompt it was
given, and a prompt can contain a person's unpublished chapter. Upstream detail
goes to the log; the client gets a fixed sentence.

**The system prompt is a message with a role.** Never string-concatenated with
user text. That separation is the only structural thing standing between an
instruction and a user who would like to overwrite it — see Task AI 17 for how
prompts get composed, and AI 19 for the injection audit.

**Retries are for transient failures only.** Unreachable, busy, timed out: the
same request may work in a moment. A 502 — the model answered and the answer was
unusable — is not retried, because asking again the same way tends to fail the
same way. **Streaming is never retried**: once a delta has reached the client, a
retry would make the reply restart mid-sentence.

**Usage is recorded for every call, success or failure**, keyed by a feature
name the caller supplies (`chat`, `assist.rewrite`, `summary.chapter`). Records
carry token counts, duration, model and outcome — never prompts or completions.
Providers report counts under their own names (Ollama's `prompt_eval_count` /
`eval_count`), normalised in the implementation so one shape reaches the sink.

**Tests never call a real provider.** `fakeAiProvider()` records what it was
sent; assertions are about the prompt, the parsing and the error mapping, never
about model prose, which is not deterministic. The suite must keep running on a
machine with nothing installed.

## Structured output

When a feature needs an object rather than prose, it calls
`aiProvider().completeStructured(schema, request)` and gets a parsed, typed
value or an error. Three things happen, and the order is the design:

1. **Constrain.** The JSON schema sent to the provider is *derived from the zod
   schema that will validate the reply* — one definition, never two that drift.
   Ollama takes it as `format` and compiles a grammar; an OpenAI-compatible
   server takes it as a strict `response_format`.
2. **Validate anyway.** A constrained reply is still model output crossing a
   trust boundary, and "constrained" means anything from a hard grammar to a
   hint the model may ignore, depending on who answered. Nothing downstream may
   depend on which one it was. Unknown fields are stripped, not rejected.
3. **Repair once, then fail.** A reply that fails validation is sent back with
   its own errors listed, which small models are good at fixing. A second
   failure is a 502 — **never a partial object**, because half a story idea is
   not a smaller story idea and a caller handed one would store it.

The wire schema is deliberately smaller than what zod emits: `type`, `enum`,
`properties`, `required`, `items`, `anyOf`, `description` and nothing else.
`minLength`, `maximum`, `default` and friends are rejected outright by some
providers' strict mode, and they were never load-bearing — zod applies them on
the way back, which is the only check that survives a provider that ignores the
schema entirely. Objects come out closed (`additionalProperties: false`) with
every field required, which is what strict mode demands and what stops a model
quietly omitting a field it had nothing to say about.

`AI_STRUCTURED_OUTPUT=off` stops sending the schema. It is an operator switch
rather than a feature flag: a provider that rejects `response_format` outright
would otherwise break every structured feature with no way back except a
deploy. Off, the prompts still ask for JSON and zod still validates — degraded,
not broken.

### The assistant returns text and writes nothing

`POST /api/ai/assist` (and `/assist/stream`) takes an action, the selected
passage and the prose either side of it, and returns a suggestion. It has no
write path at all, which is what makes "a failed request leaves the draft
untouched" a property of the design rather than a promise. Applying an edit is
the editor's job, after the author has accepted it, through the same
`patchChapter` the formatting toolbar uses.

Two budgets matter here:

- **What is sent.** `windowFor` bounds the passage and trims the surrounding
  prose to roughly 300 tokens a side. Cost is linear in what is sent, and — less
  obviously — a model handed six chapters starts summarising them instead of
  rewriting the paragraph it was asked about. The route's schema caps the same
  fields, but the service trims regardless: the schema stops an abusive request,
  the window stops an ordinary one costing five times the last.
- **What travels.** The prose goes in the request body rather than being read
  from the database by id, because the editor's buffer is the truth while
  somebody is typing and the saved copy is a debounce behind. That is also why
  there is no `chapterId` in the contract — it could only fetch a staler copy of
  the text we were just given.

The editor re-checks the range before applying an accepted suggestion: an author
can keep typing while one streams, and replacing an offset that has since moved
would corrupt the paragraph they were working on.

### A reader's guard is visibility; an author's is ownership

The two are easy to confuse and the confusion is expensive in both directions.
`services/ai/assist.ts` asserts the caller **owns** the story, because it edits
an author's draft. `services/ai/explain.ts` and `services/ai/recap.ts` assert
only that the caller may **see** the chapter, because a reader owns nothing
they read — copying the assistant's guard there would have locked every reader
out of a feature built for them, and omitting a guard would have exposed
unpublished writing to anybody who could guess a chapter id.

Neither reader feature implements the rule. `findVisibleChapterText` and
`findPreviousVisibleChapter` in `services/stories.ts` answer it, beside
`visibleTo` and `chaptersVisibleTo`, which are where every other read path in
the app answers it. That is deliberate: a draft is hidden in exactly one place,
and a second copy of that rule in `services/ai/` is how a draft would
eventually be recapped to a stranger. A missing chapter and a forbidden one
both give 404, because a distinguishable 403 confirms the draft exists.

"The previous chapter" is also a visibility question rather than arithmetic. It
is not `number - 1`: an unpublished chapter in the middle of a story is
invisible to everybody but its author, so the chapter before twelve is eleven
for one reader and nine for another, and a recap that got this wrong would
describe a chapter its reader cannot open.

### A reader-facing endpoint takes offsets, not prose

`/api/ai/assist` accepts the passage in the request body, because the author's
unsaved editor buffer is the truth and the saved copy is a debounce behind.
`/api/ai/explain` accepts a chapter id and a `[start, end)` pair instead, and
reads the text out of the stored chapter itself.

The reason is not symmetry. An endpoint that forwards arbitrary request-body
text to a model is a general-purpose model proxy behind the site's own key, and
this one is reachable by every signed-in reader. Taking offsets means the only
thing that can ever be explained is fiction somebody published on Scribe. The
offsets are validated against the real body — past the end is a 409 telling the
reader the chapter changed under them, not a slice of whatever now sits there.

The cost is paid on the client: `lib/chapter-markdown.tsx` renders `**cold**`
as `cold`, so a DOM offset is not a source offset. `lib/chapter-selection.ts`
bridges the two by searching the source for what the reader highlighted, loosely
enough to survive collapsed newlines and emphasis markers, and returns null
rather than a guess when it cannot place the selection — in which case the UI
offers no button at all.

### Generated state lives on the server

`POST /api/ai/generate/{idea,character,outline}` returns variants plus a
`sessionId`; `POST /api/ai/generate/refine` takes that id, a position and an
instruction — **never the object being revised**. The conversation that produced
each variant is held in Redis under a key that includes the caller's id, with a
30-minute TTL refreshed on each refinement.

Three properties follow, and each is the reason for a rule:

- A client cannot pass arbitrary text off as the model's own output, because the
  object being refined is the one the server recorded.
- A session id taken from someone else's browser resolves to nothing, because
  the owner is part of the key rather than a field the code must remember to
  check.
- An expired session is a 404 that says so and tells the author to generate
  again — the common case is a tab left open, and it must not read as a fault.

Alternatives are generated **sequentially**, each told what the previous ones
were, so three options are three different options rather than three rewordings.
The count is capped at three in the route schema *and* in the service: it is the
one field whose value multiplies the bill.

### Two limits, not one

Every AI route is rate-limited per user, and `/api/ai/chat` is additionally
charged against a token budget. They answer different questions, which is why
both exist: twenty requests is twenty requests whether each one was a sentence
or a chapter, so `lib/rate-limit.ts` caps how *often* somebody can ask and
`services/ai/budget.ts` caps how much they can spend doing it.

The budget is checked before the call and charged after it, because what a
completion costs is not known until it has been generated — so it is a budget
rather than a hard stop, and a caller just under the ceiling can cross it by one
request's worth. Neither refusal counts as an attempt: a caller who was turned
away did not get to ask, and charging them for it would extend their own
lockout. A stream is charged even when the reader has already closed the tab,
because the tokens were generated either way.

`AI_DAILY_TOKEN_BUDGET=0` disables it. Persisted usage, spend by feature, an
admin view and the same check on every other feature are Task AI 18; this is
what makes the setting mean something in the meantime.

The two reader features are charged against it as well, and they are the reason
it stopped being enough to charge `/api/ai/chat` alone. Everything else here is
reachable by an *author*, working on their own story — a bounded population
doing bounded work. `/api/ai/explain` is reachable by every signed-in reader on
every published chapter, which makes it the widest-open AI surface in the app
and the first one where request-rate alone would not describe the spend.

### Generated content is cached by what it was generated from

The chapter recap is the first thing here that is *stored* rather than returned
and forgotten, and the rule it establishes is that the cache key is a hash of
the input, never a timestamp. `ai.ChapterSummary` holds the SHA-256 of the
chapter body the recap was written from; a request whose chapter still hashes
to the same value is answered from the table without a model call, and one
whose chapter has changed regenerates.

A timestamp would have been wrong in both directions. `Chapter.updatedAt` moves
when an author fixes a typo or saves without changing a word, so half the
regenerations would buy an identical paragraph — and it would not move at all
if a body were ever changed by a path that forgot to touch it, leaving a recap
of prose nobody can read any more.

The property worth keeping is that **invalidation needs no cooperation**.
`services/authoring.ts` does not import this feature and has no idea it exists;
an edit made through the ORM in a test invalidates the recap exactly as an edit
through the editor does. Anything else here that starts storing generated
content — summaries, extractions, embeddings — should key the same way.

What the hash covers is the text actually sent to the model, not the whole
body: a chapter longer than `CHAPTER_LIMIT` is summarised from its opening, so
hashing the truncated text means changing that limit re-summarises everything
rather than leaving long chapters with a recap of their first two-thirds.

Every stored row also carries the model and `RECAP_PROMPT_VERSION`, so a recap
that reads badly is traceable to the prompt that wrote it, and a fixed prompt
can select the rows that need regenerating.

### Streaming, in one place

Four routes stream — chat, Scribble, the assistant and explain — through
`writeEvent` and `reportStreamFailure` in `routes/ai.ts`. Headers are written on the *first*
event, never up front: every service does its authorisation and its first
provider call before yielding anything, so a 403 or a 503 still reaches
`errorHandler` as ordinary JSON. Committing to `200 text/event-stream` earlier
would turn those into fake successes carrying an error frame. After the first
byte `errorHandler` can no longer answer, so a mid-stream failure is reported
in-band as an `error` frame, and a stream that ends without its terminal event
is a failure the client must treat as one.

The browser side is `streamRequest` in `data/ai-api.ts`, shared by all four: `request()` always ends in `response.json()`, so streaming cannot go
through it, and the chunk-boundary handling is the part that is wrong
*intermittently* when it is wrong — which is the worst way to be wrong twice.

**Scribble constrains stage 1 and not stage 3**, on purpose. A filter object
that will not parse means no query ran at all, so the intent call is worth
constraining and repairing; narration already degrades gracefully (the rows are
shown without their sentences) and it is streamed, where a schema's effect on
delivery varies by provider and cannot be verified here without a key.

## Embeddings and the chunk table

Task AI 7 is the first infrastructure here rather than a feature: it produces
`ai.chapterChunk`, the table every later retrieval task reads. Nothing serves
it, nothing queries it yet, and the only way to fill it is
`pnpm --filter api seed:embeddings`.

### A second provider, not a third method

`aiProvider()` answers who writes prose; `aiEmbedder()` answers who turns a
passage into a vector, and they are configured separately — `AI_EMBED_*`
rather than `AI_*`. That is not symmetry for its own sake. This repo's own
`.env` points chat at a hosted OpenAI-compatible endpoint that serves **no**
embedding model, while embeddings stay on the Ollama container on this
machine. One interface would have forced an object to implement a method it
has no endpoint for, so `AiEmbedder` is its own interface with its own
implementations, and the defaults describe the local embedder whatever
`AI_PROVIDER` says.

The model is `nomic-embed-text` at **768 dimensions**, and that number is in
the database: the column is `vector(768)`. Changing the model to one of a
different width is a migration plus a re-embedding of the entire corpus, not a
config edit — which is why `AI_EMBED_DIMENSIONS` exists at all. A reply of the
wrong width is rejected on the first call with a message naming both numbers,
because the alternative is a backfill that spends minutes producing vectors
Postgres will refuse several statements later.

### The vector column is not in the contract

`docker-compose.yml` runs `pgvector/pgvector:pg17` — `pg_trgm` ships with
Postgres and `vector` does not — and the migration runs `CREATE EXTENSION
vector`. But the Prisma Next extension package that would let
`contract.prisma` write `pgvector.Vector(length: 768)` is not published for
this release, so the migration adds the column itself with explicit SQL and
`services/ai/embeddings.ts` reads and writes it through `db.raw.sql`.

Two consequences worth knowing before touching this:

- The contract describes every column of `ai.chapterChunk` **except**
  `embedding`. Plain `prisma db verify` passes — extras in the database are
  allowed — while `db verify --strict` will name it.
- Vectors cross the wire as pgvector's own text form, `[0.1,0.2,…]`, which is
  what `::vector` parses and `::text` produces. That is also what makes reuse
  cheap: an unchanged window's vector is copied out and back in as a string,
  never parsed into floats and never sent to a model.

Swap this for a declared column the day the extension package exists. Nothing
above the service changes.

### Chunks, and the numbers behind them

A chapter is the wrong retrieval unit in both directions — one vector for four
thousand words is an average of everything in them, and a reader asking a
question wants the passage rather than a pointer to eleven pages. So chapters
are split into overlapping windows of about 1200 characters with about 250
characters of overlap, on paragraph boundaries, and the window carries the
vector.

`chunking.ts` splits paragraphs on **any** run of newlines, which is
deliberately not what `paragraphsOf` in `apps/web/src/types/stories.ts` does.
The corpus is the reason: `seed:stories` joins paragraphs with a blank line,
but chapters written in the editor separate them with a single newline, and in
the seeded serial that is most of them — one nine-thousand-character chapter
holds 459 newlines and not one blank line, because every line of dialogue is
its own paragraph. Splitting on blank lines only treated those chapters as one
enormous paragraph and fell through to the 2000-character sentence splitter:
measured on the seeded corpus, 66 of 161 windows were cut at exactly the limit
rather than at a boundary. After the change every window ends where a
paragraph does. (That the reader page splits the other way is why those
chapters render as one block — a rendering bug, and a different one.)

### Almost every run does nothing, and that is the feature

Embedding is the most duplicated cost in this backlog: the corpus barely
changes and the backfill is re-run whenever anybody adds a story. Three things
make the repeat free, and they are the same idea at three grains:

- **Chunking is deterministic.** The same prose always yields the same windows
  in the same order with the same hashes.
- **The chapter fast path.** If every stored row already matches the chunk it
  would produce — same ordinal, same hash, same model, same width — nothing is
  read from a model and nothing is written. Over the seeded corpus that is 21
  of 21 chapters and two seconds.
- **Per-chunk reuse.** When a chapter *has* changed, only the windows whose
  text changed are embedded; the rest keep the vectors they had. This is why
  the hash is of the chunk's own text rather than of the whole chapter body,
  which is where `ChapterSummary` hashes instead. A chapter-level hash is right
  for a chapter-level summary and wrong here: it would make a one-word edit
  cost a full re-embedding, which is the bill this column exists to avoid.

The model and the width are part of every comparison, because vectors from two
models are not comparable. Changing `AI_EMBED_MODEL` re-embeds everything, and
this is where that is noticed rather than where it silently produces distances
that mean nothing.

A chapter is replaced in one transaction, so it is never half re-embedded: a
failure leaves the previous set intact rather than a mixture of two versions,
which would retrieve as neither.

### Drafts are not embedded, for now

`embedChapter` embeds whatever it is given — it is the mechanism. The policy
is in the backfill, which takes published chapters of listed stories only
unless passed `--all`.

A vector index does not know a draft is a draft. That rule lives in `visibleTo`
in `services/stories.ts`, and applying it to search results is Task AI 8's
problem — stated in its prompt, because an embedding leak exposes unpublished
writing. Until search exists and enforces it, the cheapest defence is for
unpublished prose not to be in the index at all. Note that this is *not*
sufficient on its own even then: a chapter can be embedded and then
unpublished, so AI 8 must filter regardless.

### What is not here

No ANN index and no search. Both are Task AI 8, which is also where the
operator class and the fusion rule get decided. The rows carry `storyId`
denormalised from the chapter so that a filter does not need a join, which is
the one thing retrieval needed from this task's schema.

## Adding a feature

1. A prompt module under `services/ai/prompts/` — never a template literal in a
   route.
2. A function in `services/ai/<feature>.ts` that builds the request, calls
   `aiProvider()`, and validates what comes back with zod before it is stored or
   returned. If the reply is an object rather than prose, put its schema in
   `schemas.ts` and call `completeStructured` — never hand-write a second JSON
   schema for the wire.
3. A route in `routes/ai.ts`: `requireUser`, `parseOrThrow` on the body, a rate
   limit, `try/catch/next(error)`.
4. A `feature` string for the usage record, so cost stays attributable.
5. Tests with the fake: what was sent, how the reply parsed, what happens when
   the reply is malformed.

## What is deliberately missing

- **A hosted provider.** `build()` throws a 503 for `anthropic` with a comment
  saying why: an abstraction over two implementations written before either is
  exercised is a guess. The seam is shaped and the second file is small when
  there is a key to test it with.
- **The remaining features.** Retrieval and everything built on it — Tasks AI
  8 onward. Of Task AI 6 only the chapter recap was built; the story-level
  summary, the spoiler-free summary and the map-reduce that a multi-chapter
  summary needs are not here.
- **Persisted usage, and budgets everywhere else.** The sink still only logs,
  and the table is Task AI 18. `services/ai/budget.ts` enforces
  `AI_DAILY_TOKEN_BUDGET` on `/api/ai/chat` and on both reader features
  (`/api/ai/recap` and `/api/ai/explain`, where every signed-in reader can
  reach it rather than only authors); Scribble, the assistant and generation
  are still rate-limited by *request* only, which caps the blast radius but
  not the spend.
- **Retrieval.** The corpus is embedded, but nothing reads the table: the ANN
  index, semantic and hybrid search, and the rule that a draft never appears in
  a result are Task AI 8.
- **A hosted embedder in practice.** `createOpenAiCompatibleEmbedder` exists
  and is untested against a real provider, because the hosted endpoint this
  repo points at serves chat only.

## Running it

```bash
docker compose --profile ai up -d ollama
docker compose exec ollama ollama pull llama3.2:3b        # chat
docker compose exec ollama ollama pull nomic-embed-text   # embeddings, ~275 MB

curl http://localhost:11434/api/chat -d '{
  "model": "llama3.2:3b",
  "messages": [{ "role": "user", "content": "Say hello in five words." }],
  "stream": false
}'
```

With the container running, nothing else is required: the defaults in
`config.ts` describe exactly this setup. See `AI-BACKLOG.md` § *Running it for
free* for model choices and what is worse locally.

The embedding table starts empty and nothing fills it automatically — there is
no job runner (Task AI 20) and nothing embeds on publish:

```bash
pnpm --filter api seed:embeddings
```

Over the seeded corpus that is 244 windows across 21 chapters, about three
minutes on CPU the first time and two seconds every time after. Postgres must
be the `pgvector/pgvector:pg17` image `docker-compose.yml` now specifies; an
existing data volume needs nothing but `docker compose up -d postgres`, plus a
one-off `REINDEX` noted in that file for the collation change.
