/**
 * The seam every AI feature calls through.
 *
 * Nothing here mentions a provider, an SDK type or an HTTP shape. That is the
 * whole point: a feature written against these types keeps working when the
 * model behind it changes from a 3B model on this laptop to a hosted one, and
 * the diff is confined to `provider.ts` and one implementation file.
 */

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
  /** Caller cancellation, composed with the configured timeout. */
  signal?: AbortSignal;
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
