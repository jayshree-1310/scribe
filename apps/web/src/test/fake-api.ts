/**
 * A stand-in for the Scribe API at the one seam every request crosses:
 * `fetch`.
 *
 * Faking here rather than mocking `data/*` modules means a test drives the
 * real `api-client` -- the token bootstrap, the refresh-and-replay, the error
 * normalising -- and the real data module above it, which is where a browser
 * would find the bugs. Routes are matched on method and path, the API's own
 * paths without the `/api` prefix, with `:name` matching one segment. A
 * request nothing answers is a 501 that names it and is kept in `unhandled`,
 * so a test that forgot a route fails on what it forgot rather than on an
 * empty list.
 */

import { vi } from 'vitest'

export interface FakeRequest {
  method: string
  path: string
  query: URLSearchParams
  /** The `:name` segments of the route that answered. */
  params: Record<string, string>
  headers: Headers
  body: unknown
}

/** What a handler answers: a `Response`, or a plain body sent as 200 JSON. */
type Handler = (request: FakeRequest) => Response | unknown | Promise<Response | unknown>

export interface FakeApi {
  /** Answers `METHOD /path`. A later registration for the same route wins. */
  on: (route: string, handler: Handler) => FakeApi
  /** Every request, in the order sent. */
  calls: FakeRequest[]
  /** Requests no route answered. */
  unhandled: FakeRequest[]
  /** The calls to one route. */
  callsTo: (route: string) => FakeRequest[]
}

/** The route's `:name` segments, or null when `path` is not this route's. */
function match(route: string, method: string, path: string): Record<string, string> | null {
  const [routeMethod, routePath = ''] = route.split(' ')
  if (routeMethod !== method) return null
  const want = routePath.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return null

  const params: Record<string, string> = {}
  for (const [index, segment] of want.entries()) {
    const actual = got[index] ?? ''
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(actual)
    else if (segment !== actual) return null
  }
  return params
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The API's error envelope (`apps/api/src/lib/http-error.ts`). */
export function apiError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } })
}

/** Installs the fake as `fetch` for the current test. */
export function fakeApi(): FakeApi {
  const routes = new Map<string, Handler>()
  const calls: FakeRequest[] = []
  const unhandled: FakeRequest[] = []

  const api: FakeApi = {
    on(route, handler) {
      routes.delete(route)
      routes.set(route, handler)
      return api
    },
    calls,
    unhandled,
    callsTo: (route) => calls.filter((call) => match(route, call.method, call.path) !== null),
  }

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://scribe.test')
    const text = typeof init.body === 'string' ? init.body : null
    const request: FakeRequest = {
      method: init.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, ''),
      query: url.searchParams,
      params: {},
      headers: new Headers(init.headers),
      body: text === null ? init.body : JSON.parse(text),
    }
    calls.push(request)

    // Newest first, so a test can override one route of a shared setup.
    const found = [...routes].reverse().find(([route]) => {
      const params = match(route, request.method, request.path)
      if (params) request.params = params
      return params !== null
    })
    const handler = found?.[1]
    if (!handler) {
      unhandled.push(request)
      return apiError(501, 'not_faked', `No fake for ${request.method} ${request.path}`)
    }

    const answer = await handler(request)
    return answer instanceof Response ? answer : json(200, answer)
  })

  return api
}
