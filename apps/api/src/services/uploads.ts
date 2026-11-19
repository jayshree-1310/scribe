/**
 * Stored uploads: the bytes a caller sends, checked and written to storage.
 *
 * Deliberately knows nothing about what the file is *for*. The caller stores
 * the returned URL on whatever row references it — `Story.coverUrl` today —
 * so adding a new kind of upload is a new prefix here, not a new pipeline.
 *
 * `lib/image.ts` and `lib/media.ts` decide what the bytes actually are and
 * `lib/storage.ts` decides where they land; the image path is shared with the
 * avatar route rather than duplicated, so there is one place that can accept a
 * bad file and one place that can write it.
 *
 * **Ownership.** Every stored file is recorded in `content.Upload` with the
 * account that sent it. The rows that reference files hold free strings, so
 * without that record anybody could point a cover at somebody else's avatar
 * and then delete it by clearing the cover. Three rules close that:
 *
 * - `assertUsableUrl` lets a caller save one of our URLs only if they
 *   uploaded it; anything else must be an external `https:` address.
 * - `discardUpload` deletes only the caller's own file, and only once nothing
 *   references it any more.
 * - `sweepUnreferencedUploads` removes files nothing ever came to reference
 *   (an abandoned editor upload), after a grace period.
 */

import type { Readable } from "node:stream";
import { db } from "../prisma/db.js";
import { HttpError } from "../lib/http-error.js";
import { logger } from "../lib/logger.js";
import { sniffImage } from "../lib/image.js";
import { MEDIA_HEADER_BYTES, sniffMedia } from "../lib/media.js";
import { storage } from "../lib/storage.js";

/**
 * What an upload is for, which is also the storage prefix it lands under.
 *
 * `cover` is a story's artwork and takes images only. `media` is a chapter
 * attachment and takes audio and video as well, under a far larger cap — add
 * a new kind here rather than adding a second route.
 */
export const UPLOAD_KINDS = ["cover", "media"] as const;

export type UploadKind = (typeof UPLOAD_KINDS)[number];

/** Storage prefix each kind lands under. */
const PREFIXES: Record<UploadKind, string> = {
  cover: "covers",
  media: "media",
};

/**
 * Largest image we accept, before any re-encoding.
 *
 * Larger than the 2 MB avatar cap because a cover is displayed at several
 * times the size, and small enough that a stray full-resolution photograph is
 * refused rather than served to every reader who loads a shelf.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Largest chapter attachment we accept.
 *
 * Two orders of magnitude above the image cap because a few minutes of video
 * is simply that big, and low enough that a full-length film is refused: this
 * is a local disk with no transcoding behind it, and every byte is served
 * back by the same process that serves the API.
 */
export const MAX_MEDIA_BYTES = 128 * 1024 * 1024;

export interface StoredUpload {
  /** Stable URL to save on the referencing row. */
  url: string;
  contentType: string;
  bytes: number;
  /**
   * The `content.Multimedia.type` these bytes should be attached as, decided
   * from the signature. The caller passes it straight to `addMultimedia`
   * rather than guessing the type from the file name.
   */
  multimediaType: "IMAGE" | "AUDIO" | "VIDEO";
}

/** The field name errors are keyed under, so the form can show them inline. */
const FIELD = "file";

export async function storeImage(
  ownerId: string,
  kind: UploadKind,
  bytes: Buffer,
): Promise<StoredUpload> {
  if (bytes.length === 0) {
    throw HttpError.badRequest("That upload was empty.", {
      [FIELD]: "Choose an image to upload.",
    });
  }

  if (bytes.length > MAX_IMAGE_BYTES) {
    const message = "That image is too large. Pick one under 5 MB.";
    throw new HttpError(413, "payload_too_large", message, {
      [FIELD]: message,
    });
  }

  // The declared content type and the file name are both caller-supplied; the
  // signature is not. See `lib/image.ts` for why that distinction matters.
  const image = sniffImage(bytes);

  if (!image) {
    throw HttpError.badRequest("That file is not an image we can read.", {
      [FIELD]: "Use a PNG, JPEG, WebP or GIF image.",
    });
  }

  const stored = await storage.put({
    prefix: PREFIXES[kind],
    data: bytes,
    extension: image.extension,
    contentType: image.contentType,
  });

  await recordUpload(ownerId, stored.url);

  return {
    url: stored.url,
    contentType: image.contentType,
    bytes: bytes.length,
    multimediaType: "IMAGE",
  };
}

