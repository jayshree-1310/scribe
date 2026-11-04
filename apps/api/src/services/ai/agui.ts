/**
 * The agent's stream in AG-UI's shape (Task AI 24).
 *
 * AG-UI is the open protocol under CopilotKit: a POST of `RunAgentInput`
 * answered by an SSE stream of typed events. Speaking it costs a mapping over
 * `agentEvents` and keeps a later CopilotKit trial (AI 25), or any other AG-UI
 * client, from needing a second agent. The loop, its caps and the tools are
 * `agent.ts`'s, unchanged.
 *
 * **Only `@ag-ui/core`, not `@ag-ui/encoder`.** The encoder's SSE frame is
 * `data: <json>\n\n`, which `writeEvent` already writes; the package around it
 * brings `@ag-ui/proto`, protobuf, a protoc download and zod 3 beside our zod 4,
 * for a binary transport no client here asks for. Core's types, `EventType` and
 * its zod schemas are what the protocol actually is.
 *
 * **Every part of the input a browser controls is untrusted.** What a request
 * may say is what `/agent/stream` already accepts -- a message, the story on
 * screen, a bounded history -- and `fromRunAgentInput` reduces AG-UI's input to
 * exactly that before the route's own schema checks it:
 *
 * - identity is never read from it: not `forwardedProps`, not `state`. The
 *   route runs the loop as the session's user, as the other route does;
 * - `messages` becomes the last user message plus at most `HISTORY_LIMIT`
 *   earlier exchanges, each cut to the same bounds, and is fenced by
 *   `agentMessage` like any history. Cut rather than refused: an AG-UI client
 *   sends its whole thread on every run, and the server decides how much of it
 *   is worth re-sending a model;
 * - `context` is dropped. Nothing uses it, and it is the browser deciding what
 *   reaches a model, which Scribe decides on the server;
 * - client-declared `tools` are refused outright, so a browser can neither add
 *   a tool nor shadow a server one by name;
 * - `state` and `resume` are ignored: the agent keeps no state and never
 *   pauses (AI 21 made proposals data, not an interrupt).
 *
 * **Proposals are the pending tool calls.** AG-UI's human-in-the-loop shape is
 * a tool call the run leaves unanswered for the application, named in
 * `RUN_FINISHED`'s `pendingToolCallIds`. Each AI 21 proposal is sent that way,
 * as a `propose_edit` call whose id is the proposal's and whose arguments are
 * the proposal. The server-side `propose_edit` that recorded it is therefore
 * not streamed as a lookup as well -- a client rendering calls by name would
 * show every proposal twice. One that was refused is streamed, like any lookup
 * that did not succeed.
 */

import { randomUUID } from "node:crypto";
import {
  EventType,
  PROTOCOL_VERSION,
  contentToText,
  type AGUIEvent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/core";
import { RunAgentInputSchema, ToolSchema } from "@ag-ui/core/schemas";
import { z } from "zod";
import {
  HISTORY_ANSWER_LIMIT,
  HISTORY_LIMIT,
  MESSAGE_LIMIT,
  type AgentEvent,
  type AgentExchange,
  type AgentStep,
} from "./agent.js";

/** The tool AI 21 offers; its successful calls become the run's pending calls. */
const PROPOSE_EDIT = "propose_edit";

/** Thread and run ids are echoed back; long enough for any client's uuid. */
const ID_LIMIT = 200;

/**
 * AG-UI's own schema, with what this endpoint will not take: unbounded ids,
 * and any tool the client declares.
 */
export const runAgentInputSchema = RunAgentInputSchema.extend({
  threadId: z.string().trim().min(1).max(ID_LIMIT),
  runId: z.string().trim().min(1).max(ID_LIMIT),
  tools: z
    .array(ToolSchema)
    .max(0, "This assistant's tools are its own; a client cannot declare any.")
    .default([]),
});

export interface AguiRun {
  threadId: string;
  runId: string;
}

/**
 * What `/agent/stream` would have been sent, from an AG-UI input, unvalidated:
 * the route's schema still checks the message and the story key, so both
 * routes refuse the same things in the same words.
 */
export interface AguiRequest {
  message: unknown;
  storyId: unknown;
  history: AgentExchange[];
}

/**
 * Reduces an AG-UI input to the agent's. The last message must be the user's
 * question; before it, each user message answered by an assistant message
 * with text is one exchange, and everything else -- system, developer, tool,
 * reasoning and activity messages, and tool-call-only turns -- is not
 * history and is dropped.
 */
export function fromRunAgentInput(input: RunAgentInput): {
  run: AguiRun;
  request: AguiRequest;
} {
  const messages: readonly Message[] = input.messages;
  const last = messages.at(-1);

  const exchanges: AgentExchange[] = [];
  let question: string | null = null;
  for (const message of messages.slice(0, -1)) {
    if (message.role === "user") {
      question = contentToText(message.content).trim().slice(0, MESSAGE_LIMIT);
    } else if (message.role === "assistant" && question) {
      const answer = (message.content ?? "").trim().slice(0, HISTORY_ANSWER_LIMIT);
      if (answer === "") continue;
      exchanges.push({ question, answer });
      question = null;
    }
  }

  // `forwardedProps` is the application's to define; the only thing read from
  // it is which story is on screen, which every tool authorises for itself.
  const forwarded: unknown = input.forwardedProps;
  const storyId =
    typeof forwarded === "object" && forwarded !== null && "storyId" in forwarded
      ? forwarded.storyId
      : null;

  return {
    run: { threadId: input.threadId, runId: input.runId },
    request: {
      message: last?.role === "user" ? contentToText(last.content) : "",
      storyId,
      history: exchanges.slice(-HISTORY_LIMIT),
    },
  };
}

/** A lookup's arguments as AG-UI's argument text: as parsed, or as they came. */
function argumentText(step: AgentStep): string {
  if (step.arguments === null || step.arguments === undefined) return "";
  return typeof step.arguments === "string" ? step.arguments : JSON.stringify(step.arguments);
}

/**
 * A finished lookup's closing events. The result is the step's outcome, not
 * the tool's output: `/agent/stream` sends no tool output either, and this
 * route sends no more than that one does.
 */
function* closeLookup(toolCallId: string, step: AgentStep): Generator<AGUIEvent> {
  const args = argumentText(step);
  if (args !== "") yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args };
  yield { type: EventType.TOOL_CALL_END, toolCallId };
  yield {
    type: EventType.TOOL_CALL_RESULT,
    messageId: randomUUID(),
    toolCallId,
    role: "tool",
    content: JSON.stringify({
      outcome: step.outcome,
      ...(step.code ? { code: step.code } : {}),
      durationMs: step.durationMs,
    }),
  };
}

