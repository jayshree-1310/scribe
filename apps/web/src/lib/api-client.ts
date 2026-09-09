/**
 * Thin fetch wrapper shared by every API module.
 *
 * Responsibilities: build the URL, send/parse JSON, and normalise every
 * failure — HTTP, transport or malformed body — into an `ApiError` carrying a
 * message that is safe to show a person.
 */

import { getAccessToken } from './access-token'

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

export async function request<T>(
  path: string,
  { method = 'GET', body, query, headers, signal }: RequestOptions = {},
): Promise<T> {
  // Abort on timeout, but also stay responsive to a caller-supplied signal.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout

  let response: Response
  try {
    const accessToken = getAccessToken()

    response = await fetch(buildUrl(path, query), {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        // Attached here rather than per call site, so no request can forget it.
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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

  if (!response.ok) throw await toApiError(response)

  if (response.status === 204) return undefined as T

  try {
    return (await response.json()) as T
  } catch (cause) {
    throw new ApiError(GENERIC_MESSAGE, { code: 'invalid_response', cause })
  }
}
