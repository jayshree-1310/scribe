import app from "./app.js";
import { logger } from "./lib/logger.js";
import { db } from "./prisma/db.js";

const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "Scribe API listening");
});

/** Drain in-flight requests, then release the database pool. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down");

  server.close(async (error) => {
    if (error) logger.error({ err: error }, "Error while closing server");

    try {
      await db.close();
    } catch (closeError) {
      logger.error({ err: closeError }, "Error while closing database pool");
    }

    process.exit(error ? 1 : 0);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}
