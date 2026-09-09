/**
 * Google sign-in, exercised end to end against the development Postgres with
 * Google's own verification stubbed.
 *
 * Stubbing `verifyGoogleIdToken` is the point of the seam: everything Google
 * owns (signature, JWKS, audience) is the library's job and is not ours to
 * re-test, while everything *we* own — account matching, linking, username
 * derivation, session issuing — is what breaks and is what this covers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const verifyGoogleIdToken = vi.fn();

vi.mock("../lib/google.js", () => ({ verifyGoogleIdToken }));

const { default: app } = await import("../app.js");
const { db } = await import("../prisma/db.js");
const { redis, connectRedis } = await import("../lib/redis.js");
const { databaseAvailable } = await import("../test/harness.js");

const available = await databaseAvailable();

let server: Server;
let baseUrl = "";
const createdUserIds = new Set<string>();

interface Res<T = any> {
  status: number;
  body: T;
  setCookie: string | undefined;
}

async function post<T = any>(
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const raw = response.headers.getSetCookie?.() ?? [];

  return {
    status: response.status,
    body: (await response.json()) as T,
    setCookie: raw.find((value) => value.startsWith("refreshToken=")),
  };
}

/** `POST /api/auth/google`, remembering whoever it creates for teardown. */
async function signInWithGoogle(identity: Record<string, unknown>) {
  verifyGoogleIdToken.mockResolvedValueOnce(identity);
  const response = await post("/api/auth/google", { idToken: "stub" });
  if (response.body?.user?.id) createdUserIds.add(response.body.user.id);
  return response;
}

const googleIdentity = (over: Record<string, unknown> = {}) => ({
  googleId: `g-${Math.random().toString(36).slice(2)}`,
  email: `gtest_${Math.random().toString(36).slice(2)}@fixtures.invalid`,
  emailVerified: true,
  name: "Ada Lovelace",
  picture: "https://example.invalid/a.png",
  ...over,
});

