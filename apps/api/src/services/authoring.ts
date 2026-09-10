/**
 * The author side of `content.Story`: everything that writes.
 *
 * `services/stories.ts` is the reader's half of the same table and stays
 * read-only; this module owns creation, editing, ordering and publication.
 * Reads that an author needs are delegated back to that module rather than
 * reimplemented, so an author and a reader can never disagree about what a
 * story looks like.
 *
 * Two invariants are enforced here and nowhere else:
 *
 * - Every function takes the caller's id and asserts ownership before it
 *   writes. Nothing trusts an id from a request body.
 * - `Chapter.chapterNumber` is contiguous from 1 with no gaps, and
 *   `Chapter.wordCount` matches the body it was written from. Both are
 *   maintained inside the same transaction as the write that disturbed them.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { uniqueSlug } from "../lib/slug.js";
import { deleteAll } from "../prisma/delete-all.js";
import { discardUpload } from "./uploads.js";
import { getStory, listStories, toIso, type Page, type Story } from "./stories.js";

/**
 * The transaction context, so the helpers below can take one. Read off
 * `db.transaction` rather than imported: the type is not re-exported from the
 * runtime entry point, and deriving it here cannot drift from the client.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Either the transaction context or the client itself, for the handful of
 * helpers that are useful in both — a lookup that guards a write belongs
 * inside its transaction, the same lookup in a read path does not.
 */
type Orm = Pick<Tx, "orm"> | typeof db;

/* Shapes returned to the client ----------------------------------------- */

export interface AuthoredChapter {
  id: string;
  storyId: string;
  number: number;
  title: string;
  content: string;
  wordCount: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The chapter's attachments, so the editor can show what is attached
   * without a request per chapter. Same rows the reader gets from
   * `services/stories.ts`.
   */
  multimedia: AuthoredMedia[];
}

export interface AuthoredMedia {
  id: string;
  chapterId: string;
  type: MultimediaType;
  url: string;
  displayOrder: number;
}

export const MULTIMEDIA_TYPES = ["IMAGE", "AUDIO", "VIDEO", "LINK"] as const;

export type MultimediaType = (typeof MULTIMEDIA_TYPES)[number];

export interface StoryInput {
  title: string;
  description?: string | undefined;
  coverUrl?: string | undefined;
  /** Replaces the whole `StoryGenre` set when present; absent leaves it be. */
  genreIds?: string[] | undefined;
  kidsAppropriate?: boolean | undefined;
  isCompleted?: boolean | undefined;
}

export interface ChapterInput {
  title: string;
  content?: string | undefined;
}

export interface ChapterPatch {
  title?: string | undefined;
  content?: string | undefined;
}

/* Helpers ---------------------------------------------------------------- */

const STORY_NOT_FOUND = "That story could not be found.";
const CHAPTER_NOT_FOUND = "That chapter could not be found.";

function now(): Temporal.Instant {
  return Temporal.Now.instant();
}

/**
 * Words in a chapter body.
 *
 * Whitespace-separated runs, which is what the editor's own counter does
 * (`apps/web/src/pages/author/markdown.tsx`) -- the two have to agree or the
 * word count jumps the moment a chapter is saved. Markup is counted as written
 * rather than stripped: `**bold**` is one word either way, and a reading-time
 * estimate does not turn on the difference.
 */
