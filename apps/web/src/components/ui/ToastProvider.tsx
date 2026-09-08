import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ToastContext, type Toast, type ToastOptions } from '../../lib/toast'
import { Button } from './Button'
import { Icon } from './Icon'

const AUTO_DISMISS_MS = 4800
const MAX_VISIBLE = 3

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismissToast = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const showToast = useCallback(
    ({ message, tone = 'success' }: ToastOptions) => {
      const id = crypto.randomUUID()
      setToasts((current) => [...current, { id, message, tone }].slice(-MAX_VISIBLE))
      timers.current.set(
        id,
        setTimeout(() => dismissToast(id), AUTO_DISMISS_MS),
      )
    },
    [dismissToast],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const value = useMemo(() => ({ showToast, dismissToast }), [showToast, dismissToast])

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div className="toast-region" role="region" aria-label="Notifications">
        <ol className="toast-list" aria-live="polite" aria-relevant="additions">
          {toasts.map((toast) => (
            <li key={toast.id} className={`toast toast--${toast.tone}`}>
              <span className="toast__icon" aria-hidden="true">
                <Icon name={toast.tone === 'success' ? 'check-circle' : 'alert'} />
              </span>
              <p className="toast__message">{toast.message}</p>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Dismiss notification"
                onClick={() => dismissToast(toast.id)}
                startIcon={<Icon name="close" />}
              />
            </li>
          ))}
        </ol>
      </div>
    </ToastContext.Provider>
  )
}
