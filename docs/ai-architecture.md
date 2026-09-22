# AI architecture

How an AI request flows through Scribe, what each layer is responsible for, and
what a new AI feature has to add. Written for the state after Tasks AI 0, AI 1.5,
AI 3, AI 4 and AI 5 of `AI-BACKLOG.md`: the module and the provider seam exist, a
model can be asked for a shape rather than for prose that looks like one, and
three features are built on that — Scribble for readers, the idea studio and the
writing assistant for authors.

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
| `services/ai/provider.ts` | Constructs the provider (once), wraps it with retry and usage policy, and hands it out via `aiProvider()`. The only place a client is built. |
| `services/ai/usage.ts` | Where usage records go. Logs today; Task AI 18 swaps the sink for one that also persists. |
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

### Streaming, in one place

Two routes stream — Scribble and the assistant — through `writeEvent` and
`reportStreamFailure` in `routes/ai.ts`. Headers are written on the *first*
event, never up front: every service does its authorisation and its first
provider call before yielding anything, so a 403 or a 503 still reaches
`errorHandler` as ordinary JSON. Committing to `200 text/event-stream` earlier
would turn those into fake successes carrying an error frame. After the first
byte `errorHandler` can no longer answer, so a mid-stream failure is reported
in-band as an `error` frame, and a stream that ends without its terminal event
is a failure the client must treat as one.

The browser side is `streamRequest` in `data/ai-api.ts`, shared by both
features: `request()` always ends in `response.json()`, so streaming cannot go
through it, and the chunk-boundary handling is the part that is wrong
*intermittently* when it is wrong — which is the worst way to be wrong twice.

**Scribble constrains stage 1 and not stage 3**, on purpose. A filter object
that will not parse means no query ran at all, so the intent call is worth
constraining and repairing; narration already degrades gracefully (the rows are
shown without their sentences) and it is streamed, where a schema's effect on
delivery varies by provider and cannot be verified here without a key.

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
- **The remaining features.** Tasks AI 1 onward.
- **Persisted usage and budgets.** The sink exists; the table is Task AI 18. So
  is enforcement: `config.ts` reads `AI_DAILY_TOKEN_BUDGET` and nothing honours
  it yet. `routes/ai.ts` rate-limits *requests* per user, which caps the blast
  radius but not the spend.
- **Embeddings.** `AiProvider` has no `embed` yet; Task AI 7 adds it along with
  the model and dimension decision.

## Running it

```bash
docker compose --profile ai up -d ollama
docker compose exec ollama ollama pull llama3.2:3b

curl http://localhost:11434/api/chat -d '{
  "model": "llama3.2:3b",
  "messages": [{ "role": "user", "content": "Say hello in five words." }],
  "stream": false
}'
```

With the container running, nothing else is required: the defaults in
`config.ts` describe exactly this setup. See `AI-BACKLOG.md` § *Running it for
free* for model choices and what is worse locally.
