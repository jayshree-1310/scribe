import { useCallback, useEffect, useState } from 'react'
import { cn } from '../../lib/cn'
import { formatCount } from '../../lib/format'
import { useToast } from '../../lib/toast'
import * as engagement from '../../data/engagement-api'
import type { LikeSummary } from '../../types/engagement'
import { Icon } from '../ui/Icon'
import './engagement.css'

/**
 * A heart with a count that knows how to set itself.
 *
 * One component for both things that can be liked, and for every surface that
 * draws either — the reader's chapter footer, its comment panel, and the story
 * page's comment thread. The alternative was the same optimistic-update
 * bookkeeping written once per page, which is how three copies end up
 * disagreeing about what a failed request should leave on screen.
 *
 * Three decisions live here.
 *
 * **It sets a state rather than toggling one.** The API has `PUT` and
 * `DELETE`, not a toggle, so a double tap or a retried request lands in the
 * state the reader asked for instead of flipping back past it. `liked` from
 * the props decides which of the two is sent, and nothing depends on the
 * server and the client agreeing about how many times the button was pressed.
 *
 * **The count moves before the request finishes, and moves back if it fails.**
 * A heart that waits for a round trip feels broken at any latency worth
 * measuring. The revert restores the numbers this component was rendered with
 * rather than decrementing what it optimistically wrote, so two clicks racing
 * cannot leave a count below where it started.
 *
 * **Signing in is not guessed at.** The button does not ask whether anybody is
 * signed in before trying: in local development the API accepts a header
 * instead of a session, so a client-side check would refuse a request the
 * server would have honoured. A 401 comes back as a toast that says what to
 * do, which is the same thing a guess would have produced and is true in both
 * environments.
 */
interface LikeButtonProps {
  /** Which endpoint to address; both take the subject's id. */
  subject: 'chapter' | 'comment'
  subjectId: string
  /** The server's numbers. Changing either drops any local override. */
  likeCount: number
  likedByMe: boolean
  /**
   * `pill` for the chapter footer, `inline` for a comment's action row —
   * the same behaviour, sized and coloured for where it sits.
   */
  variant?: 'pill' | 'inline'
  /** Announced to screen readers, e.g. "this chapter" or "this comment". */
  noun: string
  className?: string
}

export function LikeButton({
  subject,
  subjectId,
  likeCount,
  likedByMe,
  variant = 'inline',
  noun,
  className,
}: LikeButtonProps) {
  const { showToast } = useToast()

  /** Null until the reader presses it; the server's numbers until then. */
  const [override, setOverride] = useState<LikeSummary | null>(null)
  const [pending, setPending] = useState(false)

  /**
   * A fresh read from the server wins over whatever this component last
   * wrote. Only a reload of the list moves these props, and when one happens
   * the list is more current than an override from before it.
   */
  useEffect(() => {
    setOverride(null)
  }, [subjectId, likeCount, likedByMe])

  const count = override?.count ?? likeCount
  const liked = override?.liked ?? likedByMe

  const onClick = useCallback(async () => {
    if (pending) return

    const next = !liked
    const previous = { count, liked }

    setOverride({ count: Math.max(0, count + (next ? 1 : -1)), liked: next })
    setPending(true)

    try {
      const summary =
        subject === 'chapter'
          ? next
            ? await engagement.likeChapter(subjectId)
            : await engagement.unlikeChapter(subjectId)
          : next
            ? await engagement.likeComment(subjectId)
            : await engagement.unlikeComment(subjectId)

      setOverride(summary)
    } catch (cause) {
      setOverride(previous)
      showToast({
        tone: 'error',
        message:
          cause instanceof Error
            ? cause.message
            : `We could not ${next ? 'like' : 'unlike'} ${noun}.`,
      })
    } finally {
      setPending(false)
    }
  }, [count, liked, noun, pending, showToast, subject, subjectId])

  return (
    <button
      type="button"
      className={cn('like', `like--${variant}`, liked && 'is-on', className)}
      // `aria-pressed` rather than two labels: the control is the same thing
      // either way, and a screen reader says the state without the name of it
      // changing under somebody mid-sentence.
      aria-pressed={liked}
      aria-label={liked ? `Remove your like from ${noun}` : `Like ${noun}`}
      onClick={onClick}
    >
      <Icon name={liked ? 'heart-filled' : 'heart'} size="1em" />
      <span className="like__count">{formatCount(count)}</span>
    </button>
  )
}
