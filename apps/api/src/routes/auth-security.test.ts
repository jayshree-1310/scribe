/**
 * Passwords and email verification, end to end against the development
 * Postgres and Redis, with the mailer stubbed.
 *
 * The mailer is the seam because the token only ever exists in the message —
 * that is the whole design — so a test that cannot read the mail cannot test
 * the flow. Everything else runs for real: argon2 hashing, the Redis token
 * store, session issuing and revocation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

const sent: SentMail[] = [];

vi.mock("../lib/mailer.js", () => ({
  sendMail: async (mail: SentMail) => {
    sent.push(mail);
  },
  webLink: (path: string) => `http://localhost:1302${path}`,
}));

const { default: app } = await import("../app.js");
const { db } = await import("../prisma/db.js");
const { redis, connectRedis } = await import("../lib/redis.js");
const { databaseAvailable } = await import("../test/harness.js");
const { DEV_USER_HEADER } = await import("../middleware/current-user.js");

const available = await databaseAvailable();

let server: Server;
let baseUrl = "";
const createdUserIds = new Set<string>();

interface Res<T = any> {
  status: number;
  body: T;
  cookie: string | undefined;
}

async function call<T = any>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    /** A bearer access token, as a browser would send. */
    token?: string;
    /** A whole `refreshToken=...` Set-Cookie value, replayed as a Cookie. */
    cookie?: string;
    /** Local-development impersonation, for the Google-only account. */
    as?: string;
  } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  if (options.cookie) headers["Cookie"] = options.cookie.split(";")[0]!;
  if (options.as) headers[DEV_USER_HEADER] = options.as;

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  return {
    status: response.status,
    body: (await response.json()) as T,
    cookie: (response.headers.getSetCookie?.() ?? []).find((value) =>
      value.startsWith("refreshToken="),
    ),
  };
}

function unique(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

interface Account {
  id: string;
  username: string;
  email: string;
  password: string;
}

/** A real password account, created the way a person would create one. */
async function signUp(password = "correct horse battery"): Promise<Account> {
  const username = unique("pwsec");
  const email = `${username}@fixtures.invalid`;

  const response = await call("/api/auth/signup", {
    body: { username, email, password },
  });

  expect(response.status).toBe(201);
  createdUserIds.add(response.body.user.id);

  return { id: response.body.user.id, username, email, password };
}

function signIn(account: Pick<Account, "email" | "password">) {
  return call("/api/auth/login", {
    body: { email: account.email, password: account.password },
  });
}

/** An account that only ever signed in with Google: no password hash at all. */
async function createGoogleOnlyUser(): Promise<Account> {
  const username = unique("pwsecg");
  const email = `${username}@fixtures.invalid`;

  const user = await db.orm.auth.User.select("id").create({
    username,
    email,
    passwordHash: null,
    googleId: unique("google"),
    emailVerified: true,
  });

  createdUserIds.add(user.id);

  return { id: user.id, username, email, password: "" };
}

/** The most recent message to an address, and the token in its link. */
function tokenSentTo(email: string, route: string): string {
  const mail = [...sent].reverse().find((item) => item.to === email);
  expect(mail, `no mail was sent to ${email}`).toBeDefined();

  const match = new RegExp(`/${route}/([A-Za-z0-9_-]+)`).exec(mail!.text);
  expect(match, `no /${route} link in the message`).not.toBeNull();

  return match![1]!;
}

beforeAll(async () => {
  if (!available) return;
  process.env.ALLOW_DEV_USER_HEADER = "true";
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
  sent.length = 0;
  // Every test shares 127.0.0.1, so one suite would otherwise exhaust the
  // per-IP budgets the routes are supposed to be enforcing per caller.
  for (const key of await redis.keys("auth:ratelimit:*")) await redis.del(key);
});

describe.skipIf(!available)("POST /api/auth/forgot-password", () => {
  it("answers the same for a known and an unknown address", async () => {
    const account = await signUp();

    const known = await call("/api/auth/forgot-password", {
      body: { email: account.email },
    });
    const unknown = await call("/api/auth/forgot-password", {
      body: { email: `${unique("nobody")}@fixtures.invalid` },
    });

    expect(known.status).toBe(unknown.status);
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);

    // ...and the difference that must not be observable from outside is real.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(account.email);
  });
});

