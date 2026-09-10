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
 */

import type { Readable } from "node:stream";
import { HttpError } from "../lib/http-error.js";
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

/**
 * Deletes a file a row no longer points at.
 *
 * Best-effort by design: a URL this backend did not write — a remote cover
 * pasted in by hand — is ignored rather than an error, so replacing one never
 * fails on the cleanup of the last.
 */
export function discardUpload(url: string | null): Promise<void> {
  return url === null ? Promise.resolve() : storage.remove(url);
}
