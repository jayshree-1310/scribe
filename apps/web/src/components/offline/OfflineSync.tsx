import { useEffect } from 'react'
import { useAuth } from '../../lib/auth'
import { useToast } from '../../lib/toast'
import { flushPending, refreshSavedStories } from '../../lib/offline'

/**
 * Keeps offline copies honest while the reader is online: on load and each
 * time the connection comes back, sends the reads and positions queued
 * offline, then checks saved stories for new, edited and withdrawn chapters
 * (`lib/offline.ts`). A story that can no longer be read is deleted from the
 * device, and the reader is told which.
 *
 * Renders nothing; it sits beside the router so it runs on every page.
 */
export function OfflineSync() {
  const { session } = useAuth()
  const { showToast } = useToast()
  const userId = session?.user.id ?? null

  useEffect(() => {
    if (!userId) return
    let active = true

    const sync = async (reconnected: boolean) => {
      await flushPending()
      const { removed } = await refreshSavedStories({ reconnected })
      if (!active) return
      for (const title of removed) {
        showToast({
          message: `“${title}” is no longer available, so its offline copy was removed.`,
        })
      }
    }

    void sync(false)
    const onOnline = () => void sync(true)
    window.addEventListener('online', onOnline)
    return () => {
      active = false
      window.removeEventListener('online', onOnline)
    }
  }, [userId, showToast])

  return null
}
