/**
 * Single-use, short-lived tokens emailed to a person: password resets and
 * email verification.
 *
 * Both flows want the same four properties, so they share one implementation
 * rather than each getting them three-quarters right:
 *
 * - **Hashed at rest.** Redis stores `sha256(token)`, never the token. Anyone
 *   who can read the keyspace — a dump, a misconfigured instance — still
 *   cannot mint a working link out of it.
 * - **Single use.** `DEL` reports how many keys it removed, which makes it the
 *   mutex: two concurrent uses of one link both read the value, exactly one
 *   gets a 1 back and proceeds.
 * - **Short TTL**, chosen by the caller.
 * - **One live link per person.** Issuing a new one drops the previous, so a
 *   reset link that was requested and abandoned cannot be used later, and an
 *   old address' link dies the moment a new one is sent.
 */

import { createHash, randomBytes } from "node:crypto";
import { connectRedis, redis } from "./redis.js";

/** What is stored alongside the subject, so a consumer can re-check context. */
export type TokenPayload = Record<string, string>;

export interface ConsumedToken {
  userId: string;
  payload: TokenPayload;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenKey(namespace: string, hash: string): string {
  return `auth:${namespace}:${hash}`;
}

/** Points at the one live token for a user, so issuing can retire it. */
function latestKey(namespace: string, userId: string): string {
  return `auth:${namespace}:latest:${userId}`;
}

/**
 * Mints a token for `userId`, retiring whatever was outstanding, and returns
 * the raw value — the only moment it exists anywhere outside the email.
 */
export async function issueOneTimeToken(
  namespace: string,
  userId: string,
  payload: TokenPayload,
  ttlSeconds: number,
): Promise<string> {
  await connectRedis();

  const token = randomBytes(32).toString("base64url");
  const hash = digest(token);

  const previous = await redis.get(latestKey(namespace, userId));
  if (previous) await redis.del(tokenKey(namespace, previous));

  await redis
    .multi()
    .set(tokenKey(namespace, hash), JSON.stringify({ userId, ...payload }), {
      EX: ttlSeconds,
    })
    .set(latestKey(namespace, userId), hash, { EX: ttlSeconds })
    .exec();

  return token;
}

/**
 * Spends a token. Returns null for anything that is not a live token —
 * expired, already used, or never issued — because the three are the same
 * answer to the person holding the link and telling them apart only helps
 * someone guessing.
 */
export async function consumeOneTimeToken(
  namespace: string,
  token: string,
): Promise<ConsumedToken | null> {
  await connectRedis();

  const key = tokenKey(namespace, digest(token));
  const raw = await redis.get(key);

  if (!raw) return null;

  // The mutex. Losing this race means another request is already spending it.
  if ((await redis.del(key)) === 0) return null;

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const { userId, ...payload } = parsed;

  if (typeof userId !== "string" || userId.length === 0) return null;

  await redis.del(latestKey(namespace, userId));

  return { userId, payload: payload as TokenPayload };
}

/**
 * Drops a user's outstanding token without spending it.
 *
 * Setting a password by any other route has to do this: a reset link sent
 * yesterday and never opened is a live credential, and the whole point of
 * changing a password is that yesterday's credentials stop working.
 */
export async function revokeOneTimeToken(
  namespace: string,
  userId: string,
): Promise<void> {
  await connectRedis();

  const hash = await redis.get(latestKey(namespace, userId));

  await redis.del(
    hash
      ? [tokenKey(namespace, hash), latestKey(namespace, userId)]
      : [latestKey(namespace, userId)],
  );
}
