/**
 * Whose behalf an AI call is made on (Task AI 18).
 *
 * The provider seam is shared by twenty features, and neither the budget nor
 * the usage table can be right if each feature has to remember to pass the
 * caller down to it -- the first one that forgot would be spending for free.
 * So the caller travels in an `AsyncLocalStorage` set once, around the AI
 * router, and the provider layers read it: every model call a request makes,
 * however deep in a service, is charged to the person who made the request.
 *
 * Work the platform does on its own behalf runs as nobody (`null`):
 * moderating a comment is not the commenter's spend, and neither is the eval
 * or a backfill script. Background work done *for* someone names them
 * explicitly with `runAs` -- the continuity check a save schedules runs as
 * the story's author, a minute after the request that scheduled it is gone.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface AiCaller {
  /** Null for the platform's own work. */
  userId: string | null;
  /**
   * The HTTP request (pino-http's id) or job this work belongs to, so every
   * log line a user action causes -- the request, each provider call, a job
   * it queued -- can be found by one id (Task AI 20).
   */
  requestId: string | null;
}

const storage = new AsyncLocalStorage<AiCaller>();

/** Runs `fn`, and every model call it makes, as `userId`. */
export function runAs<T>(userId: string | null, fn: () => T, requestId?: string | null): T {
  // A nested `runAs` keeps the enclosing request id unless it names its own.
  const inherited = storage.getStore()?.requestId ?? null;
  return storage.run({ userId, requestId: requestId ?? inherited }, fn);
}

/** The caller of the current model call, or null outside any request. */
export function currentUserId(): string | null {
  return storage.getStore()?.userId ?? null;
}

/** The request or job id the current work belongs to, if any. */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}
