/**
 * The assistant with tools: a model that decides what to look up (Task AI 15).
 *
 * Ask This Book has one fixed retrieval step -- embed the question, fetch
 * passages, answer. Here the model is offered the tools in `tools.ts` and
 * chooses: search for a story, then search its chapters, then answer; or look
 * up an author's story bible; or answer straight away when nothing needs
 * looking up. The model chooses, the code executes, and everything that makes
 * that safe is in the code.
 *
 * **The loop is hand-written, not an SDK tool runner.** There is no model SDK
 * in this repo -- the provider seam speaks HTTP to an OpenAI-compatible server
 * or to Ollama (see `provider.ts`) -- and the loop needs three things a
 * generic runner does not give: a per-request token budget checked before
 * every call, a cap on tool calls separate from the cap on model calls, and a
 * last call that is *forced* to answer rather than one that simply stops. All
 * of that is the forty lines of `runAgent`, so the runner would have bought
 * little and hidden the part this task exists to teach.
 *
 * Bounds, each tested:
 *
 * - `MAX_TOOL_CALLS` tool executions per request. Calls past it are answered
 *   with an error result rather than run, and the next model call is the last.
 * - `MAX_MODEL_CALLS` model calls per request, the last one with tools
 *   forbidden (`toolChoice: "none"`), so the loop ends with an answer however
 *   the model behaves.
 * - `TOKEN_BUDGET` tokens per request, checked before each call. A request
 *   that has spent it stops without another call.
 *
 * Logged: every tool decision (name, outcome, duration, error code) and the
 * request's totals -- never arguments or results, which carry the user's
 * question and other members' writing; `usage.ts` explains why that line is
 * held. The full trace, arguments included, goes back to the caller, who is
 * the only person entitled to it.
 *
 * **Streamed as progress, not as tokens.** What takes the time is the lookups
 * between model calls, so `agentEvents` yields each lookup as it starts and
 * as it finishes, then the answer whole. `runAgent` is the same loop read to
 * the end, for the JSON route.
 *
 * **Memory is the caller's.** Earlier exchanges arrive with each request
 * (bounded by `HISTORY_LIMIT` and `HISTORY_ANSWER_LIMIT`) and are given to the
 * model as fenced context, never as a source; see `prompts/agent.ts`. Nothing
 * is stored, and nothing in the history can widen what a tool returns,
 * because every tool still runs as the session's user.
 *
 * **Proposals are data, not a paused run (Task AI 21).** On the author's own
 * story the model is also offered `propose_edit`, and what it proposes comes
 * back on `done` beside the answer. Accepting one happens in the editor and
 * never returns here, so there is no run to suspend and resume -- the hard
 * part of human-in-the-loop, avoided rather than solved.
 */

import { logger } from "../../lib/logger.js";
import {
  AGENT_SYSTEM_PROMPT,
  AGENT_WRAP_UP,
  agentMessage,
  toolResultMessage,
  type AgentExchange,
} from "./prompts/agent.js";
import { aiProvider } from "./provider.js";
import {
  editingFor,
  RESULT_LIMIT,
  runTool,
  toolDefinitions,
  toolsFor,
  type EditProposal,
  type ToolContext,
  type ToolOutcome,
} from "./tools.js";
import type { AiMessage } from "./types.js";

const FEATURE = "agent";

/** A request, not a document: the tools fetch the long text. */
export const MESSAGE_LIMIT = 500;

/**
 * Tool executions per request.
 *
 * Six covers the longest honest path -- find a story, read its summary,
 * search two different things in it, check a fact, check a chapter -- with
 * none to spare for a model circling the same lookup, which is the behaviour
 * the cap exists to stop.
 */
export const MAX_TOOL_CALLS = 6;

/**
 * Model calls per request, including the forced last one. Lower than tool
 * calls plus one because a model can ask for several tools in one turn.
 */
export const MAX_MODEL_CALLS = 5;

/**
 * Input plus output tokens across every call of one request.
 *
 * Each call re-sends the whole conversation, tool results included, so the
 * cost of a loop grows with the square of its length; a budget on the sum is
 * the honest bound. Twenty thousand is about four full turns with a page of
 * results each -- several Ask This Book answers' worth.
 */
export const TOKEN_BUDGET = 20_000;

/** Per call. The answer is a few sentences; reasoning models count thinking too. */
const MAX_TOKENS = 900;

/**
 * Earlier exchanges a request may carry. Enough for "and her sister?" to
 * resolve three questions later; every one is re-sent on every model call of
 * the loop, so this is a cost bound as much as a relevance one.
 */
export const HISTORY_LIMIT = 6;

/** Characters of one earlier answer. Answers are a few sentences by prompt. */
export const HISTORY_ANSWER_LIMIT = 2_000;

export type { AgentExchange, EditProposal };

export interface AgentInput {
  message: string;
  /** The story the user is looking at, if any: what "this story" means. */
  storyKey: string | null;
  /** This conversation so far, oldest first. Context only; see the header. */
  history?: readonly AgentExchange[];
}

export interface AgentStep {
  tool: string;
  /** As parsed, or the raw text when they did not parse. */
  arguments: unknown;
  /** `skipped` means the call cap had been reached and it was not run. */
  outcome: ToolOutcome | "skipped";
  code?: string;
  durationMs: number;
}

/**
 * - `answered`: the model answered of its own accord.
 * - `tool_limit`: the tool-call cap forced the last call.
 * - `model_call_limit`: the model-call cap forced the last call.
 * - `token_budget`: the request ran out of tokens; the answer is a fixed one.
 */
export type AgentStop =
  | "answered"
  | "tool_limit"
  | "model_call_limit"
  | "token_budget";

