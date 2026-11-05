/**
 * The fetch wrapper every API module goes through: the session bootstrap on a
 * cold load, the refresh-and-replay on a 401, and the errors a person sees.
 *
 * `access-token` holds its state at module scope, so each test loads the
 * modules afresh -- a page load, as far as they can tell.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, fakeApi, json, type FakeApi } from '../test/fake-api'

let api: FakeApi

async function load() {
  vi.resetModules()
  // Registers the refresher `access-token` calls, as the app's import does.
  await import('../data/auth-api')
  return {
    ...(await import('./api-client')),
    ...(await import('./access-token')),
  }
}

const bearer = (call: { headers: Headers }) => call.headers.get('Authorization')

beforeEach(() => {
  api = fakeApi()
})

describe('the session on a cold load', () => {
  it('holds the first requests until the refresh answers, and shares one refresh between them', async () => {
    const { request } = await load()
    api
      .on('POST /auth/refresh', () => ({ accessToken: 'fresh' }))
      .on('GET /library', () => ({ items: [] }))
      .on('GET /stories', () => ({ items: [] }))

    await Promise.all([request('/library'), request('/stories'), request('/library')])

    expect(api.callsTo('POST /auth/refresh')).toHaveLength(1)
    const authed = api.calls.filter((call) => call.path !== '/auth/refresh')
    expect(authed.map(bearer)).toEqual(['Bearer fresh', 'Bearer fresh', 'Bearer fresh'])
  })

  it('sends an anonymous visitor anonymously, and does not ask again', async () => {
    const { request } = await load()
    api
      .on('POST /auth/refresh', () => apiError(401, 'unauthorized', 'No session.'))
      .on('GET /books', () => ({ items: [] }))

    await request('/books')
    await request('/books')

    expect(api.callsTo('POST /auth/refresh')).toHaveLength(1)
    expect(api.callsTo('GET /books').map(bearer)).toEqual([null, null])
  })

  it('never routes signing in through the refresh', async () => {
    const { request } = await load()
    api.on('POST /auth/login', () => ({ accessToken: 'new' }))

    await request('/auth/login', { method: 'POST', body: { email: 'a@b.c', password: 'x' } })

    expect(api.calls.map((call) => call.path)).toEqual(['/auth/login'])
    expect(bearer(api.calls[0]!)).toBeNull()
  })
})

describe('a token that expires mid-session', () => {
  it('is refreshed on the 401 and the request replayed with the new one', async () => {
    const { request, setAccessToken, getAccessToken } = await load()
    setAccessToken('stale')
    api
      .on('POST /auth/refresh', () => ({ accessToken: 'renewed' }))
      .on('GET /library', (call) =>
        bearer(call) === 'Bearer renewed'
          ? { items: ['kept'] }
          : apiError(401, 'unauthorized', 'Sign in to use your library.'),
      )

    await expect(request('/library')).resolves.toEqual({ items: ['kept'] })

    expect(api.callsTo('GET /library').map(bearer)).toEqual(['Bearer stale', 'Bearer renewed'])
    expect(getAccessToken()).toBe('renewed')
  })

  it('is replayed once at most, and then the 401 is the answer', async () => {
    const { request, setAccessToken } = await load()
    setAccessToken('stale')
    api
      .on('POST /auth/refresh', () => ({ accessToken: 'renewed' }))
      .on('GET /library', () => apiError(401, 'unauthorized', 'Sign in to use your library.'))

    const failure = request('/library')

    await expect(failure).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      code: 'unauthorized',
      message: 'Sign in to use your library.',
    })
    expect(api.callsTo('GET /library')).toHaveLength(2)
    expect(api.callsTo('POST /auth/refresh')).toHaveLength(1)
  })

  it('shares one refresh between requests that all come back 401 together', async () => {
    const { request, setAccessToken } = await load()
    setAccessToken('stale')
    api
      .on('POST /auth/refresh', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { accessToken: 'renewed' }
      })
      .on('GET /:list', (call) =>
        bearer(call) === 'Bearer renewed' ? { list: call.params['list'] } : apiError(401, 'unauthorized', 'No.'),
      )

    const answers = await Promise.all([request('/library'), request('/stories'), request('/clubs')])

    expect(answers).toEqual([{ list: 'library' }, { list: 'stories' }, { list: 'clubs' }])
    expect(api.callsTo('POST /auth/refresh')).toHaveLength(1)
  })
})

describe('what a failure says', () => {
  it("is the server's message, code and per-field errors when it sent them", async () => {
    const { request, setAccessToken } = await load()
    setAccessToken('t')
    api.on('POST /stories', () =>
      json(400, {
        error: {
          code: 'validation_error',
          message: 'Some of the details need fixing.',
          details: { title: 'Give the story a title.' },
        },
      }),
    )

    await expect(request('/stories', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 400,
      code: 'validation_error',
      fieldErrors: { title: 'Give the story a title.' },
    })
  })

  it("is a plain message for the status when the body is not the API's", async () => {
    const { request, setAccessToken } = await load()
    setAccessToken('t')
    api.on('GET /stories', () => new Response('<html>Bad gateway</html>', { status: 502 }))

    await expect(request('/stories')).rejects.toMatchObject({
      status: 502,
      message: 'The server got a bad response from a service it depends on.',
    })
  })

  it('is an offline error when the request never reached the server', async () => {
    const { request, setAccessToken } = await load()
    setAccessToken('t')
    api.on('GET /stories', () => {
      throw new TypeError('Failed to fetch')
    })

    const failure = await request('/stories').catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'network_error', isOffline: true })
    expect((failure as Error).message).toMatch(/couldn't reach the server/)
  })

  it('is the caller’s own abort, untouched, when the caller cancelled', async () => {
    const { request, setAccessToken } = await load()
    setAccessToken('t')
    const controller = new AbortController()
    api.on('GET /stories', () => {
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    })

    await expect(request('/stories', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('is a generic message when a 200 is not JSON', async () => {
    const { request, setAccessToken } = await load()
    setAccessToken('t')
    api.on('GET /stories', () => new Response('not json', { status: 200 }))

    await expect(request('/stories')).rejects.toMatchObject({ code: 'invalid_response' })
  })
})
