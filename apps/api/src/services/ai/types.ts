/**
 * The seam every AI feature calls through.
 *
 * Nothing here mentions a provider, an SDK type or an HTTP shape. That is the
 * whole point: a feature written against these types keeps working when the
 * model behind it changes from a 3B model on this laptop to a hosted one, and
 * the diff is confined to `provider.ts` and one implementation file.
 *
 * The one import is zod's `ZodType`, for `completeStructured`. Zod is this
 * codebase's validation library rather than a model vendor's SDK, so it does
 * not compromise the property above: a schema means the same thing whichever
 * provider is behind the seam.
 */

import type { ZodType } from "zod";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequest {
  /**
   * Names the calling feature -- `chat`, `assist.rewrite`, `summary.chapter`.
   * Every usage row is keyed by it, which is what makes per-feature cost
   * visible later, so it is required rather than optional.
   */
  feature: string;
  /** Standing instructions. Never user input; see `prompts/`. */
  system: string;
  /** The conversation. User content belongs here, never in `system`. */
  messages: AiMessage[];
  /** Defaults to the configured model; pass the fast model for bulk work. */
  model?: string;
  maxTokens?: number;
  /**
   * Constrains the reply to a JSON schema, where the provider supports it.
   *
   * Set by `completeStructured`, never by a feature: the schema on the wire is
   * derived from the zod schema that will validate the reply, so the two
   * cannot drift. Providers that cannot constrain output ignore it, which is
   * why the reply is validated regardless.
   */
  format?: AiResponseFormat;
  /** Caller cancellation, composed with the configured timeout. */
  signal?: AbortSignal;
}

/**
 * A JSON schema to constrain output to, plus a name for the providers that
 * insist on one. Built by `json-schema.ts` from a zod schema.
 */
export interface AiResponseFormat {
  /** `[A-Za-z0-9_-]+`, because hosted providers reject anything else. */
  name: string;
  schema: Record<string, unknown>;
}

export interface AiUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface AiCompletion {
  text: string;
  usage: AiUsage;
}

/**
 * One text delta, then exactly one terminal `done` carrying usage.
 *
 * Usage arrives at the end because that is when a provider knows it -- the
 * token counts are not available until generation stops.
 */
export type AiStreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; usage: AiUsage };

export interface AiProvider {
  /** For logs and error messages: `ollama`, `anthropic`, `fake`. */
  readonly name: string;
  complete(request: AiRequest): Promise<AiCompletion>;
  /**
   * Yields deltas as they arrive. Callers must consume to completion or abort
   * via `request.signal`; abandoning the iterator without either leaves the
   * provider generating tokens nobody will read.
   */
  stream(request: AiRequest): AsyncIterable<AiStreamEvent>;
}

/**
 * A validated, typed result plus what it cost to get one.
 *
 * `attempts` is on the record rather than hidden because a shape that
 * routinely needs a second call is a prompt problem, and the number is the
 * only thing that says so.
 */
export interface AiStructuredCompletion<T> {
  value: T;
  /** Summed across attempts: a repaired reply cost two calls, not one. */
  usage: AiUsage;
  attempts: number;
}

/**
 * What `aiProvider()` hands out: an `AiProvider` plus the structured path.
 *
 * Separate from `AiProvider` so that an implementation only ever has to
 * implement the two transport methods. `completeStructured` is written once,
 * in `structured.ts`, and wraps whichever implementation is configured --
 * including the test fake, which is why a test can exercise the repair loop
 * without a model.
 */
export interface AiClient extends AiProvider {
  /**
   * Asks for a value of `schema`'s shape and returns it parsed, or throws.
   *
   * Never returns a partial object: a reply that does not satisfy the schema
   * after one repair attempt is an upstream failure, because half a story
   * idea is not a smaller story idea.
   */
  completeStructured<T>(
    schema: ZodType<T>,
    request: AiRequest,
  ): Promise<AiStructuredCompletion<T>>;
}

/**
 * Where a usage record goes. Defaults to the log; Task AI 18 swaps in a sink
 * that also persists, without touching a single feature.
 */
export type AiUsageSink = (record: AiUsageRecord) => void;

export interface AiUsageRecord extends AiUsage {
  feature: string;
  outcome: "ok" | "error";
  /** The failure's stable code, never a provider message. */
  errorCode?: string;
}
