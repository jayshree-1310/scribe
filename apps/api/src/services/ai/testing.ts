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

/**
 * Options for a fake that knows a little about meaning.
 *
 * `concepts` maps a concept name to the words that express it. A text
 * mentioning any of a concept's words embeds onto that concept's axis -- one
 * axis per concept, summed when a text mentions several -- so "grief" and
 * "mourning" come out identical, and a text mentioning neither comes out as an
 * unrelated pseudo-vector. That is the one property of a real embedding model
 * a search test needs: synonyms are near and strangers are far. It is a
 * stand-in for the model, not a model -- a test built on it asserts that search
 * *uses* nearness correctly, never that nearness is right.
 *
 * `model` names the fake, which matters more than it looks: search filters
 * stored rows by model, so a suite with its own model name sees only the rows
 * it embedded, even while another suite writes `fake-embed` rows beside it.
 */
export interface FakeEmbedderOptions {
  model?: string;
  concepts?: Record<string, string[]>;
}

function conceptVector(
  text: string,
  width: number,
  concepts: string[][],
): number[] | null {
  const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const vector = new Array<number>(width).fill(0);
  let matched = false;

  concepts.forEach((synonyms, axis) => {
    if (axis < width && synonyms.some((word) => words.has(word.toLowerCase()))) {
      vector[axis] = 1;
      matched = true;
    }
  });

  return matched ? vector : null;
}

export function fakeAiEmbedder(
  dimensions = 8,
  options: FakeEmbedderOptions = {},
): FakeAiEmbedder {
  const calls: RecordedEmbedCall[] = [];
  let failure: HttpError | null = null;
  let widthOnce: number | null = null;
  const concepts = Object.values(options.concepts ?? {});

  return {
    name: "fake",
    model: options.model ?? "fake-embed",
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
        vectors: request.texts.map(
          (text) =>
            conceptVector(text, width, concepts) ?? vectorFor(text, width),
        ),
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
