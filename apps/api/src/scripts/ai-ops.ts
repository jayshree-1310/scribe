/**
 * Operating the AI side without a deploy (`docs/ai-operations.md`).
 *
 *   pnpm --filter api ai:ops status            queue counts, dead letters, switches
 *   pnpm --filter api ai:ops retry <job-id>    give a dead job fresh attempts
 *   pnpm --filter api ai:ops purge             drop every dead job
 *   pnpm --filter api ai:ops drain             run every queued job now, here
 *   pnpm --filter api ai:ops off <feature>     switch a feature off (e.g. assist)
 *   pnpm --filter api ai:ops on <feature>      switch it back on
 */

import { deadJobs, drainJobs, purgeDeadJobs, queueCounts, retryDeadJob } from "../lib/jobs.js";
import { redis } from "../lib/redis.js";
import { db } from "../prisma/db.js";
import { registerAiJobs } from "../services/ai/jobs.js";
import { disabledFeatures, setFeature } from "../services/ai/switches.js";

const [command, argument] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (command) {
    case "status": {
      console.log("Queue:", await queueCounts());
      const dead = await deadJobs(20);
      console.log(dead.length === 0 ? "No dead jobs." : "Dead jobs (newest last):");
      for (const job of dead) console.log(`  ${job.id}  ${job.type}  ${job.error ?? ""}  attempts=${job.attempts}  ${job.updatedAt}`);
      const off = await disabledFeatures();
      console.log(off.length === 0 ? "Every AI feature is on." : `Switched off: ${off.join(", ")}`);
      return 0;
    }
    case "retry":
      if (!argument) break;
      console.log((await retryDeadJob(argument)) ? `Requeued ${argument}.` : `${argument} is not a dead job.`);
      return 0;
    case "purge":
      console.log(`Dropped ${await purgeDeadJobs()} dead job(s).`);
      return 0;
    case "drain":
      // Runs the handlers in this process, so an operator can empty the queue
      // with the API's worker stopped.
      registerAiJobs();
      console.log(`Ran ${await drainJobs()} job(s).`);
      return 0;
    case "off":
    case "on":
      if (!argument) break;
      console.log("Switched off:", (await setFeature(argument, command === "on")).join(", ") || "nothing");
      return 0;
  }
  console.error("Usage: ai:ops status | retry <job-id> | purge | drain | off <feature> | on <feature>");
  return 1;
}

let code = 1;
try {
  code = await main();
} finally {
  await db.close();
  if (redis.isOpen) await redis.quit();
}
process.exit(code);
