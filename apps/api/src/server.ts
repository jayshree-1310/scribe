import app from "./app.js";
import { logger } from "./lib/logger.js";
import { db } from "./prisma/db.js";
import { connectRedis, redis } from "./lib/redis.js";
import { flushAnalytics } from "./services/analytics.js";
import { flushBadges } from "./services/gamification.js";
import { flushNotifications } from "./services/notifications.js";

const PORT = Number(process.env.PORT) || 3000;

async function start() {
  await connectRedis();

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "Scribe API listening");
  });

  /** Drain in-flight requests, then release database and Redis connections. */
  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "Shutting down");

    server.close(async (error) => {
      if (error) {
        logger.error({ err: error }, "Error while closing server");
      }

      try {
        /**
         * Analytics events, badge awards and notification fan-outs are issued
         * fire-and-forget, so a request that has already answered can still
         * have a write in flight here. All three expose a flush for exactly
         * this; without it the write meets a closed pool and is lost.
         *
         * Notifications drain *after* badges rather than alongside them: an
         * award issues a notification as it lands, so draining both at once
         * can finish the second before the first has handed it anything. See
         * `flushNotifications`.
         */
        await Promise.all([flushAnalytics(), flushBadges()]);
        await flushNotifications();
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