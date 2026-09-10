# AI architecture

How an AI request flows through Scribe, what each layer is responsible for, and
what a new AI feature has to add. Written for the state after Task AI 0 of
`AI-BACKLOG.md`: the module and the provider seam exist; no feature uses them
yet.

## The path

```
browser
  → POST /api/ai/…                       routes/ai.ts        (AI 1+)
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
| `services/ai/testing.ts` | `fakeAiProvider()` — records what it was sent, returns scripted replies. Every AI test uses it. |

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

## Adding a feature

1. A prompt module under `services/ai/prompts/` — never a template literal in a
   route.
2. A function in `services/ai/<feature>.ts` that builds the request, calls
   `aiProvider()`, and validates what comes back with zod before it is stored or
   returned.
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
- **Prompts, routes and features.** Tasks AI 1 onward.
- **Persisted usage and budgets.** The sink exists; the table is Task AI 18.
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
