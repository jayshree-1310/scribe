/**
 * Runs the automated content check over comments that have no verdict yet.
 *
 *   pnpm --filter api moderation:pending          # up to 200 comments
 *   pnpm --filter api moderation:pending 1000     # a larger batch
 *
 * Two kinds of comment have none: those posted while the model could not be
 * reached, which were published and recorded as `UNCHECKED` (see
 * `services/ai/moderation.ts` for why they were not held), and those posted
 * before the check existed. This is what closes that gap; there is no job
 * runner (Task AI 20), so nothing else will.
 *
 * **Safe to re-run.** A comment with a verdict is skipped without a model
 * call, one a moderator has already ruled on is never acted on again, and the
 * sweep stops at the first comment the model cannot be asked about rather than
 * failing the same way down the whole list.
 *
 * It does what a live check does, including hiding: a comment scoring above
 * the reject threshold is taken down and its author told. Run it with the
 * thresholds you mean.
 */

import { db } from "../prisma/db.js";
import { loadAiModerationConfig } from "../services/ai/config.js";
import { moderatePending } from "../services/ai/moderation.js";
import { drainDeferredWrites } from "../services/deferred.js";

const DEFAULT_BATCH = 200;

async function main(): Promise<void> {
  const config = loadAiModerationConfig();
  if (!config.enabled) {
    console.log("AI_MODERATION is off; nothing to do.");
    return;
  }

  const requested = Number(process.argv[2]);
  const limit =
    Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_BATCH;

  console.log(
    `Checking up to ${limit} comments ` +
      `(review at ${config.reviewThreshold}, hide at ${config.rejectThreshold}).`,
  );

  const sweep = await moderatePending(limit);

  console.log(
    `${sweep.examined} checked: ${sweep.allowed} allowed, ` +
      `${sweep.queued} queued for review, ${sweep.hidden} hidden and queued.`,
  );

  if (sweep.unchecked > 0) {
    console.log(
      "Stopped early: the model could not be asked. Nothing was hidden or " +
        "queued for that comment; run this again when it is reachable.",
    );
  }

  // Hiding tells the author, and that write is fire-and-forget.
  await drainDeferredWrites();
}

await main();
await db.close();
