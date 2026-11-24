import { useMemo, useState } from 'react'
import { useAsync } from '../../hooks/useAsync'
import { useObjectUrl } from '../../lib/object-url'
import { useToast } from '../../lib/toast'
import {
  QUOTE_CARD_STYLES,
  quoteCardAddress,
  quoteCardLink,
  renderQuoteCard,
  type QuoteCardStyle,
} from '../../lib/quote-card'
import { plainQuote, type SavedHighlight } from '../../types/highlights'
import { storyAuthorName, type StoryDetail } from '../../types/stories'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { SegmentedControl } from '../ui/Tabs'
import { Skeleton } from '../ui/Skeleton'
import './quote-card.css'

/**
 * A highlighted passage as an image to share (`lib/quote-card.ts`).
 *
 * The card is drawn here, in the browser, and offered three ways: the
 * system share sheet where the browser can share a file, a download, and the
 * chapter's link on its own. The link opens the chapter for anyone, signed in
 * or not, because only published chapters of a listed story offer a card.
 */

interface QuoteCardDialogProps {
  open: boolean
  onClose: () => void
  /** Kept by the caller after closing, so the card stays up while it animates out. */
  highlight: SavedHighlight | null
  story: Pick<StoryDetail, 'id' | 'slug' | 'title' | 'coverUrl' | 'genres' | 'author'>
}

export function QuoteCardDialog({ open, onClose, highlight, story }: QuoteCardDialogProps) {
  const { showToast } = useToast()
  const [style, setStyle] = useState<QuoteCardStyle>('violet')
  const [sharing, setSharing] = useState(false)

  const authorName = storyAuthorName(story.author)
  const link = highlight
    ? quoteCardLink(window.location.origin, story.slug, highlight.chapterNumber)
    : ''

  /**
   * Not keyed on `open`: the caller keeps the highlight while the dialog
   * animates out, and the card has to stay on screen for that. Reopening the
   * same passage shows the card already drawn.
   */
  const card = useAsync(
    () =>
      highlight
        ? renderQuoteCard({
            quote: highlight.quote,
            storyId: story.id,
            storyTitle: story.title,
            authorName,
            coverUrl: story.coverUrl,
            hue: story.genres[0]?.hue ?? 268,
            chapterNumber: highlight.chapterNumber,
            chapterTitle: highlight.chapterTitle,
            address: quoteCardAddress(link),
            style,
          })
        : Promise.resolve(null),
    [
      highlight?.id,
      highlight?.quote,
      highlight?.chapterTitle,
      story.id,
      story.title,
      story.coverUrl,
      authorName,
      style,
      link,
    ],
  )

  const blob = card.data?.blob ?? null
  const preview = useObjectUrl(blob)

  /**
   * The image as a file for the share sheet, when the browser can share one.
   * Desktop Chrome on Linux and Firefox cannot; there the download and the
   * link are the way out.
   */
  const shareable = useMemo(() => {
    if (!blob || typeof navigator.canShare !== 'function') return null
    const file = new File([blob], `${story.slug}-quote.png`, { type: 'image/png' })
    try {
      return navigator.canShare({ files: [file] }) ? file : null
    } catch {
      return null
    }
  }, [blob, story.slug])

  async function share() {
    if (!shareable) return
    setSharing(true)
    try {
      await navigator.share({
        files: [shareable],
        title: story.title,
        // The link rides in the text: several share targets drop `url` when
        // a file is attached.
        text: `${story.title} by ${authorName}, on Scribe: ${link}`,
      })
    } catch (cause) {
      // Closing the share sheet is not a failure.
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        showToast({ tone: 'error', message: 'We could not share the card.' })
      }
    } finally {
      setSharing(false)
    }
  }

  function download() {
    if (!preview) return
    const anchor = document.createElement('a')
    anchor.href = preview
    anchor.download = `${story.slug}-quote.png`
    anchor.click()
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link)
      showToast({ message: 'Link to the chapter copied.' })
    } catch {
      showToast({ tone: 'error', message: 'We could not copy the link.' })
    }
  }

  const ready = card.status === 'ready' && preview !== null

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Quote card"
      description="Share this passage as an image. It credits the author and links to the chapter."
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => void copyLink()}
            startIcon={<Icon name="link" size="1em" />}
          >
            Copy link
          </Button>
          <Button
            variant={shareable ? 'secondary' : 'primary'}
            disabled={!ready}
            onClick={download}
            startIcon={<Icon name="image" size="1em" />}
          >
            Download
          </Button>
          {shareable ? (
            <Button
              variant="primary"
              disabled={!ready}
              loading={sharing}
              onClick={() => void share()}
              startIcon={<Icon name="share" size="1em" />}
            >
              Share
            </Button>
          ) : null}
        </>
      }
    >
      <div className="quote-card">
        <div className="quote-card__frame">
          {card.status === 'error' ? (
            <p className="quote-card__error" role="alert">
              {card.error ?? 'The card could not be made.'}{' '}
              <button type="button" className="quote-card__retry" onClick={card.reload}>
                Try again
              </button>
            </p>
          ) : ready ? (
            <img
              className="quote-card__image"
              src={preview}
              alt={`Quote card: “${highlight ? plainQuote(highlight.quote) : ''}” from ${story.title} by ${authorName}.`}
            />
          ) : (
            <Skeleton className="quote-card__loading" width="100%" height="100%" radius="0" />
          )}
        </div>

        <SegmentedControl
          label="Card style"
          size="sm"
          items={QUOTE_CARD_STYLES}
          value={style}
          onChange={setStyle}
        />

        {card.data?.truncated ? (
          <p className="quote-card__note">
            This passage is longer than one card holds, so the card shows its
            beginning. Highlight a shorter passage to quote all of it.
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
