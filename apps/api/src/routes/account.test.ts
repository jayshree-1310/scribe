import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { db } from "../prisma/db.js";
import { UPLOAD_ROOT } from "../lib/storage.js";

const api = new TestApi();
const available = await databaseAvailable();

let reader: string;
let neighbour: string;

/** A one-pixel PNG: the smallest input that passes signature sniffing. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** Files written by the suite, removed afterwards so runs leave no residue. */
const writtenUrls: string[] = [];

function uploadAvatar(data: Buffer, as = reader, contentType = "image/png") {
  return api.request("/api/account/avatar", {
    method: "POST",
    as,
    raw: { data, contentType },
  });
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  reader = await api.createUser("account");
  neighbour = await api.createUser("neighbour");
});

afterAll(async () => {
  if (!available) return;

  for (const url of writtenUrls.filter(Boolean)) {
    const key = url.slice(url.indexOf("/uploads/") + "/uploads/".length);
    await rm(path.join(UPLOAD_ROOT, key), { force: true });
  }

  await api.stop();
});

describe.skipIf(!available)("GET /api/account/me", () => {
  it("requires a signed-in caller", async () => {
    const response = await api.request("/api/account/me");

    expect(response.status).toBe(401);
  });

  it("returns the caller's own profile and never their password hash", async () => {
    const response = await api.request("/api/account/me", { as: reader });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(reader);
    expect(response.body).toHaveProperty("bio");
    expect(response.body).not.toHaveProperty("passwordHash");
  });
});

describe.skipIf(!available)("PATCH /api/account/me", () => {
  it("updates only the fields sent", async () => {
    const named = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { displayName: "Jayshree U.", bio: "Reader first." },
    });

    expect(named.status).toBe(200);
    expect(named.body.displayName).toBe("Jayshree U.");

    const bioOnly = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { bio: "Writer on Sundays." },
    });

    // The display name survives a request that did not mention it.
    expect(bioOnly.body.displayName).toBe("Jayshree U.");
    expect(bioOnly.body.bio).toBe("Writer on Sundays.");
  });

  it("stores a cleared bio or display name as null", async () => {
    const response = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { bio: "   ", displayName: "" },
    });

    expect(response.body.bio).toBeNull();
    expect(response.body.displayName).toBeNull();
  });

  it("rejects a username another account already has", async () => {
    // Fixture usernames carry the run id and are too long to be re-sent
    // through the API's own rule, so the neighbour claims a legal one first.
    const taken = `n${Date.now().toString(36)}`.slice(0, 24);

    const claimed = await api.request("/api/account/me", {
      method: "PATCH",
      as: neighbour,
      body: { username: taken },
    });

    expect(claimed.status).toBe(200);

    const response = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { username: taken },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.username).toMatch(/already taken/i);
  });

  it("accepts the caller's own username unchanged", async () => {
    const name = `r${Date.now().toString(36)}`.slice(0, 24);
    await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { username: name },
    });

    const before = await api.request("/api/account/me", { as: reader });

    const response = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { username: before.body.username },
    });

    expect(response.status).toBe(200);
    expect(response.body.username).toBe(before.body.username);
  });

  it("reports an invalid username per field rather than generically", async () => {
    const response = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { username: "no spaces here" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.username).toBeTruthy();
  });

  it("resets email verification when the address changes", async () => {
    const address = `${api.runId}-moved@fixtures.invalid`;

    const response = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { email: address },
    });

    expect(response.status).toBe(200);
    expect(response.body.email).toBe(address);
    expect(response.body.emailVerified).toBe(false);
  });
});

describe.skipIf(!available)("avatar upload", () => {
  it("stores an image and returns a URL that resolves to those bytes", async () => {
    const response = await uploadAvatar(PNG);

    expect(response.status).toBe(200);
    expect(response.body.avatarUrl).toMatch(/^\/uploads\/avatars\/.+\.png$/);
    writtenUrls.push(response.body.avatarUrl);

    const key = response.body.avatarUrl.replace("/uploads/", "");
    const onDisk = await readFile(path.join(UPLOAD_ROOT, key));
    expect(onDisk.equals(PNG)).toBe(true);
  });

  it("replaces the previous file rather than accumulating", async () => {
    const first = await uploadAvatar(PNG);
    const second = await uploadAvatar(PNG);

    writtenUrls.push(second.body.avatarUrl);
    expect(second.body.avatarUrl).not.toBe(first.body.avatarUrl);

    const staleKey = first.body.avatarUrl.replace("/uploads/", "");
    await expect(readFile(path.join(UPLOAD_ROOT, staleKey))).rejects.toThrow();
  });

  it("rejects a non-image wearing an image content type", async () => {
    const response = await uploadAvatar(
      Buffer.from("<script>alert(1)</script>", "utf8"),
      reader,
      "image/png",
    );

    expect(response.status).toBe(400);
    expect(response.body.error.details.avatar).toBeTruthy();
  });

  it("rejects a body that is not an image at all", async () => {
    const response = await api.request("/api/account/avatar", {
      method: "POST",
      as: reader,
      body: { avatar: "please" },
    });

    expect(response.status).toBe(400);
  });

  it("clears the avatar on delete", async () => {
    const uploaded = await uploadAvatar(PNG);
    const key = uploaded.body.avatarUrl.replace("/uploads/", "");

    const response = await api.request("/api/account/avatar", {
      method: "DELETE",
      as: reader,
    });

    expect(response.status).toBe(200);
    expect(response.body.avatarUrl).toBeNull();
    await expect(readFile(path.join(UPLOAD_ROOT, key))).rejects.toThrow();
  });

  it("requires a signed-in caller", async () => {
    const response = await api.request("/api/account/avatar", {
      method: "POST",
      raw: { data: PNG, contentType: "image/png" },
    });

    expect(response.status).toBe(401);
  });
});

