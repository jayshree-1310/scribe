import type { ErrorRequestHandler, RequestHandler } from "express";
import { HttpError, type ErrorResponseBody } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { db } from "../prisma/db.js";
import { getUserId } from "./current-user.js";

/** Shape `express.json()` uses to report a malformed or oversized body. */
interface BodyParserError extends Error {
  status?: number;
  type?: string;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    error instanceof Error &&
    typeof (error as BodyParserError).type === "string" &&
    typeof (error as BodyParserError).status === "number"
  );
}

/** Postgres reports a foreign-key breach as SQLSTATE 23503. */
function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as { code?: unknown; sqlState?: unknown; cause?: unknown };
  if (candidate.code === "23503" || candidate.sqlState === "23503") return true;

  return candidate.cause !== undefined && isForeignKeyViolation(candidate.cause);
}

/**
 * Whether a foreign-key failure is the caller's account having gone.
 *
 * An access token outlives the account for up to its fifteen minutes (it is a
 * signed claim, not a lookup), so a write made with it after `DELETE
 * /api/account/me` breaches `story_authorId_fkey` or the like. That is "sign
 * in again", not a server fault. Checked only here, on the failure path,
 * rather than with a lookup on every write.
 */
async function callerIsGone(req: Parameters<RequestHandler>[0]): Promise<boolean> {
  const userId = getUserId(req);
  if (userId === null) return false;

  const user = await db.orm.auth.User.select("id")
    .where((row) => row.id.eq(userId))
    .first();

  return user === null || user === undefined;
}

/** Terminal handler for unmatched routes. */
export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ErrorResponseBody = {
    error: {
      code: "route_not_found",
      message: `Cannot ${req.method} ${req.path}`,
    },
  };
  res.status(404).json(body);
};

/**
 * Single exit point for every failed request. Known failures answer with their
 * own message; anything unrecognised is logged in full and reported as a
 * generic 500 so internals never reach the client.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (!res.headersSent && isForeignKeyViolation(error)) {
    callerIsGone(req)
      .catch(() => false)
      .then((gone) =>
        respond(
          gone
            ? HttpError.unauthorized("Your account no longer exists. Please sign in again.")
            : error,
          req,
          res,
          next,
        ),
      );
    return;
  }

  respond(error, req, res, next);
};

const respond: ErrorRequestHandler = (error, req, res, next) => {
  // Headers already sent: nothing useful left to say, let Express tear down.
  if (res.headersSent) {
    next(error);
    return;
  }

  const log = req.log ?? logger;

  if (error instanceof HttpError) {
    if (error.status >= 500) log.error({ err: error }, "Request failed");
    else log.warn({ err: error, code: error.code }, "Request rejected");

    if (error.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }

    res.status(error.status).json(error.toBody());
    return;
  }

  if (isBodyParserError(error)) {
    const tooLarge = error.type === "entity.too.large";
    const body: ErrorResponseBody = {
      error: tooLarge
        ? {
            code: "payload_too_large",
            message: "That upload is too large.",
          }
        : {
            code: "invalid_json",
            message: "The request body could not be read as JSON.",
          },
    };

    log.warn({ type: error.type }, "Malformed request body");
    res.status(tooLarge ? 413 : 400).json(body);
    return;
  }

  log.error({ err: error }, "Unhandled error");

  const body: ErrorResponseBody = {
    error: {
      code: "internal_error",
      message: "Something went wrong on our end. Please try again.",
    },
  };
  res.status(500).json(body);
};
