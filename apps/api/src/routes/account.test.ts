import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { TestApi, databaseAvailable } from "../test/harness.js";
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
