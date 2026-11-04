/**
 * What a request to the assistant with tools may carry, and what it costs to
 * start one -- shared by every route that runs the loop in `agent.ts`:
 * `/api/ai/agent`, its streamed twin and the AG-UI route (Task AI 24). One
 * schema and one charge, so no route can accept more or be charged less than
 * another.
 */

import { z } from "zod";
import { HttpError } from "../../lib/http-error.js";
import { isRateLimited, recordAttempt } from "../../lib/rate-limit.js";
import { HISTORY_ANSWER_LIMIT, HISTORY_LIMIT, MESSAGE_LIMIT } from "./agent.js";
import { assertWithinDailyBudget } from "./budget.js";

/**
 * Tighter than Ask This Book's: one request here is up to five model calls and
 * six lookups, so ten requests is fifty calls. The per-request token budget in
 * `agent.ts` bounds one request; this bounds how many of them.
 */
const AGENT_LIMIT = 10;
const AGENT_WINDOW_SECONDS = 60 * 10;

export const agentRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .min(2, "Ask the assistant something.")
    .max(
      MESSAGE_LIMIT,
      `Keep it under ${MESSAGE_LIMIT} characters — the assistant looks the rest up.`,
    ),
  /** The story on screen, if any. Authorised by each tool that uses it. */
  storyId: z.string().trim().min(1).max(200).nullish(),
  /**
   * The conversation so far, oldest first, as the client holds it. Context
   * for a follow-up, never a source, and never a way to widen what a tool
   * returns: the tools run as the session's user whatever this says.
   */
  history: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(MESSAGE_LIMIT),
        answer: z.string().trim().min(1).max(HISTORY_ANSWER_LIMIT),
      }),
    )
    .max(HISTORY_LIMIT, `Send at most ${HISTORY_LIMIT} earlier exchanges.`)
    .default([]),
});

export type AgentRequest = z.infer<typeof agentRequestSchema>;

/**
 * The request limit and the day's budget, checked and charged before the
 * first model call, because one request is several of them.
 */
export async function chargeAgentRequest(userId: string): Promise<void> {
  const key = `ai:agent:${userId}`;
  const status = await isRateLimited(key, AGENT_LIMIT);
  if (status.limited) {
    throw HttpError.tooManyRequests(
      "You have asked the assistant a lot in a short time. Try again shortly.",
      status.retryAfter,
    );
  }
  await assertWithinDailyBudget(userId);
  await recordAttempt(key, AGENT_WINDOW_SECONDS);
}
