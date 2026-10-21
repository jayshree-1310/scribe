import app from "./app.js";
import { logger } from "./lib/logger.js";
import { db } from "./prisma/db.js";
import { connectRedis, redis } from "./lib/redis.js";
import { drainDeferredWrites } from "./services/deferred.js";
import { enqueue, startWorker, stopWorker } from "./lib/jobs.js";
import { loadAiConfig } from "./services/ai/config.js";
import { USAGE_PRUNE_JOB } from "./services/ai/job-schedule.js";
import { registerAiJobs } from "./services/ai/jobs.js";

/**
 * Queues the daily usage prune, once a day across restarts: the `NX` key is
 * the "already scheduled today" marker, so a server restarted ten times in a
 * day still prunes once.
 */
async function scheduleDailyPrune(): Promise<void> {
  const claimed = await redis.set("jobs:schedule:usage.prune", "1", { NX: true, EX: 60 * 60 * 24 });
  if (claimed) await enqueue(USAGE_PRUNE_JOB, {});
}

const PORT = Number(process.env.PORT) || 3000;

async function start() {
  await connectRedis();

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "Scribe API listening");
  });

  /**
   * The background worker, in this process: one small instance, so a second
   * service would be a second bill for work that takes seconds. See
   * `lib/jobs.ts` and `docs/ai-operations.md`.
   */
  let pruneTimer: NodeJS.Timeout | undefined;
  if (loadAiConfig().jobs) {
    registerAiJobs();
    await startWorker();
    const prune = () => void scheduleDailyPrune().catch((error) => logger.warn({ err: error }, "usage prune not scheduled"));
    prune();
    pruneTimer = setInterval(prune, 60 * 60 * 1000);
  }

  /** Drain in-flight requests, then release database and Redis connections. */
  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "Shutting down");

    server.close(async (error) => {
      if (error) {
        logger.error({ err: error }, "Error while closing server");
      }

      // Stop taking jobs and let the current one finish; anything still
      // queued stays in Redis for the next process.
      clearInterval(pruneTimer);
      try {
        await stopWorker();
      } catch (workerError) {
        logger.error({ err: workerError }, "Error while stopping the job worker");
      }

      try {
        /**
         * Analytics events, badge awards and notification fan-outs are issued
         * fire-and-forget, so a request that has already answered can still
         * have a write in flight here; without draining them the write meets a
         * closed pool and is lost. The order they have to settle in is
         * `drainDeferredWrites`'s business, not this file's.
         */
        await drainDeferredWrites();
      } catch (flushError) {
        logger.error({ err: flushError }, "Error while draining background writes");
      }

      try {
        await db.close();
      } catch (closeError) {
        logger.error(
          { err: closeError },
          "Error while closing database pool",
        );
      }

      try {
        await redis.quit();
      } catch (redisError) {
        logger.error(
          { err: redisError },
          "Error while closing Redis connection",
        );
      }

      process.exit(error ? 1 : 0);
    });
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

void start();