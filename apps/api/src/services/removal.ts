/**
 * Removing a story, a club or a channel along with every row that hangs off
 * it.
 *
 * Shared by the single deletes (`deleteStory`, `deleteClub`,
 * `deleteChannel`) and by `deleteAccount`, which removes all of a person's at
 * once. Each used to carry its own copy of these sweeps, and the copies
 * drifted: the account one learnt about analytics rows that the story one
 * never did, so an author could not delete any story somebody had opened.
 *
 * Every sweep is one raw statement rather than the ORM's `deleteAll` loop, for
 * two reasons:
 *
 * - **Self-referencing tables.** `engagement.comment` and
 *   `clubs.clubDiscussion` point back at themselves through `parentId`.
 *   `deleteAll` takes an arbitrary matching row each round and can take a
 *   thread before its replies, which the foreign key refuses. Postgres checks
 *   a non-deferred foreign key at the *end* of a statement, so a thread and
 *   its replies leaving in the same `DELETE` is fine whatever the row order.
 * - **Size.** An active story has thousands of reads and views; one statement
 *   per table is one round trip, not one per row.
 *
 * None of these check who is asking. The callers authorise first, inside the
 * same transaction they pass in.
 */

import { db } from "../prisma/db.js";

/**
 * The transaction context. Derived from `db.transaction` for the reason
 * `services/authoring.ts` gives: the type is not re-exported from the runtime
 * entry point.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Deletes a story and everything that references it, whoever wrote it.
 *
 * Other readers' comments, ratings, progress, shelves and challenge entries
 * go with it -- there is nothing left for them to point at, which is what the
 * confirmation dialog warns about. A club reading it keeps going with no
 * current read: that club belongs to somebody else, and its setting must not
 * be able to block an author's delete.
 *
 * Tables declared `onDelete: Cascade` (the AI-derived rows and
 * `library.libraryEntry`) need no line here. `ai.chapterSummary` is the one
 * AI table that does not cascade, so it is swept by hand.
 */
export async function removeStory(tx: Tx, storyId: string): Promise<void> {
  // Rows keyed on a chapter only, with no `storyId` of their own.
  await tx.query(
    db.raw.sql`
      DELETE FROM "content"."multimedia"
       WHERE "chapterId" IN (SELECT "id" FROM "content"."chapter" WHERE "storyId" = ${storyId})
    `.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`
      DELETE FROM "engagement"."chapterLike"
       WHERE "chapterId" IN (SELECT "id" FROM "content"."chapter" WHERE "storyId" = ${storyId})
    `.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`
      DELETE FROM "ai"."chapterSummary"
       WHERE "chapterId" IN (SELECT "id" FROM "content"."chapter" WHERE "storyId" = ${storyId})
    `.affectedCount().build(),
  );

  // Likes on the story's comments, then the comments -- threads and replies
  // together, see the header.
  await tx.query(
    db.raw.sql`
      DELETE FROM "engagement"."commentLike"
       WHERE "commentId" IN (SELECT "id" FROM "engagement"."comment" WHERE "storyId" = ${storyId})
    `.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "engagement"."comment" WHERE "storyId" = ${storyId}`.affectedCount().build(),
  );

  /**
   * The analytics events. Most belong to nobody -- a signed-out visitor is
   * recorded with a null `userId` -- so no per-user sweep can reach them.
   * Comments, progress and reads all carry `storyId` even when they point at
   * a chapter, so one pass each clears the chapter-level rows too.
   */
  await tx.query(
    db.raw.sql`DELETE FROM "engagement"."chapterRead" WHERE "storyId" = ${storyId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "engagement"."storyView" WHERE "storyId" = ${storyId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "engagement"."rating" WHERE "storyId" = ${storyId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "engagement"."readingHistory" WHERE "storyId" = ${storyId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "challenges"."challengeEntry" WHERE "storyId" = ${storyId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`
      UPDATE "clubs"."bookClub"
         SET "currentStoryId" = NULL, "updatedAt" = now()
       WHERE "currentStoryId" = ${storyId}
    `.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "content"."storyGenre" WHERE "storyId" = ${storyId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "content"."chapter" WHERE "storyId" = ${storyId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "content"."story" WHERE "id" = ${storyId}`.affectedCount().build(),
  );
}

/** Deletes a club with its whole membership roll and every discussion in it. */
export async function removeClub(tx: Tx, clubId: string): Promise<void> {
  await tx.query(
    db.raw.sql`DELETE FROM "clubs"."clubDiscussion" WHERE "clubId" = ${clubId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "clubs"."clubMembership" WHERE "clubId" = ${clubId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "clubs"."bookClub" WHERE "id" = ${clubId}`.affectedCount().build(),
  );
}

/** Deletes a channel with all its posts and subscriptions. */
export async function removeChannel(tx: Tx, channelId: string): Promise<void> {
  await tx.query(
    db.raw.sql`DELETE FROM "channels"."channelPost" WHERE "channelId" = ${channelId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "channels"."channelSubscriber" WHERE "channelId" = ${channelId}`.affectedCount().build(),
  );
  await tx.query(
    db.raw.sql`DELETE FROM "channels"."broadcastChannel" WHERE "id" = ${channelId}`.affectedCount().build(),
  );
}
