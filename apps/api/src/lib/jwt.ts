import jwt, { type SignOptions } from "jsonwebtoken";

function getEnvSecret(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

const accessSecret = getEnvSecret("JWT_ACCESS_SECRET");
const refreshSecret = getEnvSecret("JWT_REFRESH_SECRET");

const accessExpiresIn = process.env.JWT_ACCESS_EXPIRES_IN || "15m";

/**
 * Pinned on both sign and verify. Naming the algorithm explicitly stops a
 * token from being accepted under any algorithm an attacker picks, which is
 * the classic JWT confusion bug.
 */
const ALGORITHM = "HS256" as const;

const accessOptions: SignOptions = {
  algorithm: ALGORITHM,
  expiresIn: accessExpiresIn as SignOptions["expiresIn"],
};

export function createAccessToken(userId: string): string {
  return jwt.sign(
    {
      sub: userId,
      type: "access",
      /**
       * Issue time in milliseconds. `iat` is whole seconds, too coarse to
       * tell a token issued just before a revocation from the one issued just
       * after it (`isAccessTokenRevoked` in `lib/sessions.ts`).
       */
      iatMs: Date.now(),
    },
    accessSecret,
    accessOptions,
  );
}

/**
 * A refresh token that expires with its session.
 *
 * `expiresInSeconds` is the Redis session's own TTL (`storeSession` in
 * `lib/sessions.ts`), which is what actually decides whether a refresh
 * works. There used to be a separate `JWT_REFRESH_EXPIRES_IN` here, set to
 * 30 days while sessions lasted 7: the token outlived what it named, and the
 * variable read as if it controlled something it did not.
 */
export function createRefreshToken(
  userId: string,
  sessionId: string,
  familyId: string,
  expiresInSeconds: number,
): string {
  return jwt.sign(
    {
      sub: userId,
      sid: sessionId,
      /**
       * The rotation chain this token belongs to. Rotation deletes the old
       * `sid`, so a replayed token would otherwise be indistinguishable from
       * an expired one; carrying the family lets the server ask whether the
       * chain is still live and burn it if so.
       */
      fid: familyId,
      type: "refresh",
    },
    refreshSecret,
    { algorithm: ALGORITHM, expiresIn: expiresInSeconds },
  );
}

export interface RefreshTokenPayload {
  /** The owning user's id. */
  sub: string;
  /** The refresh session id this token is bound to. */
  sid: string;
  /** The rotation chain this token belongs to. */
  fid: string;
}

/**
 * Verifies signature, expiry, algorithm and payload shape together, so callers
 * cannot forget one of the four and never handle the refresh secret directly.
 * Every kind of bad token collapses to `null`, because every kind of bad token
 * gets the same 401 — distinguishing them only helps someone probing.
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  let payload: string | jwt.JwtPayload;

  try {
    payload = jwt.verify(token, refreshSecret, { algorithms: [ALGORITHM] });
  } catch {
    return null;
  }

  if (typeof payload === "string") {
    return null;
  }

  if (
    payload.type !== "refresh" ||
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    typeof payload.sid !== "string" ||
    payload.sid.length === 0 ||
    typeof payload.fid !== "string" ||
    payload.fid.length === 0
  ) {
    return null;
  }

  return { sub: payload.sub, sid: payload.sid, fid: payload.fid };
}

/**
 * Verifies an access token the same way as a refresh token: signature, expiry,
 * pinned algorithm and payload shape together, collapsing every failure to
 * `null` so a caller cannot accidentally treat a bad token as anonymous.
 */
export function verifyAccessToken(token: string): { sub: string; issuedAtMs: number } | null {
  let payload: string | jwt.JwtPayload;

  try {
    payload = jwt.verify(token, accessSecret, { algorithms: [ALGORITHM] });
  } catch {
    return null;
  }

  if (typeof payload === "string") {
    return null;
  }

  if (
    payload.type !== "access" ||
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    typeof payload.iat !== "number"
  ) {
    return null;
  }

  // Tokens issued before `iatMs` existed carry only the second.
  const issuedAtMs = typeof payload["iatMs"] === "number" ? payload["iatMs"] : payload.iat * 1000;

  return { sub: payload.sub, issuedAtMs };
}
