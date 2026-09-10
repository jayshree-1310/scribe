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
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

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
