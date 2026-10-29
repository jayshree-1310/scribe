/**
 * When a chapter gets its continuity check: a quiet minute after the last
 * save, not on every one.
 *
 * The editor autosaves a second and a half after typing stops, so a check per
 * save would be a model call per pause -- and every one but the last would be
 * about a draft that no longer exists. Each save therefore *resets* a timer
 * for its chapter, and the check runs once the author has left it alone for
 * `AI_CONTINUITY_QUIET_MS`.
 *
 * **A save never waits for any of this.** `scheduleContinuityCheck` returns
 * `void` after setting a timer; nothing it leads to can slow a save down or
 * fail one. The check itself is imported only when a timer fires, which is
 * also what keeps `services/authoring.ts` -- the caller -- from importing the
 * AI services that import it back.
 *
 * **On the job queue when there is one.** With `AI_JOBS` on, the check is a
 * `continuity.check` job delayed by the quiet period and keyed by chapter, so
 * each save pushes the one waiting job later -- the same debounce, but it
 * survives a restart and runs wherever the worker does. With jobs off (the
 * test suite, a server run without the worker) it falls back to an in-memory
 * timer, where a restart drops what is pending; nothing that matters is lost
 * either way, because a check is "is what is stored still a check of this
 * text?", and the next save or the Check button runs the dropped one.
 */

import { enqueue } from "../../lib/jobs.js";
import { logger } from "../../lib/logger.js";
import { loadAiConfig } from "./config.js";
import { CONTINUITY_CHECK_JOB } from "./job-schedule.js";

const timers = new Map<string, NodeJS.Timeout>();
const running = new Set<Promise<unknown>>();

function run(chapterId: string): void {
  timers.delete(chapterId);

  const work = import("./continuity.js")
    .then((continuity) => continuity.runScheduledCheck(chapterId))
    .catch((error: unknown) => {
      // Never rethrown: there is no request left to fail, and an unhandled
      // rejection from a background check must not take the process down.
      logger.warn({ err: error, chapterId }, "continuity: scheduled check failed");
    });

  running.add(work);
  void work.finally(() => running.delete(work));
}

/**
 * Asks for this chapter to be checked once it has gone quiet.
 *
 * Call it after the save commits. Whether the story has a bible at all -- and
 * so whether there is anything to check against -- is decided when the timer
 * fires, not here: answering it now would cost every save of every story a
 * query to learn, almost always, "no".
 */
export function scheduleContinuityCheck(chapterId: string): void {
  const config = loadAiConfig();
  if (!config.continuityChecks) return;

  if (config.jobs) {
    void enqueue(
      CONTINUITY_CHECK_JOB,
      { chapterId },
      { delayMs: config.continuityQuietMs, dedupeKey: `continuity:${chapterId}` },
    ).catch((error: unknown) => {
      // The queue is Redis; if it is unreachable the timer still checks.
      logger.warn({ err: error, chapterId }, "continuity: check not queued, timing it here");
      startTimer(chapterId, config.continuityQuietMs);
    });
    return;
  }

  startTimer(chapterId, config.continuityQuietMs);
}

function startTimer(chapterId: string, quietMs: number): void {
  const pending = timers.get(chapterId);
  if (pending) clearTimeout(pending);

  const timer = setTimeout(() => run(chapterId), quietMs);
  // A pending check is never a reason to keep the process alive.
  timer.unref();
  timers.set(chapterId, timer);
}

/** Whether a check is waiting for this chapter to go quiet. For tests. */
export function isContinuityCheckPending(chapterId: string): boolean {
  return timers.has(chapterId);
}

/**
 * Runs every waiting check now and settles the ones in flight.
 *
 * For tests, which cannot wait a minute. Not part of `drainDeferredWrites`:
 * that runs at shutdown and before an account is deleted, and neither should
 * be made to wait on a model.
 */
export async function flushContinuityChecks(): Promise<void> {
  for (const [chapterId, timer] of [...timers]) {
    clearTimeout(timer);
    run(chapterId);
  }

  while (running.size > 0) await Promise.all([...running]);
}

/** Drops every waiting check without running it. */
export function cancelContinuityChecks(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