beforeAll(async () => {
  if (!available) return;
  process.env.GOOGLE_CLIENT_ID ??= "test-client-id.apps.googleusercontent.com";
  await connectRedis();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!available) return;
  for (const id of createdUserIds) {
    for (const key of await redis.keys(`auth:sessions:${id}`)) {
      await redis.del(key);
    }
    await db.orm.auth.User.where((u) => u.id.eq(id)).delete();
  }
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(async () => {
  if (!available) return;
  verifyGoogleIdToken.mockReset();
  // The limiter is keyed per IP and every test shares 127.0.0.1.
  for (const key of await redis.keys("auth:ratelimit:*")) await redis.del(key);
});

describe.skipIf(!available)("POST /api/auth/google", () => {
  it("creates an account for a first-time Google user", async () => {
    const identity = googleIdentity();
    const response = await signInWithGoogle(identity);

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTypeOf("string");
    expect(response.body.user.email).toBe(identity.email);
    expect(response.body.user.displayName).toBe("Ada Lovelace");

    const stored = await db.orm.auth.User.where((u) =>
      u.id.eq(response.body.user.id),
    ).first();

    expect(response.body.created).toBe(true);
    expect(stored?.googleId).toBe(identity.googleId);
    expect(stored?.emailVerified).toBe(true);
    // The whole reason passwordHash became nullable.
    expect(stored?.passwordHash).toBeNull();
  });

  it("never returns the refresh token in the body, only as an HttpOnly cookie", async () => {
    const response = await signInWithGoogle(googleIdentity());

    expect(JSON.stringify(response.body)).not.toContain("refreshToken");
    expect(response.setCookie).toMatch(/HttpOnly/i);
    expect(response.setCookie).toMatch(/Path=\/api\/auth/);
    expect(response.setCookie).toMatch(/SameSite=Lax/i);
  });

  it("derives a username that satisfies the signup rules", async () => {
    const response = await signInWithGoogle(
      googleIdentity({ email: "Some.Person+tag@fixtures.invalid" }),
    );

    const stored = await db.orm.auth.User.where((u) =>
      u.id.eq(response.body.user.id),
    ).first();

    expect(stored?.username).toMatch(/^[a-z0-9_]{3,24}$/);
  });

  it("reuses the same account when the user returns", async () => {
    const identity = googleIdentity();

    const first = await signInWithGoogle(identity);
    const second = await signInWithGoogle(identity);

    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
    // Only the first visit is a new account, so only it goes to onboarding.
    expect(first.body.created).toBe(true);
    expect(second.body.created).toBe(false);
  });

  it("issues a session that rotates like a password login's", async () => {
    const response = await signInWithGoogle(googleIdentity());
    const cookie = response.setCookie!.split(";")[0]!;

    const refreshed = await post("/api/auth/refresh", undefined, cookie);

    expect(refreshed.status).toBe(200);
    expect(refreshed.setCookie).toBeDefined();
    expect(refreshed.setCookie).not.toContain(cookie);

    // And the replayed token is rejected, as it is for any other session.
    const replay = await post("/api/auth/refresh", undefined, cookie);
    expect(replay.status).toBe(401);
  });

  it("rejects a token the verifier will not vouch for", async () => {
    verifyGoogleIdToken.mockResolvedValueOnce(null);

    const response = await post("/api/auth/google", { idToken: "forged" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
  });

  it("refuses an unverified Google email", async () => {
    const response = await signInWithGoogle(
      googleIdentity({ emailVerified: false }),
    );

    expect(response.status).toBe(401);
    expect(response.body.error.message).toMatch(/not verified/i);
  });

  it("validates its own input", async () => {
    const missing = await post("/api/auth/google", {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("validation_error");

    const empty = await post("/api/auth/google", { idToken: "" });
    expect(empty.status).toBe(400);
  });

  it("adopts an existing password account with the same verified email", async () => {
    const email = `link_${Math.random().toString(36).slice(2)}@fixtures.invalid`;

    const signup = await post("/api/auth/signup", {
      username: `lnk${Math.random().toString(36).slice(2, 10)}`,
      email,
      password: "SuperSecret123!",
    });
    expect(signup.status).toBe(201);
    createdUserIds.add(signup.body.user.id);

    // A live session on the password account, which linking must revoke.
    const login = await post("/api/auth/login", {
      email,
      password: "SuperSecret123!",
    });
    expect(login.status).toBe(200);
    const oldCookie = login.setCookie!.split(";")[0]!;

    const linked = await signInWithGoogle(googleIdentity({ email }));

    expect(linked.status).toBe(200);
    expect(linked.body.user.id).toBe(signup.body.user.id);

    const stored = await db.orm.auth.User.where((u) =>
      u.id.eq(signup.body.user.id),
    ).first();
    expect(stored?.googleId).toBeTruthy();
    expect(stored?.emailVerified).toBe(true);

    // Sessions that existed before the link are gone.
    const reuse = await post("/api/auth/refresh", undefined, oldCookie);
    expect(reuse.status).toBe(401);
  });

  it("keeps password login working for a linked account", async () => {
    const email = `both_${Math.random().toString(36).slice(2)}@fixtures.invalid`;
    const password = "SuperSecret123!";

    const signup = await post("/api/auth/signup", {
      username: `both${Math.random().toString(36).slice(2, 10)}`,
      email,
      password,
    });
    createdUserIds.add(signup.body.user.id);

    await signInWithGoogle(googleIdentity({ email }));

    const login = await post("/api/auth/login", { email, password });
    expect(login.status).toBe(200);
  });

  it("refuses password login for a Google-only account instead of crashing", async () => {
    const identity = googleIdentity();
    const created = await signInWithGoogle(identity);
    expect(created.status).toBe(200);

    // Null passwordHash: this must be an ordinary 401, not a 500.
    const login = await post("/api/auth/login", {
      email: identity.email,
      password: "AnythingAtAll123",
    });

    expect(login.status).toBe(401);
    expect(login.body.error.message).toBe("Invalid email or password.");
  });

  it("does not reveal whether a Google-only address is registered", async () => {
    const identity = googleIdentity();
    await signInWithGoogle(identity);

    const known = await post("/api/auth/login", {
      email: identity.email,
      password: "AnythingAtAll123",
    });
    const unknown = await post("/api/auth/login", {
      email: `nobody_${Math.random().toString(36).slice(2)}@fixtures.invalid`,
      password: "AnythingAtAll123",
    });

    expect(known.status).toBe(unknown.status);
    expect(known.body.error.message).toBe(unknown.body.error.message);
  });

  it("rate limits repeated attempts", async () => {
    let sawTooMany = false;

    for (let i = 0; i < 24; i += 1) {
      verifyGoogleIdToken.mockResolvedValueOnce(null);
      const response = await post("/api/auth/google", { idToken: "x" });
      if (response.status === 429) {
        sawTooMany = true;
        expect(response.body.error.code).toBe("too_many_requests");
        break;
      }
    }

    expect(sawTooMany).toBe(true);
  });
});
