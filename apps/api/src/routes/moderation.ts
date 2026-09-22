/**
 * Reporting and moderation routes.
 *
 * Mounted at `/api` rather than under one prefix, because the surface is
 * deliberately two: `/api/reports` is what any signed-in reader posts to, and
 * `/api/moderation/...` is the staff queue. Splitting them across two routers
 * would put one service behind two files; keeping the split in the paths makes
 * "which of these is public?" readable from a URL, which is the question a
 * reverse proxy and a reader of this file both ask.
 *
 * Every route here needs a signed-in caller, so the whole router sits behind
 * `requireUser`. Being an administrator is *not* checked here: `listReports`
 * and `resolveReport` call `assertAdmin` themselves, so the rule lives beside
 * the query it guards and a second caller of either cannot route around it.
 */

import { Router } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { HttpError } from "../lib/http-error.js";
import { isRateLimited, recordAttempt } from "../lib/rate-limit.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import {
  DETAILS_MAX_LENGTH,
  MAX_PAGE_SIZE,
  NOTE_MAX_LENGTH,
  REPORT_ACTIONS,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGETS,
  createReport,
  listReports,
  reinstateUser,
  resolveReport,
} from "../services/moderation.js";

const router = Router();

router.use(requireUser);

/**
 * Per *user*, not per IP, for the reason `routes/engagement.ts` gives. Tighter
 * than the comment limit and over a longer window, because reporting is the
 * one write here whose cost falls on somebody else: twenty reports an hour is
 * far more than a reader files in good faith and is exactly what somebody
 * burying one person's account under a queue does.
 */
const REPORT_LIMIT = 20;

const REPORT_WINDOW_SECONDS = 60 * 60;

function reportKey(userId: string): string {
  return `rl:report:${userId}`;
}

const reportBodySchema = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: z.uuid("That content could not be found."),
  reason: z.enum(REPORT_REASONS),
  /**
   * `.trim()` before the length check, so a box of nothing but whitespace is
   * stored as no details rather than as a string of spaces.
   */
  details: z.string().trim().max(DETAILS_MAX_LENGTH).optional(),
});

const queueQuerySchema = z.object({
  /**
   * Defaulted to `OPEN` rather than left open: the queue is a to-do list, and
   * a moderator who wanted the archive asks for it. `all` is the escape
   * hatch, spelled as a value rather than as an absent parameter so the
   * default cannot be reached by forgetting one.
   */
  status: z.enum([...REPORT_STATUSES, "ALL"]).default("OPEN"),
  targetType: z.enum(REPORT_TARGETS).optional(),
  reason: z.enum(REPORT_REASONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

const userIdParamSchema = z.object({
  id: z.uuid("That account could not be found."),
});

const reportIdParamSchema = z.object({
  id: z.uuid("That report could not be found."),
});

const resolveBodySchema = z.object({
  action: z.enum(REPORT_ACTIONS),
  note: z.string().trim().max(NOTE_MAX_LENGTH).optional(),
});

/* Reporting -------------------------------------------------------------- */

router.post("/reports", async (req, res, next) => {
  try {
    const body = parseOrThrow(reportBodySchema, req.body);
    const userId = requireUserId(res);

    const { limited, retryAfter } = await isRateLimited(
      reportKey(userId),
      REPORT_LIMIT,
    );
    if (limited) {
      throw HttpError.tooManyRequests(
        "You have reported a lot in a short time. Give it a moment and try again.",
        retryAfter || REPORT_WINDOW_SECONDS,
      );
    }

    const report = await createReport(userId, {
      targetType: body.targetType,
      targetId: body.targetId,
      reason: body.reason,
      details: body.details,
    });

    // Charged only once the report landed, like the comment limit: a rejected
    // report -- no such content, already reported -- must not spend the
    // caller's budget, or a reader who mis-clicks twice is locked out.
    await recordAttempt(reportKey(userId), REPORT_WINDOW_SECONDS);

    res.status(201).json({ report });
  } catch (error) {
    next(error);
  }
});

/* The queue -------------------------------------------------------------- */

router.get("/moderation/reports", async (req, res, next) => {
  try {
    const query = parseOrThrow(queueQuerySchema, req.query);

    res.json(
      await listReports(requireUserId(res), {
        status: query.status === "ALL" ? undefined : query.status,
        targetType: query.targetType,
        reason: query.reason,
        page: query.page,
        limit: query.limit,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post("/moderation/reports/:id/resolve", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(reportIdParamSchema, req.params);
    const body = parseOrThrow(resolveBodySchema, req.body);

    // The resolved report rather than a 204: the queue redraws the row it just
    // acted on -- its new status, and whether the target is now hidden -- and
    // this request has already read everything that answer needs.
    res.json({
      report: await resolveReport(requireUserId(res), id, {
        action: body.action,
        note: body.note,
      }),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Lifting a suspension, without a report to hang it on.
 *
 * A `POST` rather than a `DELETE` on some suspension resource: there is no
 * suspension row to delete -- it is a column on the account -- and the verb
 * that matches what a moderator is doing is the one in the path.
 */
router.post("/moderation/users/:id/reinstate", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(userIdParamSchema, req.params);

    res.json({ user: await reinstateUser(requireUserId(res), id) });
  } catch (error) {
    next(error);
  }
});

export default router;
