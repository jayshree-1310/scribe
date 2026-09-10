import { useEffect, useId, useRef } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { Button } from './Button'
import { Icon } from './Icon'

interface LightboxProps {
  open: boolean
  onClose: () => void
  src: string
  /** Describes the picture; also the accessible name of the viewer. */
  alt: string
  /** Optional actions under the image, e.g. a link to change the picture. */
  children?: ReactNode
}

/**
 * A picture at its own size, on a dimmed backdrop.
 *
 * Built on the native `<dialog>` for the same reasons as `Dialog` — focus
 * trapping, background inertness and the top layer come from the platform —
 * but deliberately without that component's header and footer chrome: this
 * exists to show one image, and a titled panel around it competes with it.
 */
export function Lightbox({ open, onClose, src, alt, children }: LightboxProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const labelId = `${useId()}-label`

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (!open) return
    // showModal() does not stop the page behind the dialog from scrolling.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  function onBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    // Anywhere but the picture and its actions closes the viewer, which is
    // what people expect of a photo opened full size.
    if (event.target === event.currentTarget) onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="lightbox"
      aria-labelledby={labelId}
      onClick={onBackdropClick}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      <div className="lightbox__panel">
        <Button
          className="lightbox__close"
          variant="ghost"
          iconOnly
          aria-label="Close picture"
          onClick={onClose}
          startIcon={<Icon name="close" />}
        />
        <img className="lightbox__image" id={labelId} src={src} alt={alt} />
        {children ? <div className="lightbox__actions">{children}</div> : null}
      </div>
    </dialog>
  )
}
