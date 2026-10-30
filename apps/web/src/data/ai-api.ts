/**
 * AI data access, following `books-api.ts`.
 *
 * The features differ in how much of what they return a model wrote, and the
 * UI has to differ with them. Scribble returns books: everything about them —
 * title, author, description, link — came out of the database, and only
 * `reason` and `intro` were generated. Generation and the writing assistant
 * return material that is *entirely* model-written, which is why nothing they
 * produce is saved until an author acts on it, and why the UI labels all of
 * it. Chat is the bare path underneath all three, for `/ai-lab`.
 */

import {
  AI_REQUEST_TIMEOUT_MS,
  API_BASE_URL,
  ApiError,
  request,
  toApiError,
} from '../lib/api-client'
import { ensureAccessToken, getAccessToken } from '../lib/access-token'
import type { Story, StoryPage } from '../types/stories'

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
  /**
   * The saved chapter being edited. Says only where in the story the passage
   * is, so the story bible knows what has already happened; the prose still
   * travels in `text`.
   */
  chapterId?: string | null
}

export type AssistEvent =
  | { type: 'text'; text: string }
  /**
   * The cleaned whole. A wrapper can only be recognised once it has closed.
   * `facts` is how many story-bible facts the model was shown; 0 for a story
   * with no bible.
   */
  | { type: 'done'; text: string; facts?: number }
  | { type: 'error'; code: string; message: string }

