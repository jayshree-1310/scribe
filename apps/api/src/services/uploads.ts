/**
 * Stored uploads: the bytes a caller sends, checked and written to storage.
 *
 * Deliberately knows nothing about what the file is *for*. The caller stores
 * the returned URL on whatever row references it — `Story.coverUrl` today —
 * so adding a new kind of upload is a new prefix here, not a new pipeline.
 *
 * `lib/image.ts` decides what the bytes actually are and `lib/storage.ts`
 * decides where they land; both are shared with the avatar route rather than
 * duplicated, so there is one place that can accept a bad file and one place
 * that can write it.
 */

import { HttpError } from "../lib/http-error.js";
import { sniffImage } from "../lib/image.js";
import { storage } from "../lib/storage.js";

/**
 * What an upload is for, which is also the storage prefix it lands under.
 *
 * Only story covers for now. Chapter multimedia needs audio and video, and
 * therefore a different sniffer and a much larger cap — see the file-uploads
 * task in `docs/BACKLOG.md`; add it here rather than adding a second route.
 */
export const UPLOAD_KINDS = ["cover"] as const;

export type UploadKind = (typeof UPLOAD_KINDS)[number];

/**
 * Largest image we accept, before any re-encoding.
 *
 * Larger than the 2 MB avatar cap because a cover is displayed at several
 * times the size, and small enough that a stray full-resolution photograph is
 * refused rather than served to every reader who loads a shelf.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface StoredUpload {
  /** Stable URL to save on the referencing row. */
  url: string;
  contentType: string;
  bytes: number;
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
    prefix: kind === "cover" ? "covers" : kind,
    data: bytes,
    extension: image.extension,
    contentType: image.contentType,
  });

  return {
    url: stored.url,
    contentType: image.contentType,
    bytes: bytes.length,
  };
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
