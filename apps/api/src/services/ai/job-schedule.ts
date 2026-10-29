/**
 * Queueing AI work from outside `services/ai/` (Task AI 20).
 *
 * Imported by `authoring.ts`, so it imports nothing that imports authoring --
 * only the generic queue and configuration, exactly as `continuity-queue.ts`
 * does for the same reason. The handlers live in `jobs.ts`, registered by the
 * process that runs the worker.
 *
 * Never throws: a chapter is published whether or not its embedding could be
 * queued, and running `seed:embeddings` catches anything that was missed.
 */

import { enqueue } from "../../lib/jobs.js";
import { logger } from "../../lib/logger.js";
import { loadAiConfig } from "./config.js";

export const EMBED_CHAPTER_JOB = "embed.chapter";
export const BIBLE_READ_JOB = "bible.read";
export const USAGE_PRUNE_JOB = "usage.prune";
export const SUMMARY_STORY_JOB = "summary.story";
/** Queued by `continuity-queue.ts`, which owns the debounce. */
export const CONTINUITY_CHECK_JOB = "continuity.check";

/**
 * How long after the last save a published chapter is embedded. The editor
 * autosaves every pause; a minute of quiet is one embedding per editing
 * session rather than one per sentence.
 */
export const EMBED_QUIET_MS = 60_000;

/**
 * How long after the last save a story's bible is read again. Longer than
 * the continuity check's quiet minute, so a check compares the new chapter
 * with what the bible said before it, and the bible then learns the change.
 */
export const BIBLE_QUIET_MS = 3 * 60_000;

/**
 * Queues (or pushes back) a re-read of a story's bible, as its author, after
 * they have stopped writing for a while.
 *
 * Only a bible the author has already built is kept current: the handler
 * skips a story with none, because reading every chapter of every story on
 * save would spend authors' allowances on something they never asked for.
 * Its own dedupe key, apart from the author's Read button, so an autosave
 * can never push an explicit request later.
 */
export async function scheduleBibleRefresh(
  storyId: string,
  userId: string,
  delayMs = BIBLE_QUIET_MS,
): Promise<void> {
  if (!loadAiConfig().jobs) return;
  try {
    await enqueue(
      BIBLE_READ_JOB,
      { storyId, auto: true },
      { userId, delayMs, dedupeKey: `bible-auto:${storyId}` },
    );
  } catch (error) {
    logger.warn({ err: error, storyId }, "bible refresh not queued");
  }
}

/** Queues (or pushes back) the embedding of one chapter. */
export async function scheduleChapterEmbedding(chapterId: string, delayMs = EMBED_QUIET_MS): Promise<void> {
  if (!loadAiConfig().jobs) return;
  try {
    await enqueue(EMBED_CHAPTER_JOB, { chapterId }, { delayMs, dedupeKey: `embed:${chapterId}` });
  } catch (error) {
    logger.warn({ err: error, chapterId }, "chapter embedding not queued");
  }
}
