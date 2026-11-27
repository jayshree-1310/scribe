import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './components/ui/ui.css'
import './components/story/story.css'
import App from './App.tsx'

/**
 * The service worker keeps a copy of the app so Scribe opens offline, where a
 * reader can open the stories they saved (`sw/service-worker.js`). Production
 * builds only: `vite build` writes `sw.js`, and the dev server has none.
 * After `load`, so installing it never competes with the first page for
 * bandwidth.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Unsupported or blocked: Scribe still works online, just not offline.
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
