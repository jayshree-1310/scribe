import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { UPLOAD_ROOT } from "../lib/storage.js";

const api = new TestApi();
const available = await databaseAvailable();

let authorId: string;

/** A one-pixel PNG: the smallest input that passes signature sniffing. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** Files this suite wrote, removed afterwards so runs leave no residue. */
const writtenUrls: string[] = [];

/** `as: null` makes the request anonymously; omitting it uses the author. */
function upload(
  data: Buffer,
  as: string | null = authorId,
  contentType = "image/png",
  kind = "cover",
) {
  return api.request(`/api/uploads?kind=${kind}`, {
    method: "POST",
    ...(as === null ? {} : { as }),
    raw: { data, contentType },
  });
}

function keyOf(url: string): string {
  return url.replace("/uploads/", "");
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  authorId = await api.createUser("uploader");
}, 30_000);

afterAll(async () => {
  if (!available) return;

  for (const url of writtenUrls) {
    await rm(path.join(UPLOAD_ROOT, keyOf(url)), { force: true });
  }

  await api.stop();
}, 30_000);

describe.skipIf(!available)("POST /api/uploads", () => {
  it("stores an image and returns a URL that resolves to those bytes", async () => {
    const { status, body } = await upload(PNG);

    expect(status).toBe(201);
    expect(body.url).toMatch(/^\/uploads\/covers\/.+\.png$/);
    expect(body.contentType).toBe("image/png");
    expect(body.bytes).toBe(PNG.length);
    writtenUrls.push(body.url);

    const onDisk = await readFile(path.join(UPLOAD_ROOT, keyOf(body.url)));
    expect(onDisk.equals(PNG)).toBe(true);
  });

  it("names the file from the signature, not from the declared type", async () => {
    // A PNG announced as a JPEG still lands as `.png`, because the bytes are
    // the only thing that gets a say.
    const { body } = await upload(PNG, authorId, "image/jpeg");

    expect(body.url).toMatch(/\.png$/);
    writtenUrls.push(body.url);
  });

  it("rejects a non-image wearing an image content type", async () => {
    const { status, body } = await upload(
      Buffer.from("<script>alert(1)</script>", "utf8"),
      authorId,
      "image/png",
    );

    expect(status).toBe(400);
    expect(body.error.details.file).toBeTruthy();
  });

  it("rejects a body that is not an image at all", async () => {
    const { status } = await api.request("/api/uploads", {
      method: "POST",
      as: authorId,
      body: { file: "please" },
    });

    expect(status).toBe(400);
  });

  it("rejects an unknown upload kind", async () => {
    const { status } = await upload(PNG, authorId, "image/png", "hologram");
    expect(status).toBe(400);
  });

  it("requires a signed-in caller", async () => {
    const { status } = await upload(PNG, null);
    expect(status).toBe(401);
  });
});

/* The round trip that matters: an upload becomes a story's cover ---------- */

describe.skipIf(!available)("story covers", () => {
  it("saves an uploaded URL as the cover and serves it to readers", async () => {
    const created = await api.request("/api/author/stories", {
      method: "POST",
      as: authorId,
      body: { title: `Covered ${api.runId}` },
    });

    const storyId = created.body.story.id;
    expect(created.body.story.coverUrl).toBeNull();

    const uploaded = await upload(PNG);
    writtenUrls.push(uploaded.body.url);

    const patched = await api.request(`/api/author/stories/${storyId}`, {
      method: "PATCH",
      as: authorId,
      body: { coverUrl: uploaded.body.url },
    });

    expect(patched.body.story.coverUrl).toBe(uploaded.body.url);

    const read = await api.request(
      `/api/stories/${created.body.story.slug}`,
      { as: authorId },
    );
    expect(read.body.story.coverUrl).toBe(uploaded.body.url);
  });

  it("removes the file a replaced cover leaves behind", async () => {
    const created = await api.request("/api/author/stories", {
      method: "POST",
      as: authorId,
      body: { title: `Recovered ${api.runId}` },
    });

    const storyId = created.body.story.id;

    const first = await upload(PNG);
    await api.request(`/api/author/stories/${storyId}`, {
      method: "PATCH",
      as: authorId,
      body: { coverUrl: first.body.url },
    });

    const second = await upload(PNG);
    writtenUrls.push(second.body.url);
    await api.request(`/api/author/stories/${storyId}`, {
      method: "PATCH",
      as: authorId,
      body: { coverUrl: second.body.url },
    });

    await expect(
      readFile(path.join(UPLOAD_ROOT, keyOf(first.body.url))),
    ).rejects.toThrow();
  });

  it("clears the cover when sent an empty string, and removes the file", async () => {
    const created = await api.request("/api/author/stories", {
      method: "POST",
      as: authorId,
      body: { title: `Uncovered ${api.runId}` },
    });

    const uploaded = await upload(PNG);

    await api.request(`/api/author/stories/${created.body.story.id}`, {
      method: "PATCH",
      as: authorId,
      body: { coverUrl: uploaded.body.url },
    });

    const cleared = await api.request(
      `/api/author/stories/${created.body.story.id}`,
      { method: "PATCH", as: authorId, body: { coverUrl: "" } },
    );

    expect(cleared.body.story.coverUrl).toBeNull();
    await expect(
      readFile(path.join(UPLOAD_ROOT, keyOf(uploaded.body.url))),
    ).rejects.toThrow();
  });

  it("removes the cover file when the story is deleted", async () => {
    const created = await api.request("/api/author/stories", {
      method: "POST",
      as: authorId,
      body: { title: `Withdrawn ${api.runId}` },
    });

    const uploaded = await upload(PNG);

    await api.request(`/api/author/stories/${created.body.story.id}`, {
      method: "PATCH",
      as: authorId,
      body: { coverUrl: uploaded.body.url },
    });

    await api.request(`/api/author/stories/${created.body.story.id}`, {
      method: "DELETE",
      as: authorId,
    });

    await expect(
      readFile(path.join(UPLOAD_ROOT, keyOf(uploaded.body.url))),
    ).rejects.toThrow();
  });
});

