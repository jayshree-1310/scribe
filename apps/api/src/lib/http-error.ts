/**
 * Application errors that carry an HTTP status and a message intended for the
 * caller. Anything thrown that is *not* an `HttpError` is treated as an
 * internal fault by the error handler: logged in full, reported generically.
 */

/** Stable, machine-readable error identifiers returned to clients. */
export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_many_requests"
  | "route_not_found"
  | "invalid_json"
  | "payload_too_large"
  /** A dependency we call out to failed: today, only the model provider. */
  | "upstream_error"
  /** A dependency is absent or unreachable, and the caller can retry later. */
  | "service_unavailable"
  | "internal_error";

/** Field-level messages, keyed by field name. */
export type ErrorDetails = Record<string, string>;

export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetails;
    /** On a 429: how long to wait, the same number as `Retry-After`. */
    retryAfterSeconds?: number;
  };
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;
  /** Seconds a throttled caller should wait, surfaced as `Retry-After`. */
  retryAfterSeconds?: number;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: ErrorDetails,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: ErrorDetails): HttpError {
    return new HttpError(400, "validation_error", message, details);
  }

  static unauthorized(message: string): HttpError {
    return new HttpError(401, "unauthorized", message);
  }

  /**
   * Carries `Retry-After` seconds so the error handler is not the only place
   * that knows how to answer a throttled caller. `limit` names which ceiling
   * was hit (`daily_token_budget`, `ai_requests`), so a client -- or a person
   * reading a log -- can tell "wait a minute" from "come back tomorrow".
   */
  static tooManyRequests(
    message: string,
    retryAfterSeconds: number,
    limit?: string,
  ): HttpError {
    const error = new HttpError(
      429,
      "too_many_requests",
      message,
      limit ? { limit } : undefined,
    );
    error.retryAfterSeconds = retryAfterSeconds;
    return error;
  }

  /**
   * Distinct from `unauthorized`: the caller is who they say they are, and
   * still may not do this. A client must not respond by signing them out.
   */
  static forbidden(message: string): HttpError {
    return new HttpError(403, "forbidden", message);
  }

  static notFound(message: string): HttpError {
    return new HttpError(404, "not_found", message);
  }

  static conflict(message: string): HttpError {
    return new HttpError(409, "conflict", message);
  }

  /**
   * A dependency answered, and badly. Distinct from `internal_error`: nothing
   * in *this* service is broken, so the message may say so without leaking
   * internals -- but never pass a provider's own message through, because it
   * can quote the prompt it was given.
   */
  static upstream(message: string): HttpError {
    return new HttpError(502, "upstream_error", message);
  }

  /**
   * A dependency is missing or unreachable: not configured, not running, or
   * timed out. Separate from `upstream` because it is the caller's cue to try
   * again rather than to report a bug, and `503` keeps it out of error budgets
   * that count 5xx faults.
   */
  static unavailable(message: string, retryAfterSeconds?: number): HttpError {
    const error = new HttpError(503, "service_unavailable", message);
    if (retryAfterSeconds !== undefined) {
      error.retryAfterSeconds = retryAfterSeconds;
    }
    return error;
  }

  /** A dependency took too long. The request may succeed on a retry. */
  static upstreamTimeout(message: string): HttpError {
    return new HttpError(504, "upstream_error", message);
  }

  toBody(): ErrorResponseBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        ...(this.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: this.retryAfterSeconds }
          : {}),
      },
    };
  }
}

/**
 * What a model provider actually said, when an `HttpError` came from one, in
 * the shape the logs may carry.
 *
 * `services/ai/openai-compatible.ts` and `ollama.ts` attach it as a
 * non-enumerable `upstreamDetail` so it can never reach a response; the logs
 * have to ask for it, because pino's error serialiser skips non-enumerable
 * properties. Undefined for any other error.
 *
 * The provider's status and its own short error `code` and `type` -- what
 * tells a request too large from a reply that failed its schema -- are always
 * included. The raw `body` is not unless `withBody` is set: a provider's
 * error can quote the prompt, which is a member's unpublished prose, and logs
 * carry no prompt content by default (`AI_LOG_CONTENT`, never in production).
 */
export function upstreamDetailOf(
  error: unknown,
  withBody = false,
): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const detail = (error as { upstreamDetail?: unknown }).upstreamDetail;
  if (typeof detail !== "object" || detail === null) return undefined;

  const { body, ...rest } = detail as Record<string, unknown>;
  return withBody && body !== undefined ? { ...rest, body } : rest;
}

/**
 * The provider's own error code and type from an error body, when it is the
 * usual `{ "error": { "code": ..., "type": ... } }` and they are identifiers.
 * Anything else -- free text, which can quote the prompt -- is left out.
 */
export function providerErrorCodes(body: string): { code?: string; type?: string } {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
    const identifier = (value: unknown) =>
      typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
    const code = identifier(parsed.error?.code);
    const type = identifier(parsed.error?.type);
    return { ...(code ? { code } : {}), ...(type ? { type } : {}) };
  } catch {
    return {};
  }
}
