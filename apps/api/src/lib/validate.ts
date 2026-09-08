import type { ZodType } from "zod";
import { HttpError, type ErrorDetails } from "./http-error.js";

/**
 * Turns Zod issues into a flat `field -> message` map. The first issue per
 * field wins, which is what a form wants to show.
 */
function toDetails(issues: readonly { path: readonly PropertyKey[]; message: string }[]): ErrorDetails {
  const details: ErrorDetails = {};

  for (const issue of issues) {
    const field = issue.path.length > 0 ? issue.path.join(".") : "_";
    if (!(field in details)) details[field] = issue.message;
  }

  return details;
}

/**
 * Validates `value` against `schema`, returning the parsed (and narrowed)
 * result. Throws a 400 `HttpError` carrying per-field messages on failure.
 */
export function parseOrThrow<T>(
  schema: ZodType<T>,
  value: unknown,
  message = "Some of the details you sent are not valid.",
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw HttpError.badRequest(message, toDetails(result.error.issues));
}