/**
 * Stores a chapter's audio or video, streaming it to disk.
 *
 * Video is too big to hold in memory — a handful of concurrent uploads at the
 * cap would be more than the process has — so the bytes go to storage as they
 * arrive. That costs the two things a buffer gives you for free, and both are
 * handled here rather than left to the storage backend:
 *
 * - The signature has to be checked before the write starts, so only the
 *   first `MEDIA_HEADER_BYTES` are held back and sniffed; if they are not a
 *   container we accept, nothing is ever written.
 * - The size cap can no longer be a length check, so it is counted as the
 *   stream runs and the pipeline is aborted the moment it is exceeded. The
 *   partial file is removed by `storage.putStream`.
 */
export async function storeMedia(
  ownerId: string,
  source: Readable | AsyncIterable<Buffer>,
  /** Overridable so the cap itself can be tested without a 128 MB fixture. */
  maxBytes: number = MAX_MEDIA_BYTES,
): Promise<StoredUpload> {
  // Pulled through the iterator by hand rather than with `for await`, because
  // breaking out of a `for await` calls `return()` on it — which destroys the
  // request mid-upload and leaves the rest of the file unreachable.
  const iterator = source[Symbol.asyncIterator]();

  const chunks: Buffer[] = [];
  let head = Buffer.alloc(0);

  while (head.length < MEDIA_HEADER_BYTES) {
    const next = await iterator.next();
    if (next.done) break;

    chunks.push(next.value);
    head = Buffer.concat(chunks);
  }

  if (head.length === 0) {
    throw HttpError.badRequest("That upload was empty.", {
      [FIELD]: "Choose a file to upload.",
    });
  }

  const media = sniffMedia(head);

  if (!media) {
    // Nothing has been written yet, so a refusal here costs no cleanup.
    throw HttpError.badRequest("That file is not audio or video we can read.", {
      [FIELD]: "Use an MP3, MP4, WebM, OGG or WAV file.",
    });
  }

  const stored = await storage.putStream({
    prefix: PREFIXES["media"],
    data: capped(head, iterator, maxBytes),
    extension: media.extension,
    contentType: media.contentType,
  });

  await recordUpload(ownerId, stored.url);

  return {
    url: stored.url,
    contentType: media.contentType,
    bytes: stored.bytes,
    multimediaType: media.multimediaType,
  };
}

/**
 * The held-back header followed by the rest of the upload, refusing to yield
 * past `maxBytes`.
 *
 * Throwing mid-stream is what stops the write: `putStream` unlinks the partial
 * file and rethrows, so an oversize upload leaves no trace and the caller sees
 * the same 413 a length check would have given.
 */
async function* capped(
  head: Buffer,
  rest: AsyncIterator<Buffer>,
  maxBytes: number,
): AsyncGenerator<Buffer> {
  let total = 0;

  const check = (chunk: Buffer): Buffer => {
    total += chunk.length;

    if (total > maxBytes) {
      const megabytes = Math.round(maxBytes / (1024 * 1024));
      const message = `That file is too large. Pick one under ${megabytes} MB.`;

      throw new HttpError(413, "payload_too_large", message, {
        [FIELD]: message,
      });
    }

    return chunk;
  };

  yield check(head);

  for (;;) {
    const next = await rest.next();
    if (next.done) return;

    yield check(next.value);
  }
}

/* Ownership -------------------------------------------------------------- */

/**
 * Records who uploaded a file, right after it is written. If the insert
 * fails the file is removed again: an unrecorded file is one nobody could
 * ever reference or delete.
 */
export async function recordUpload(ownerId: string, url: string): Promise<void> {
  try {
    await db.orm.content.Upload.create({ url, ownerId });
  } catch (error) {
    await storage.remove(url);
    throw error;
  }
}

/**
 * Refuses a URL the caller may not save on a cover or an attachment.
 *
 * One of our own files has to be one the caller uploaded. Anything else has
 * to be an absolute `https:` address: not `javascript:` or `data:`, which a
 * link or an image source would hand straight to the browser, and not a
 * relative path, which would resolve against our own origin. `current` is the
 * value the row already holds, which is always allowed back so a form that
 * resubmits an unchanged cover from before uploads were recorded still saves.
 */
export async function assertUsableUrl(
  userId: string,
  url: string,
  field: string,
  current: string | null = null,
): Promise<void> {
  if (url === current) return;

  if (storage.keyOf(url) !== null) {
    if (await ownedBy(userId, url)) return;

    throw HttpError.badRequest("Some of the details need fixing.", {
      [field]: "Upload that file yourself, then use it here.",
    });
  }

  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // Relative or malformed: refused below.
  }

  if (parsed?.protocol !== "https:") {
    throw HttpError.badRequest("Some of the details need fixing.", {
      [field]: "Use a web address starting with https://.",
    });
  }
}

