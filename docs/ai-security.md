# AI security audit

Task AI 19. Every AI path in the API (`routes/ai.ts`, `services/ai/`, and the
two AI calls that run outside that router: comment moderation and the
continuity check a chapter save schedules) was audited against the checklist
in `AI-BACKLOG.md`. This records what was checked, what was found and fixed,
which test holds each line, and the residual risks that were accepted, with
reasons.

Audited 2026-10-21, against commit `1a1987a` plus the changes in this task.
Tests referred to are in `apps/api/src/`; `routes/ai-security.test.ts` holds the
ones written for this audit.

## Summary

| Item | Result | Held by |
| --- | --- | --- |
| Provider key reachable from the browser | Clean | `ai-security.test.ts` › no provider key |
| Every AI route has a session and a rate limit | **Fixed**: 10 routes had no rate limit | `ai-security.test.ts` › every AI route; `suspension.test.ts` |
| Inputs validated and bounded | Clean | `parseOrThrow` on every route; route suites |
| Retrieved and stored content is untrusted | Fixed in Task AI 17; re-tested here | `prompts/prompts.test.ts`; `ai-security.test.ts` › planted injection; `ai-ask`, `ai-agent`, `ai-reader` suites |
| Tool permissions | Clean (Task AI 15) | `ai-agent.test.ts` |
| Logging | **Fixed**: search queries reached the request log | `ai-security.test.ts` › logs |
| Retention and deletion | **Fixed**: usage rows outlived the account; nothing pruned them | `ai-security.test.ts` › account deletion; `ai:prune-usage` |
| Abuse | **Fixed**: a 429 did not say which limit or how long, outside a header | `ai-security.test.ts` › says which limit |

## 1. No provider key reachable from the browser

**Checked.** Every `VITE_` variable the web app reads, in source and in `.env`
files: `VITE_API_URL`, `VITE_API_PROXY_TARGET`, `VITE_DEV_USER_ID`,
`VITE_GOOGLE_CLIENT_ID`. The last is an OAuth *client* id, public by design.
No model key. The browser talks only to `/api/ai`. `/health` reports which
provider is selected and whether its credential is present, through
`describeAiConfig`, which returns neither the key nor the base URL.

No AI response echoes configuration. The one route that returns a model name
is `/api/ai/chat` (the dev workbench), and that is the provider's own model id.

**Test.** A scan of `apps/web` for any `VITE_` name containing KEY, SECRET,
TOKEN or PASSWORD, and a check that `/health` contains neither the key nor the
URL.

## 2. Every AI endpoint requires a session and is rate-limited

**Checked.** All 29 registrations in `routes/ai.ts`, plus the three generation
routes registered in a loop. Every one has `requireUser`. Ten had no rate
limit, because none of them calls a model:

- the reads: conversations, a conversation, a recap, a bible, a chapter's
  continuity, the admin spend view;
- the edits: bible fact add, edit and delete, finding dismissal and
  conversation delete.

The checklist allows no exceptions, and "calls no model" was an argument
rather than a guarantee.

**Fixed.** A baseline limiter on the whole AI router: 300 requests per caller
per ten minutes (`AI_BASELINE_REQUEST_LIMIT`), keyed by user, or by address for
an anonymous request. That is generous enough that browsing and editing never
meet it, and it stops a loop. Each feature's own, tighter limit still applies
on top.

**Also found.** `suspension.test.ts`, the guard that every write route has a
recorded suspension decision, only matched double-quoted paths, so the
generation routes (`/generate/${kind}`) were invisible to it. It now matches
template literals, and those routes carry their exemption explicitly.

**Test.** An anonymous read is a 401. A read past the baseline is a 429
naming `ai_requests`.

## 3. Every input validated and bounded

**Checked.** Every AI route parses its body, query or params with zod through
`parseOrThrow` before doing anything else, and every free-text field has a
maximum:

