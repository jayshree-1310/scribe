/**
 * The CopilotKit trial (Task AI 25): Scribe's own agent behind CopilotKit's
 * runtime, so CopilotKit's headless React hooks can drive it.
 *
 * **One agent, and never `BuiltInAgent`.** `ScribeAgent` is an AG-UI agent
 * whose `run` is `agentEvents` mapped by AI 24's `aguiEvents` -- the same
 * loop, caps, tools, provider seam, budget and usage rows as every other
 * agent route. `BuiltInAgent` calls models itself through the Vercel AI SDK
 * and would skip all of that.
 *
 * **Identity comes from `runAs`, through the runtime.** The router wraps the
 * request in the caller's `AsyncLocalStorage` scope (`caller.ts`), and both
 * `identifyUser` (which owns the runtime's threads) and `run` read it back
 * from inside the runtime's own async code. Whether that scope survives the
 * trip is the trial's first question; when it does not, `run` refuses rather
 * than running as nobody.
 *
 * **What the browser sends is reduced as on `/agent/agui`,** with one
 * difference: client-declared `tools` are ignored here rather than refused.
 * `useHumanInTheLoop` declares its tool from the browser on every run, so
 * refusing would refuse every run; the tools are never offered to the model,
 * so a browser still cannot add or shadow a server tool. They only tell the
 * client how to draw the pending `propose_edit` calls.
 *
 * **Loaded only when the trial is on.** `@copilotkit/runtime` is imported
 * dynamically by `copilotkitHandler`, so with `AI_COPILOTKIT` off the API
 * never loads it.
 */

import { AbstractAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { Observable } from "rxjs";
import { HttpError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { parseOrThrow } from "../../lib/validate.js";
import { agentEvents } from "./agent.js";
import { agentRequestSchema } from "./agent-request.js";
import { aguiEvents, fromRunAgentInput } from "./agui.js";
import { currentUserId } from "./caller.js";

/** The agent's id on the runtime: `/agent/scribe/run`. */
export const COPILOTKIT_AGENT_ID = "scribe";

const NOT_IDENTIFIED = "The assistant could not tell who is asking. Sign in again.";

/**
 * Scribe's agent as an AG-UI `AbstractAgent`. Holds nothing per user: the
 * runtime clones it per request, and every run reads its caller afresh.
 */
export class ScribeAgent extends AbstractAgent {
  constructor() {
    super({ agentId: COPILOTKIT_AGENT_ID, description: "Scribe's story assistant." });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const controller = new AbortController();
      // Read when the runtime subscribes, inside the request's scope if it
      // carried one this far.
      const userId = currentUserId();

      const pump = async () => {
        if (!userId) throw HttpError.unauthorized(NOT_IDENTIFIED);
        const { run, request } = fromRunAgentInput(input as Parameters<typeof fromRunAgentInput>[0]);
        const body = parseOrThrow(agentRequestSchema, request);
        const events = agentEvents(
          { message: body.message, storyKey: body.storyId ?? null, history: body.history },
          { userId, signal: controller.signal },
        );
        for await (const event of aguiEvents(events, run)) {
          if (subscriber.closed) return;
          // Core 1.0.3's events, typed against the runtime's 1.0.2: the
          // enum values are the same strings, the enums are not the same type.
          subscriber.next(event as unknown as BaseEvent);
        }
        subscriber.complete();
      };

      pump().catch((error: unknown) => {
        if (subscriber.closed) return;
        // In-band, as `/agent/agui` reports a failure after its status line:
        // the runtime has already answered 200 by the time a run starts.
        const reported =
          error instanceof HttpError
            ? { code: error.code, message: error.message }
            : { code: "internal_error", message: "The assistant could not answer just now." };
        if (!(error instanceof HttpError)) logger.error({ err: error }, "copilotkit run failed");
        subscriber.next({ type: EventType.RUN_ERROR, ...reported } as unknown as BaseEvent);
        subscriber.complete();
      });

      return () => controller.abort();
    });
  }
}

type ExpressHandler = (req: unknown, res: unknown, next: (error?: unknown) => void) => void;

let handler: Promise<ExpressHandler> | null = null;

/**
 * The runtime's Express handler, built once on first use. Threads live in the
 * runtime's in-memory runner, owned by the caller `identifyUser` names, so a
 * thread id one user holds is no key to another user's thread.
 */
export function copilotkitHandler(): Promise<ExpressHandler> {
  handler ??= (async () => {
    const [{ CopilotRuntime, InMemoryAgentRunner }, { createCopilotExpressHandler }] =
      await Promise.all([
        import("@copilotkit/runtime/v2"),
        import("@copilotkit/runtime/v2/express"),
      ]);

    const runtime = new CopilotRuntime({
      agents: { [COPILOTKIT_AGENT_ID]: new ScribeAgent() },
      runner: new InMemoryAgentRunner(),
      identifyUser: () => {
        const id = currentUserId();
        if (!id) throw HttpError.unauthorized(NOT_IDENTIFIED);
        return { id, name: id };
      },
    });

    // Mounted below the router's own path, so the runtime sees `/info`,
    // `/agent/scribe/run`; the app sets CORS for every route already.
    return createCopilotExpressHandler({ runtime, basePath: "/", cors: false }) as ExpressHandler;
  })();
  return handler;
}