async function ownedBy(userId: string, url: string): Promise<boolean> {
  const row = await db.orm.content.Upload.select("id")
    .where((upload) => upload.url.eq(url))
    .where((upload) => upload.ownerId.eq(userId))
    .first();

  return row !== null && row !== undefined;
}

/** Whether any avatar, cover or attachment still points at the URL. */
async function isReferenced(url: string): Promise<boolean> {
  const [row] = await db.runtime().query(
    db.raw.sql`
      SELECT EXISTS (SELECT 1 FROM "auth"."user" WHERE "avatarUrl" = ${url})
          -- A moderator's take-down keeps the avatar aside to restore.
          OR EXISTS (SELECT 1 FROM "auth"."user" WHERE "hiddenAvatarUrl" = ${url})
          OR EXISTS (SELECT 1 FROM "content"."story" WHERE "coverUrl" = ${url})
          OR EXISTS (SELECT 1 FROM "content"."multimedia" WHERE "url" = ${url})
          AS "referenced"
    `.returnsRow({ referenced: "pg/bool@1" }).build(),
  );

  return row?.referenced === true;
}

/** Removes the file and its ownership record. */
async function destroy(url: string): Promise<void> {
  await storage.remove(url);
  await db.orm.content.Upload.where((upload) => upload.url.eq(url)).delete();
}

/**
 * Deletes a file a row no longer points at, if it is the caller's own.
 *
 * Called after the row change commits. Best-effort by design, and a no-op for
 * anything that is not the caller's: a remote URL, a file somebody else
 * uploaded, a file from before uploads were recorded. A file the caller still
 * uses elsewhere -- the same image as a cover and an attachment -- stays until
 * the last reference goes.
 */
export async function discardUpload(
  userId: string,
  url: string | null,
): Promise<void> {
  if (url === null || storage.keyOf(url) === null) return;
  if (!(await ownedBy(userId, url))) return;
  if (await isReferenced(url)) return;

  await destroy(url);
}

/**
 * Every file an account uploaded, removed with its records. For
 * `deleteAccount`, after its transaction has removed the rows that referenced
 * them. A file somebody else still references -- which ownership rules make
 * impossible for new uploads, but backfilled ones predate them -- is kept.
 */
export async function discardUploadsOf(userId: string): Promise<void> {
  const owned = await db.orm.content.Upload.select("url")
    .where((upload) => upload.ownerId.eq(userId))
    .all();

  for (const { url } of owned) {
    if (await isReferenced(url)) {
      // Kept, but no longer anybody's: the sweep will not touch a referenced
      // file, and the record must not name an account that is gone.
      await db.orm.content.Upload.where((upload) => upload.url.eq(url)).delete();
      continue;
    }

    await destroy(url);
  }
}

/**
 * How long an unreferenced upload is kept. Long enough for an author to
 * upload a cover and finish filling in the story form; short enough that an
 * abandoned upload does not sit in storage for months.
 */
export const UNREFERENCED_UPLOAD_GRACE_HOURS = 24;

/**
 * Removes uploads nothing has referenced since the grace period ran out:
 * the cover picked and then abandoned, the attachment uploaded and never
 * added. Returns how many went. Runs once a day from `server.ts`.
 */
export async function sweepUnreferencedUploads(
  graceHours: number = UNREFERENCED_UPLOAD_GRACE_HOURS,
  limit = 500,
): Promise<number> {
  const stale = await db.runtime().query(
    db.raw.sql`
      SELECT up."url"
        FROM "content"."upload" AS up
       WHERE up."createdAt" < now() - make_interval(hours => ${graceHours}::int)
         AND NOT EXISTS (SELECT 1 FROM "auth"."user" WHERE "avatarUrl" = up."url")
         AND NOT EXISTS (SELECT 1 FROM "auth"."user" WHERE "hiddenAvatarUrl" = up."url")
         AND NOT EXISTS (SELECT 1 FROM "content"."story" WHERE "coverUrl" = up."url")
         AND NOT EXISTS (SELECT 1 FROM "content"."multimedia" WHERE "url" = up."url")
       ORDER BY up."createdAt"
       LIMIT ${limit}::int
    `.returnsRow({ url: "pg/text@1" }).build(),
  );

  let removed = 0;

  for (const { url } of stale) {
    try {
      await destroy(url);
      removed += 1;
    } catch (error) {
      logger.warn({ err: error }, "unreferenced upload not removed");
    }
  }

  return removed;
}
