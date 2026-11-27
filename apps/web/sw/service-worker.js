/**
 * Scribe's service worker: keeps a copy of the app itself, so Scribe opens
 * with no connection and a reader can get to the stories they saved for
 * offline reading (those live in IndexedDB; see `src/lib/offline.ts`).
 *
 * This file is a template. `vite.config.ts` (`serviceWorker()`) fills in
 * the two placeholders below after each production build -- every file the
 * build wrote, and a hash of them -- and writes the result to `dist/sw.js`.
 * A new release therefore always changes `sw.js`, which is how the browser
 * notices one; that only works while `sw.js` itself is served uncached
 * (`nginx.conf`, `render.yaml`).
 *
 * What it does and does not touch:
 *
 * - **Pages** (navigations): the network first, so an online reader always
 *   gets the latest release; the saved `index.html` when the network fails
 *   or takes longer than `NAVIGATION_TIMEOUT_MS`. The app routes on the
 *   client, so that one page serves every address.
 * - **The build's own files** (hashed scripts and styles, icons, the
 *   manifest): from the saved copy, falling back to the network.
 * - **Fonts** from Google Fonts: the saved copy while a fresh one is fetched,
 *   so the reading typeface survives offline.
 * - **The API and uploads**: never. Story data is the app's business, and a
 *   stale API answer served as current would be worse than an honest error.
 */

const VERSION = '__SCRIBE_VERSION__'
const PRECACHE = __SCRIBE_PRECACHE__

const SHELL_CACHE = `scribe-shell-${VERSION}`
const FONT_CACHE = 'scribe-fonts-v1'
const NAVIGATION_TIMEOUT_MS = 5000

const PRECACHED = new Set(PRECACHE)

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // `reload` skips the HTTP cache, so the copy is the release just built.
      await cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' })))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((name) => name.startsWith('scribe-shell-') && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return
    if (request.mode === 'navigate') {
      event.respondWith(navigate(request))
      return
    }
    if (PRECACHED.has(url.pathname)) event.respondWith(fromShell(request))
    return
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    const { response, update } = font(request)
    event.respondWith(response)
    // The refresh outlives the response when a saved copy answered first.
    event.waitUntil(update.catch(() => undefined))
  }
})

async function navigate(request) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS)
  try {
    const response = await fetch(request, { signal: controller.signal })
    // A server error is no better than no server; anything else is the answer.
    if (response.status < 500) return response
  } catch {
    // Offline, or too slow: the saved page below.
  } finally {
    clearTimeout(timer)
  }

  const cache = await caches.open(SHELL_CACHE)
  const page = await cache.match('/index.html')
  return page ?? fetch(request)
}

async function fromShell(request) {
  const cache = await caches.open(SHELL_CACHE)
  return (await cache.match(request)) ?? fetch(request)
}

/**
 * The saved copy at once, while a fresh one replaces it for next time. Only
 * CORS responses are kept: `index.html` loads the stylesheet `crossorigin`,
 * because Chrome counts an opaque response against the site's storage as
 * several megabytes, whatever its size.
 */
function font(request) {
  const cache = caches.open(FONT_CACHE)
  const update = Promise.all([cache, fetch(request)]).then(async ([open, response]) => {
    if (response.ok) await open.put(request, response.clone())
    return response
  })
  const response = cache
    .then((open) => open.match(request))
    .then((saved) => saved ?? update)
  return { response, update }
}
