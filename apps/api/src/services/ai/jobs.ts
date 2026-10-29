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
 *   Queued by a save too (`auto`), for a story that already has a bible; that
 *   kind skips a story with none and an author out of allowance.
 * - `continuity.check` -- `checkChapter` skips a chapter whose stored check
 *   already covers its text and facts, so a re-run asks no model. Delayed and
 *   keyed by chapter, so a run of saves is one check.
 * - `usage.prune` -- a `DELETE ... WHERE createdAt < cutoff` is idempotent by
 *   construction. Scheduled once a day by the worker.
 * - `summary.story` -- `generateStorySummary` reuses every chapter summary and
 *   story summary whose input hash is unchanged, so a re-run writes nothing
 *   unless asked to `force` (the author's Regenerate, which is meant to).
 *   Runs as whoever queued it: the author for a regenerate, the platform for
 *   a reader's missing summary.
 */

import { HttpError } from "../../lib/http-error.js";
import { registerJobType } from "../../lib/jobs.js";
import { db } from "../../prisma/db.js";
import { runAs } from "./caller.js";
import { embedChapter } from "./embeddings.js";
import { runScheduledCheck } from "./continuity.js";
import {
  BIBLE_READ_JOB,
  CONTINUITY_CHECK_JOB,
  EMBED_CHAPTER_JOB,
  SUMMARY_STORY_JOB,
  USAGE_PRUNE_JOB,
} from "./job-schedule.js";
import { generateStorySummary } from "./summaries.js";
import { hasBible, refreshBible } from "./story-bible.js";
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
      // Queued by a save rather than by the author (`scheduleBibleRefresh`).
      const auto = payload["auto"] === true;

      // Kept current only once the author has built it.
      if (auto && !(await hasBible(storyId))) return { skipped: "no-bible" };

      let processed = 0;
      let pending = 0;
      try {
        for (let batch = 0; batch < BIBLE_MAX_BATCHES && !signal.aborted; batch += 1) {
          const result = await runAs(userId, () => refreshBible(userId, storyId, BIBLE_BATCH, signal), job.requestId);
          processed += result.processed.filter((item) => !item.unchanged).length;
          pending = result.bible.pending;
          if (pending === 0 || result.processed.length === 0) break;
        }
      } catch (error) {
        // An author out of allowance is not a failure to retry and dead-letter
        // for a read they did not ask for: what was read stays read, and the
        // next save, or the Read button, picks up the rest.
        if (auto && error instanceof HttpError && error.status === 429) {
          return { skipped: "limited", processed, pending };
        }
        throw error;
      }
      return { processed, pending };
    },
  });

  registerJobType(CONTINUITY_CHECK_JOB, {
    // A model that could not be asked is recorded as a failed check, not
    // thrown, so a retry here is for the database, not the provider.
    maxAttempts: 2,
    async handler(payload) {
      await runScheduledCheck(String(payload["chapterId"] ?? ""));
      return {};
    },
  });

  registerJobType(SUMMARY_STORY_JOB, {
    maxAttempts: 3,
    async handler(payload, { job, signal }) {
      const storyId = String(payload["storyId"] ?? "");
      const upTo = typeof payload["upToChapter"] === "number" ? payload["upToChapter"] : null;
      const result = await runAs(
        job.userId,
        () => generateStorySummary(storyId, upTo, { force: payload["force"] === true, signal }),
        job.requestId,
      );
      return { calls: result.calls, upToChapter: result.summary?.upToChapter ?? null };
    },
  });

  registerJobType(USAGE_PRUNE_JOB, {
    maxAttempts: 2,
    async handler() {
      return { removed: await pruneUsage() };
    },
  });
}
