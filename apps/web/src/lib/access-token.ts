/**
 * The access token, held in memory only.
 *
 * Deliberately not `localStorage`: a token there is readable by any script that
 * gets injected into the page, and it is the one credential that grants API
 * access directly. Losing it on reload costs nothing, because the refresh
 * cookie is HttpOnly and `POST /api/auth/refresh` mints a new one.
 */

let accessToken: string | null = null

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null): void {
  accessToken = token
}