| Input | Bound |
| --- | --- |
| Chat prompt | 4,000 |
| Scribble message | 500 |
| Assist selection | capped, with context windows trimmed server-side |
| Ask and conversation questions | 300 |
| Agent message | 500 |
| Search query | 200 |
| Fact fields | per field |

Everything enumerable is an enum: assist action, explain mode, generation
kind, fact kind, spend window. The explain route takes offsets into a stored
chapter rather than prose, so it cannot be used as a general model proxy.

Model-chosen tool arguments are untrusted input too, and are parsed with
each tool's own zod schema (Task AI 15).

**No change needed.**

## 4. Retrieved and stored content is untrusted

**Checked.** Every path by which member-written text reaches a model:

- chapters (recap, explain, Ask This Book, the bible, continuity, the agent's
  `search_chapters`);
- comments (moderation);
- story descriptions (Scribble narration, agent tools);
- bible facts (assistant, continuity);
- earlier conversation turns and summaries;
- client-supplied previous filters (Scribble);
- tool results (agent).

Since Task AI 17 each reaches a prompt only through `fenced()`, which wraps it
in named markers and defangs it so it cannot forge a marker. Every system
prompt ends with the standing rule that fenced text is data, never
instruction.

Task AI 17 found and fixed the five builders that got this wrong:

- recap and explain fenced chapter text without defanging it;
- the assistant interpolated `tone` into its instruction line;
- Scribble wrote client filters into its system prompt;
- the agent named the story on screen outside any fence.

**Tests.** `prompts.test.ts` renders every message builder with an injection
planted in every input and fails if any of it lands outside a fence. It is
mutation-checked: 21 failures without the defang. This audit adds route-level
tests for the two stored paths that had none:

- a comment being moderated;
- a chapter read into the story bible.

Each runs through the real service, and asserts that the system prompt is the
constant and that the real closing marker appears exactly once.

## 5. Tool permissions

**Checked** in Task AI 15 and re-read here. Every tool runs as the session's
user, never as an argument; undeclared argument keys are stripped by zod. Each
tool reaches data only through the service the matching route uses. No tool
writes, widens a spoiler bound or calls a model. `ai-agent.test.ts` covers
refusal of another author's draft, bible and continuity findings, invalid
arguments, the call caps and a failing tool. **No change needed.**

## 6. Logging

**Checked.** Every log call on an AI path. All of them record ids, codes,
counts and durations, never text:

- the usage line;
- the agent's tool decisions;
- the error handler;
- cache and moderation warnings.

A provider's error body can quote the prompt. It is attached to the error as
a *non-enumerable* `upstreamDetail`, which pino's error serializer does not
write. That property was relied on without a test; it has one now.

**Found.** The request logger (`pino-http`) writes the full URL, and
`GET /api/ai/search?q=…` carries what a reader typed. Every search query was
in the request log.

**Fixed.**

- `app.ts` strips the query string from logged `/api/ai` URLs. The path is
  kept, so requests can still be traced.
- `AI_LOG_CONTENT=on` logs prompts and completions at debug level, through one
  function in `withPolicy`. `config.ts` forces it off when
  `NODE_ENV=production`, whatever the variable says.

**Test.** Logs are captured from the shared logger and every per-request child
while three things run:

- a successful call;
- a failed call whose error carries the secret in `upstreamDetail`;
- a search whose query is the secret.

The secret must appear nowhere, while the usage and request lines must be
present. With the flag on it appears, and with `NODE_ENV=production` the flag
reads off. Mutation-checked: removing the stripping fails the test.

## 7. Retention

Decided as follows.