export function countWords(content: string): number {
  const trimmed = content.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

interface OwnedStoryRow {
  id: string;
  authorId: string;
  slug: string;
  title: string;
  source: string;
  coverUrl: string | null;
  listedAt: unknown;
}

/**
 * The story `storyId` names, once the caller is established as its author.
 *
 * 404 for a story that does not exist, 403 for one that does but belongs to
 * somebody else: an author must be told the difference, and a story's
 * existence is not a secret -- its *contents* are, and those are guarded by
 * the read path in `services/stories.ts`.
 *
 * A catalogue import is refused outright. Its `authorId` points at whichever
 * account the seed script attributed it to, so ownership alone would let that
 * account rewrite an imported edition through the authoring API.
 */
async function ownedStory(
  client: Orm,
  storyId: string,
  userId: string,
): Promise<OwnedStoryRow> {
  const row = await client.orm.content.Story.select(
    "id",
    "authorId",
    "slug",
    "title",
    "source",
    "coverUrl",
    "listedAt",
  )
    .where((story) => story.id.eq(storyId))
    .first();

  if (!row) throw HttpError.notFound(STORY_NOT_FOUND);
  if (row.authorId !== userId) {
    throw HttpError.forbidden("That story is not yours to edit.");
  }
  if (row.source !== "SCRIBE") {
    throw HttpError.forbidden("Catalogue editions cannot be edited here.");
  }

  return row;
}

interface OwnedChapterRow {
  id: string;
  storyId: string;
  chapterNumber: number;
  title: string;
  content: string;
  publishedAt: unknown;
}

/** The same guard, entered from a chapter id. */
async function ownedChapter(
  client: Orm,
  chapterId: string,
  userId: string,
): Promise<{ chapter: OwnedChapterRow; story: OwnedStoryRow }> {
  const chapter = await client.orm.content.Chapter.select(
    "id",
    "storyId",
    "chapterNumber",
    "title",
    "content",
    "publishedAt",
  )
    .where((row) => row.id.eq(chapterId))
    .first();

  if (!chapter) throw HttpError.notFound(CHAPTER_NOT_FOUND);

  return { chapter, story: await ownedStory(client, chapter.storyId, userId) };
}

function toChapter(row: {
  id: string;
  storyId: string;
  chapterNumber: number;
  title: string;
  content: string;
  wordCount: number;
  publishedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
},
  media: AuthoredMedia[] = [],
): AuthoredChapter {
  return {
    id: row.id,
    storyId: row.storyId,
    number: row.chapterNumber,
    title: row.title,
    content: row.content,
    wordCount: row.wordCount,
    publishedAt: toIso(row.publishedAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
    multimedia: media,
  };
}

const MEDIA_COLUMNS = [
  "id",
  "chapterId",
  "type",
  "url",
  "displayOrder",
] as const;

/**
 * Attachments for a set of chapters, grouped by chapter.
 *
 * One query for the whole story rather than one per chapter: the editor loads
 * every chapter at once, and this is the shape `toChapter` wants.
 */
async function mediaByChapter(
  chapterIds: string[],
): Promise<Map<string, AuthoredMedia[]>> {
  const grouped = new Map<string, AuthoredMedia[]>();
  if (chapterIds.length === 0) return grouped;

  const rows = await db.orm.content.Multimedia.select(...MEDIA_COLUMNS)
    .where((item) => item.chapterId.in(chapterIds))
    .orderBy((item) => item.displayOrder.asc())
    .all();

  for (const row of rows) {
    const list = grouped.get(row.chapterId) ?? [];
    list.push(toMedia(row));
    grouped.set(row.chapterId, list);
  }

  return grouped;
}

const CHAPTER_COLUMNS = [
  "id",
  "storyId",
  "chapterNumber",
  "title",
  "content",
  "wordCount",
  "publishedAt",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Rewrites `chapterNumber` so the given order becomes 1..n.
 *
 * Two passes, through negative numbers, because `@@unique([storyId,
 * chapterNumber])` is checked per statement rather than at commit: moving
 * chapter 3 to position 1 collides with the sitting chapter 1 the instant the
 * first UPDATE lands. Negatives cannot collide with anything, so the second
 * pass always has a clear field.
 */
async function renumber(
  tx: Tx,
  orderedIds: string[],
  timestamp: Temporal.Instant,
): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await tx.orm.content.Chapter.where((chapter) => chapter.id.eq(id)).update({
      chapterNumber: -(index + 1),
    });
  }

  for (const [index, id] of orderedIds.entries()) {
    await tx.orm.content.Chapter.where((chapter) => chapter.id.eq(id)).update({
      chapterNumber: index + 1,
      updatedAt: timestamp,
    });
  }
}

/** Chapter ids of one story in reading order. */
async function chapterIdsInOrder(tx: Tx, storyId: string): Promise<string[]> {
  const rows = await tx.orm.content.Chapter.select("id")
    .where((chapter) => chapter.storyId.eq(storyId))
    .orderBy((chapter) => chapter.chapterNumber.asc())
    .all();

  return rows.map((row) => row.id);
}

/**
 * Points the story's genre set at exactly `genreIds`.
 *
 * Delete-then-insert rather than a diff: the set is at most a handful of rows,
 * and inside the caller's transaction the intermediate state is invisible.
 * Unknown ids are rejected before anything is written, so a typo cannot leave
 * a story with half its genres.
 */
async function replaceGenres(
  tx: Tx,
  storyId: string,
  genreIds: string[],
): Promise<void> {
  const wanted = [...new Set(genreIds)];

  if (wanted.length > 0) {
    const known = await tx.orm.content.Genre.select("id")
      .where((genre) => genre.id.in(wanted))
      .all();

    if (known.length !== wanted.length) {
      throw HttpError.badRequest("Some of the details need fixing.", {
        genreIds: "One of those genres no longer exists.",
      });
    }
  }

  await deleteAll(() =>
    tx.orm.content.StoryGenre.where((link) => link.storyId.eq(storyId)),
  );

  for (const genreId of wanted) {
    await tx.orm.content.StoryGenre.create({ storyId, genreId });
  }
}

/** Marks `updatedAt` on the story any child write just changed. */
async function touchStory(
  tx: Tx,
  storyId: string,
  timestamp: Temporal.Instant,
): Promise<void> {
  await tx.orm.content.Story.where((story) => story.id.eq(storyId)).update({
    updatedAt: timestamp,
  });
}

/* Stories ---------------------------------------------------------------- */

/**
 * The caller's own stories, drafts included.
 *
 * Delegated to the public list query with the caller as both filter and
 * viewer, because its visibility rule already answers exactly this: listed
 * stories plus the viewer's own drafts, narrowed to one author.
 */
export function listMyStories(
  userId: string,
  page: number,
  limit: number,
): Promise<Page<Story>> {
  return listStories(
    { authorId: userId, sort: "newest", page, limit },
    userId,
  );
}

export async function createStory(
  userId: string,
  input: StoryInput,
): Promise<Story> {
  const timestamp = now();

  const storyId = await db.transaction(async (tx) => {
    const slug = await uniqueSlug(input.title, async (candidate) => {
      const taken = await tx.orm.content.Story.select("id")
        .where((story) => story.slug.eq(candidate))
        .first();
      return taken !== undefined && taken !== null;
    });

    const story = await tx.orm.content.Story.select("id").create({
      authorId: userId,
      title: input.title,
      slug,
      source: "SCRIBE",
      // A new story is always a draft. Publishing is a deliberate, separate
      // act -- see `publishStory`.
      listedAt: null,
      description: input.description ?? null,
      coverUrl: input.coverUrl ?? null,
      kidsAppropriate: input.kidsAppropriate ?? false,
      isCompleted: input.isCompleted ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    if (input.genreIds) await replaceGenres(tx, story.id, input.genreIds);

    /**
     * Becoming an author is not a decision anyone makes separately: the flag
     * exists to tell the UI which navigation to show, and starting a story is
     * the only act that means "I write here". An explicit endpoint would be a
     * step with nothing behind it, so the write rides along with the first
     * story instead.
     */
    await tx.orm.auth.User.where((user) => user.id.eq(userId)).update({
      isAuthor: true,
      updatedAt: timestamp,
    });

    return story.id;
  });

  return getStory(storyId, userId);
}

export async function updateStory(
  userId: string,
  storyId: string,
  input: Partial<StoryInput>,
): Promise<Story> {
  const timestamp = now();

  /**
   * The file a new cover replaces. Removed only after the transaction commits:
   * a rollback would otherwise leave the story pointing at a file that is
   * already gone.
   */
  let replacedCover: string | null = null;

  await db.transaction(async (tx) => {
    const story = await ownedStory(tx, storyId, userId);

    const changes: Record<string, unknown> = { updatedAt: timestamp };

    if (input.title !== undefined && input.title !== story.title) {
      changes["title"] = input.title;

      /**
       * A slug is stable once anyone could have linked to it, so a rename only
       * re-derives it while the story is still a draft. After publication the
       * old slug keeps working and simply no longer matches the title -- the
       * alternative is breaking every link and bookmark to the story.
       */
      if (story.listedAt === null || story.listedAt === undefined) {
        changes["slug"] = await uniqueSlug(input.title, async (candidate) => {
          if (candidate === story.slug) return false;
          const taken = await tx.orm.content.Story.select("id")
            .where((row) => row.slug.eq(candidate))
            .first();
          return taken !== undefined && taken !== null;
        });
      }
    }

    if (input.description !== undefined) {
      changes["description"] = input.description.length > 0
        ? input.description
        : null;
    }
    if (input.coverUrl !== undefined) {
      const next = input.coverUrl.length > 0 ? input.coverUrl : null;

      if (next !== story.coverUrl) {
        changes["coverUrl"] = next;
        replacedCover = story.coverUrl;
      }
    }
    if (input.kidsAppropriate !== undefined) {
      changes["kidsAppropriate"] = input.kidsAppropriate;
    }
    if (input.isCompleted !== undefined) {
      changes["isCompleted"] = input.isCompleted;
    }

    await tx.orm.content.Story.where((row) => row.id.eq(storyId)).update(changes);

    if (input.genreIds) await replaceGenres(tx, storyId, input.genreIds);
  });

  await discardUpload(replacedCover);

  return getStory(storyId, userId);
}

/**
 * Deletes a story and everything hanging off it.
 *
 * The dependent rows go by hand because only `library.LibraryEntry` declares
 * `onDelete: Cascade` in the contract; the rest would raise a foreign-key
 * violation. That includes other people's comments, ratings and progress:
 * there is nothing for them to point at once the story is gone, which is what
 * the confirmation dialog warns about.
 */
export async function deleteStory(
  userId: string,
  storyId: string,
): Promise<void> {
  let cover: string | null = null;
  const media: string[] = [];

  await db.transaction(async (tx) => {
    const story = await ownedStory(tx, storyId, userId);
    cover = story.coverUrl;

    const chapterIds = await chapterIdsInOrder(tx, storyId);

    media.push(...(await mediaUrls(tx, chapterIds)));

    for (const chapterId of chapterIds) {
      await deleteAll(() =>
        tx.orm.content.Multimedia.where((item) => item.chapterId.eq(chapterId)),
      );
    }

    // Comments and progress rows carry `storyId` even when they point at a
    // chapter, so one pass each clears both the story-level and chapter-level
    // rows before the chapters themselves go.
    await deleteAll(() =>
      tx.orm.engagement.Comment.where((row) => row.storyId.eq(storyId)),
    );
    await deleteAll(() =>
      tx.orm.engagement.ReadingHistory.where((row) => row.storyId.eq(storyId)),
    );
    await deleteAll(() =>
      tx.orm.engagement.Rating.where((row) => row.storyId.eq(storyId)),
    );
    await deleteAll(() =>
      tx.orm.challenges.ChallengeEntry.where((row) => row.storyId.eq(storyId)),
    );
    await deleteAll(() =>
      tx.orm.content.StoryGenre.where((link) => link.storyId.eq(storyId)),
    );
    await deleteAll(() =>
      tx.orm.content.Chapter.where((chapter) => chapter.storyId.eq(storyId)),
    );

    await tx.orm.content.Story.where((story) => story.id.eq(storyId)).delete();
  });

  // Nothing references the cover or the chapter attachments now.
  await discardUpload(cover);
  await discardUploads(media);
}

/* Publication ------------------------------------------------------------ */

/**
 * Lists the story, making it visible to every reader.
 *
 * A story with nothing published in it would appear on the shelves as an empty
 * book, so at least one published chapter is required. Chapter publication
 * stays a separate call rather than being implied here: an author holding
 * chapter 4 back while listing the story is the normal case, and a publish
 * that quietly published everything written would defeat it.
 */
export async function publishStory(
  userId: string,
  storyId: string,
): Promise<Story> {
  const timestamp = now();

  await db.transaction(async (tx) => {
    const story = await ownedStory(tx, storyId, userId);

    const published = await tx.orm.content.Chapter.select("id")
      .where((chapter) => chapter.storyId.eq(storyId))
      .where((chapter) => chapter.publishedAt.isNotNull())
      .first();

    if (!published) {
      throw HttpError.badRequest("This story has nothing to read yet.", {
        chapters: "Publish at least one chapter before listing the story.",
      });
    }

    // Already listed: keep the original date. Re-publishing after an
    // unpublish is a correction, not a new release, and moving the date would
    // shuffle the story back to the top of "recently published".
    if (story.listedAt === null || story.listedAt === undefined) {
      await tx.orm.content.Story.where((row) => row.id.eq(storyId)).update({
        listedAt: timestamp,
        updatedAt: timestamp,
      });
    }
  });

  return getStory(storyId, userId);
}

/** Returns the story to draft. Only its author can see it again. */
export async function unpublishStory(
  userId: string,
  storyId: string,
): Promise<Story> {
  const timestamp = now();

  await db.transaction(async (tx) => {
    await ownedStory(tx, storyId, userId);

    await tx.orm.content.Story.where((row) => row.id.eq(storyId)).update({
      listedAt: null,
      updatedAt: timestamp,
    });
  });

  return getStory(storyId, userId);
}

export async function publishChapter(
  userId: string,
  chapterId: string,
): Promise<AuthoredChapter> {
  const timestamp = now();

  await db.transaction(async (tx) => {
    const { chapter } = await ownedChapter(tx, chapterId, userId);

    if (chapter.content.trim().length === 0) {
      throw HttpError.badRequest("This chapter is still empty.", {
        content: "Write something before publishing this chapter.",
      });
    }

    if (chapter.publishedAt === null || chapter.publishedAt === undefined) {
      await tx.orm.content.Chapter.where((row) => row.id.eq(chapterId)).update({
        publishedAt: timestamp,
        updatedAt: timestamp,
      });
    }

    await touchStory(tx, chapter.storyId, timestamp);
  });

  return loadChapter(chapterId);
}

export async function unpublishChapter(
  userId: string,
  chapterId: string,
): Promise<AuthoredChapter> {
  const timestamp = now();

  await db.transaction(async (tx) => {
    const { chapter } = await ownedChapter(tx, chapterId, userId);

    await tx.orm.content.Chapter.where((row) => row.id.eq(chapterId)).update({
      publishedAt: null,
      updatedAt: timestamp,
    });

    await touchStory(tx, chapter.storyId, timestamp);
  });

  return loadChapter(chapterId);
}

/* Chapters --------------------------------------------------------------- */

async function loadChapter(chapterId: string): Promise<AuthoredChapter> {
  const row = await db.orm.content.Chapter.select(...CHAPTER_COLUMNS)
    .where((chapter) => chapter.id.eq(chapterId))
    .first();

  if (!row) throw HttpError.notFound(CHAPTER_NOT_FOUND);

  const media = await mediaByChapter([row.id]);

  return toChapter(row, media.get(row.id) ?? []);
}

/**
 * Every chapter of one of the caller's stories, bodies included.
 *
 * The public chapter list returns summaries so a reader's chapter list costs
 * one query; the editor is the one caller that needs the prose, and asking for
 * it per chapter turned that into a request per chapter.
 */
export async function listMyChapters(
  userId: string,
  storyId: string,
): Promise<AuthoredChapter[]> {
  await ownedStory(db, storyId, userId);

  const rows = await db.orm.content.Chapter.select(...CHAPTER_COLUMNS)
    .where((chapter) => chapter.storyId.eq(storyId))
    .orderBy((chapter) => chapter.chapterNumber.asc())
    .all();

  const media = await mediaByChapter(rows.map((row) => row.id));

  return rows.map((row) => toChapter(row, media.get(row.id) ?? []));
}

/** Appends a chapter, as an unpublished draft, after the last one. */
export async function createChapter(
  userId: string,
  storyId: string,
  input: ChapterInput,
): Promise<AuthoredChapter> {
  const timestamp = now();
  const content = input.content ?? "";

  const chapterId = await db.transaction(async (tx) => {
    await ownedStory(tx, storyId, userId);

    const { highest } = await tx.orm.content.Chapter.where((chapter) =>
      chapter.storyId.eq(storyId),
    ).aggregate((aggregate) => ({ highest: aggregate.max("chapterNumber") }));

    const chapter = await tx.orm.content.Chapter.select("id").create({
      storyId,
      title: input.title,
      content,
      chapterNumber: (highest ?? 0) + 1,
      wordCount: countWords(content),
      publishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await touchStory(tx, storyId, timestamp);

    return chapter.id;
  });

  return loadChapter(chapterId);
}

/**
 * Edits a chapter's title or body. `wordCount` is rewritten whenever the body
 * is, because the chapter list and every reading-time estimate read it rather
 * than the prose.
 */
export async function updateChapter(
  userId: string,
  chapterId: string,
  patch: ChapterPatch,
): Promise<AuthoredChapter> {
  const timestamp = now();

  await db.transaction(async (tx) => {
    const { chapter } = await ownedChapter(tx, chapterId, userId);

    const changes: Record<string, unknown> = { updatedAt: timestamp };

    if (patch.title !== undefined) changes["title"] = patch.title;
    if (patch.content !== undefined) {
      changes["content"] = patch.content;
      changes["wordCount"] = countWords(patch.content);
    }

    await tx.orm.content.Chapter.where((row) => row.id.eq(chapterId)).update(
      changes,
    );

    await touchStory(tx, chapter.storyId, timestamp);
  });

  return loadChapter(chapterId);
}

/**
 * Removes a chapter and closes the gap it leaves, so what was chapter 4 is
 * chapter 3 rather than the sequence reading 1, 2, 4.
 */
export async function deleteChapter(
  userId: string,
  chapterId: string,
): Promise<AuthoredChapter[]> {
  const timestamp = now();
  const media: string[] = [];

  const storyId = await db.transaction(async (tx) => {
    const { chapter } = await ownedChapter(tx, chapterId, userId);

    media.push(...(await mediaUrls(tx, [chapterId])));

    await deleteAll(() =>
      tx.orm.content.Multimedia.where((item) => item.chapterId.eq(chapterId)),
    );
    await deleteAll(() =>
      tx.orm.engagement.Comment.where((row) => row.chapterId.eq(chapterId)),
    );
    // A resume point inside the deleted chapter has nowhere to point; the
    // story-level row survives, so the reader keeps their place in the story.
    await tx.orm.engagement.ReadingHistory.where((row) =>
      row.chapterId.eq(chapterId),
    ).update({ chapterId: null, progress: 0, updatedAt: timestamp });

    await tx.orm.content.Chapter.where((row) => row.id.eq(chapterId)).delete();

    await renumber(tx, await chapterIdsInOrder(tx, chapter.storyId), timestamp);
    await touchStory(tx, chapter.storyId, timestamp);

    return chapter.storyId;
  });

  await discardUploads(media);

  return listMyChapters(userId, storyId);
}

/**
 * Reorders a story's chapters to exactly `orderedIds`.
 *
 * The list has to be the story's whole set: a partial order leaves the rest of
 * the chapters somewhere the caller did not choose, which is a silent way to
 * lose a chapter's place in the sequence.
 */
export async function reorderChapters(
  userId: string,
  storyId: string,
  orderedIds: string[],
): Promise<AuthoredChapter[]> {
  const timestamp = now();

  await db.transaction(async (tx) => {
    await ownedStory(tx, storyId, userId);

    const existing = await chapterIdsInOrder(tx, storyId);
    const wanted = new Set(orderedIds);

    if (wanted.size !== orderedIds.length) {
      throw HttpError.badRequest("That chapter order is not valid.", {
        chapterIds: "The same chapter appears more than once.",
      });
    }

    if (
      orderedIds.length !== existing.length ||
      existing.some((id) => !wanted.has(id))
    ) {
      throw HttpError.badRequest("That chapter order is not valid.", {
        chapterIds: "List every chapter of this story exactly once.",
      });
    }

    await renumber(tx, orderedIds, timestamp);
    await touchStory(tx, storyId, timestamp);
  });

  return listMyChapters(userId, storyId);
}

/* Multimedia ------------------------------------------------------------- */

/** The stored URLs of some chapters' attachments, for cleanup after a delete. */
async function mediaUrls(tx: Tx, chapterIds: string[]): Promise<string[]> {
  if (chapterIds.length === 0) return [];

  const rows = await tx.orm.content.Multimedia.select("url")
    .where((item) => item.chapterId.in(chapterIds))
    .all();

  return rows.map((row) => row.url);
}

/** Best-effort cleanup of the files whose rows have just gone. */
async function discardUploads(urls: string[]): Promise<void> {
  await Promise.all(urls.map((url) => discardUpload(url)));
}

function toMedia(row: {
  id: string;
  chapterId: string;
  type: string;
  url: string;
  displayOrder: number;
}): AuthoredMedia {
  return {
    id: row.id,
    chapterId: row.chapterId,
    type: row.type as MultimediaType,
    url: row.url,
    displayOrder: row.displayOrder,
  };
}

/**
 * Attaches media to a chapter. `displayOrder` defaults to the end of the list,
 * which is where an author who did not say otherwise means it to go.
 */
export async function addMultimedia(
  userId: string,
  chapterId: string,
  input: { type: MultimediaType; url: string; displayOrder?: number | undefined },
): Promise<AuthoredMedia> {
  const timestamp = now();

  const mediaId = await db.transaction(async (tx) => {
    const { chapter } = await ownedChapter(tx, chapterId, userId);

    let order = input.displayOrder;

    if (order === undefined) {
      const { highest } = await tx.orm.content.Multimedia.where((item) =>
        item.chapterId.eq(chapterId),
      ).aggregate((aggregate) => ({ highest: aggregate.max("displayOrder") }));

      order = highest === null ? 0 : highest + 1;
    }

    const item = await tx.orm.content.Multimedia.select("id").create({
      chapterId,
      type: input.type,
      url: input.url,
      displayOrder: order,
      createdAt: timestamp,
    });

    await touchStory(tx, chapter.storyId, timestamp);

    return item.id;
  });

  const row = await db.orm.content.Multimedia.select(
    "id",
    "chapterId",
    "type",
    "url",
    "displayOrder",
  )
    .where((item) => item.id.eq(mediaId))
    .first();

  if (!row) throw HttpError.notFound("That attachment could not be found.");

  return toMedia(row);
}

export async function removeMultimedia(
  userId: string,
  mediaId: string,
): Promise<void> {
  const timestamp = now();
  let url: string | null = null;

  await db.transaction(async (tx) => {
    const item = await tx.orm.content.Multimedia.select(
      "id",
      "chapterId",
      "url",
    )
      .where((row) => row.id.eq(mediaId))
      .first();

    if (!item) throw HttpError.notFound("That attachment could not be found.");

    const { chapter } = await ownedChapter(tx, item.chapterId, userId);

    await tx.orm.content.Multimedia.where((row) => row.id.eq(mediaId)).delete();
    await touchStory(tx, chapter.storyId, timestamp);

    url = item.url;
  });

  // After the commit, and only for a file this backend wrote — `discardUpload`
  // ignores anything else, so a LINK attachment costs nothing here.
  await discardUpload(url);
}
