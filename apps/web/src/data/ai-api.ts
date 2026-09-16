/**
 * AI data access, following `books-api.ts`.
 *
 * Scribble is the only endpoint for now. Everything it returns about a book —
 * title, author, description, link — came out of the database; only `reason`
 * and `intro` were generated, and the UI labels them as such.
 */

import {
  AI_REQUEST_TIMEOUT_MS,
  API_BASE_URL,
  ApiError,
  request,
  toApiError,
} from '../lib/api-client'
import { ensureAccessToken, getAccessToken } from '../lib/access-token'

const DEV_READER_ID =
  import.meta.env.VITE_DEV_USER_ID ?? '00000000-0000-4000-8000-000000000001'

/** See the identical block in `books-api.ts`; both go when sign-in is wired. */
function readerHeaders(): Record<string, string> {
  if (import.meta.env.PROD) return {}
  if (getAccessToken() !== null) return {}
  return { 'X-Scribe-User-Id': DEV_READER_ID }
}

export interface ScribbleGenre {
  id: string
  name: string
  hue: number
}

export interface ScribbleRecommendation {
  id: string
  slug: string
  title: string
  description: string | null
  coverUrl: string | null
  source: 'SCRIBE' | 'CATALOGUE'
  kidsAppropriate: boolean
  ratingAverage: number | null
  author: { username: string; displayName: string | null }
  genres: ScribbleGenre[]
  /** Generated. Empty when the model contributed nothing usable. */
  reason: string
  /** Built server-side: `/book/:id` for the catalogue, `/story/:slug` for Scribe. */
  url: string
}

export interface ScribbleReply {
  intro: string
  recommendations: ScribbleRecommendation[]
  interpreted: {
    genre: string | null
    kidsAppropriate: boolean
    completed: boolean | null
    search: string | null
    /** A title or author that matched nothing and was dropped to find these. */
    droppedSearch: string | null
  }
}

export async function askScribble(
  message: string,
  signal?: AbortSignal,
): Promise<ScribbleReply> {
  return request<ScribbleReply>('/ai/scribble', {
    method: 'POST',
    headers: readerHeaders(),
    body: { message },
    // Two model calls on a local CPU model: the shared 15s default aborts
    // every one of them.
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
}

/* Streaming -------------------------------------------------------------- */

/**
 * What the server sends, in order. `candidates` is the one that matters for
 * perceived speed: the cards come out of the database, so they arrive before
 * the model has written a word.
 */
export type ScribbleEvent =
  | { type: 'meta'; interpreted: ScribbleReply['interpreted'] }
  | { type: 'candidates'; candidates: ScribbleRecommendation[] }
  | { type: 'intro'; text: string }
  | { type: 'pick'; id: string; reason: string }
  | { type: 'done'; reply: ScribbleReply }
  | { type: 'error'; code: string; message: string }

/**
 * Reads the SSE endpoint.
 *
 * Cannot go through `request()`, which always ends in `response.json()`, so
 * this repeats the parts it must: the bearer token, the dev reader header, and
 * turning any failure into an `ApiError` so callers keep one error type. It
 * deliberately does *not* replay on 401 — a stream is not safely replayable,
 * and `ensureAccessToken()` has already refreshed a stale token before the
 * request goes out.
 */
/** Length of `buffer` that `drain` will have consumed, delimiters included. */
function consumedLength(buffer: string): number {
  const last = buffer.lastIndexOf('\n\n')
  return last === -1 ? 0 : last + 2
}

/**
 * Parses the complete frames in `buffer`.
 *
 * A frame is delimited by a blank line and a network read can end mid-frame,
 * so an unterminated tail is left for the next read — unless `final`, when
 * there will be no next read and the tail is all that is left.
 */
function* drain(buffer: string, final: boolean): Generator<ScribbleEvent> {
  const end = final ? buffer.length : consumedLength(buffer)
  const region = buffer.slice(0, end)
  if (region.length === 0) return

  for (const frame of region.split('\n\n')) {
    const trimmed = frame.trim()
    if (!trimmed.startsWith('data:')) continue

    let event: ScribbleEvent
    try {
      event = JSON.parse(trimmed.slice(5).trim()) as ScribbleEvent
    } catch {
      continue
    }

    if (event.type === 'error') {
      throw new ApiError(event.message, { code: event.code, status: 502 })
    }
    yield event
  }
}

/** The previous turn's filters, so a follow-up narrows rather than restarts. */
export interface ScribbleContext {
  genre: string | null
  kidsAppropriate: boolean
  completed: boolean | null
  search: string | null
}

export async function* streamScribble(
  message: string,
  context?: ScribbleContext | undefined,
  signal?: AbortSignal,
): AsyncGenerator<ScribbleEvent> {
  const token = await ensureAccessToken()

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/ai/scribble/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...readerHeaders(),
      },
      body: JSON.stringify(context ? { message, context } : { message }),
      credentials: 'include',
      ...(signal ? { signal } : {}),
    })
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new ApiError(
      "We couldn't reach the server. Please check your connection and try again.",
      { code: 'network_error', cause },
    )
  }

  // A failure before the first byte is still an ordinary JSON error, because
  // the server does not commit to streaming until retrieval has succeeded.
  if (!response.ok || !response.body) {
    throw await toApiError(response)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        // Flush whatever the decoder was holding, then fall through to parse
        // any last frame the server did not terminate with a blank line.
        buffer += decoder.decode()
        yield* drain(buffer, true)
        break
      }

      // `stream: true` keeps a multi-byte character split across two reads
      // from decoding as two replacement characters.
      buffer += decoder.decode(value, { stream: true })

      const consumed = [...drain(buffer, false)]
      buffer = buffer.slice(consumedLength(buffer))
      yield* consumed
    }
  } finally {
    // Stops the server generating tokens nobody will read when a caller
    // breaks out of the loop or aborts.
    await reader.cancel().catch(() => {})
  }
}
