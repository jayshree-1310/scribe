/**
 * The validation rules for the three fields that identify an account.
 *
 * Signup, the settings form, the password routes and the web form
 * (`apps/web/src/lib/auth.ts`) all have to agree on these. Three copies in
 * three routers is how the form ends up accepting a username signup rejects,
 * or — worse — the reverse.
 */

import { z } from "zod";

/**
 * Stored lower-case: the column is `@unique`, which is case-sensitive, so
 * without normalising here `Alice` and `alice` are two accounts that look
 * like one — a ready-made impersonation.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Use at least 3 characters.")
  .max(24, "Use at most 24 characters.")
  .regex(/^[a-z0-9_]+$/, "Use only letters, numbers and underscores.");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("That email address does not look right.");

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/**
 * Length only. Composition rules (a symbol, a digit) are advisory in the UI's
 * strength meter and deliberately not enforced here: they push people towards
 * a small set of predictable substitutions, and a long passphrase that fails
 * them is stronger than a short password that passes.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
  .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters.`);
