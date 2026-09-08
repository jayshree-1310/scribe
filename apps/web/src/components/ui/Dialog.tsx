import { useEffect, useId, useRef, useState } from 'react'
import type { AnimationEvent, MouseEvent, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Button } from './Button'
import { Icon } from './Icon'

type Phase = 'closed' | 'open' | 'closing'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /**
   * When false, Esc and backdrop clicks are ignored — set this while a submit
   * is in flight so a stray click can't discard the user's work.
   */
  dismissible?: boolean
}

/**
 * Built on the native `<dialog>` element, so focus trapping, background
 * inertness and the top layer come from the platform. Esc is intercepted only
 * so the exit animation can play before the element actually closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const id = useId()
  const titleId = `${id}-title`
  const descriptionId = `${id}-description`

  // `closing` keeps the panel mounted for its exit animation. Both values are
  // adjusted during render — the pattern React recommends for state derived
  // from a prop change — rather than inside an effect.
  const [closing, setClosing] = useState(false)
  const [lastOpen, setLastOpen] = useState(open)

  if (lastOpen !== open) {
    setLastOpen(open)
    setClosing(!open)
  }

  const phase: Phase = open ? 'open' : closing ? 'closing' : 'closed'
  const mounted = phase !== 'closed'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || !dialog || dialog.open) return

    dialog.showModal()

    // showModal() focuses the first focusable node, which is the close button.
    // For a dialog that exists to be typed into, put the cursor in the field.
    dialog
      .querySelector<HTMLElement>('.dialog__body input, .dialog__body textarea')
      ?.focus()
  }, [open])

  useEffect(() => {
    if (!mounted) return
    // showModal() does not stop the page behind the dialog from scrolling.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [mounted])

  function onAnimationEnd(event: AnimationEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || phase !== 'closing') return
    dialogRef.current?.close()
    setClosing(false)
  }

  function onBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget && dismissible) onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className={cn('dialog', `dialog--${size}`)}
      data-phase={phase}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClick={onBackdropClick}
      onCancel={(event) => {
        event.preventDefault()
        if (dismissible) onClose()
      }}
    >
      {mounted ? (
        <div className="dialog__panel" onAnimationEnd={onAnimationEnd}>
          <header className="dialog__header">
            <div className="dialog__heading">
              <h2 className="dialog__title" id={titleId}>
                {title}
              </h2>
              {description ? (
                <p className="dialog__description" id={descriptionId}>
                  {description}
                </p>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Close dialog"
              onClick={onClose}
              startIcon={<Icon name="close" />}
            />
          </header>

          <div className="dialog__body">{children}</div>

          {footer ? <footer className="dialog__footer">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  )
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  pending?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  pending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      dismissible={!pending}
      footer={
        <>
          <Button onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="dialog__message">{message}</p>
      {error ? (
        <p className="dialog__error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
