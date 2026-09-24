/**
 * The smallest end-to-end path there is: a prompt in, a reply out.
 *
 * Nothing else in `services/ai/` is this bare -- Scribble routes a sentence
 * into SQL, the assistant windows a passage, generation constrains a shape --
 * and that is the point of keeping it. It is the workbench the `/ai-lab` page
 * drives, so when a provider swap, a model change or a timeout is misbehaving
 * there is one surface with nothing else in the way to blame.
 *
 * What it still does, because every AI feature must: it names itself in the
 * usage record, it caps what it sends, and it reports what the call cost --
 * that last one is why `ChatReply` carries usage at all. Everywhere else usage
 * goes only to the log; here it goes to the client too, because a workbench
 * whose whole purpose is to show what a request costs cannot keep the number
 * to itself.
 */

import { CHAT_SYSTEM_PROMPT } from "./prompts/chat.js";
import { aiProvider } from "./provider.js";
import type { AiRequest, AiUsage } from "./types.js";

/**
 * Well under any model's context window, in characters rather than tokens
 * because there is no tokeniser here. Roughly a thousand tokens at the usual
 * four-characters-a-token rule of thumb -- a long question, not a chapter.
 * The route states the number in its rejection so a caller can act on it.
 */
export const PROMPT_LIMIT = 4000;

/** Keyed on in every usage record this feature produces. */
const FEATURE = "chat";

/** What a call cost, in the shape the client is given. */
export interface ChatUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Provided rather than left to the caller: it is what a budget is spent in. */
  totalTokens: number;
  durationMs: number;
}

export interface ChatReply {
  text: string;
  usage: ChatUsage;
}

export type ChatEvent =
  | { type: "text"; text: string }
  /** Exactly one, last, carrying what the whole call cost. */
  | { type: "done"; usage: ChatUsage };

/**
 * Drops `provider` and adds the total.
 *
 * The provider's name is deliberately not forwarded: `/health` already reports
 * which provider is configured, and a per-reply copy of it would be a second
 * place to leak how this deployment is wired.
 */
function toChatUsage(usage: AiUsage): ChatUsage {
  return {
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    durationMs: usage.durationMs,
  };
}

/**
 * The prompt travels as a **user message**, never appended to the system text.
 *
 * That separation is the only structural thing standing between an instruction
 * and a user who would like to replace it, and it is why this function exists
 * rather than the two routes each building a request inline.
 */
function requestFor(prompt: string, signal?: AbortSignal): AiRequest {
  return {
    feature: FEATURE,
    system: CHAT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    ...(signal ? { signal } : {}),
  };
}

export async function chat(
  prompt: string,
  signal?: AbortSignal,
): Promise<ChatReply> {
  const completion = await aiProvider().complete(requestFor(prompt, signal));

  return {
    // Trimmed and otherwise untouched. The assistant strips a fence the model
    // wrapped its prose in because an author is going to paste that into a
    // chapter; here the raw reply *is* the thing being inspected, and quietly
    // editing it would hide the prompt problem you opened the lab to find.
    text: completion.text.trim(),
    usage: toChatUsage(completion.usage),
  };
}

/**
 * The same call, streamed.
 *
 * A separate function rather than a flag for the reason `provider.ts` gives:
 * the streaming path is deliberately not retried, so the two have genuinely
 * different failure behaviour and a caller should have to choose.
 *
 * Nothing is yielded before the provider's first delta, which is what keeps a
 * 503 from an unreachable model server an ordinary HTTP status rather than an
 * error frame inside a 200 -- see `writeEvent` in `routes/ai.ts`.
 */
export async function* chatStream(
  prompt: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  for await (const event of aiProvider().stream(requestFor(prompt, signal))) {
    if (event.type === "text") {
      yield { type: "text", text: event.text };
    } else {
      yield { type: "done", usage: toChatUsage(event.usage) };
    }
  }
}
