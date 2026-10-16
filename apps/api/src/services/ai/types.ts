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

/**
 * One turn of a conversation.
 *
 * The two tool variants exist only for the agent loop (`agent.ts`). Every
 * other feature sends plain user and assistant text, and a provider that is
 * never sent `tools` never sees the other two shapes.
 */
export type AiMessage = AiTextMessage | AiToolCallMessage | AiToolResultMessage;

export interface AiTextMessage {
  role: "user" | "assistant";
  content: string;
}

/** The model's own turn when it chose tools, replayed so it sees what it asked. */
export interface AiToolCallMessage {
  role: "assistant";
  /** Often empty: a model that calls a tool usually says nothing beside it. */
  content: string;
  toolCalls: AiToolCall[];
}

/** What running one tool produced, answering the call with the same id. */
export interface AiToolResultMessage {
  role: "tool";
  toolCallId: string;
  /** The tool's name; Ollama keys results by name rather than by id. */
  name: string;
  content: string;
}

/**
 * A tool the model may ask for, described the way providers want it.
 *
 * `parameters` is a JSON schema derived from the zod schema that validates the
 * arguments (`json-schema.ts`), so what the model is told and what the code
 * accepts are one definition.
 */
export interface AiToolDefinition {
  /** `[a-z_]+`: providers reject anything fancier. */
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * A model's request to run a tool.
 *
 * `arguments` stays the raw JSON text the model wrote. Parsing it is the
 * agent's job, through zod, because a model-chosen argument is untrusted input
 * exactly as a request body is -- and a provider that pre-parsed it would be
 * deciding what malformed means.
 */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
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
  /**
   * Tools the model may call instead of answering. `complete` only: the agent
   * loop decides between steps, and a tool call is never streamed to a reader.
   */
  tools?: AiToolDefinition[];
  /**
   * `none` forbids a tool call while still describing the tools -- for the
   * last step of a capped loop, whose history holds tool calls that some
   * servers refuse to read without the definitions beside them.
   */
  toolChoice?: "auto" | "none";
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
  /**
   * Present and non-empty when the model chose tools rather than answering.
   * Only ever set when the request carried `tools`.
   */
  toolCalls?: AiToolCall[];
}

/**
 * One text delta, then exactly one terminal `done` carrying usage.
 *
 * Usage arrives at the end because that is when a provider knows it -- the
 * token counts are not available until generation stops.
 */
export type AiStreamEvent =
  { type: "text"; text: string } | { type: "done"; usage: AiUsage };

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

/* Embeddings ------------------------------------------------------------- */

export interface AiEmbedRequest {
  /** Same role as `AiRequest.feature`: what the usage record is keyed by. */
  feature: string;
  /** One vector comes back per entry, in the same order. */
  texts: string[];
  /** Defaults to the configured embedding model. */
  model?: string;
  signal?: AbortSignal;
}

export interface AiEmbeddings {
  /** Parallel to `texts`, every vector the same width. */
  vectors: number[][];
  /** `outputTokens` is always 0: an embedder generates nothing. */
  usage: AiUsage;
}

/**
 * The embedding seam -- deliberately **not** a method on `AiProvider`.
 *
 * Writing prose and turning it into a vector are two services in the general
 * case and two services in this repo's own setup: chat is answered by a hosted
 * OpenAI-compatible endpoint that serves no embedding model, and embeddings by
 * the local Ollama container. A single interface would have forced one object
 * to implement a method it has no endpoint for, and the honest expression of
 * "these can be different providers" is two interfaces with two accessors.
 *
 * `dimensions` is on the interface rather than inferred from the first reply
 * because it is a *declared* width that the database column must agree with.
 * An implementation checks what came back against it and fails loudly on a
 * mismatch; see `embeddings.ts` for why a quiet one would be so expensive.
 */
export interface AiEmbedder {
  /** For logs and error messages: `ollama`, `openai`, `fake`. */
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(request: AiEmbedRequest): Promise<AiEmbeddings>;
}
