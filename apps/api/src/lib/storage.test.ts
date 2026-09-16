/**
 * Tests for which backend `createStorage` picks, and for the object-store
 * backend's key and URL handling.
 *
 * The AWS client is mocked rather than pointed at a bucket: what matters here
 * is the key each command carries, the URL a row ends up with, and the cleanup
 * after a failed stream — none of which need a network.
 *
 * Each case re-imports the module, because the backend and its configuration
 * are resolved once at import time.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const mocks = vi.hoisted(() => ({
  /** Every command handed to `S3Client.send`, in order. */
  sent: [] as { kind: string; input: Record<string, unknown> }[],
  /** Set to make `Upload.done()` reject, standing in for an aborted stream. */
  uploadFails: false,
  aborted: 0,
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(command: { kind: string; input: Record<string, unknown> }) {
      mocks.sent.push(command);
      return Promise.resolve({});
    }
  },
  PutObjectCommand: class {
    kind = "put";
    constructor(public input: Record<string, unknown>) {}
  },
  DeleteObjectCommand: class {
    kind = "delete";
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(public options: { params: { Body: Readable } }) {}

    async done() {
      // Drain the body so the backend's byte counter sees the stream, the
      // same way a real multipart upload would consume it.
      for await (const _chunk of this.options.params.Body) void _chunk;

      if (mocks.uploadFails) throw new Error("stream aborted");
    }

    async abort() {
      mocks.aborted += 1;
    }
  },
}));

const S3_VARS = [
  "S3_BUCKET",
  "S3_PUBLIC_BASE_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

/** Imports a fresh copy of the module under the given environment. */
async function loadStorage(env: Record<string, string>) {
  for (const name of S3_VARS) delete process.env[name];
  Object.assign(process.env, env);

  vi.resetModules();

  return import("./storage.js");
}

const BUCKET = {
  S3_BUCKET: "scribe-media",
  S3_PUBLIC_BASE_URL: "https://media.example.com",
};

afterEach(() => {
  for (const name of S3_VARS) delete process.env[name];
  mocks.sent.length = 0;
  mocks.uploadFails = false;
  mocks.aborted = 0;
});

describe("createStorage", () => {
  it("uses the local filesystem when no bucket is configured", async () => {
    const { createStorage, UPLOAD_ROOT } = await loadStorage({});

    const stored = await createStorage().put({
      prefix: "covers",
      data: Buffer.from("not really a png"),
      extension: ".png",
      contentType: "image/png",
    });

    expect(stored.url).toBe(`/uploads/${stored.key}`);
    expect(mocks.sent).toHaveLength(0);

    await rm(path.join(UPLOAD_ROOT, stored.key), { force: true });
  });

  it("refuses at startup when a bucket has no public base URL", async () => {
    // The throw is at import, not first upload: a misconfigured deployment
    // should fail its health check rather than accept unreadable uploads.
    await expect(loadStorage({ S3_BUCKET: "scribe-media" })).rejects.toThrow(
      /S3_PUBLIC_BASE_URL/,
    );
  });
});

describe("the object store backend", () => {
  it("writes under the prefix and returns a public URL", async () => {
    const { createStorage } = await loadStorage(BUCKET);

    const stored = await createStorage().put({
      prefix: "covers",
      data: Buffer.from("bytes"),
      extension: ".png",
      contentType: "image/png",
    });

    expect(stored.key).toMatch(/^covers\/[0-9a-f-]{36}\.png$/);
    expect(stored.url).toBe(`https://media.example.com/${stored.key}`);

    expect(mocks.sent).toHaveLength(1);
    expect(mocks.sent[0]?.input).toMatchObject({
      Bucket: "scribe-media",
      Key: stored.key,
      ContentType: "image/png",
    });
  });

  it("does not double the separator when the base URL has a trailing slash", async () => {
    const { createStorage } = await loadStorage({
      ...BUCKET,
      S3_PUBLIC_BASE_URL: "https://media.example.com/",
    });

    const stored = await createStorage().put({
      prefix: "avatars",
      data: Buffer.from("bytes"),
      extension: ".jpg",
      contentType: "image/jpeg",
    });

    expect(stored.url).toBe(`https://media.example.com/${stored.key}`);
  });

  it("counts the bytes it streamed", async () => {
    const { createStorage } = await loadStorage(BUCKET);

    const stored = await createStorage().putStream({
      prefix: "media",
      data: Readable.from([Buffer.alloc(300), Buffer.alloc(212)]),
      extension: ".mp4",
      contentType: "video/mp4",
    });

    expect(stored.bytes).toBe(512);
    expect(stored.url).toBe(`https://media.example.com/${stored.key}`);
  });

  it("leaves nothing behind when a stream fails partway", async () => {
    const { createStorage } = await loadStorage(BUCKET);

    mocks.uploadFails = true;

    await expect(
      createStorage().putStream({
        prefix: "media",
        data: Readable.from([Buffer.alloc(16)]),
        extension: ".mp4",
        contentType: "video/mp4",
      }),
    ).rejects.toThrow("stream aborted");

    expect(mocks.aborted).toBe(1);

    // The delete covers a single-part write that had already landed.
    const deletes = mocks.sent.filter((command) => command.kind === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.input["Key"]).toMatch(/^media\//);
  });

  it("deletes by the key inside a URL it wrote", async () => {
    const { createStorage } = await loadStorage(BUCKET);

    await createStorage().remove(
      "https://media.example.com/covers/11111111-2222-3333-4444-555555555555.png",
    );

    expect(mocks.sent).toHaveLength(1);
    expect(mocks.sent[0]).toMatchObject({
      kind: "delete",
      input: {
        Bucket: "scribe-media",
        Key: "covers/11111111-2222-3333-4444-555555555555.png",
      },
    });
  });

  it("ignores a URL it did not write, so legacy and Google URLs survive the switch", async () => {
    const { createStorage } = await loadStorage(BUCKET);

    const storage = createStorage();

    // Both would otherwise reach the bucket with a nonsense key. Returning
    // early is what keeps replacing an avatar from failing on cleanup.
    await storage.remove("/uploads/avatars/abc.jpg");
    await storage.remove("https://lh3.googleusercontent.com/a/ACg8ocK");

    expect(mocks.sent).toHaveLength(0);
  });
});
