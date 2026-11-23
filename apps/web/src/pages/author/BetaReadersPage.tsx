import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useAsync } from '../../hooks/useAsync'
import { useToast } from '../../lib/toast'
import { ApiError } from '../../lib/api-client'
import { formatDate, formatRelative } from '../../lib/format'
import * as storiesApi from '../../data/stories-api'
import * as betaApi from '../../data/beta-api'
import {
  betaInviteUrl,
  betaPersonName,
  type BetaFeedback,
  type BetaReaderSummary,
} from '../../types/beta'
import { Avatar } from '../../components/ui/Avatar'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { StatusBadge } from '../../components/ui/Chip'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { Icon } from '../../components/ui/Icon'
import { Skeleton } from '../../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../../components/ui/States'
import '../pages.css'
import './author.css'
import './beta-readers.css'

/**
 * Beta readers for one story: the invite link, who has joined, and what they
 * said.
 *
 * Three things the page has to make plain, because each is a way sharing a
 * draft goes wrong:
 *
 * - **What a beta reader can see.** Every chapter, published or not, except
 *   one a moderator took down. Said beside the link, before it is copied.
 * - **What turning the link off does.** Everyone who joined loses access; a
 *   link sent around keeps working until then. Said in the confirmation.
 * - **That feedback is the author's.** It stays when a chapter is published
 *   and when a reader leaves, until the author deletes it.
 */

