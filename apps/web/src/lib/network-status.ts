/**
 * Whether the browser says it has a network connection.
 *
 * `navigator.onLine` only knows about the device's own link: it is false with
 * the radio off or the cable out, and true on a café's Wi-Fi that reaches
 * nothing. So `false` is reliable and `true` is a hope. The data layer does
 * not rely on it: a story saved for offline reading is served from its copy
 * whenever a request fails to reach the server, whatever this says. What
 * reads it is the UI, which hides what cannot work offline (comments, likes,
 * the AI tools) and says why.
 */

import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/** True unless the browser says it is offline. */
export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/** `isOnline`, re-rendering when the connection comes or goes. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true)
}
