/**
 * The CopilotKit trial (Task AI 25), mounted inside the AI router at
 * `/api/ai/copilotkit`.
 *
 * Inside rather than beside it so that it inherits what every AI route has:
 * the caller's `runAs` scope, the baseline request limit and the request-log
 * redaction. On top of those, in order:
 *
 * - `requireUser`, and the trial switch (`AI_COPILOTKIT`): off, it is a 404;
 * - an allowlist of the runtime's routes. The runtime also serves suggest,
 *   transcribe, thread listing, memories, the inspector and debug events;
 *   none is used here, and none should be reachable because a package added
 *   it. Only runtime info, run, connect and stop pass;
 * - on run, the checks `/agent/stream` makes before its loop -- the body,
 *   the request limit and the day's budget -- so a 400 or a 429 is a status,
 *   not an event inside a stream that has already said 200.
 */

import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { Router, type NextFunction, type Request, type Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { parseOrThrow } from "../lib/validate.js";
import { requireUser, requireUserId } from "../middleware/current-user.js";
import { agentRequestSchema, chargeAgentRequest } from "../services/ai/agent-request.js";
import { fromRunAgentInput } from "../services/ai/agui.js";
import { loadAiConfig } from "../services/ai/config.js";
import { COPILOTKIT_AGENT_ID, copilotkitHandler } from "../services/ai/copilotkit.js";

const router = Router();

const AGENT = `/agent/${COPILOTKIT_AGENT_ID}`;

/** The runtime routes the hooks need. Everything else the runtime serves is a 404. */
const ALLOWED: readonly { method: string; path: RegExp }[] = [
  { method: "GET", path: /^\/info$/ },
  { method: "POST", path: new RegExp(`^${AGENT}/run$`) },
  { method: "POST", path: new RegExp(`^${AGENT}/connect$`) },
  { method: "POST", path: new RegExp(`^${AGENT}/stop/[^/]+$`) },
];

const NOT_FOUND = "That could not be found.";

router.use(requireUser, (req: Request, _res: Response, next: NextFunction) => {
  if (!loadAiConfig().copilotkitTrial) return next(HttpError.notFound(NOT_FOUND));
  const allowed = ALLOWED.some(
    (route) => route.method === req.method && route.path.test(req.path),
  );
  next(allowed ? undefined : HttpError.notFound(NOT_FOUND));
});

// Spelled out, not built from `AGENT`, so the suspension audit finds it.
router.post("/agent/scribe/run", async (req, res, next) => {
  try {
    // Client tools are ignored by the agent, not refused: see `copilotkit.ts`.
    const input = parseOrThrow(RunAgentInputSchema, req.body);
    parseOrThrow(agentRequestSchema, fromRunAgentInput(input).request);
    await chargeAgentRequest(requireUserId(res));
    next();
  } catch (error) {
    next(error);
  }
});

router.use(async (req, res, next) => {
  try {
    (await copilotkitHandler())(req, res, next);
  } catch (error) {
    next(error);
  }
});

export default router;
