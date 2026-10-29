# Scribe — AI work after the CopilotKit assessment

Companion to `AI-BACKLOG.md`, which ends at Task AI 20. Same format: each task
is a self-contained prompt you can hand to an implementer, and the house-rules
block from `AI-BACKLOG.md` applies to every one of them unchanged.

This file exists because of one question — *should Scribe integrate
[CopilotKit](https://github.com/CopilotKit/CopilotKit)?* — and records the
answer, the reasons, and the work that answer leads to. Assessed 2026-10-29
against `c526981`, with CopilotKit at **1.83.0** and AG-UI at **1.0.3**.

## The decision

**Not yet.** Of the five things CopilotKit was considered for, Scribe already
does four — the writing assistant, the book assistant, the story planner and
context-bounded prompting — and does them with server-side rules CopilotKit
would not replace. The fifth, an assistant that *proposes* an edit for the
author to accept or reject, is a gap, and it is small enough to build on the
stack that exists (Task AI 21).

| Use case | Already in the tree | Gap | Needs CopilotKit? |
| --- | --- | --- | --- |
| Writing assistant | `assist.ts`, `AssistPanel.tsx`: eight actions, a ~300-token window, story-bible facts, Accept / Reject / Regenerate, range re-checked before applying | No dialogue or pacing action | No — Task AI 22 |
| Book assistant | Ask This Book, conversations, explain, recap, story summary | — | No |
| Story planner | Idea Studio (idea, character, outline, refine), story bible, continuity | No plot twists | No — Task AI 23 |
| Interactive editing | Accept / reject on a selection the author made | The editor assistant cannot propose an edit | No — Task AI 21 |
| Context-aware assistance | `windowFor`, `factsForPrompt`, the spoiler bound, bounded conversation prompts, the agent's token budget | — | No |

Why not adopt it anyway, for the UI:

- **The easy path bypasses the provider seam.** CopilotKit's `BuiltInAgent`
  calls models itself through the Vercel AI SDK, so no budget, no usage rows,
  no kill switches, no retries, no feature routing. The only acceptable shape
  is a hand-written adapter over `agentEvents`, and that adapter is the
  integration — the chat UI is the cheap part.
- **It moves the decision about context to the browser.** `useAgentContext`
  and AG-UI's `context` / `state` / `messages` are sent by the client on every
  run. Scribe decides on the server what reaches a model, and the reader
  features take offsets rather than prose precisely so that it can.
- **The dependency tree.** `@copilotkit/react-core` is ~12.9 MB unpacked
  (recharts, katex, lit, radix, tailwind-merge, its own inspector, a GraphQL
  client); `@copilotkit/runtime` brings the Vercel AI SDK, graphql-yoga,
  type-graphql, hono, the MCP SDK, a LangGraph adapter, Segment analytics, a
  licence verifier and zod 3 beside our zod 4. The web app's runtime
  dependencies today are React, React DOM and the router.
- **Paid and default-on parts.** Persisted threads are Intelligence (or an
  in-memory runner whose thread routes the docs say are unauthorised by
  default); `selfManagedAgents` is documented as Enterprise Intelligence;
  runtime telemetry is on until `COPILOTKIT_TELEMETRY_DISABLED=true`.
- **Its styling.** The prebuilt chat brings its own Tailwind-derived look.
  Scribe's UI is its own tokens and components, so we would use the headless
  hooks and draw everything ourselves — at which point CopilotKit is an event
  client and a tool registry.

What *is* worth keeping an eye on is **AG-UI**, the open (MIT) protocol
underneath CopilotKit: a POST of `{ threadId, runId, state, messages, tools,
context, forwardedProps }` answered by an SSE stream of typed events
(`RunStarted`, `TextMessage*`, `ToolCall*`, `StateSnapshot` / `StateDelta`,
`RunFinished`, `RunError`). Our agent stream is already close to it. Task AI 24
makes it match, which keeps every later option open for very little.

**LangGraph is not justified.** Our workflows are bounded loops (at most five
model calls) and fixed pipelines, and slow work already runs on the Redis job
queue. LangGraph earns its place with long, checkpointed, branching workflows
that pause across requests — planning a novel over days with an approval at
each stage. Revisit if a task here ever needs that; it would mean a Python
service or LangGraph JS with a Postgres checkpointer, and it would duplicate
`agent.ts`.

**Order:** AI 21 first — it is the only real gap. AI 22 and AI 23 are
independent and small; do them whenever. AI 24 is optional. AI 25 only after
AI 21 has shipped and AI 24 exists, and only if a second agentic surface wants
it.

---

## Task AI 21 — The editor assistant proposes, the author decides

**Do this first.** It is the one use case from the assessment Scribe does not
already cover, and it tests whether authors want agent-proposed edits before
anything is spent on a framework for them.

**What exists.** **Ask about this story** (`components/ai/StoryAssistant.tsx`)
runs the tool loop in `services/ai/agent.ts` over five read-only tools in
`tools.ts`; none can write, and that is asserted in `ai-agent.test.ts`. The
writing assistant already has the accept path this task needs:
`AssistPanel.tsx` shows the original beside the suggestion, and
`acceptAssist` in `pages/author/StoryEditorPage.tsx` re-checks the range and
applies through `patchChapter`, the same path as the formatting toolbar.
`search_chapters` already reads an author's drafts through `listMyChapters`.

**What is missing.** The assistant can tell an author "her eyes are green in
chapter 2 and grey in chapter 5" but cannot offer the fix. The author copies
the sentence, finds it, and rewrites it by hand.

**The shape.** A proposal is *output*, not an action. The agent's answer
carries zero or more proposals; nothing is written until the author accepts
one in the editor. Accepting does not go back to the model, so no
pause-and-resume is needed — which is the hard part of every
human-in-the-loop framework, and the reason this does not need one.

**Prompt:**

> Let the editor assistant propose edits to the author's own chapters, which
> the author previews and accepts or rejects. Nothing is written by the server.
>
> Server:
> - A sixth tool, `propose_edit`, in `services/ai/tools.ts`:
>   `{ chapterNumber, quote, replacement, reason }`, all bounded in the zod
>   schema (quote and replacement under `SELECTION_LIMIT` from `assist.ts`,
>   reason a sentence). It asserts the story is the caller's with
>   `assertStoryOwned`, reads the chapter through `listMyChapters` (drafts
>   included), and refuses unless `quote` occurs in it **exactly once**.
>   It writes nothing; it returns `{ accepted: true, proposalId }` so the model
>   knows the proposal was recorded and can say so.
> - `agent.ts` collects the proposals that succeeded and returns them on
>   `done` (and in `runAgent`'s answer) as
>   `{ id, chapterId, chapterNumber, quote, replacement, reason }`. Cap them per
>   request — three is plenty — and count `propose_edit` against
>   `MAX_TOOL_CALLS` like any other tool.
> - The tool is offered **only** when the request has a `storyId` the caller
>   owns. A reader asking about someone else's story is never shown it.
> - `prompts/agent.ts`: one rule — propose with the tool, never claim to have
>   changed the text, never paste a rewritten passage into the answer instead
>   of proposing it. Bump the version, add a history line, update the snapshot.
>
> Client:
> - `data/ai-api.ts`: the proposal type on the agent's `done` event.
> - `StoryAssistant.tsx`: under an answer, one card per proposal — the quote
>   and the replacement side by side, reusing `assist.css`'s two columns, the
>   reason, **AI suggestion** label, Accept and Reject.
> - `StoryEditorPage.tsx`: accepting applies to the open chapter only. If the
>   proposal is for another chapter, say "Open chapter N to apply this". Find
>   `quote` in `active.body` — the editor's buffer, which is the truth — and
>   apply only if it occurs exactly once; otherwise say the passage changed and
>   apply nothing, as `acceptAssist` does. Apply through `patchChapter`.
>
> The server checks against the saved chapter and the client against the
> buffer; they can disagree while a save is pending, and the client's check is
> the one that guards the author's text.
>
> Tests (`routes/ai-agent.test.ts`, `services/ai/tools.test.ts`, with the
> fake provider):
> - a proposal on the caller's own chapter comes back on `done`;
> - a proposal on another author's story is `refused`, and the tool is not
>   offered at all without an owned `storyId`;
> - a quote that is absent, or present twice, is `refused`;
> - **no chapter row changes** after a run that proposed edits;
> - the per-request cap holds;
> - the prompt snapshot and its planted-injection case still pass.
>
> Learn: human-in-the-loop as data rather than as a paused run, anchoring an
> edit by content instead of offsets, and why "the model cannot write" is a
> property worth keeping when the model starts suggesting writes.

---

## Task AI 22 — Dialogue and pacing in the writing assistant

**Small and independent.** Two of the assessment's writing-assistant asks —
*improve dialogue* and *improve pacing* — have no action of their own. `improve`
covers them loosely, which is not the same as being asked.

**What exists.** `ASSIST_ACTIONS` in `services/ai/assist-types.ts`, one
instruction per action in `prompts/assist/actions.ts`, a token budget per
action in `assist.ts`, labels in `components/ai/assist-actions.ts`.

**Prompt:**

> Add two writing-assistant actions, `dialogue` and `pacing`.
>
> - `dialogue`: tighten the spoken lines in the selection — distinct voices,
>   fewer dialogue tags, no exposition said aloud — while keeping who says what
>   and every event. Prose between lines may change only as far as the lines
>   need.
> - `pacing`: adjust the rhythm of the selection — vary sentence length, cut
>   what stalls, slow what is rushed — while keeping every event, name and
>   piece of information.
>
> One instruction each in `prompts/assist/actions.ts`, a token budget each in
> `assist.ts` (same as `improve`), labels in `assist-actions.ts`. Bump
> `ASSIST_PROMPT`'s version with a history line and update the snapshots.
> Nothing else changes: the window, the bible facts, the accept path.
>
> Tests: the route accepts both actions; each renders its own instruction; the
> planted-injection case covers them. Add an `ai:eval` case for each using the
> assistant's existing graders (no preamble, names kept).
>
> Learn: that a prompt is data, and adding a capability can be one line of it
> plus a test.

---

## Task AI 23 — Plot twists in the Idea Studio

**Small and independent.** The planner generates premises, characters and
outlines; *suggest a plot twist* is the one ask from the assessment it does
not cover.

**What exists.** `GENERATION_KINDS` (`idea`, `character`, `outline`) in
`services/ai/generate-types.ts`, schemas in `schemas.ts`, prompts in
`prompts/generate.ts`, one route per kind generated in a loop in
`routes/ai.ts`, sequential variants that are told about each other, refinement
held in Redis, and `IdeaStudioPage.tsx`.

**Prompt:**

> Add a fourth generation kind, `twist`, for a story the caller owns.
>
> - Schema in `schemas.ts`: `{ twist, setup, payoff, risks }` — what changes,
>   what earlier chapters must already have planted, where it pays off, and
>   what it would contradict.
> - The seed requires a `storyId` (owned, checked where the other kinds check
>   it). The prompt is given the story's premise and a bounded selection of its
>   story-bible facts — `factsForPrompt` or the same budget — never chapter
>   bodies. A twist that contradicts an established fact should say so in
>   `risks` rather than be silently suppressed.
> - Variants are sequential and told about each other, as the other kinds are,
>   so three twists are three different twists.
> - A **Twists** tab in the Idea Studio for a chosen story. Nothing is written
>   to the story; the author copies what they want.
>
> Tests: the route requires an owned story; the bible facts sent are bounded;
> the reply is validated and repaired once like the other kinds; refinement
> works on a twist session.
>
> Learn: grounding generation in the author's own facts rather than in their
> whole manuscript.

---

## Task AI 24 — The agent's stream in AG-UI's shape (optional)

**Optional.** Do this only if a CopilotKit trial (AI 25) or another AG-UI
client is a real prospect. It is the cheap way to keep that door open: the
protocol without the UI library.

**What exists.** `agentEvents` in `agent.ts` yields `lookup`, `step` and
`done`; `writeEvent` and `reportStreamFailure` in `routes/ai.ts` send them as
SSE, with headers written on the first event so a 401, 429 or 503 is still
JSON. `@ag-ui/core` and `@ag-ui/encoder` are MIT; core's only peer is zod.

**Prompt:**

> Add `POST /api/ai/agent/agui`, the same loop as `/agent/stream`, speaking
> AG-UI. Leave the existing route and `StoryAssistant.tsx` exactly as they are.
>
> - Map `agentEvents` onto AG-UI events: `RunStarted`; each tool as
>   `ToolCallStart` / `ToolCallArgs` / `ToolCallEnd` / `ToolCallResult`; the
>   answer as `TextMessageStart` / `TextMessageContent` / `TextMessageEnd`;
>   AI 21's proposals as `propose_edit` tool calls; then `RunFinished`, or
>   `RunError` in place of it. Use `@ag-ui/core`'s types and `@ag-ui/encoder`.
> - The input is AG-UI's `RunAgentInput`, and **every part a browser controls
>   is untrusted**: identity comes from the session through `startAgent`, never
>   from `forwardedProps` or `state`; `messages` is cut to `HISTORY_LIMIT`
>   exchanges and fenced as the current history is; `context` is dropped (or
>   fenced, if a real use appears); client-declared `tools` are refused, so a
>   browser cannot add or shadow a server tool.
> - Keep the late-header rule: authorisation, rate limit, budget and the first
>   provider call happen before `RunStarted` is written.
>
> Tests: the event sequence for a run with two lookups and an answer; a forged
> `forwardedProps.userId` changes nothing; a 25-exchange `messages` array
> sends no more than the current route does; client `tools` are refused; a
> provider outage is still a JSON 503.
>
> Learn: what an agent–UI protocol standardises (events, tool calls, state)
> and what it cannot (who the caller is, what is safe to send a model).

---

## Task AI 25 — A CopilotKit trial on `/ai-lab` (optional, gated)

**Only after AI 21 has shipped and AI 24 exists,** and only if a second agentic
surface wants it. Time-box it, keep it behind a flag on `/ai-lab`, and end it
with a written decision either way.

**Prompt:**

> Try CopilotKit's headless React hooks against Scribe's own agent and record
> whether it pays for itself.
>
> - API: add `@copilotkit/runtime`; mount
>   `createCopilotExpressHandler` from `@copilotkit/runtime/v2/express` at
>   `/api/copilotkit` **after** `authenticate`, behind `requireUser` and a rate
>   limit, with `cors: false` (the app sets CORS). Register one agent in
>   `CopilotRuntime({ agents })`: an adapter over AI 24's event mapping. **Never
>   `BuiltInAgent`** — it bypasses the provider seam.
> - Set `COPILOTKIT_TELEMETRY_DISABLED=true` in `docker-compose.yml`,
>   `docker-compose.prod.yml`, `render.yaml` and `.env.example`.
> - Web: add `@copilotkit/react-core` and use `/v2` hooks only — `useAgent`,
>   and `useHumanInTheLoop` to render AI 21's proposals — with Scribe's own
>   components. No prebuilt chat, no `publicLicenseKey`, no Intelligence.
>
> The trial passes only if all of these hold, each shown by a test or a
> recorded check:
> - the caller set by `runAs` (`caller.ts`, an `AsyncLocalStorage`) survives
>   into the agent through the runtime's own async code, so usage rows and the
>   daily budget land on the right user;
> - a 401, a 429 with its `retryAfter`, and a 503 reach the user as clearly as
>   they do on `/agent/stream`;
> - the 15-minute access token is refreshed on long sessions;
> - `ai-security.test.ts` passes with the new route included in its every-route
>   checks;
> - the web bundle and the API's installed size grow by an amount someone has
>   looked at and accepted;
> - `pnpm typecheck` passes on TypeScript 6.
>
> Write the decision into this file: adopt for named surfaces, or remove the
> packages.
>
> Learn: the cost of a framework is measured in what it makes you re-prove.

---

## Housekeeping noticed during the assessment

- `docs/ai-architecture.md` § *What is deliberately missing* still lists
  **Answer regeneration** as missing. Commit `b561423` built it (regenerate
  an answer, edit a question, rebuild the summary); remove the bullet.

## Not to do, and why

- **`BuiltInAgent` or any model client outside `provider.ts`.** It skips the
  budget, usage records, kill switches, retries and feature routing at once.
- **`selfManagedAgents` / a browser talking straight to an agent endpoint.**
  It skips the runtime's server side, and the docs place it in the Enterprise
  tier.
- **CopilotKit threads or Intelligence.** `ai.Conversation` already persists
  conversations with ownership checked on every read.
- **LangGraph**, until a workflow needs durable, multi-request pauses. See the
  decision above.
- **Sending reader context from the browser.** Readers send chapter ids and
  offsets; the server reads the text. Keep it that way under any framework.

## Sources

- CopilotKit: [repository](https://github.com/CopilotKit/CopilotKit),
  [frontend tools](https://docs.copilotkit.ai/frontend-tools),
  [human-in-the-loop](https://docs.copilotkit.ai/human-in-the-loop),
  [shared state](https://docs.copilotkit.ai/shared-state),
  [runtime endpoints](https://docs.copilotkit.ai/backend/runtime-endpoints),
  [self-managed agents](https://docs.copilotkit.ai/backend/self-managed-agents),
  [reference](https://docs.copilotkit.ai/reference),
  [premium](https://docs.copilotkit.ai/premium),
  [telemetry](https://docs.copilotkit.ai/telemetry).
- AG-UI: [introduction](https://docs.ag-ui.com/introduction),
  [events](https://docs.ag-ui.com/concepts/events),
  [server quickstart](https://docs.ag-ui.com/quickstart/server).
- Versions, peers and dependencies: `npm view` on 2026-10-29.
