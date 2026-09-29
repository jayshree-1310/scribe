/**
 * The provider the test suite uses.
 *
 * No network, no key, no cost -- the suite runs on a machine with nothing
 * installed, and it must stay that way. Every AI test asserts on **what was
 * sent** (the system prompt, the messages, the model, whether retrieved
 * context was fenced) and on **how the reply was parsed**, never on model
 * prose: a real model's wording is not deterministic, so a test that asserts
 * on it is a test that fails for no reason.
 *
 * Usage:
 *
 *   const fake = fakeAiProvider(["Some reply"]);
 *   setAiProvider(fake);
 *   ...
 *   expect(fake.calls[0].system).toContain("never invent plot");
 *   resetAiProvider();
 */

import { HttpError } from "../../lib/http-error.js";
import type {
  AiEmbedder,
  AiProvider,
  AiRequest,
  AiResponseFormat,
  AiStreamEvent,
  AiUsage,
} from "./types.js";

export interface RecordedCall {
  feature: string;
  system: string;
  messages: AiRequest["messages"];
  model: string | undefined;
  maxTokens: number | undefined;
  /** The schema the caller asked the provider to constrain output to, if any. */
  format: AiResponseFormat | undefined;
  /** Whether the caller's signal was aborted by the time the call ended. */
  aborted: boolean;
  streamed: boolean;
}

export interface FakeAiProvider extends AiProvider {
  /** Every call, in order. */
  readonly calls: RecordedCall[];
  /** Queue another reply; reused when the queue runs dry. */
  push(reply: string): void;
  /** Make the next call fail, once. */
  failNext(error: HttpError): void;
  reset(): void;
}

const usageFor = (model: string, text: string): AiUsage => ({
  provider: "fake",
  model,
  // Rough, deterministic, and clearly not a real tokeniser: usage assertions
  // should check that counts are *recorded*, not what they are.
  inputTokens: 10,
  outputTokens: Math.max(1, Math.ceil(text.length / 4)),
  durationMs: 1,
});

export function fakeAiProvider(replies: string[] = ["ok"]): FakeAiProvider {
  const queue = [...replies];
  const calls: RecordedCall[] = [];
  let failure: HttpError | null = null;

  function nextReply(): string {
    // Falls back to the last reply rather than throwing, so a test that makes
    // more calls than it scripted fails on its own assertion instead of on a
    // confusing "no reply queued".
    return queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? "ok");
  }

  function record(request: AiRequest, streamed: boolean): void {
    calls.push({
      feature: request.feature,
      system: request.system,
      messages: request.messages,
      model: request.model,
      maxTokens: request.maxTokens,
      format: request.format,
      aborted: request.signal?.aborted === true,
      streamed,
    });
  }

  function takeFailure(): HttpError | null {
    const error = failure;
    failure = null;
    return error;
  }

  return {
    name: "fake",
    calls,

    push(reply) {
      queue.push(reply);
    },

    failNext(error) {
      failure = error;
    },

    reset() {
      calls.length = 0;
      failure = null;
    },

    async complete(request) {
      record(request, false);

      const error = takeFailure();
      if (error) throw error;

      const text = nextReply();
      return { text, usage: usageFor(request.model ?? "fake-model", text) };
    },

    async *stream(request) {
      record(request, true);

      const error = takeFailure();
      if (error) throw error;

      const text = nextReply();

      // Split into several deltas so a consumer that only handles one chunk,
      // or that reassembles them wrongly, is caught.
      for (const piece of text.match(/.{1,8}/gs) ?? []) {
        if (request.signal?.aborted) return;
        yield { type: "text", text: piece } satisfies AiStreamEvent;
      }

      yield {
        type: "done",
        usage: usageFor(request.model ?? "fake-model", text),
      } satisfies AiStreamEvent;
    },
  };
}

/* Embeddings ------------------------------------------------------------- */

export interface RecordedEmbedCall {
  feature: string;
  texts: string[];
  model: string | undefined;
}

export interface FakeAiEmbedder extends AiEmbedder {
  /** Every call, in order. A test asserting "no model call" checks `length`. */
  readonly calls: RecordedEmbedCall[];
  /** Make the next call fail, once. */
  failNext(error: HttpError): void;
  /** Answer with vectors of this width instead of `dimensions`, once. */
  returnWidthOnce(width: number): void;
  reset(): void;
}

/**
 * Deterministic pseudo-vectors: the same text always embeds to the same
 * numbers, and different texts to different ones.
 *
 * That is the only property the tests need, and it is the one a real model
 * also has. Nothing here is a distance metric -- a test asserting that two
 * passages about grief come out near each other would be testing the model,
 * which this is not.
 */
function vectorFor(text: string, width: number): number[] {
  let seed = 0;
  for (const character of text) {
    seed = (seed * 31 + character.codePointAt(0)!) % 2147483647;
  }

  return Array.from({ length: width }, (_, index) => {
    seed = (seed * 48271 + index) % 2147483647;
    return (seed % 2000) / 1000 - 1;
  });
}

export function fakeAiEmbedder(dimensions = 8): FakeAiEmbedder {
  const calls: RecordedEmbedCall[] = [];
  let failure: HttpError | null = null;
  let widthOnce: number | null = null;

  return {
    name: "fake",
    model: "fake-embed",
    dimensions,
    calls,

    failNext(error) {
      failure = error;
    },

    returnWidthOnce(width) {
      widthOnce = width;
    },

    reset() {
      calls.length = 0;
      failure = null;
      widthOnce = null;
    },

    async embed(request) {
      calls.push({
        feature: request.feature,
        texts: request.texts,
        model: request.model,
      });

      const error = failure;
      failure = null;
      if (error) throw error;

      const width = widthOnce ?? dimensions;
      widthOnce = null;

      return {
        vectors: request.texts.map((text) => vectorFor(text, width)),
        usage: {
          provider: "fake",
          model: request.model ?? "fake-embed",
          inputTokens: request.texts.reduce(
            (total, text) => total + Math.ceil(text.length / 4),
            0,
          ),
          outputTokens: 0,
          durationMs: 1,
        },
      };
    },
  };
}
