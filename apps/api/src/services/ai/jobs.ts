/**
 * The AI work that runs off the request path (Task AI 20).
 *
 * Each handler is idempotent, because the queue promises at-least-once: a
 * retried or recovered job runs again, and must not double-write.
 *
 * - `embed.chapter` -- `embedChapter` compares window hashes and writes only
 *   what changed, so a second run over the same text writes nothing. Only a
 *   published chapter of a listed story is embedded, the backfill's own rule:
 *   the cheapest way to keep a draft out of search is to keep it out of the
 *   index.
 * - `bible.read` -- `refreshBible` reads only chapters whose stored reading is
 *   stale, so a re-run picks up where the last stopped. Runs as the author who
 *   asked, so it is charged to them and refused when they are over budget.
 * - `usage.prune` -- a `DELETE ... WHERE createdAt < cutoff` is idempotent by
 *   construction. Scheduled once a day by the worker.
 */

import { HttpError } from "../../lib/http-error.js";
import { registerJobType } from "../../lib/jobs.js";
import { db } from "../../prisma/db.js";
import { runAs } from "./caller.js";
import { embedChapter } from "./embeddings.js";
import { BIBLE_READ_JOB, EMBED_CHAPTER_JOB, USAGE_PRUNE_JOB } from "./job-schedule.js";
import { refreshBible } from "./story-bible.js";
import { pruneUsage } from "./usage.js";

/** Chapters per `refreshBible` call: the same batch the bible page asks for. */
const BIBLE_BATCH = 3;
/** A runaway guard: a hundred batches is three hundred chapters. */
const BIBLE_MAX_BATCHES = 100;

export function registerAiJobs(): void {
  registerJobType(EMBED_CHAPTER_JOB, {
    maxAttempts: 4,
    async handler(payload, { job }) {
      const chapterId = String(payload["chapterId"] ?? "");
      const chapter = await db.orm.content.Chapter.select("id", "storyId", "content", "publishedAt")
        .where((row) => row.id.eq(chapterId))
        .first();
      // Deleted since it was queued: nothing to do, and not a failure.
      if (!chapter) return { skipped: "missing" };

      const story = await db.orm.content.Story.select("listedAt")
        .where((row) => row.id.eq(chapter.storyId))
        .first();
      if (chapter.publishedAt === null || chapter.publishedAt === undefined || !story?.listedAt) {
        return { skipped: "unpublished" };
      }

      const result = await runAs(null, () =>
        embedChapter({ id: chapter.id, storyId: chapter.storyId, content: chapter.content }),
        job.requestId,
      );
      return result;
    },
  });

  registerJobType(BIBLE_READ_JOB, {
    maxAttempts: 3,
    async handler(payload, { job, signal }) {
      const storyId = String(payload["storyId"] ?? "");
      if (!job.userId) throw HttpError.forbidden("A bible reading needs the author who asked for it.");
      const userId = job.userId;

      let processed = 0;
      let pending = 0;
      for (let batch = 0; batch < BIBLE_MAX_BATCHES && !signal.aborted; batch += 1) {
        const result = await runAs(userId, () => refreshBible(userId, storyId, BIBLE_BATCH, signal), job.requestId);
        processed += result.processed.filter((item) => !item.unchanged).length;
        pending = result.bible.pending;
        if (pending === 0 || result.processed.length === 0) break;
      }
      return { processed, pending };
    },
  });

  registerJobType(USAGE_PRUNE_JOB, {
    maxAttempts: 2,
    async handler() {
      return { removed: await pruneUsage() };
    },
  });
}