| Data | Lives until | Deletion path |
| --- | --- | --- |
| Conversations, messages, citations | The owner deletes them, or the account goes | `DELETE /api/ai/conversations/:id`; foreign keys cascade from the account and from the story |
| Recaps (`ChapterSummary`) | The chapter changes (regenerated) or goes | Explicit delete in `deleteAccount` and `deleteStory`; written from a member's prose, so it goes with it |
| Story bible, extractions, continuity checks, findings, dismissals, chunks | The story or chapter goes | Cascade from story and chapter |
| `ai.UsageEvent` | **90 days** (`AI_USAGE_RETENTION_DAYS`), or until the account is deleted | `pnpm --filter api ai:prune-usage`; `deleteAccount` deletes the account's rows |
| Moderation decisions and scores | Kept | No text; a content hash and scores. They are the audit trail for an automated takedown |
| Redis: budgets, rate windows, query vectors, result cache, generation sessions | Their TTL: at most a day | Expiry |
| Logs | The log platform's retention | No content by default (§6) |

**Found.**

- `ai.UsageEvent` has no foreign key, deliberately: it is written
  fire-and-forget. So a deleted account's rows kept its id indefinitely.
- Nothing pruned the table.

**Fixed.**

- `deleteAccount` deletes the account's usage rows inside its transaction.
  `drainDeferredWrites`, which it already calls first, settles any row still
  in flight.
- `pruneUsage` and the `ai:prune-usage` script remove rows past the window.
  It becomes a scheduled job with Task AI 20.

**Test.** An account with a conversation, usage rows and a story-bible fact
is deleted through `DELETE /api/account/me`, and all three are gone.
Mutation-checked: skipping the usage delete fails it.

## 8. Abuse

**Checked.** A caller looping on an AI feature meets three limits in turn:

- the baseline (§2);
- the feature's own per-ten-minute limit;
- the daily token budget.

Since Task AI 18 the budget is enforced in the provider seam for every
feature, before the call.

**Found.** The 429 said "try again shortly" and put the wait only in
`Retry-After`. A client could not tell "wait a minute" from "come back
tomorrow". Detection was the spend view's heaviest callers, with nothing in
the log at the moment it happened.

**Fixed.**

- Every 429 body carries `retryAfterSeconds`.
- The limits added or touched here name themselves in `details.limit`:
  `ai_requests`, `daily_token_budget`.
- An exhausted budget logs `AI budget exhausted` with the user id and the
  limit, never what they asked.

**Test.** A read past the baseline and an assist call over budget both
return 429 with the limit's name and a positive `retryAfterSeconds`, and the
over-budget call never reaches the model.

## Residual risks, accepted

- **A model can still follow an injection it can read.** Fencing and the data
  rule make injected text clearly data. They do not make a model incapable of
  obeying it. What bounds the damage is that nothing a model says is trusted:
  - replies are validated;
  - citations are derived from what was sent;
  - tools are read-only and authorise as the caller;
  - moderation scores, never decides;
  - no model output is published without a person accepting it.
- **The provider sees the text.** Chapters, questions and drafts are sent to
  whichever provider is configured: Groq, in this deployment. That is a
  deployment decision with a data-processing agreement attached, not something
  code can remove. The local Ollama provider is the alternative.
- **The budget is behind by one call.** A completion's cost is known only
  after it is generated, so a caller just under the ceiling can cross it once
  per window. The Redis count is per rolling window and is not the audit;
  `ai.UsageEvent` is.
- **Explain results are shared between readers.** A cached explanation is
  served to anyone who highlights the same passage in the same mode. The key
  is computed after the visibility check, and the passage is text both readers
  can already see, so nothing crosses a permission boundary.
- **Conversations have no expiry.** They are private, deletable by their
  owner, and go with the account. An automatic expiry would delete something
  people come back to.
- **Moderation decisions are kept.** They hold no text, and they are the only
  record of why something was hidden automatically.
- **The dev identity header.** `X-Scribe-User-Id` lets a request act as any
  user when `ALLOW_DEV_USER_HEADER=true`. It is refused when
  `NODE_ENV=production`, and it is how the test suite authenticates. A
  non-production deployment that sets the flag is open; that is documented in
  `middleware/current-user.ts` and accepted for development.
- **Non-AI error logs.** A database error logged by the generic handler can
  include a constraint's values. That is outside the AI paths and was not
  audited here.
