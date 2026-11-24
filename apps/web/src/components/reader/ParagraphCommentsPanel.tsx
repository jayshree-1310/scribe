import { useMemo, useState } from 'react'
import { useAsync } from '../../hooks/useAsync'
import { cn } from '../../lib/cn'
import { formatCount, formatRelative } from '../../lib/format'
import { useToast } from '../../lib/toast'
import * as engagement from '../../data/engagement-api'
import {
  COMMENT_MAX_LENGTH,
  commentUserName,
  type Comment,
} from '../../types/engagement'
import { LikeButton } from '../engagement/LikeButton'
import { SignInPrompt } from '../engagement/SignInPrompt'
import { ReportMenu } from '../moderation/ReportMenu'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import { TextField } from '../ui/TextField'
import { ReaderPanel } from './ReaderPanel'
import './paragraph-comments.css'

/**
 * The public conversation about one paragraph, in the reader's side panel.
 *
 * Opened from the marker beside a paragraph, from "Comment" on a selection,
 * or from a notification's link. Everything a story comment has, a
 * paragraph comment has -- one level of replies, likes, delete for its
 * writer, report for everyone else -- because it is one: an
 * `engagement.Comment` that also names its paragraph. Unlike a highlight's
 * note it is public, which the form says where the reader types.
 *
 * Mounted per paragraph (keyed in `ReaderPage`), so nothing here has to be
 * reset when the reader opens another. What is posted or deleted here is laid
 * over the fetched list rather than reloading it, and reported to the page
 * through `onCountChange` so the paragraph's marker keeps count.
 */

interface ParagraphCommentsPanelProps {
  storyId: string
  chapterId: string
  /** Where the paragraph starts in the chapter source. */
  paragraph: number
  /** The paragraph as the reader sees it. */
  quote: string
  signedIn: boolean
  viewerId: string | null
  /** Comments were added (positive) or removed (negative) here. */
  onCountChange: (delta: number) => void
  onClose: () => void
}

const PAGE_SIZE = 20

/** Past this, the quote is clamped and offers to open. */
const LONG_QUOTE = 220

