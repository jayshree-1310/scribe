/**
 * AI data access, following `books-api.ts`.
 *
 * Two features live here. Scribble returns books: everything about them —
 * title, author, description, link — came out of the database, and only
 * `reason` and `intro` were generated. Generation returns material that is
 * *entirely* model-written, which is why nothing it produces is saved until an
 * author acts on it, and why the UI labels all of it.
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
function* drain<T extends { type: string }>(
  buffer: string,
  final: boolean,
): Generator<T> {
  const end = final ? buffer.length : consumedLength(buffer)
  const region = buffer.slice(0, end)
  if (region.length === 0) return

  for (const frame of region.split('\n\n')) {
    const trimmed = frame.trim()
    if (!trimmed.startsWith('data:')) continue

    let event: T
    try {
      event = JSON.parse(trimmed.slice(5).trim()) as T
    } catch {
      continue
    }

    /**
     * A failure the server could only report in-band, because the status line
     * was already out. Raised as the same `ApiError` a non-streamed call would
     * have produced, so a caller has one error type either way.
     */
    if (event.type === 'error') {
      const failure = event as unknown as { code: string; message: string }
      throw new ApiError(failure.message, { code: failure.code, status: 502 })
    }
    yield event
  }
}

/**
 * Reads an SSE endpoint, yielding its events.
 *
 * Cannot go through `request()`, which always ends in `response.json()`, so
 * this repeats the parts it must: the bearer token, the dev reader header, and
 * turning any failure into an `ApiError` so callers keep one error type. It
 * deliberately does *not* replay on 401 — a stream is not safely replayable,
 * and `ensureAccessToken()` has already refreshed a stale token before the
 * request goes out.
 *
 * Shared by every streamed AI feature rather than copied per feature: the
 * chunk-boundary handling below is the part that is wrong intermittently when
 * it is wrong, which is the worst way for a parser to be wrong twice.
 */
export async function* streamRequest<T extends { type: string }>(
  path: string,
  payload: unknown,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const token = await ensureAccessToken()

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...readerHeaders(),
      },
      body: JSON.stringify(payload),
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
  // the server does not commit to streaming until its first event.
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
        // Flush whatever the decoder was holding, then parse any last frame
        // the server did not terminate with a blank line.
        buffer += decoder.decode()
        yield* drain<T>(buffer, true)
        break
      }

      // `stream: true` keeps a multi-byte character split across two reads
      // from decoding as two replacement characters.
      buffer += decoder.decode(value, { stream: true })

      const consumed = [...drain<T>(buffer, false)]
      buffer = buffer.slice(consumedLength(buffer))
      yield* consumed
    }
  } finally {
    // Stops the server generating tokens nobody will read when a caller
    // breaks out of the loop or aborts.
    await reader.cancel().catch(() => {})
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
  yield* streamRequest<ScribbleEvent>(
    '/ai/scribble/stream',
    context ? { message, context } : { message },
    signal,
  )
}

/* Generation ------------------------------------------------------------- */

export type GenerationKind = 'idea' | 'character' | 'outline'

export interface StoryIdea {
  title: string
  premise: string
  genre: string
  characters: { name: string; role: string }[]
  conflict: string
  setting: string
  ending: string
}

export interface CharacterProfile {
  name: string
  role: string
  personality: string
  motivations: string[]
  strengths: string[]
  weaknesses: string[]
  relationships: { name: string; relationship: string }[]
}

export interface ChapterOutline {
  title: string
  summary: string
  scenes: { title: string; summary: string }[]
  characters: string[]
  conflict: string
  endingHook: string
}

export type GeneratedValue = StoryIdea | CharacterProfile | ChapterOutline

export interface GenerationSeed {
  genre?: string | null
  theme?: string | null
  premise?: string | null
  /** One of the caller's own stories; the API asserts ownership. */
  storyId?: string | null
}

export interface GenerationResult {
  /**
   * The server-side conversation these came from. Refinement sends this back
   * rather than the object, so the model revises what it actually wrote.
   */
  sessionId: string
  kind: GenerationKind
  variants: GeneratedValue[]
  expiresInSeconds: number
}

export interface RefinementResult {
  sessionId: string
  kind: GenerationKind
  index: number
  value: GeneratedValue
  expiresInSeconds: number
}

/** `count` is capped server-side: every alternative is another model call. */
export async function generate(
  kind: GenerationKind,
  seed: GenerationSeed,
  count = 1,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  return request<GenerationResult>(`/ai/generate/${kind}`, {
    method: 'POST',
    headers: readerHeaders(),
    body: { seed, count },
    // Up to three sequential completions on a local CPU model. The shared 15s
    // default would abort the first one.
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
}

export async function refineGeneration(
  sessionId: string,
  index: number,
  instruction: string,
  signal?: AbortSignal,
): Promise<RefinementResult> {
  return request<RefinementResult>('/ai/generate/refine', {
    method: 'POST',
    headers: readerHeaders(),
    body: { sessionId, index, instruction },
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
}

/* Writing assistant ------------------------------------------------------ */

export type AssistAction =
  | 'improve'
  | 'rewrite'
  | 'grammar'
  | 'tone'
  | 'shorten'
  | 'expand'
  | 'alternatives'
  | 'continue'

export interface AssistPayload {
  action: AssistAction
  /** The selection, or — for `continue` — the prose before the caret. */
  text: string
  /** Surrounding prose for voice and continuity; the server bounds it. */
  before?: string
  after?: string
  tone?: string | null
  /** Null while a story has never been saved and so has no id yet. */
  storyId?: string | null
}

export type AssistEvent =
  | { type: 'text'; text: string }
  /** The cleaned whole. A wrapper can only be recognised once it has closed. */
  | { type: 'done'; text: string }
  | { type: 'error'; code: string; message: string }

export async function assist(
  payload: AssistPayload,
  signal?: AbortSignal,
): Promise<{ action: AssistAction; text: string }> {
  return request('/ai/assist', {
    method: 'POST',
    headers: readerHeaders(),
    body: payload,
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
}

export function streamAssist(
  payload: AssistPayload,
  signal?: AbortSignal,
): AsyncGenerator<AssistEvent> {
  return streamRequest<AssistEvent>('/ai/assist/stream', payload, signal)
}
