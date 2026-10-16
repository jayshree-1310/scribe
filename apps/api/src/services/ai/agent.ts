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
 */

import { logger } from "../../lib/logger.js";
import {
  AGENT_SYSTEM_PROMPT,
  AGENT_WRAP_UP,
  agentMessage,
  toolResultMessage,
} from "./prompts/agent.js";
import { aiProvider } from "./provider.js";
import {
  RESULT_LIMIT,
  runTool,
  toolDefinitions,
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

export interface AgentInput {
  message: string;
  /** The story the user is looking at, if any: what "this story" means. */
  storyKey: string | null;
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
  steps: AgentStep[];
  stoppedBy: AgentStop;
  modelCalls: number;
  tokensUsed: number;
}

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
 * Runs the loop for one request, as `context.userId`.
 *
 * Throws only for what a route should turn into a status: AI not configured,
 * a provider failure on a model call, an abort. A tool failing does not throw
 * -- see `runTool`.
 */
export async function runAgent(
  input: AgentInput,
  context: ToolContext,
): Promise<AgentAnswer> {
  const provider = aiProvider();
  const tools = toolDefinitions();

  const messages: AiMessage[] = [
    { role: "user", content: agentMessage(input) },
  ];
  const steps: AgentStep[] = [];
  let tokensUsed = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  /** Set once a cap has been reached: the next call is the last. */
  let forcedBy: AgentStop | null = null;

  const finish = (answer: string, stoppedBy: AgentStop): AgentAnswer => {
    logger.info(
      { agent: { modelCalls, toolCalls, tokensUsed, stoppedBy } },
      "agent request",
    );
    return { answer, steps, stoppedBy, modelCalls, tokensUsed };
  };

  for (;;) {
    if (tokensUsed >= TOKEN_BUDGET) return finish(OUT_OF_BUDGET, "token_budget");

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
      return finish(answer === "" ? NO_ANSWER : answer, forcedBy ?? "answered");
    }

    messages.push({ role: "assistant", content: completion.text, toolCalls: calls });

    for (const call of calls) {
      if (toolCalls >= MAX_TOOL_CALLS) {
        // Answered rather than dropped: every call in the history needs a
        // result, or the next request is malformed.
        steps.push({ tool: call.name, arguments: null, outcome: "skipped", durationMs: 0 });
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
      const run = await runTool(call, context);

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

      steps.push({
        tool: call.name,
        arguments: run.arguments,
        outcome: run.outcome,
        ...(run.code ? { code: run.code } : {}),
        durationMs: run.durationMs,
      });
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