export function ParagraphCommentsPanel({
  storyId,
  chapterId,
  paragraph,
  quote,
  signedIn,
  viewerId,
  onCountChange,
  onClose,
}: ParagraphCommentsPanelProps) {
  const { showToast } = useToast()
  const [quoteOpen, setQuoteOpen] = useState(false)

  /* Threads ------------------------------------------------------------- */

  const first = useAsync(
    () => engagement.listComments(storyId, { chapterId, paragraph, limit: PAGE_SIZE }),
    [storyId, chapterId, paragraph],
  )
  /** Pages past the first, fetched when the reader asks for more. */
  const [later, setLater] = useState<{ items: Comment[]; page: number; hasMore: boolean } | null>(
    null,
  )
  const [loadingMore, setLoadingMore] = useState(false)
  /** Threads posted here, newest first, above what was fetched. */
  const [posted, setPosted] = useState<Comment[]>([])
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set())
  /** Replies written or deleted here, per thread, over its fetched count. */
  const [replyDelta, setReplyDelta] = useState<Record<string, number>>({})

  /**
   * Deduplicated by id: a thread posted here shifts the pages behind it by
   * one, so the next page can repeat the last one's final thread.
   */
  const threads = useMemo(() => {
    const seen = new Set<string>()
    return [...posted, ...(first.data?.items ?? []), ...(later?.items ?? [])].filter(
      (comment) => {
        if (seen.has(comment.id) || removed.has(comment.id)) return false
        seen.add(comment.id)
        return true
      },
    )
  }, [posted, first.data, later, removed])
  const hasMore = later ? later.hasMore : (first.data?.hasMore ?? false)

  const repliesOf = (thread: Comment) =>
    Math.max(0, thread.replyCount + (replyDelta[thread.id] ?? 0))

  async function loadMore() {
    setLoadingMore(true)
    try {
      const page = (later?.page ?? 1) + 1
      const next = await engagement.listComments(storyId, {
        chapterId,
        paragraph,
        page,
        limit: PAGE_SIZE,
      })
      setLater({
        items: [...(later?.items ?? []), ...next.items],
        page,
        hasMore: next.hasMore,
      })
    } catch (cause) {
      showToast({
        tone: 'error',
        message: cause instanceof Error ? cause.message : 'More comments could not be loaded.',
      })
    } finally {
      setLoadingMore(false)
    }
  }

  /* Writing ------------------------------------------------------------- */

  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | undefined>()

  async function onPost(event: React.FormEvent) {
    event.preventDefault()
    const content = draft.trim()
    if (content.length === 0) {
      setError('Write something before posting.')
      return
    }

    setPosting(true)
    try {
      const comment = await engagement.postComment(storyId, { content, chapterId, paragraph })
      setPosted((current) => [comment, ...current])
      setDraft('')
      setError(undefined)
      onCountChange(1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not post that comment.')
    } finally {
      setPosting(false)
    }
  }

  /* Replies ------------------------------------------------------------- */

  /** The thread whose replies are open. One at a time, as on the story page. */
  const [openThread, setOpenThread] = useState<string | null>(null)
  const replies = useAsync(
    () =>
      openThread
        ? engagement.listComments(storyId, { parentId: openThread, limit: 50 })
        : Promise.resolve(null),
    [storyId, openThread],
  )
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')
  const [replying, setReplying] = useState(false)

  async function onReply(thread: Comment) {
    const content = replyBody.trim()
    if (content.length === 0) return

    setReplying(true)
    try {
      await engagement.postComment(storyId, { content, parentId: thread.id })
      setReplyBody('')
      setReplyTo(null)
      setReplyDelta((current) => ({ ...current, [thread.id]: (current[thread.id] ?? 0) + 1 }))
      onCountChange(1)
      // Open the thread so the reply is visible where it landed.
      if (openThread === thread.id) replies.reload()
      else setOpenThread(thread.id)
    } catch (cause) {
      showToast({
        tone: 'error',
        message: cause instanceof Error ? cause.message : 'We could not post that reply.',
      })
    } finally {
      setReplying(false)
    }
  }

  async function onDelete(comment: Comment) {
    try {
      await engagement.deleteComment(comment.id)
      if (comment.parentId === null) {
        // A thread takes its replies with it.
        const thread = threads.find((item) => item.id === comment.id)
        setRemoved((current) => new Set(current).add(comment.id))
        onCountChange(-(1 + (thread ? repliesOf(thread) : 0)))
      } else {
        const threadId = comment.parentId
        setReplyDelta((current) => ({ ...current, [threadId]: (current[threadId] ?? 0) - 1 }))
        onCountChange(-1)
        replies.reload()
      }
      showToast({ message: 'Comment deleted.' })
    } catch (cause) {
      showToast({
        tone: 'error',
        message: cause instanceof Error ? cause.message : 'That comment could not be deleted.',
      })
    }
  }

  /** The writer's Delete, or everybody else's Report: never both, never neither. */
  function ownActions(comment: Comment, noun: string) {
    if (!signedIn) return null
    return comment.user.id === viewerId ? (
      <button type="button" className="paragraph-panel__action" onClick={() => void onDelete(comment)}>
        Delete
      </button>
    ) : (
      <ReportMenu targetType="COMMENT" targetId={comment.id} noun={noun} size="sm" />
    )
  }

  const long = quote.length > LONG_QUOTE

  return (
    <ReaderPanel
      label="Comments on this paragraph"
      icon="comment"
      title="Comments on this paragraph"
      className="paragraph-panel"
      onClose={onClose}
    >
      <div className="explain-sheet__body">
        <blockquote
          className={cn('explain-sheet__passage', 'paragraph-panel__quote', quoteOpen && 'is-open')}
        >
          {quote}
        </blockquote>
        {long ? (
          <button
            type="button"
            className="paragraph-panel__action paragraph-panel__more-quote"
            aria-expanded={quoteOpen}
            onClick={() => setQuoteOpen((open) => !open)}
          >
            {quoteOpen ? 'Show less' : 'Show the whole paragraph'}
          </button>
        ) : null}

        {signedIn ? (
          <form className="paragraph-panel__form" onSubmit={onPost}>
            <TextField
              multiline
              hideLabel
              label="Comment on this paragraph"
              placeholder="What did you make of this paragraph?"
              rows={3}
              value={draft}
              error={error}
              maxLength={COMMENT_MAX_LENGTH}
              disabled={posting}
              onChange={(event) => {
                setDraft(event.target.value)
                setError(undefined)
              }}
            />
            <div className="paragraph-panel__form-row">
              <span className="paragraph-panel__public">
                <Icon name="globe" size="0.9em" />
                Public: anyone reading this chapter can see it.
              </span>
              <Button
                variant="primary"
                size="sm"
                type="submit"
                loading={posting}
                startIcon={<Icon name="send" size="0.95em" />}
              >
                Post
              </Button>
            </div>
          </form>
        ) : (
          <SignInPrompt action="comment on this paragraph" />
        )}

        {first.status === 'error' ? (
          <p className="explain-sheet__error">
            {first.error ?? 'These comments could not be loaded.'}{' '}
            <button type="button" className="paragraph-panel__action" onClick={first.reload}>
              Try again
            </button>
          </p>
        ) : first.status === 'loading' && threads.length === 0 ? (
          <Skeleton height="4rem" radius="var(--radius-md)" />
        ) : threads.length === 0 ? (
          <p className="explain-sheet__hint paragraph-panel__empty">
            No comments on this paragraph yet.
            {signedIn ? ' Start the conversation.' : null}
          </p>
        ) : (
          <ul className="reader__comment-list paragraph-panel__list">
            {threads.map((thread) => {
              const count = repliesOf(thread)
              const open = openThread === thread.id

              return (
                <li key={thread.id}>
                  <Avatar user={thread.user} size="sm" />
                  <div className="reader__comment-body">
                    <p className="reader__comment-head">
                      <strong>{commentUserName(thread.user)}</strong>
                      <span>{formatRelative(thread.createdAt)}</span>
                    </p>
                    <p className="reader__comment-text">{thread.content}</p>

                    <div className="reader__comment-actions-row paragraph-panel__actions">
                      <LikeButton
                        subject="comment"
                        subjectId={thread.id}
                        likeCount={thread.likeCount}
                        likedByMe={thread.likedByMe}
                        noun="this comment"
                        readOnly={!signedIn}
                      />
                      {signedIn ? (
                        <button
                          type="button"
                          className="paragraph-panel__action"
                          aria-expanded={replyTo === thread.id}
                          onClick={() => {
                            setReplyTo(replyTo === thread.id ? null : thread.id)
                            setReplyBody('')
                          }}
                        >
                          Reply
                        </button>
                      ) : null}
                      {count > 0 ? (
                        <button
                          type="button"
                          className="paragraph-panel__action"
                          aria-expanded={open}
                          onClick={() => setOpenThread(open ? null : thread.id)}
                        >
                          {open
                            ? 'Hide replies'
                            : `${formatCount(count)} ${count === 1 ? 'reply' : 'replies'}`}
                        </button>
                      ) : null}
                      {ownActions(thread, 'comment')}
                    </div>

                    {open ? (
                      replies.status === 'loading' ? (
                        <Skeleton height="3rem" radius="var(--radius-md)" />
                      ) : replies.status === 'error' ? (
                        <p className="explain-sheet__error">{replies.error}</p>
                      ) : (
                        <ul className="paragraph-panel__replies">
                          {replies.data?.items.map((reply) => (
                            <li key={reply.id}>
                              <Avatar user={reply.user} size="xs" />
                              <div className="reader__comment-body">
                                <p className="reader__comment-head">
                                  <strong>{commentUserName(reply.user)}</strong>
                                  <span>{formatRelative(reply.createdAt)}</span>
                                </p>
                                <p className="reader__comment-text">{reply.content}</p>
                                <div className="reader__comment-actions-row paragraph-panel__actions">
                                  <LikeButton
                                    subject="comment"
                                    subjectId={reply.id}
                                    likeCount={reply.likeCount}
                                    likedByMe={reply.likedByMe}
                                    noun="this reply"
                                    readOnly={!signedIn}
                                  />
                                  {ownActions(reply, 'reply')}
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )
                    ) : null}

                    {replyTo === thread.id ? (
                      <form
                        className="paragraph-panel__reply-form"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void onReply(thread)
                        }}
                      >
                        <TextField
                          multiline
                          hideLabel
                          autoFocus
                          label={`Reply to ${commentUserName(thread.user)}`}
                          placeholder="Write a reply…"
                          rows={2}
                          value={replyBody}
                          maxLength={COMMENT_MAX_LENGTH}
                          disabled={replying}
                          onChange={(event) => setReplyBody(event.target.value)}
                        />
                        <div className="paragraph-panel__form-row is-end">
                          <Button size="sm" variant="ghost" onClick={() => setReplyTo(null)} disabled={replying}>
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            type="submit"
                            loading={replying}
                            disabled={replyBody.trim() === ''}
                          >
                            Reply
                          </Button>
                        </div>
                      </form>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {hasMore ? (
          <Button
            variant="ghost"
            size="sm"
            className="paragraph-panel__load-more"
            loading={loadingMore}
            onClick={() => void loadMore()}
          >
            Show more comments
          </Button>
        ) : null}
      </div>
    </ReaderPanel>
  )
}