export async function assist(
  payload: AssistPayload,
  signal?: AbortSignal,
): Promise<{ action: AssistAction; text: string; facts: number }> {
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

/* Story bible ------------------------------------------------------------- */

export type FactKind = 'character' | 'location' | 'relationship' | 'event'

/** `extracted` is a model's reading of a chapter; `author` is the author's own. */
export type FactOrigin = 'extracted' | 'author'

export interface StoryFact {
  id: string
  kind: FactKind
  subject: string
  attribute: string
  value: string
  /** For a relationship, the other person. */
  related: string | null
  /** The chapter's own words for it; null for a fact the author typed in. */
  quote: string | null
  origin: FactOrigin
  chapterId: string | null
  chapterNumber: number | null
  chapterTitle: string | null
  updatedAt: string | null
}

/**
 * - `missing`: never read.
 * - `stale`: read, but the text has changed since.
 * - `current`: what is stored is a reading of what is there now.
 */
export type ChapterBibleState = 'missing' | 'stale' | 'current'

export interface ChapterBibleStatus {
  chapterId: string
  chapterNumber: number
  title: string
  state: ChapterBibleState
  factCount: number
  /** Facts the model offered that the chapter does not actually say. */
  droppedCount: number
  /** The chapter was longer than an extraction reads. */
  truncated: boolean
  extractedAt: string | null
}

export interface StoryBible {
  storyId: string
  chapters: ChapterBibleStatus[]
  /** Chapters a refresh would read. */
  pending: number
  facts: StoryFact[]
}

export interface BibleRefresh {
  processed: {
    chapterId: string
    chapterNumber: number
    unchanged: boolean
    facts: number
    dropped: number
    truncated: boolean
  }[]
  bible: StoryBible
}

export interface FactDraft {
  kind: FactKind
  subject: string
  attribute: string
  value: string
  related?: string | null
  /** The chapter it is true from; omit for the whole story. */
  chapterId?: string | null
}

/** Never calls a model, so it is safe to request on every open. */
export async function getStoryBible(
  storyId: string,
  signal?: AbortSignal,
): Promise<StoryBible> {
  return request<StoryBible>(`/ai/bible/${storyId}`, {
    headers: readerHeaders(),
    ...(signal ? { signal } : {}),
  })
}

/**
 * Reads the next chapter that needs it. Call until `bible.pending` is 0: one
 * chapter per request keeps each short and lets a page show its progress.
 */
export async function refreshStoryBible(
  storyId: string,
  signal?: AbortSignal,
): Promise<BibleRefresh> {
  return request<BibleRefresh>(`/ai/bible/${storyId}/refresh`, {
    method: 'POST',
    headers: readerHeaders(),
    body: { limit: 1 },
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
}

export async function addStoryFact(
  storyId: string,
  draft: FactDraft,
): Promise<StoryFact> {
  const { fact } = await request<{ fact: StoryFact }>(
    `/ai/bible/${storyId}/facts`,
    { method: 'POST', headers: readerHeaders(), body: draft },
  )
  return fact
}

/** Correcting a fact makes it the author's: it then survives re-reading. */
export async function updateStoryFact(
  factId: string,
  patch: Partial<Omit<FactDraft, 'chapterId'>>,
): Promise<StoryFact> {
  const { fact } = await request<{ fact: StoryFact }>(
    `/ai/bible/facts/${factId}`,
    { method: 'PATCH', headers: readerHeaders(), body: patch },
  )
  return fact
}

export async function removeStoryFact(factId: string): Promise<void> {
  await request<void>(`/ai/bible/facts/${factId}`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}

/* Continuity --------------------------------------------------------------- */

export type ContinuityKind =
  | 'attribute'
  | 'whereabouts'
  | 'timeline'
  | 'death'
  | 'relationship'
  | 'other'

export interface ContinuityFinding {
  id: string
  kind: ContinuityKind
  /** Generated: one sentence on what does not add up. */
  explanation: string
  /** 0-100. */
  confidence: number
  /** What this chapter says. */
  claim: { subject: string; attribute: string; value: string; quote: string }
  /** What the rest of the story says, and where. */
  fact: {
    subject: string
    attribute: string
    value: string
    quote: string | null
    origin: FactOrigin
    chapterId: string | null
    chapterNumber: number | null
    chapterTitle: string | null
  }
  createdAt: string | null
}

export interface ChapterContinuity {
  chapterId: string
  /** False when the story has no bible yet, or checks are switched off. */
  enabled: boolean
  check: {
    outcome: 'ok' | 'failed'
    checkedAt: string | null
    /** The chapter has changed since it was checked. */
    stale: boolean
    compared: number
  } | null
  findings: ContinuityFinding[]
}

/** The last check's findings. Never calls a model. */
export async function getChapterContinuity(
  chapterId: string,
  signal?: AbortSignal,
): Promise<ChapterContinuity> {
  return request<ChapterContinuity>(`/ai/continuity/chapters/${chapterId}`, {
    headers: readerHeaders(),
    ...(signal ? { signal } : {}),
  })
}

/** Checks the saved chapter now rather than a minute after the last save. */
export async function checkChapterContinuity(
  chapterId: string,
  signal?: AbortSignal,
): Promise<ChapterContinuity> {
  return request<ChapterContinuity>(
    `/ai/continuity/chapters/${chapterId}/check`,
    {
      method: 'POST',
      headers: readerHeaders(),
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    },
  )
}

/** One chapter's line in the story-wide view. Mirrors `services/ai/continuity.ts`. */
export interface ChapterContinuityCount {
  chapterId: string
  chapterNumber: number
  title: string
  /** Open findings: raised and not dismissed. */
  findings: number
  /** Changed since its last check. */
  stale: boolean
}

export interface StoryContinuity {
  storyId: string
  enabled: boolean
  total: number
  chapters: ChapterContinuityCount[]
}

/** Where a story's open findings are, chapter by chapter. Never calls a model. */
export async function getStoryContinuity(
  storyId: string,
  signal?: AbortSignal,
): Promise<StoryContinuity> {
  return request<StoryContinuity>(`/ai/continuity/stories/${storyId}`, {
    headers: readerHeaders(),
    ...(signal ? { signal } : {}),
  })
}

/** Open findings per story, for every story of the caller's that has any. */
export async function countContinuityFindings(
  signal?: AbortSignal,
): Promise<{ storyId: string; findings: number }[]> {
  const body = await request<{ stories: { storyId: string; findings: number }[] }>(
    '/ai/continuity/stories',
    { headers: readerHeaders(), ...(signal ? { signal } : {}) },
  )
  return body.stories
}

/** "Not a mistake": this pair of claims is never raised again. */
export async function dismissContinuityFinding(findingId: string): Promise<void> {
  await request<void>(`/ai/continuity/findings/${findingId}/dismiss`, {
    method: 'POST',
    headers: readerHeaders(),
  })
}

/* Reader: recap ---------------------------------------------------------- */

export interface ChapterRecap {
  /** The chapter recapped — the one *before* the one being read. */
  chapterNumber: number
  chapterTitle: string
  /** Generated. Always labelled as such in the UI. */
  text: string
  generatedAt: string | null
  /** The chapter was long enough to be cut before summarising. */
  truncated: boolean
}

export interface RecapStatus {
  /**
   * False when there is no previous chapter this reader can open — the first
   * chapter of a story, or the first one visible to them. The card is not
   * rendered at all, rather than rendered empty.
   */
  available: boolean
  /** Null until somebody has generated it. */
  recap: ChapterRecap | null
}

/**
 * What to show above a chapter. Never calls a model, so it is safe to request
 * on every chapter open.
 */
export async function getRecap(
  slugOrId: string,
  chapterNumber: number,
  signal?: AbortSignal,
): Promise<RecapStatus> {
  return request<RecapStatus>(
    `/ai/recap/${encodeURIComponent(slugOrId)}/${chapterNumber}`,
    {
      headers: readerHeaders(),
      ...(signal ? { signal } : {}),
    },
  )
}

/**
 * Writes the recap, or returns the one somebody already generated.
 *
 * Behind a button rather than automatic: this is the call that can occupy a
 * CPU core for half a minute, and a reader working straight through a serial
 * has not forgotten anything and should not pay for it.
 */
export async function generateRecap(
  slugOrId: string,
  chapterNumber: number,
  signal?: AbortSignal,
): Promise<RecapStatus> {
  return request<RecapStatus>(
    `/ai/recap/${encodeURIComponent(slugOrId)}/${chapterNumber}`,
    {
      method: 'POST',
      headers: readerHeaders(),
      // A whole chapter through a local CPU model; the shared 15s default
      // would abort every one of them.
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    },
  )
}

/* Reader: explain -------------------------------------------------------- */

export type ExplainMode = 'explain' | 'simplify' | 'define'

/**
 * Offsets into the stored chapter, never the text itself.
 *
 * The server slices the passage out of the chapter it looks up, which is what
 * stops this endpoint being a general-purpose model proxy — and means the
 * client has to send offsets that match the published body, not whatever the
 * DOM happened to hold.
 */
export interface ExplainPayload {
  chapterId: string
  start: number
  end: number
  mode: ExplainMode
}

export type ExplainEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; tokensUsed: number }
  | { type: 'error'; code: string; message: string }

export function streamExplain(
  payload: ExplainPayload,
  signal?: AbortSignal,
): AsyncGenerator<ExplainEvent> {
  return streamRequest<ExplainEvent>('/ai/explain/stream', payload, signal)
}

/* Reader: ask this book -------------------------------------------------- */

/**
 * A passage an answer leans on. `quote` is read out of the stored chapter, so
 * it is the author's words — only the *choice* of passage came from a model.
 */
export interface AskCitation {
  /** The `[n]` the answer uses for it. */
  marker: number
  chapterId: string
  chapterNumber: number
  chapterTitle: string
  quote: string
}

/** Where the spoiler bound came from; see `AskScopeBasis` in `services/ai/ask-book.ts`. */
export type AskScopeBasis = 'request' | 'progress' | 'start' | 'author'

export interface AskScope {
  /** Null means the whole story. */
  upToChapter: number | null
  basis: AskScopeBasis
}

export interface AskBookPayload {
  /** Slug or id. */
  storyId: string
  question: string
  /** Omit to let the server use the reader's saved position. */
  upToChapter?: number
}

export type AskBookEvent =
  | { type: 'text'; text: string }
  | {
      type: 'done'
      /** False when nothing in range covered the question and no model was asked. */
      answerable: boolean
      citations: AskCitation[]
      scope: AskScope
      tokensUsed: number
    }
  | { type: 'error'; code: string; message: string }

/** The answer as it is written, then its citations on the terminal event. */
export function streamAskBook(
  payload: AskBookPayload,
  signal?: AbortSignal,
): AsyncGenerator<AskBookEvent> {
  return streamRequest<AskBookEvent>('/ai/ask/stream', payload, signal)
}

/* Reader: conversations -------------------------------------------------- */

/**
 * Ask This Book with memory. Each turn's question is rewritten on the server
 * to stand alone before it is searched with — "what happened after that?"
 * becomes something retrieval can use — and `standaloneQuestion` reports what
 * it became, so the reader can see what was actually looked for.
 */
export interface ConversationSummary {
  id: string
  storyId: string
  /** The opening question; empty until one has been asked. */
  title: string
  createdAt: string
  updatedAt: string
}

export interface ConversationMessage {
  id: string
  ordinal: number
  role: 'user' | 'assistant'
  content: string
  standaloneQuestion: string | null
  answerable: boolean
  scope: AskScope | null
  citations: AskCitation[]
  createdAt: string
}

export interface Conversation extends ConversationSummary {
  messages: ConversationMessage[]
}

export type ConversationEvent =
  | { type: 'text'; text: string }
  | {
      type: 'done'
      questionId: string
      answerId: string
      standaloneQuestion: string | null
      answerable: boolean
      citations: AskCitation[]
      /** Null when the turn was a pleasantry and nothing was searched. */
      scope: AskScope | null
      tokensUsed: number
    }
  | { type: 'error'; code: string; message: string }

export async function startConversation(
  storyId: string,
): Promise<ConversationSummary> {
  return request<ConversationSummary>('/ai/conversations', {
    method: 'POST',
    headers: readerHeaders(),
    body: { storyId },
  })
}

export async function listConversations(
  storyId: string,
  signal?: AbortSignal,
): Promise<{ items: ConversationSummary[] }> {
  return request<{ items: ConversationSummary[] }>('/ai/conversations', {
    headers: readerHeaders(),
    query: { storyId },
    ...(signal ? { signal } : {}),
  })
}

export async function getConversation(
  id: string,
  signal?: AbortSignal,
): Promise<Conversation> {
  return request<Conversation>(`/ai/conversations/${encodeURIComponent(id)}`, {
    headers: readerHeaders(),
    ...(signal ? { signal } : {}),
  })
}

export async function deleteConversation(id: string): Promise<void> {
  await request<null>(`/ai/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: readerHeaders(),
  })
}

/** One turn: the answer as it is written, then its citations and rewrite. */
export function streamConversationMessage(
  conversationId: string,
  payload: {
    content: string
    upToChapter?: number
    /** A question to ask this in place of, with everything after it. */
    replaceFrom?: string
  },
  signal?: AbortSignal,
): AsyncGenerator<ConversationEvent> {
  return streamRequest<ConversationEvent>(
    `/ai/conversations/${encodeURIComponent(conversationId)}/messages`,
    payload,
    signal,
  )
}

/* Chat ------------------------------------------------------------------- */

/**
 * The plain prompt-in, reply-out path, plus what it cost.
 *
 * Only `/ai-lab` uses it. It is kept because it is the one AI call with
 * nothing around it — no retrieval, no schema, no window — so it is where a
 * provider swap, a model change or a timeout gets diagnosed before the blame
 * lands on a feature.
 */
export interface ChatUsage {
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Measured at the provider, so it excludes this app's own overhead. */
  durationMs: number
}

export interface ChatReply {
  text: string
  usage: ChatUsage
}

export type ChatEvent =
  | { type: 'text'; text: string }
  /** Exactly one, last. A stream that ends without it failed. */
  | { type: 'done'; usage: ChatUsage }
  | { type: 'error'; code: string; message: string }

export async function chat(
  prompt: string,
  signal?: AbortSignal,
): Promise<ChatReply> {
  return request<ChatReply>('/ai/chat', {
    method: 'POST',
    headers: readerHeaders(),
    body: { prompt },
    // A local CPU model takes tens of seconds; the shared 15s default would
    // abort every call.
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
}

/* Assistant with tools --------------------------------------------------- */

/**
 * One lookup the assistant chose to make. `arguments` are what the model
 * asked for (as validated), so the trace shows its reasoning as well as its
 * result.
 */
export interface AgentStep {
  tool: string
  arguments: unknown
  /** `skipped`: the request's lookup cap had been reached, so it did not run. */
  outcome: 'ok' | 'invalid' | 'refused' | 'error' | 'skipped'
  code?: string
  durationMs: number
}

/**
 * An edit the assistant proposed to the author's own chapter. Nothing has been
 * changed: the editor applies it only if the author accepts, and only if
 * `quote` still occurs exactly once in what they have open.
 */
export interface EditProposal {
  id: string
  chapterId: string
  chapterNumber: number
  quote: string
  /** Generated. Empty when the proposal is to remove the quote. */
  replacement: string
  reason: string
}

export interface AgentAnswer {
  /** Generated, from what the tools returned. */
  answer: string
  /** Always empty unless the story asked about is the caller's own. */
  proposals: EditProposal[]
  steps: AgentStep[]
  stoppedBy: 'answered' | 'tool_limit' | 'model_call_limit' | 'token_budget'
  modelCalls: number
  tokensUsed: number
}

/** One earlier question and its answer, oldest first: the assistant's memory. */
export interface AgentExchange {
  question: string
  answer: string
}

/**
 * What the server accepts as memory, mirroring `HISTORY_LIMIT` and
 * `HISTORY_ANSWER_LIMIT` in `services/ai/agent.ts`.
 */
export const AGENT_HISTORY_LIMIT = 6
export const AGENT_HISTORY_ANSWER_LIMIT = 2_000

/**
 * The streamed assistant: each lookup as it starts and as it finishes, then
 * the answer whole. Mirrors `AgentEvent` in `services/ai/agent.ts`.
 */
export type AgentEvent =
  | { type: 'lookup'; tool: string }
  | { type: 'step'; step: AgentStep }
  | ({ type: 'done' } & AgentAnswer)

export async function* streamAgent(
  message: string,
  storyId: string | null,
  history: AgentExchange[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  yield* streamRequest<AgentEvent>('/ai/agent/stream', { message, storyId, history }, signal)
}

export async function askAgent(
  message: string,
  storyId: string | null,
  signal?: AbortSignal,
): Promise<AgentAnswer> {
  return request<AgentAnswer>('/ai/agent', {
    method: 'POST',
    headers: readerHeaders(),
    body: { message, storyId },
    // Several model calls with lookups between them.
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
}

export function streamChat(
  prompt: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  return streamRequest<ChatEvent>('/ai/chat/stream', { prompt }, signal)
}

/* Search ----------------------------------------------------------------- */

/**
 * A passage quoted under a search result.
 *
 * The author's own words, read out of the stored chapter — nothing here was
 * generated. What the model contributed is only the *choice* of passage: it is
 * the one whose meaning sat nearest the query.
 */
export interface SearchPassage {
  chapterId: string
  chapterNumber: number
  chapterTitle: string
  excerpt: string
  similarity: number
}

/** Where a result came from; see `SearchMatch` in `services/ai/search.ts`. */
export interface SearchMatch {
  keywordRank: number | null
  semanticRank: number | null
  score: number
}

export interface SearchResult extends Story {
  passages: SearchPassage[]
  match: SearchMatch | null
}

/**
 * What actually ran. `keyword` means meaning search was asked for and the
 * server could not reach its embedder, so the page should say so rather than
 * present title matches as the usual results.
 */
export type SearchBasis = 'list' | 'hybrid' | 'semantic' | 'keyword'

export interface SearchPage extends StoryPage {
  items: SearchResult[]
  basis: SearchBasis
}

export interface SearchFilters {
  q: string
  genreId?: string | null
  mode?: 'hybrid' | 'semantic'
  page?: number
  limit?: number
}

/**
 * Hybrid search over Scribe stories: title and author, and what their
 * chapters are about. Same page shape as `listStories`, so the result renders
 * with the components that already draw story lists.
 */
export async function searchStories(
  filters: SearchFilters,
  signal?: AbortSignal,
): Promise<SearchPage> {
  return request<SearchPage>('/ai/search', {
    headers: readerHeaders(),
    query: {
      q: filters.q.trim(),
      genreId: filters.genreId ?? undefined,
      mode: filters.mode,
      // Authored stories only: the catalogue grid below has its own search.
      source: 'SCRIBE',
      page: filters.page === undefined ? undefined : String(filters.page),
      limit: filters.limit === undefined ? undefined : String(filters.limit),
    },
    ...(signal ? { signal } : {}),
  })
}

/* Administration: spend --------------------------------------------------- */

/** One row of the spend view; see `services/ai/spend.ts`. */
export interface SpendLine {
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  /** Input tokens the provider served from its prompt cache, when it says. */
  cachedTokens: number
  avgDurationMs: number
  p50DurationMs: number
  p95DurationMs: number
  /** Null unless the server has prices configured. */
  costUsd: number | null
}

export type SpendWindow = 1 | 7 | 30

export interface SpendReport {
  days: SpendWindow
  priced: boolean
  total: SpendLine
  platform: SpendLine
  byFeature: (SpendLine & { feature: string; kind: string })[]
  byModel: (SpendLine & { model: string; provider: string })[]
  topCallers: (SpendLine & { userId: string; username: string | null })[]
}

/** Administrators only; anybody else gets a 403. */
export async function getSpend(days: SpendWindow): Promise<SpendReport> {
  return request<SpendReport>('/ai/admin/spend', {
    headers: readerHeaders(),
    query: { days: String(days) },
  })
}

/* Story summaries ---------------------------------------------------------- */

/** One paragraph of "the story so far". Generated; always labelled as such. */
export interface StorySummary {
  text: string
  upToChapter: number
  /** `story`: every published chapter. `spoiler_free`: it stops earlier. */
  kind: 'story' | 'spoiler_free'
  chapterCount: number
  generatedAt: string | null
}

export interface StorySummaryStatus {
  available: boolean
  scope: { upToChapter: number | null; basis: 'request' | 'progress' | 'start' | 'author' }
  summary: StorySummary | null
  /** The server queued it; ask again in a few seconds. */
  generating: boolean
}

/** Never calls a model: a missing summary is queued and reported as generating. */
export async function getStorySummary(
  storyKey: string,
  upToChapter?: number | null,
): Promise<StorySummaryStatus> {
  return request<StorySummaryStatus>(`/ai/summaries/story/${encodeURIComponent(storyKey)}`, {
    headers: readerHeaders(),
    ...(upToChapter ? { query: { upToChapter: String(upToChapter) } } : {}),
  })
}

/** The author's Regenerate. Answers with a background job id. */
export async function regenerateStorySummary(storyId: string): Promise<{ jobId: string }> {
  return request<{ jobId: string }>(`/ai/summaries/story/${encodeURIComponent(storyId)}/regenerate`, {
    method: 'POST',
    headers: readerHeaders(),
  })
}