describe.skipIf(!available)("POST /api/auth/reset-password", () => {
  it("spends the token exactly once", async () => {
    const account = await signUp();

    await call("/api/auth/forgot-password", { body: { email: account.email } });
    const token = tokenSentTo(account.email, "reset-password");

    const first = await call("/api/auth/reset-password", {
      body: { token, password: "a whole new sentence" },
    });
    const second = await call("/api/auth/reset-password", {
      body: { token, password: "yet another sentence" },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);

    // The first password won; the replay did not overwrite it.
    expect(
      (await signIn({ email: account.email, password: "a whole new sentence" }))
        .status,
    ).toBe(200);
  });

  it("refuses a token whose window has passed", async () => {
    const account = await signUp();

    await call("/api/auth/forgot-password", { body: { email: account.email } });
    const token = tokenSentTo(account.email, "reset-password");

    // Expiry is a Redis TTL, so the honest way to test it is to let the key
    // go rather than to wait half an hour for it.
    const hash = await import("node:crypto").then((crypto) =>
      crypto.createHash("sha256").update(token).digest("hex"),
    );
    await redis.del(`auth:pwreset:${hash}`);

    const response = await call("/api/auth/reset-password", {
      body: { token, password: "too late for this one" },
    });

    expect(response.status).toBe(400);
    expect(
      (await signIn(account)).status,
      "the original password must still work",
    ).toBe(200);
  });

  it("refuses a link sent to an address the account no longer uses", async () => {
    const account = await signUp();

    await call("/api/auth/forgot-password", { body: { email: account.email } });
    const token = tokenSentTo(account.email, "reset-password");

    await db.orm.auth.User.where((u) => u.id.eq(account.id)).update({
      email: `${unique("moved")}@fixtures.invalid`,
    });

    const response = await call("/api/auth/reset-password", {
      body: { token, password: "should not be accepted" },
    });

    expect(response.status).toBe(400);
  });

  it("revokes every session, so a reset locks an intruder out", async () => {
    const account = await signUp();

    const laptop = await signIn(account);
    const phone = await signIn(account);

    expect(laptop.cookie).toBeDefined();
    expect(phone.cookie).toBeDefined();

    await call("/api/auth/forgot-password", { body: { email: account.email } });
    await call("/api/auth/reset-password", {
      body: {
        token: tokenSentTo(account.email, "reset-password"),
        password: "the locks have been changed",
      },
    });

    for (const cookie of [laptop.cookie, phone.cookie]) {
      const refreshed = await call("/api/auth/refresh", { cookie });
      expect(refreshed.status).toBe(401);
    }
  });

  it("counts as proof of the address, so it verifies the account", async () => {
    const account = await signUp();

    await call("/api/auth/forgot-password", { body: { email: account.email } });
    await call("/api/auth/reset-password", {
      body: {
        token: tokenSentTo(account.email, "reset-password"),
        password: "proved it by opening the mail",
      },
    });

    const stored = await db.orm.auth.User.select("emailVerified")
      .where((u) => u.id.eq(account.id))
      .first();

    expect(stored?.emailVerified).toBe(true);
  });
});

describe.skipIf(!available)("POST /api/auth/change-password", () => {
  it("rejects the wrong current password with a field error", async () => {
    const account = await signUp();
    const session = await signIn(account);

    const response = await call("/api/auth/change-password", {
      token: session.body.accessToken,
      body: { currentPassword: "not it at all", newPassword: "a new one here" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.currentPassword).toBeTypeOf("string");
    expect((await signIn(account)).status).toBe(200);
  });

  it("signs out other devices and keeps the caller signed in", async () => {
    const account = await signUp();

    const laptop = await signIn(account);
    const phone = await signIn(account);

    const response = await call("/api/auth/change-password", {
      token: laptop.body.accessToken,
      body: {
        currentPassword: account.password,
        newPassword: "changed from the laptop",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTypeOf("string");

    // The other device's refresh token is dead...
    expect((await call("/api/auth/refresh", { cookie: phone.cookie })).status).toBe(
      401,
    );

    // ...while the cookie this response set still rotates.
    expect(
      (await call("/api/auth/refresh", { cookie: response.cookie })).status,
    ).toBe(200);
  });

  it("refuses to reuse the password that is already set", async () => {
    const account = await signUp();
    const session = await signIn(account);

    const response = await call("/api/auth/change-password", {
      token: session.body.accessToken,
      body: {
        currentPassword: account.password,
        newPassword: account.password,
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.newPassword).toBeTypeOf("string");
  });

  it("tells a Google-only account to set a password instead", async () => {
    const account = await createGoogleOnlyUser();

    const response = await call("/api/auth/change-password", {
      as: account.id,
      body: { currentPassword: "anything", newPassword: "eight or more" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/set one instead/i);
  });
});

describe.skipIf(!available)("POST /api/auth/set-password", () => {
  it("gives a Google-only account a second way in", async () => {
    const account = await createGoogleOnlyUser();

    const response = await call("/api/auth/set-password", {
      as: account.id,
      body: { password: "now I have both" },
    });

    expect(response.status).toBe(200);
    expect(
      (await signIn({ email: account.email, password: "now I have both" }))
        .status,
    ).toBe(200);
  });

  it("refuses an account that already has one", async () => {
    const account = await signUp();

    const response = await call("/api/auth/set-password", {
      as: account.id,
      body: { password: "trying to skip the old one" },
    });

    expect(response.status).toBe(409);
    expect((await signIn(account)).status).toBe(200);
  });
});

describe.skipIf(!available)("email verification", () => {
  it("verifies the address the link was sent to, once", async () => {
    const account = await signUp();

    const requested = await call("/api/auth/send-verification", {
      as: account.id,
    });
    expect(requested.status).toBe(200);

    const token = tokenSentTo(account.email, "verify-email");

    const first = await call("/api/auth/verify-email", { body: { token } });
    const second = await call("/api/auth/verify-email", { body: { token } });

    expect(first.status).toBe(200);
    expect(first.body.email).toBe(account.email);
    expect(second.status).toBe(400);

    const stored = await db.orm.auth.User.select("emailVerified")
      .where((u) => u.id.eq(account.id))
      .first();

    expect(stored?.emailVerified).toBe(true);
  });

  it("sends nothing to an account that is already verified", async () => {
    const account = await createGoogleOnlyUser();

    const response = await call("/api/auth/send-verification", {
      as: account.id,
    });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});