export interface AgentAnswer {
  answer: string;
  /** Edits for the author to accept or reject; empty unless it is their story. */
  proposals: EditProposal[];
  steps: AgentStep[];
  stoppedBy: AgentStop;
  modelCalls: number;
  tokensUsed: number;
}

/**
 * What the stream says, in order: zero or more `lookup` / `step` pairs, then
 * one `done`. A `lookup` carries the tool's name only -- its arguments are
 * not validated until it runs, and the `step` that follows has them as parsed.
 */
export type AgentEvent =
  | { type: "lookup"; tool: string }
  | { type: "step"; step: AgentStep }
  | ({ type: "done" } & AgentAnswer);

/** Said when a forced answer came back empty, rather than an empty bubble. */
const NO_ANSWER =
  "I couldn't put together an answer from what I found. Try asking more specifically.";

const OUT_OF_BUDGET =
  "That needed more looking up than I can do for one question. Try asking something narrower.";

/** A result as text for the model, bounded by `RESULT_LIMIT`. */
function resultText(result: unknown): string {
  const json = JSON.stringify(result) ?? "null";
  return json.length > RESULT_LIMIT
    ? `${json.slice(0, RESULT_LIMIT)}… (truncated: ask for something narrower)`
    : json;
}

/**
 * Runs the loop for one request and returns its answer, as `context.userId`.
 *
 * Throws only for what a route should turn into a status: AI not configured,
 * a provider failure on a model call, an abort. A tool failing does not throw
 * -- see `runTool`.
 */
export async function runAgent(
  input: AgentInput,
  context: ToolContext,
): Promise<AgentAnswer> {
  for await (const event of agentEvents(input, context)) {
    if (event.type === "done") {
      const { type: _type, ...answer } = event;
      return answer;
    }
  }
  // The generator always ends on `done` or throws.
  throw new Error("agent: the loop ended without an answer");
}

/**
 * The loop, as events. Nothing is yielded before the first model call has
 * returned, so a failure there -- not configured, provider down -- still
 * reaches the route before it has committed to streaming.
 */
export async function* agentEvents(
  input: AgentInput,
  context: ToolContext,
): AsyncGenerator<AgentEvent> {
  const provider = aiProvider();
  // Resolved once, from the session's user: whether this request may propose
  // edits, and to which story. Nothing the model or the history says changes it.
  const editing = await editingFor(input.storyKey, context.userId);
  const toolContext: ToolContext = editing ? { ...context, editing } : context;
  const tools = toolDefinitions(toolsFor(toolContext));

  const messages: AiMessage[] = [
    { role: "user", content: agentMessage(input) },
  ];
  const steps: AgentStep[] = [];
  let tokensUsed = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  /** Set once a cap has been reached: the next call is the last. */
  let forcedBy: AgentStop | null = null;

  const finish = (answer: string, stoppedBy: AgentStop): AgentEvent => {
    logger.info(
      { agent: { modelCalls, toolCalls, tokensUsed, stoppedBy } },
      "agent request",
    );
    return {
      type: "done",
      answer,
      proposals: editing?.proposals ?? [],
      steps,
      stoppedBy,
      modelCalls,
      tokensUsed,
    };
  };

  for (;;) {
    if (tokensUsed >= TOKEN_BUDGET) {
      yield finish(OUT_OF_BUDGET, "token_budget");
      return;
    }

    if (forcedBy === null && modelCalls === MAX_MODEL_CALLS - 1) {
      forcedBy = "model_call_limit";
    }
    const last = forcedBy !== null;

    const completion = await provider.complete({
      feature: last ? `${FEATURE}.answer` : FEATURE,
      system: AGENT_SYSTEM_PROMPT,
      messages: last
        ? [...messages, { role: "user", content: AGENT_WRAP_UP }]
        : messages,
      tools,
      toolChoice: last ? "none" : "auto",
      maxTokens: MAX_TOKENS,
      ...(context.signal ? { signal: context.signal } : {}),
    });

    modelCalls += 1;
    tokensUsed += completion.usage.inputTokens + completion.usage.outputTokens;

    const calls = completion.toolCalls ?? [];
    // `last` is checked as well as `calls`: a server that ignored "none" and
    // called a tool anyway still does not get another turn.
    if (calls.length === 0 || last) {
      const answer = completion.text.trim();
      yield finish(answer === "" ? NO_ANSWER : answer, forcedBy ?? "answered");
      return;
    }

    messages.push({ role: "assistant", content: completion.text, toolCalls: calls });

    for (const call of calls) {
      if (toolCalls >= MAX_TOOL_CALLS) {
        // Answered rather than dropped: every call in the history needs a
        // result, or the next request is malformed.
        const skipped: AgentStep = { tool: call.name, arguments: null, outcome: "skipped", durationMs: 0 };
        steps.push(skipped);
        yield { type: "step", step: skipped };
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: toolResultMessage(
            resultText({ error: "Not run: the lookup limit for this request was reached." }),
          ),
        });
        continue;
      }

      toolCalls += 1;
      yield { type: "lookup", tool: call.name };
      const run = await runTool(call, toolContext);

      logger.info(
        {
          agent: {
            tool: call.name,
            outcome: run.outcome,
            code: run.code,
            durationMs: run.durationMs,
          },
        },
        "agent tool call",
      );

      const step: AgentStep = {
        tool: call.name,
        arguments: run.arguments,
        outcome: run.outcome,
        ...(run.code ? { code: run.code } : {}),
        durationMs: run.durationMs,
      };
      steps.push(step);
      yield { type: "step", step };
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: toolResultMessage(resultText(run.result)),
      });
    }

    if (toolCalls >= MAX_TOOL_CALLS) forcedBy ??= "tool_limit";
  }
}
