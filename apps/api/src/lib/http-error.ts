/**
 * Application errors that carry an HTTP status and a message intended for the
 * caller. Anything thrown that is *not* an `HttpError` is treated as an
 * internal fault by the error handler: logged in full, reported generically.
 */

/** Stable, machine-readable error identifiers returned to clients. */
export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "route_not_found"
  | "invalid_json"
  | "payload_too_large"
  | "internal_error";

/** Field-level messages, keyed by field name. */
export type ErrorDetails = Record<string, string>;

export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetails;
  };
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;

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

  static notFound(message: string): HttpError {
    return new HttpError(404, "not_found", message);
  }

  static conflict(message: string): HttpError {
    return new HttpError(409, "conflict", message);
  }

  toBody(): ErrorResponseBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