function messageFor(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

type Pending =
  | { kind: 'revoke' }
  | { kind: 'remove'; reader: BetaReaderSummary }
  | { kind: 'delete'; feedback: BetaFeedback }

export function BetaReadersPage() {
  const { slug } = useParams()
  const { showToast } = useToast()

  const story = useAsync(
    () => (slug ? storiesApi.getStory(slug) : Promise.resolve(null)),
    [slug],
  )
  const storyId = story.data?.id ?? null

  const overview = useAsync(
    () => (storyId ? betaApi.getOverview(storyId) : Promise.resolve(null)),
    [storyId],
  )
  const feedback = useAsync(
    () => (storyId ? betaApi.listFeedback(storyId) : Promise.resolve(null)),
    [storyId],
  )

  const [creating, setCreating] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [working, setWorking] = useState(false)
  const [pendingError, setPendingError] = useState<string | null>(null)

  async function onCreateLink() {
    if (!storyId) return
    setCreating(true)
    try {
      await betaApi.createLink(storyId)
      overview.reload()
    } catch (cause) {
      showToast({ tone: 'error', message: messageFor(cause, 'The link could not be made.') })
    } finally {
      setCreating(false)
    }
  }

  async function onCopy(token: string) {
    try {
      await navigator.clipboard.writeText(betaInviteUrl(token))
      showToast({ message: 'Invite link copied to your clipboard.' })
    } catch {
      showToast({ tone: 'error', message: 'Copy did not work. Select the link and copy it instead.' })
    }
  }

  async function onConfirm() {
    if (!pending || !storyId) return
    setWorking(true)
    setPendingError(null)
    try {
      if (pending.kind === 'revoke') {
        await betaApi.revokeLink(storyId)
        showToast({ message: 'Link turned off. Nobody can use it to read this story now.' })
        overview.reload()
      } else if (pending.kind === 'remove') {
        await betaApi.removeReader(storyId, pending.reader.user.id)
        showToast({ message: `${betaPersonName(pending.reader.user)} can no longer read your drafts.` })
        overview.reload()
      } else {
        await betaApi.deleteFeedback(pending.feedback.id)
        showToast({ message: 'Feedback deleted.' })
        feedback.reload()
        overview.reload()
      }
      setPending(null)
    } catch (cause) {
      setPendingError(messageFor(cause, 'That did not work. Try again.'))
    } finally {
      setWorking(false)
    }
  }

  /* Render -------------------------------------------------------------- */

  if (story.status === 'loading' || (storyId && overview.status === 'loading' && !overview.data)) {
    return (
      <div className="beta__loading">
        <Skeleton height="2.5rem" width="40%" />
        <Skeleton height="8rem" />
        <Skeleton height="12rem" />
      </div>
    )
  }

  if (story.status === 'error' || !story.data || overview.status === 'error' || !overview.data) {
    return (
      <ErrorState
        title="Beta readers could not be opened"
        message={story.error ?? overview.error ?? 'It may not be your story, or it may be gone.'}
        onRetry={() => {
          story.reload()
          overview.reload()
        }}
      />
    )
  }

  const { link, readers } = overview.data
  const items = feedback.data ?? []

  /** Chapter by chapter, keeping the API's reading order. */
  const groups: Array<{ chapterId: string; label: string; published: boolean; items: BetaFeedback[] }> = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last && last.chapterId === item.chapterId) last.items.push(item)
    else
      groups.push({
        chapterId: item.chapterId,
        label: `${item.chapterNumber}. ${item.chapterTitle}`,
        published: item.chapterPublished,
        items: [item],
      })
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Beta readers</h1>
          <p className="page-head__sub">
            Share <strong>{story.data.title}</strong> with readers you choose
            before it is published, and read what they think. Only you see
            their feedback.
          </p>
        </div>
        <ButtonLink
          to={`/author/stories/${story.data.slug}`}
          startIcon={<Icon name="arrow-left" size="1em" />}
        >
          Back to the editor
        </ButtonLink>
      </header>

      {/* Invite link ------------------------------------------------------ */}
      <Card className="beta__link">
        <div className="beta__link-head">
          <div>
            <h2 className="beta__section-title">Invite link</h2>
            <p className="beta__note">
              Anyone with a Scribe account who opens this link can join. Beta
              readers can read every chapter of this story, including drafts
              and scheduled chapters. They cannot comment on, like or rate
              anything that is not published.
            </p>
          </div>
          {link ? null : (
            <Button
              variant="primary"
              loading={creating}
              onClick={() => void onCreateLink()}
              startIcon={<Icon name="link" size="1em" />}
            >
              Create invite link
            </Button>
          )}
        </div>

        {link ? (
          <>
            <div className="beta__link-row">
              <input
                className="beta__link-url"
                readOnly
                aria-label="Invite link"
                value={betaInviteUrl(link.token)}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                variant="primary"
                onClick={() => void onCopy(link.token)}
                startIcon={<Icon name="share" size="1em" />}
              >
                Copy link
              </Button>
            </div>
            <div className="beta__link-foot">
              <span className="beta__note">Made {formatRelative(link.createdAt)}.</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPendingError(null)
                  setPending({ kind: 'revoke' })
                }}
                startIcon={<Icon name="close" size="0.95em" />}
              >
                Turn off link
              </Button>
            </div>
          </>
        ) : null}
      </Card>

      {/* Readers ---------------------------------------------------------- */}
      <section className="page-section">
        <h2 className="beta__section-title">
          Readers{readers.length > 0 ? ` (${readers.length})` : ''}
        </h2>
        {readers.length === 0 ? (
          <EmptyState
            icon="users"
            size="sm"
            title="Nobody has joined yet"
            description={
              link
                ? 'Send the invite link to the readers you want. They appear here when they join.'
                : 'Create an invite link and send it to the readers you want.'
            }
          />
        ) : (
          <ul className="beta__readers">
            {readers.map((entry) => (
              <li key={entry.user.id} className="beta__reader">
                <Avatar user={entry.user} size="sm" />
                <div className="beta__reader-body">
                  <strong>{betaPersonName(entry.user)}</strong>
                  <span className="beta__note">
                    Joined {formatDate(entry.joinedAt)} ·{' '}
                    {entry.feedbackCount === 1 ? '1 note' : `${entry.feedbackCount} notes`}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPendingError(null)
                    setPending({ kind: 'remove', reader: entry })
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Feedback --------------------------------------------------------- */}
      <section className="page-section">
        <h2 className="beta__section-title">Feedback</h2>
        <p className="beta__note beta__note--spaced">
          Kept after a chapter is published and after a reader leaves, until
          you delete it.
        </p>
        {feedback.status === 'error' ? (
          <ErrorState message={feedback.error} onRetry={feedback.reload} />
        ) : feedback.status === 'loading' ? (
          <Skeleton height="6rem" radius="var(--radius-md)" />
        ) : groups.length === 0 ? (
          <EmptyState
            icon="comment"
            size="sm"
            title="No feedback yet"
            description="Beta readers leave notes from the reader, on a chapter or on a passage they select."
          />
        ) : (
          groups.map((group) => (
            <div key={group.chapterId} className="beta__group">
              <h3 className="beta__chapter">
                {group.label}
                <StatusBadge tone={group.published ? 'brand' : 'neutral'}>
                  {group.published ? 'Published' : 'Draft'}
                </StatusBadge>
              </h3>
              <ul className="beta__feedback">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <Card className="beta__note-card">
                      <div className="beta__note-head">
                        <Avatar user={item.reader} size="xs" />
                        <strong>{betaPersonName(item.reader)}</strong>
                        <span className="beta__note">{formatRelative(item.createdAt)}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label="Delete this feedback"
                          title="Delete"
                          className="beta__note-delete"
                          onClick={() => {
                            setPendingError(null)
                            setPending({ kind: 'delete', feedback: item })
                          }}
                          startIcon={<Icon name="trash" size="0.95em" />}
                        />
                      </div>
                      {item.quote ? (
                        <blockquote className="beta__quote">{item.quote.replace(/[*_]/g, '')}</blockquote>
                      ) : null}
                      <p className="beta__body">{item.body}</p>
                    </Card>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === 'revoke'
            ? 'Turn off the invite link?'
            : pending?.kind === 'remove'
              ? `Remove ${betaPersonName(pending.reader.user)}?`
              : 'Delete this feedback?'
        }
        message={
          pending?.kind === 'revoke'
            ? 'Everyone who joined through it loses access to your drafts, and the link stops working. Their feedback stays here. You can make a new link afterwards.'
            : pending?.kind === 'remove'
              ? 'They will no longer be able to read your unpublished chapters. Their feedback stays here.'
              : 'It is removed for you and for the reader who wrote it.'
        }
        confirmLabel={
          pending?.kind === 'revoke' ? 'Turn off link' : pending?.kind === 'remove' ? 'Remove' : 'Delete'
        }
        pending={working}
        error={pendingError}
        onConfirm={() => void onConfirm()}
        onCancel={() => setPending(null)}
      />
    </>
  )
}
