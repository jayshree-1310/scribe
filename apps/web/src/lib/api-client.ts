/**
 * Thin fetch wrapper shared by every API module.
 *
 * Responsibilities: build the URL, send/parse JSON, and normalise every
 * failure — HTTP, transport or malformed body — into an `ApiError` carrying a
 * message that is safe to show a person.
 */

import { ensureAccessToken, refreshAccessToken } from './access-token'

/** Error envelope returned by the API (`apps/api/src/lib/http-error.ts`). */
interface ApiErrorBody {
  error?: {
    code?: string
    message?: string
    details?: Record<string, string>
  }
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.'

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Some of the details need fixing.',
  404: "We couldn't find that note — it may have been deleted.",
  409: 'That change conflicts with a more recent update.',
  429: 'Too many requests. Give it a moment and try again.',
  500: 'The server ran into a problem. Please try again.',
  503: 'The service is temporarily unavailable. Please try again shortly.',
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** Per-field messages, keyed by field name, when the server rejected input. */
  readonly fieldErrors: Record<string, string>

  constructor(
    message: string,
    options: {
      status?: number
      code?: string
      fieldErrors?: Record<string, string>
      cause?: unknown
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'ApiError'
    this.status = options.status ?? 0
    this.code = options.code ?? 'unknown_error'
    this.fieldErrors = options.fieldErrors ?? {}
  }

  /** True when the request never reached the server. */
  get isOffline(): boolean {
    return this.status === 0
  }

  get isNotFound(): boolean {
    return this.status === 404
  }
}

/** `VITE_API_URL` lets a deployed build point at a separate API origin. */
const BASE_URL = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

const REQUEST_TIMEOUT_MS = 15_000

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /**
   * Serialised as JSON, unless it is binary — a `File`, `Blob` or buffer —
   * in which case it is sent verbatim. The avatar endpoint takes the image
   * bytes as the whole body, so nothing here may re-encode them.
   */
  body?: unknown
  query?: Record<string, string | undefined>
  /** Extra request headers, merged after the JSON content type. */
  headers?: Record<string, string>
  signal?: AbortSignal
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${BASE_URL}${path}`
  if (!query) return url

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value)
  }
  const search = params.toString()
  return search ? `${url}?${search}` : url
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | undefined
  try {
    body = (await response.json()) as ApiErrorBody
  } catch {
    // A non-JSON error body (proxy error page, empty 502) is expected here.
  }

  const message =
    body?.error?.message ??
    STATUS_MESSAGES[response.status] ??
    GENERIC_MESSAGE

  return new ApiError(message, {
    status: response.status,
    code: body?.error?.code,
    fieldErrors: body?.error?.details,
  })
}

function isBinary(body: unknown): body is Blob | ArrayBuffer | ArrayBufferView {
  return (
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  )
}

/**
 * Auth endpoints mint and clear the session themselves, so they must not be
 * routed through the token bootstrap or the refresh-and-replay below — doing
 * so would have `/auth/refresh` recurse into itself.
 */
function isAuthEndpoint(path: string): boolean {
  return path.startsWith('/auth/')
}

export async function request<T>(
  path: string,
  { method = 'GET', body, query, headers, signal }: RequestOptions = {},
): Promise<T> {
  /**
   * Waiting for the token rather than reading whatever is in memory right now
   * is what keeps a cold page load from firing its first authed requests
   * anonymously: the access token lives in memory only, so on every reload it
   * is null until `/auth/refresh` answers, and a request that went out in that
   * window came back 401 with the API's "Sign in to use your library."
   */
  const bootstrapped = isAuthEndpoint(path) ? null : await ensureAccessToken()

  return send<T>(path, { method, body, query, headers, signal }, bootstrapped)
}

async function send<T>(
  path: string,
  { method = 'GET', body, query, headers, signal }: RequestOptions,
  accessToken: string | null,
  retried = false,
): Promise<T> {
  // Abort on timeout, but also stay responsive to a caller-supplied signal.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout

  let response: Response
  try {
    const binary = isBinary(body)

    response = await fetch(buildUrl(path, query), {
      method,
      headers: {
        // A `File` carries its own type, which `fetch` sets for us; declaring
        // it here would send a second, possibly wrong, header.
        ...(body === undefined || binary
          ? {}
          : { 'Content-Type': 'application/json' }),
        // Attached here rather than per call site, so no request can forget it.
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : binary
            ? (body as BodyInit)
            : JSON.stringify(body),
      /**
       * The refresh token is an HttpOnly cookie. Same-origin is the default,
       * and the dev server proxies `/api`, but a deployed build pointed at
       * another origin via `VITE_API_URL` needs this to send it at all.
       */
      credentials: 'include',
      signal: composed,
    })
  } catch (cause) {
    // Re-throw caller-driven cancellation untouched so callers can ignore it.
    if (signal?.aborted) throw cause

    const timedOut = timeout.aborted
    throw new ApiError(
      timedOut
        ? 'The request took too long. Please check your connection and try again.'
        : "We couldn't reach the server. Please check your connection and try again.",
      { code: timedOut ? 'request_timeout' : 'network_error', cause },
    )
  }

  /**
   * A 401 on an authed call means the access token expired mid-session. The
   * refresh cookie usually outlives it, so mint a new token and replay once;
   * only if that fails is the caller genuinely signed out. `retried` bounds
   * this to a single attempt, and the refresh itself is de-duplicated, so a
   * page whose requests all 401 at once shares one refresh between them.
   */
  if (response.status === 401 && !retried && !isAuthEndpoint(path)) {
    const renewed = await refreshAccessToken()
    if (renewed) {
      return send<T>(path, { method, body, query, headers, signal }, renewed, true)
    }
  }

  if (!response.ok) throw await toApiError(response)

  if (response.status === 204) return undefined as T

  try {
    return (await response.json()) as T
  } catch (cause) {
    throw new ApiError(GENERIC_MESSAGE, { code: 'invalid_response', cause })
  }
}
