import { useEffect, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import '../ai/reader-ai.css'

/**
 * The reader's side panel: the one shell every reader panel opens in --
 * Explain, Ask This Book, the highlights list, a highlight's note, beta
 * feedback and a paragraph's comments.
 *
 * Docked to the right of the window on a wide screen, below the reader's top
 * bar, and the chapter slides left to make room (`.reader.has-panel` in
 * `reader.css`), so the passage a panel is about stays in view beside it.
 * These used to be bottom sheets; a sheet covers the lines at the foot of the
 * window, which is where a reader's eye usually is.
 *
 * On a narrow screen there is no room beside the text, so the panel covers
 * the page and its header leads with a Back button instead of a close mark.
 *
 * One panel at a time: the reader page holds which one is open. Escape closes
 * it. The class names are still `explain-sheet*`, the shell's first user's,
 * so the panels' own stylesheets keep working.
 */

interface ReaderPanelProps {
  /** What a screen reader announces the panel as. */
  label: string
  icon: IconName
  /** The heading. Pass `head` instead for something other than a title. */
  title?: ReactNode
  /** Replaces the title with other header content, such as Explain's tabs. */
  head?: ReactNode
  /** Buttons beside the close mark, such as a highlight's Quote card. */
  actions?: ReactNode
  className?: string
  onClose: () => void
  /** The body: an `.explain-sheet__body`, and anything below it. */
  children: ReactNode
}

export function ReaderPanel({
  label,
  icon,
  title,
  head,
  actions,
  className,
  onClose,
  children,
}: ReaderPanelProps) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className={cn('explain-sheet', className)} role="dialog" aria-label={label}>
      <div className="explain-sheet__inner">
        <div className="explain-sheet__head">
          <Button
            variant="ghost"
            size="sm"
            className="explain-sheet__back"
            onClick={onClose}
            startIcon={<Icon name="chevron-left" size="1rem" />}
          >
            Back
          </Button>
          <Icon name={icon} className="explain-sheet__mark" size="0.95rem" />
          {head ?? <h2 className="explain-sheet__title">{title}</h2>}
          {actions}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            className="explain-sheet__close"
            aria-label="Close"
            onClick={onClose}
            startIcon={<Icon name="close" size="1rem" />}
          />
        </div>
        {children}
      </div>
    </aside>
  )
}
