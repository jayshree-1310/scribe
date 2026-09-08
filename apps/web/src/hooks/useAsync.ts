import { useCallback, useEffect, useRef, useState } from 'react'

export type AsyncStatus = 'loading' | 'ready' | 'error'

export interface AsyncState<T> {
  data: T | null
  status: AsyncStatus
  error: string | null
  /** Re-runs the loader. */
  reload: () => void
}

interface Snapshot<T> {
  /** Identifies the request these results belong to. */
  key: string
  data: T | null
  status: AsyncStatus
  error: string | null
}

function messageFor(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : 'Something went wrong. Please try again.'
}

/**
 * Runs an async loader and exposes loading / ready / error for the UI.
 *
 * `deps` behaves like an effect dependency list. The reset back to `loading`
 * happens during render when those inputs change — the pattern React
 * recommends for state derived from props — so results from a superseded
 * request can never be shown.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[] = [],
): AsyncState<T> {
  const [attempt, setAttempt] = useState(0)
  const key = `${attempt}:${JSON.stringify(deps)}`

  const [state, setState] = useState<Snapshot<T>>({
    key,
    data: null,
    status: 'loading',
    error: null,
  })

  if (state.key !== key) {
    setState({ key, data: null, status: 'loading', error: null })
  }

  // Hold the newest loader without touching the ref during render. Declared
  // before the fetching effect so it has already run by the time that fires.
  const loaderRef = useRef(loader)
  useEffect(() => {
    loaderRef.current = loader
  })

  useEffect(() => {
    let active = true

    loaderRef
      .current()
      .then((result) => {
        if (active) setState({ key, data: result, status: 'ready', error: null })
      })
      .catch((cause: unknown) => {
        if (active) {
          setState({ key, data: null, status: 'error', error: messageFor(cause) })
        }
      })

    return () => {
      active = false
    }
  }, [key])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])

  return { data: state.data, status: state.status, error: state.error, reload }
}
