/**
 * Where uploaded files live.
 *
 * One narrow interface with a local-filesystem implementation, because dev
 * needs uploads to work with no credentials at all. `S3_BUCKET`-style storage
 * plugs in at `createStorage` below without any caller changing: everything
 * outside this module knows only `put`, `remove` and the public URL it gets
 * back.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface StoredFile {
  /** Opaque key the storage backend addresses the file by. */
  key: string;
  /** URL a browser can fetch. Stored on the row that references the file. */
  url: string;
}

export interface Storage {
  put(input: {
    /** Folder-ish namespace, e.g. `avatars`. */
    prefix: string;
    data: Buffer;
    extension: string;
    contentType: string;
  }): Promise<StoredFile>;

  /**
   * Writes a file the caller is still reading, for uploads too large to hold
   * in memory — a chapter's video, mostly.
   *
   * Any failure while reading leaves nothing behind: the partial file is
   * removed and the error rethrown, so a caller that aborts the stream to
   * enforce a size cap does not have to know a file was started.
   */
  putStream(input: {
    /** The source, as a stream or as anything else that yields its bytes. */
    data: Readable | AsyncIterable<Buffer>;
    prefix: string;
    extension: string;
    contentType: string;
  }): Promise<StoredFile & { bytes: number }>;

  /**
   * Deletes by the URL that `put` returned, since that is what rows store.
   * A URL this backend did not produce is ignored rather than failing: a
   * Google profile picture sits in `User.avatarUrl` too, and replacing one
   * must not error.
   */
  remove(url: string): Promise<void>;
}

/** Directory served statically by `app.ts`, and the path prefix it is served at. */
export const UPLOAD_ROOT = path.resolve(
  process.env["UPLOAD_DIR"] ?? "uploads",
);

export const UPLOAD_URL_PREFIX = "/uploads";

/**
 * Absolute origin to prefix URLs with, for deployments where the API and the
 * web app are on different hosts. Unset (the dev proxy case) yields
 * root-relative URLs, which work wherever the app is served from.
 */
const PUBLIC_BASE_URL = (process.env["PUBLIC_UPLOAD_BASE_URL"] ?? "").replace(
  /\/$/,
  "",
);

function localStorageBackend(): Storage {
  return {
    async put({ prefix, data, extension }) {
      // A random name, never anything caller-supplied: an upload must not be
      // able to choose where on disk it lands or overwrite another user's file.
      const name = `${randomUUID()}${extension}`;
      const directory = path.join(UPLOAD_ROOT, prefix);

      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, name), data);

      const key = `${prefix}/${name}`;

      return { key, url: `${PUBLIC_BASE_URL}${UPLOAD_URL_PREFIX}/${key}` };
    },

    async putStream({ prefix, data, extension }) {
      const name = `${randomUUID()}${extension}`;
      const directory = path.join(UPLOAD_ROOT, prefix);

      await mkdir(directory, { recursive: true });

      const target = path.join(directory, name);
      let bytes = 0;

      // Counted inside the pipeline rather than from a `data` listener: a
      // listener would put the source into flowing mode before the write end
      // was attached, and the first chunks would go nowhere.
      async function* counting(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.length;
          yield chunk;
        }
      }

      try {
        await pipeline(data, counting, createWriteStream(target));
      } catch (error) {
        // `pipeline` has already destroyed both ends; what is left is the
        // truncated file on disk, which nothing will ever hold a URL for.
        await unlink(target).catch(() => {});
        throw error;
      }

      const key = `${prefix}/${name}`;

      return {
        key,
        bytes,
        url: `${PUBLIC_BASE_URL}${UPLOAD_URL_PREFIX}/${key}`,
      };
    },

    async remove(url) {
      const marker = `${UPLOAD_URL_PREFIX}/`;
      const index = url.indexOf(marker);
      if (index === -1) return;

      const key = url.slice(index + marker.length);

      // `path.normalize` collapses any `..` the stored value might contain
      // before the containment check, so a doctored row cannot reach outside
      // the upload root.
      const target = path.normalize(path.join(UPLOAD_ROOT, key));
      if (!target.startsWith(`${UPLOAD_ROOT}${path.sep}`)) return;

      try {
        await unlink(target);
      } catch {
        // Already gone, or never written by this backend. Removing a file is
        // best-effort cleanup; the row no longer points at it either way.
      }
    },
  };
}

export const storage: Storage = localStorageBackend();
