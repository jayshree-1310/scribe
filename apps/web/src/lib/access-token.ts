/**
 * The access token, held in memory only.
 *
 * Deliberately not `localStorage`: a token there is readable by any script that
 * gets injected into the page, and it is the one credential that grants API
 * access directly. Losing it on reload costs nothing, because the refresh
 * cookie is HttpOnly and `POST /api/auth/refresh` mints a new one.
 *
 * Because the token is minted asynchronously, every consumer needs a way to
 * *wait* for it rather than read a null that only means "not yet". That is
 * what `ensureAccessToken` is for, and why the refresh is coordinated here:
 * a cold page load fires several authed requests at once, and all of them
 * must share one refresh instead of racing it.
 */

/** Performs the network half of a refresh. Registered by `data/auth-api`. */
type Refresher = () => Promise<string | null>

let accessToken: string | null = null
let refresher: Refresher | null = null

/** The in-flight refresh, shared by every caller that arrives during it. */
let inFlight: Promise<string | null> | null = null

/**
 * True once a refresh has come back empty, or the user has signed out — the
 * difference between "no token yet" and "no session at all". Without it every
 * request an anonymous visitor makes would re-attempt a refresh that is known
 * to fail.
 */
let known = false

export function registerTokenRefresher(fn: Refresher): void {
  refresher = fn
}

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null): void {
  accessToken = token
  // Either way the session state is now settled: a token means signed in, and
  // an explicit null means signed out rather than merely unresolved.
  known = true
}

/**
 * Runs a refresh, folding concurrent callers into the single request already
 * on the wire.
 */
export function refreshAccessToken(): Promise<string | null> {
  if (inFlight) return inFlight
  if (!refresher) return Promise.resolve(accessToken)

  inFlight = refresher().finally(() => {
    inFlight = null
  })

  return inFlight
}

/**
 * The token to send with the next request: the one in memory, or the one a
 * refresh is about to produce.
 *
 * Returning null here is a real answer — nobody is signed in — rather than a
 * timing artefact, which is what lets callers treat a 401 as authoritative.
 */
export function ensureAccessToken(): Promise<string | null> {
  if (accessToken !== null) return Promise.resolve(accessToken)
  if (inFlight) return inFlight
  if (known) return Promise.resolve(null)

  return refreshAccessToken()
}
