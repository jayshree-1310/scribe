import { OAuth2Client } from "google-auth-library";
import { HttpError } from "./http-error.js";

/**
 * Google's ID-token verification, kept behind one function so the route never
 * touches raw claims.
 *
 * The client id is read lazily rather than at import time: the API must still
 * boot — and every other route keep working — on a deployment that has not
 * configured Google sign-in. Callers get a clear 503 instead of a crash loop.
 */
let client: OAuth2Client | null = null;

function getClientId(): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    throw new HttpError(
      503,
      "internal_error",
      "Google sign-in is not configured on this server.",
    );
  }

  return clientId;
}

function getClient(): OAuth2Client {
  client ??= new OAuth2Client();
  return client;
}

export interface GoogleIdentity {
  /** Google's `sub`: stable for the life of the account. */
  googleId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/**
 * Verifies signature, expiry, issuer and audience, then returns the claims we
 * use. `null` means "not a token we can trust", with no distinction between
 * expired, forged and malformed — the caller answers 401 for all of them.
 *
 * `verifyIdToken` checks `aud` against our client id and `iss` against
 * Google's, and fetches/caches Google's signing keys itself. Both matter: a
 * token minted for a *different* application is validly signed by Google and
 * would otherwise be accepted here.
 */
export async function verifyGoogleIdToken(
  idToken: string,
): Promise<GoogleIdentity | null> {
  const audience = getClientId();

  let payload;

  try {
    const ticket = await getClient().verifyIdToken({ idToken, audience });
    payload = ticket.getPayload();
  } catch {
    return null;
  }

  if (!payload?.sub || !payload.email) {
    return null;
  }

  return {
    googleId: payload.sub,
    email: payload.email.trim().toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: payload.name?.trim() || null,
    picture: payload.picture ?? null,
  };
}