/**
 * The loop's events as AG-UI's: `RUN_STARTED`; each lookup as
 * `TOOL_CALL_START` when it starts and `TOOL_CALL_ARGS` / `TOOL_CALL_END` /
 * `TOOL_CALL_RESULT` when it finishes; the answer as one text message; the
 * proposals as `propose_edit` calls left pending; then `RUN_FINISHED`.
 *
 * `RUN_STARTED` waits for the loop's first event, which `agentEvents` yields
 * only after its first model call has returned -- so a provider that is down
 * still fails the request before anything is written, and the route can
 * answer with a status. `RUN_ERROR` is the route's to send, since a failure
 * is a throw out of this generator.
 */
export async function* aguiEvents(
  events: AsyncIterable<AgentEvent>,
  run: AguiRun,
): AsyncGenerator<AGUIEvent> {
  let started = false;
  /** The call the loop is running now, between its `lookup` and its `step`. */
  let running: string | null = null;

  for await (const event of events) {
    if (!started) {
      started = true;
      yield {
        type: EventType.RUN_STARTED,
        threadId: run.threadId,
        runId: run.runId,
        protocolVersion: PROTOCOL_VERSION,
      };
    }

    if (event.type === "lookup") {
      if (event.tool === PROPOSE_EDIT) continue;
      running = randomUUID();
      yield { type: EventType.TOOL_CALL_START, toolCallId: running, toolCallName: event.tool };
      continue;
    }

    if (event.type === "step") {
      const { step } = event;
      if (step.tool === PROPOSE_EDIT) {
        if (step.outcome === "ok") continue;
        // Its lookup was held back; a refusal is shown whole.
        const toolCallId = randomUUID();
        yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: step.tool };
        yield* closeLookup(toolCallId, step);
        continue;
      }
      // A skipped call never had a lookup: the cap stopped it before it ran.
      const toolCallId = running ?? randomUUID();
      if (running === null) {
        yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: step.tool };
      }
      running = null;
      yield* closeLookup(toolCallId, step);
      continue;
    }

    const messageId = randomUUID();
    yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" };
    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.answer };
    yield { type: EventType.TEXT_MESSAGE_END, messageId };

    for (const proposal of event.proposals) {
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: proposal.id,
        toolCallName: PROPOSE_EDIT,
        parentMessageId: messageId,
      };
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: proposal.id, delta: JSON.stringify(proposal) };
      yield { type: EventType.TOOL_CALL_END, toolCallId: proposal.id };
    }

    yield {
      type: EventType.RUN_FINISHED,
      threadId: run.threadId,
      runId: run.runId,
      outcome: {
        type: "success",
        ...(event.proposals.length > 0
          ? { pendingToolCallIds: event.proposals.map((proposal) => proposal.id) }
          : {}),
      },
      result: {
        stoppedBy: event.stoppedBy,
        modelCalls: event.modelCalls,
        tokensUsed: event.tokensUsed,
      },
    };
    return;
  }
}