describe.skipIf(!available)("DELETE /api/account/me", () => {
  /**
   * A fixture user carries a placeholder hash that argon2 cannot read, and
   * the delete route asks for a password whenever the account has one — so
   * these tests give it a real hash rather than testing against a value no
   * real account would hold.
   */
  // Labels stay short: the harness truncates a fixture username to 30
  // characters, and four long ones collide into a single name.
  async function createDeletable(
    label: string,
    password: string | null,
  ): Promise<{ id: string; username: string }> {
    const id = await api.createUser(label);

    await db.orm.auth.User.where((u) => u.id.eq(id)).update({
      passwordHash: password === null ? null : await argon2.hash(password),
    });

    const row = await db.orm.auth.User.select("username")
      .where((u) => u.id.eq(id))
      .first();

    return { id, username: row!.username };
  }

  function stillExists(id: string) {
    return db.orm.auth.User.select("id")
      .where((u) => u.id.eq(id))
      .first();
  }

  it("refuses without the typed confirmation", async () => {
    const user = await createDeletable("d1", "open sesame please");

    const response = await api.request("/api/account/me", {
      method: "DELETE",
      as: user.id,
      body: { confirmUsername: "not-my-username", password: "open sesame please" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.confirmUsername).toBeTruthy();
    expect(await stillExists(user.id)).toBeTruthy();
  });

  it("refuses the wrong password", async () => {
    const user = await createDeletable("d2", "open sesame please");

    const response = await api.request("/api/account/me", {
      method: "DELETE",
      as: user.id,
      body: { confirmUsername: user.username, password: "wrong one entirely" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.password).toBeTruthy();
    expect(await stillExists(user.id)).toBeTruthy();
  });

  it("deletes the account and everything hanging off it", async () => {
    const user = await createDeletable("d3", "open sesame please");

    const genreId = await api.createGenre("dg");
    const story = await api.createStory({
      title: "A story to be unpublished by deletion",
      authorId: user.id,
      genreIds: [genreId],
    });
    await api.createChapter({ storyId: story.id, number: 1 });

    // Someone else's rating against that story has to go too, or the story
    // delete would fail on a foreign key.
    const neighbourId = await api.createUser("d5");
    await api.createRating({ userId: neighbourId, storyId: story.id, rating: 4 });

    const response = await api.request("/api/account/me", {
      method: "DELETE",
      as: user.id,
      body: { confirmUsername: user.username, password: "open sesame please" },
    });

    expect(response.status).toBe(200);
    expect(await stillExists(user.id)).toBeFalsy();

    const remaining = await db.orm.content.Story.select("id")
      .where((row) => row.id.eq(story.id))
      .first();

    expect(remaining).toBeFalsy();
  });

  it("asks a Google-only account for the username alone", async () => {
    const user = await createDeletable("d4", null);

    const response = await api.request("/api/account/me", {
      method: "DELETE",
      as: user.id,
      body: { confirmUsername: user.username },
    });

    expect(response.status).toBe(200);
    expect(await stillExists(user.id)).toBeFalsy();
  });

  it("requires a signed-in caller", async () => {
    const response = await api.request("/api/account/me", {
      method: "DELETE",
      body: { confirmUsername: "anyone" },
    });

    expect(response.status).toBe(401);
  });
});

describe.skipIf(!available)("password state on the profile", () => {
  it("reports whether the account can be signed into with a password", async () => {
    const withPassword = await api.request("/api/account/me", { as: reader });
    expect(withPassword.body.hasPassword).toBe(true);

    await db.orm.auth.User.where((u) => u.id.eq(neighbour)).update({
      passwordHash: null,
    });

    const googleOnly = await api.request("/api/account/me", { as: neighbour });
    expect(googleOnly.body.hasPassword).toBe(false);
    expect(googleOnly.body).not.toHaveProperty("passwordHash");
  });
});
