import { coverArt } from '../../lib/cover'
import { Icon } from '../ui/Icon'
import type { ChapterMedia } from '../../types/stories'
import './chapter-media.css'

interface ChapterAttachmentProps {
  item: ChapterMedia
  /** Genre hue, for the backdrop behind an unplayed video. */
  hue?: number
}

/**
 * One attachment on a chapter, played or shown in place.
 *
 * Real elements rather than the styled placeholders this used to draw: the URL
 * points at a file the author uploaded, so the browser's own controls are both
 * more honest and more useful than a painted play button. Nothing here
 * navigates — an image is the image and audio plays where it sits.
 *
 * Shared by the reader and the editor's preview, which is why its styles carry
 * fallbacks: the `--read-*` variables only exist inside the reader's theme.
 *
 * `content.Multimedia` has no caption or duration column, so neither is shown
 * — the type, its URL and its position are all the record carries.
 */
export function ChapterAttachment({ item, hue = 268 }: ChapterAttachmentProps) {
  if (item.type === 'AUDIO') {
    return (
      <figure className="media media--audio">
        <audio className="media__audio" controls preload="metadata" src={item.url} />
        <figcaption>
          <Icon name="audio" size="0.9em" />
          Audio attachment
        </figcaption>
      </figure>
    )
  }

  if (item.type === 'VIDEO') {
    // The generated art is a CSS gradient rather than an image, so it cannot
    // be a `poster`; as a backdrop it still keeps an unplayed video from being
    // a black rectangle.
    return (
      <figure className="media media--video">
        <video
          className="media__video"
          controls
          preload="metadata"
          src={item.url}
          style={{ background: coverArt(item.id, hue).background }}
        />
        <figcaption>
          <Icon name="video" size="0.9em" />
          Video attachment
        </figcaption>
      </figure>
    )
  }

  if (item.type === 'LINK') {
    return (
      <figure className="media media--link">
        <a className="media__link" href={item.url} target="_blank" rel="noreferrer">
          <Icon name="link" size="0.9em" />
          {item.url}
        </a>
      </figure>
    )
  }

  return (
    <figure className="media media--image">
      {/* No alt text to give: the row carries a URL and a type, nothing else. */}
      <img className="media__image" src={item.url} alt="" loading="lazy" />
      <figcaption>
        <Icon name="image" size="0.9em" />
        Image attachment
      </figcaption>
    </figure>
  )
}
