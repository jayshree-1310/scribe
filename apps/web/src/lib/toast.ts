/**
 * Toast context, kept apart from the provider component so that both this
 * module and `ToastProvider.tsx` stay Fast-Refresh friendly.
 */

import { createContext, useContext } from 'react'

export type ToastTone = 'success' | 'error'

export interface ToastOptions {
  message: string
  tone?: ToastTone
}

export interface Toast extends ToastOptions {
  id: string
  tone: ToastTone
}

export interface ToastContextValue {
  showToast: (options: ToastOptions) => void
  dismissToast: (id: string) => void
}

export const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used inside a <ToastProvider>.')
  }
  return context
}