/* Chapter media: the streaming path, over HTTP ---------------------------- */

/** A minimal MP3 — an ID3 tag padded past the bytes the sniffer reads. */
const MP3 = Buffer.concat([Buffer.from("ID3 ", "ascii"), Buffer.alloc(128)]);

function uploadMedia(data: Buffer, contentType = "audio/mpeg", as = authorId) {
  return api.request("/api/uploads?kind=media", {
    method: "POST",
    as,
    raw: { data, contentType },
  });
}

describe.skipIf(!available)("POST /api/uploads?kind=media", () => {
  it("stores audio and returns a URL that resolves to those bytes", async () => {
    const { status, body } = await uploadMedia(MP3);

    expect(status).toBe(201);
    expect(body.url).toMatch(/^\/uploads\/media\/.+\.mp3$/);
    expect(body.contentType).toBe("audio/mpeg");
    expect(body.multimediaType).toBe("AUDIO");
    expect(body.bytes).toBe(MP3.length);
    writtenUrls.push(body.url);

    // The URL is served by this app, so a reader's player really can fetch it.
    const served = await fetch(`${api.baseUrl}${body.url}`);
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(MP3)).toBe(true);
  });

  it("rejects a non-media body wearing a media content type", async () => {
    const { status, body } = await uploadMedia(
      Buffer.from("<script>alert(1)</script>".padEnd(128), "utf8"),
      "video/mp4",
    );

    expect(status).toBe(400);
    expect(body.error.details.file).toBeTruthy();
  });

  it("still refuses a non-image body under the cover kind", async () => {
    // `kind=cover` takes images only; audio arriving there is a client bug,
    // not a stream to buffer.
    const { status } = await api.request("/api/uploads?kind=cover", {
      method: "POST",
      as: authorId,
      raw: { data: MP3, contentType: "audio/mpeg" },
    });

    expect(status).toBe(400);
  });

  it("takes an image under the media kind, into the media prefix", async () => {
    // A chapter can be given an image as well as audio, and it belongs
    // alongside the other attachments rather than with the story covers.
    const { status, body } = await uploadMedia(PNG, "image/png");

    expect(status).toBe(201);
    expect(body.url).toMatch(/^\/uploads\/media\/.+\.png$/);
    expect(body.multimediaType).toBe("IMAGE");
    writtenUrls.push(body.url);
  });

  it("requires a signed-in caller", async () => {
    const { status } = await api.request("/api/uploads?kind=media", {
      method: "POST",
      raw: { data: MP3, contentType: "audio/mpeg" },
    });

    expect(status).toBe(401);
  });
});

describe.skipIf(!available)("chapter attachments", () => {
  it("attaches an upload to a chapter and removes the file when detached", async () => {
    const story = await api.request("/api/author/stories", {
      method: "POST",
      as: authorId,
      body: { title: `Scored ${api.runId}` },
    });

    const storyId = story.body.story.id;

    const chapter = await api.request(
      `/api/author/stories/${storyId}/chapters`,
      { method: "POST", as: authorId, body: { title: "One", content: "Hi." } },
    );

    const chapterId = chapter.body.chapter.id;
    const uploaded = await uploadMedia(MP3);

    const attached = await api.request(
      `/api/author/chapters/${chapterId}/multimedia`,
      {
        method: "POST",
        as: authorId,
        body: {
          type: uploaded.body.multimediaType,
          url: uploaded.body.url,
        },
      },
    );

    expect(attached.status).toBe(201);
    expect(attached.body.multimedia.type).toBe("AUDIO");

    // The editor reads attachments off the chapter list rather than asking per
    // chapter, so they have to come back with it.
    const listed = await api.request(
      `/api/author/stories/${storyId}/chapters`,
      { as: authorId },
    );

    expect(listed.body.chapters[0].multimedia).toEqual([
      attached.body.multimedia,
    ]);

    await api.request(
      `/api/author/multimedia/${attached.body.multimedia.id}`,
      { method: "DELETE", as: authorId },
    );

    // Detaching is the only chance to reclaim the file: nothing else holds the
    // URL once the row is gone.
    await expect(
      readFile(path.join(UPLOAD_ROOT, keyOf(uploaded.body.url))),
    ).rejects.toThrow();
  });

  it("removes attachment files when the story is deleted", async () => {
    const story = await api.request("/api/author/stories", {
      method: "POST",
      as: authorId,
      body: { title: `Silenced ${api.runId}` },
    });

    const chapter = await api.request(
      `/api/author/stories/${story.body.story.id}/chapters`,
      { method: "POST", as: authorId, body: { title: "One", content: "Hi." } },
    );

    const uploaded = await uploadMedia(MP3);

    await api.request(
      `/api/author/chapters/${chapter.body.chapter.id}/multimedia`,
      {
        method: "POST",
        as: authorId,
        body: { type: "AUDIO", url: uploaded.body.url },
      },
    );

    await api.request(`/api/author/stories/${story.body.story.id}`, {
      method: "DELETE",
      as: authorId,
    });

    await expect(
      readFile(path.join(UPLOAD_ROOT, keyOf(uploaded.body.url))),
    ).rejects.toThrow();
  });
});
