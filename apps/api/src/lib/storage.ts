/**
 * Where uploaded files live.
 *
 * One narrow interface with two implementations, chosen by `createStorage`
 * below: the local filesystem when nothing is configured, because dev needs
 * uploads to work with no credentials at all, and any S3-compatible object
 * store when `S3_BUCKET` is set. Everything outside this module knows only
 * `put`, `putStream`, `remove` and the public URL it gets back.
 *
 * The local backend is not durable on a host with no persistent disk — a free
 * Render instance wipes it on every deploy and every spin-down — so a
 * deployment that accepts uploads wants the object store.
 */

import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
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

/* Object storage ------------------------------------------------------- */

/**
 * Read origin for stored objects, e.g. an R2 custom domain or the bucket's
 * public URL. Required alongside `S3_BUCKET`: the backend hands rows a URL a
 * browser can fetch, and a bucket endpoint is for writing, not reading. It is
 * also what `remove` matches on to recognise its own URLs.
 */
const S3_PUBLIC_BASE_URL = (process.env["S3_PUBLIC_BASE_URL"] ?? "").replace(
  /\/$/,
  "",
);

function s3StorageBackend(bucket: string): Storage {
  if (!S3_PUBLIC_BASE_URL) {
    throw new Error(
      "S3_BUCKET is set but S3_PUBLIC_BASE_URL is not. Uploads would be " +
        "stored with no address a browser could read them from.",
    );
  }

  const endpoint = process.env["S3_ENDPOINT"];

  const client = new S3Client({
    // R2 and most S3-compatible stores ignore the region but require one to be
    // present; `auto` is what Cloudflare documents. AWS proper needs the real
    // region, so it stays overridable.
    region: process.env["S3_REGION"] ?? "auto",
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    credentials: {
      accessKeyId: process.env["S3_ACCESS_KEY_ID"] ?? "",
      secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] ?? "",
    },
  });

  /** Same shape the local backend uses, so URLs read alike across backends. */
  function newKey(prefix: string, extension: string): string {
    return `${prefix}/${randomUUID()}${extension}`;
  }

  function urlFor(key: string): string {
    return `${S3_PUBLIC_BASE_URL}/${key}`;
  }

  /**
   * Objects are served publicly through bucket configuration — an R2 public
   * bucket or custom domain, an S3 bucket policy — rather than a per-object
   * ACL, because R2 does not implement ACLs and rejects the header outright.
   */
  return {
    async put({ prefix, data, extension, contentType }) {
      const key = newKey(prefix, extension);

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
        }),
      );

      return { key, url: urlFor(key) };
    },

    async putStream({ prefix, data, extension, contentType }) {
      const key = newKey(prefix, extension);
      let bytes = 0;

      // Counted in the pipeline for the same reason the local backend does it:
      // a `data` listener would start the flow before the consumer is attached.
      async function* counting(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.length;
          yield chunk;
        }
      }

      // `Upload` switches to multipart on its own once the body outgrows one
      // part, which is what makes a video upload work without knowing its
      // length in advance.
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: key,
          Body: Readable.from(counting(data)),
          ContentType: contentType,
        },
      });

      try {
        await upload.done();
      } catch (error) {
        // Mirrors the local backend's contract: a caller that aborts the
        // stream to enforce a size cap must not leave an object behind.
        // `abort` clears an in-flight multipart; the delete covers the case
        // where a single-part write had already landed.
        await upload.abort().catch(() => {});
        await client
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
          .catch(() => {});

        throw error;
      }

      return { key, bytes, url: urlFor(key) };
    },

    async remove(url) {
      // Anything this backend did not write is ignored rather than failing:
      // Google avatar URLs sit in the same column, and so do rows written
      // before the store was switched over.
      const marker = `${S3_PUBLIC_BASE_URL}/`;
      if (!url.startsWith(marker)) return;

      const key = url.slice(marker.length);
      if (key.length === 0) return;

      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        );
      } catch {
        // Already gone, or the store is briefly unreachable. Removing a file
        // is best-effort cleanup; the row no longer points at it either way.
      }
    },
  };
}

/**
 * Picks the backend from the environment, so dev and test need no credentials
 * and a deployment opts in by setting `S3_BUCKET`.
 */
export function createStorage(): Storage {
  const bucket = process.env["S3_BUCKET"];

  return bucket ? s3StorageBackend(bucket) : localStorageBackend();
}

export const storage: Storage = createStorage();

/**
 * Which backend is live, for `/health`.
 *
 * Same purpose as `describeAiConfig`: the difference between a deployment
 * writing to an object store and one silently still on its own disk is
 * invisible from outside until a file disappears hours later. A host is all
 * this reports — no key, no bucket path — and it is a host the API already
 * publishes in every upload URL it hands out.
 */
export function describeStorage(): {
  backend: "s3" | "local";
  /** Where uploads are served from; null when URLs are host-relative. */
  publicHost: string | null;
} {
  const base = process.env["S3_BUCKET"] ? S3_PUBLIC_BASE_URL : PUBLIC_BASE_URL;

  let publicHost: string | null = null;

  if (base) {
    try {
      publicHost = new URL(base).host;
    } catch {
      publicHost = "invalid";
    }
  }

  return {
    backend: process.env["S3_BUCKET"] ? "s3" : "local",
    publicHost,
  };
}
