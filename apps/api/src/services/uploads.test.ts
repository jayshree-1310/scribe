/**
 * Unit tests for the media upload path.
 *
 * These call the service directly rather than going through the route: the
 * only thing that needs a running app is the rate limit, and the size cap in
 * particular is impossible to exercise over HTTP without a 128 MB fixture.
 * `storeMedia` takes its cap as an argument for exactly that reason.
 */

import { afterAll, describe, expect, it } from "vitest";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { HttpError } from "../lib/http-error.js";
import { UPLOAD_ROOT } from "../lib/storage.js";
import { storeMedia } from "./uploads.js";

/** Files these tests wrote, removed afterwards so runs leave no residue. */
const written: string[] = [];

function keyOf(url: string): string {
  return url.replace("/uploads/", "");
}

/** A signature padded out past the 64 bytes the sniffer looks at. */
function file(...head: (string | number[])[]): Buffer {
  const parts = head.map((part) =>
    typeof part === "string" ? Buffer.from(part, "ascii") : Buffer.from(part),
  );

  return Buffer.concat([...parts, Buffer.alloc(128)]);
}

const MP3 = file("ID3 ");
const MP4 = file([0, 0, 0, 0x18], "ftyp", "isom");
const M4A = file([0, 0, 0, 0x18], "ftyp", "M4A ");
const WEBM = file([0x1a, 0x45, 0xdf, 0xa3]);
const WAV = file("RIFF", [0, 0, 0, 0], "WAVE");

/** An Ogg page whose codec name sits at offset 28, where the sniffer looks. */
function ogg(codec: string): Buffer {
  const bytes = Buffer.alloc(128);
  bytes.write("OggS", 0, "ascii");
  bytes.write(codec, 28, "ascii");
  return bytes;
}

async function store(bytes: Buffer, maxBytes?: number) {
  const stored = await storeMedia(Readable.from([bytes]), maxBytes);
  written.push(stored.url);
  return stored;
}

afterAll(async () => {
  for (const url of written) {
    await rm(path.join(UPLOAD_ROOT, keyOf(url)), { force: true });
  }
});

describe("storeMedia", () => {
  it("names each container from its signature, not from a declared type", async () => {
    // Nothing here declares a content type at all — the bytes are the only
    // input, which is the point.
    await expect(store(MP3)).resolves.toMatchObject({
      contentType: "audio/mpeg",
      multimediaType: "AUDIO",
      url: expect.stringMatching(/^\/uploads\/media\/.+\.mp3$/),
    });

    await expect(store(MP4)).resolves.toMatchObject({
      contentType: "video/mp4",
      multimediaType: "VIDEO",
      url: expect.stringMatching(/\.mp4$/),
    });

    await expect(store(WEBM)).resolves.toMatchObject({
      contentType: "video/webm",
      multimediaType: "VIDEO",
    });

    await expect(store(WAV)).resolves.toMatchObject({
      contentType: "audio/wav",
      multimediaType: "AUDIO",
    });
  });

  it("separates the audio-only ISO brands from video", async () => {
    // An `.m4a` attached as VIDEO would render an empty player frame.
    await expect(store(M4A)).resolves.toMatchObject({
      contentType: "audio/mp4",
      multimediaType: "AUDIO",
      url: expect.stringMatching(/\.m4a$/),
    });
  });

  it("reads the Ogg codec rather than guessing one way", async () => {
    await expect(store(ogg("theora"))).resolves.toMatchObject({
      contentType: "video/ogg",
      multimediaType: "VIDEO",
    });

    await expect(store(ogg("vorbis"))).resolves.toMatchObject({
      contentType: "audio/ogg",
      multimediaType: "AUDIO",
    });
  });

  it("writes the whole stream, not just the sniffed header", async () => {
    const bytes = Buffer.concat([MP3, Buffer.alloc(5000, 7)]);
    const stored = await store(bytes);

    expect(stored.bytes).toBe(bytes.length);

    const onDisk = await readFile(path.join(UPLOAD_ROOT, keyOf(stored.url)));
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it("rejects a non-media file whatever it is named", async () => {
    // The disguise a declared content type buys you: this arrives from the
    // browser as `video/mp4` and is still refused, because the declared type
    // never reaches the decision.
    const html = Buffer.from("<script>alert(1)</script>".padEnd(128), "utf8");

    await expect(storeMedia(Readable.from([html]))).rejects.toThrow(
      /not audio or video/,
    );
  });

  it("rejects an empty upload", async () => {
    await expect(storeMedia(Readable.from([]))).rejects.toThrow(/empty/);
  });

  it("rejects an oversize file and leaves no partial behind", async () => {
    const before = await readdir(path.join(UPLOAD_ROOT, "media"));

    // 1 KB of audio against a 512-byte cap: the header sniffs fine, so the
    // refusal can only come from the byte count during the write.
    const bytes = Buffer.concat([MP3, Buffer.alloc(1024)]);

    await expect(storeMedia(Readable.from([bytes]), 512)).rejects.toMatchObject(
      { status: 413 },
    );

    // The truncated file is gone, so nothing is served from a URL no row holds.
    expect(await readdir(path.join(UPLOAD_ROOT, "media"))).toEqual(before);
  });

  it("reports the cap it enforced", async () => {
    const oversize = Buffer.concat([MP3, Buffer.alloc(3 * 1024 * 1024)]);

    await expect(
      storeMedia(Readable.from([oversize]), 2 * 1024 * 1024),
    ).rejects.toThrow(/under 2 MB/);
  });

  it("throws HttpError rather than an opaque stream failure", async () => {
    // The route relies on this: a mid-stream failure has to reach the error
    // handler as a 413, not as a write error.
    const bytes = Buffer.concat([MP3, Buffer.alloc(1024)]);

    await expect(storeMedia(Readable.from([bytes]), 512)).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});
