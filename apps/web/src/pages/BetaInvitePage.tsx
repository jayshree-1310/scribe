import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useToast } from '../lib/toast'
import { ApiError } from '../lib/api-client'
import * as betaApi from '../data/beta-api'
import { storyAuthorName } from '../types/stories'
import { Button, ButtonLink } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { StatusBadge } from '../components/ui/Chip'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { ErrorState } from '../components/ui/States'
import { StoryCover } from '../components/story/StoryCover'
import './pages.css'
import './author/beta-readers.css'

/**
 * Where an author's invite link lands: what the story is, and a button to
 * join as a beta reader.
 *
 * Joining is a button rather than something opening the link does by itself,
 * so a link preview fetched by a chat app, or a click by mistake, does not put
 * somebody on an author's reader list. Signed-out visitors are sent to sign
 * in first by the shell, and come back here afterwards.
 */
export function BetaInvitePage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const { showToast } = useToast()
  const invite = useAsync(() => betaApi.previewInvite(token), [token])
  const [joining, setJoining] = useState(false)

  async function onJoin() {
    setJoining(true)
    try {
      const slug = await betaApi.joinBeta(token)
      showToast({ message: 'You are a beta reader now. Your feedback goes only to the author.' })
      navigate(`/story/${slug}`, { replace: true })
    } catch (cause) {
      showToast({
        tone: 'error',
        message: cause instanceof ApiError ? cause.message : 'You could not join. Try again.',
      })
      setJoining(false)
    }
  }

  if (invite.status === 'loading') {
    return (
      <div className="beta-invite">
        <Skeleton height="9rem" radius="var(--radius-lg)" />
      </div>
    )
  }

  if (invite.status === 'error' || !invite.data) {
    return (
      <ErrorState
        title="This invite link does not work"
        message={invite.error ?? 'It may have been turned off by the author.'}
      />
    )
  }

  const { story, isAuthor, joined } = invite.data

  return (
    <div className="beta-invite">
      <Card>
        <div className="beta-invite__story">
          <StoryCover story={story} size="sm" className="beta-invite__cover" />
          <div className="beta-invite__meta">
            <p className="beta__note">
              <StatusBadge tone="brand" icon={<Icon name="lock" size="0.9em" />}>
                Beta invite
              </StatusBadge>
            </p>
            <h1 className="beta-invite__title">{story.title}</h1>
            <p className="beta__note">by {storyAuthorName(story.author)}</p>
            {story.description ? <p className="beta__body">{story.description}</p> : null}
          </div>
        </div>
      </Card>

      {isAuthor ? (
        <>
          <p className="beta__note">
            This is your own story&rsquo;s invite link. Send it to the readers
            you want to read your drafts.
          </p>
          <div className="beta-invite__actions">
            <ButtonLink
              variant="primary"
              to={`/author/stories/${story.slug}/beta`}
              startIcon={<Icon name="users" size="1em" />}
            >
              Manage beta readers
            </ButtonLink>
          </div>
        </>
      ) : joined ? (
        <>
          <p className="beta__note">You are already a beta reader of this story.</p>
          <div className="beta-invite__actions">
            <ButtonLink variant="primary" to={`/story/${story.slug}`}>
              Open the story
            </ButtonLink>
          </div>
        </>
      ) : (
        <>
          <p className="beta__note">
            {storyAuthorName(story.author)} has invited you to read this story
            before it is published, including chapters that are not out yet,
            and to tell them what you think. Your feedback goes only to the
            author. The author will see your name and can remove you at any
            time.
          </p>
          <div className="beta-invite__actions">
            <Button
              variant="primary"
              loading={joining}
              onClick={() => void onJoin()}
              startIcon={<Icon name="book-open" size="1em" />}
            >
              Join as a beta reader
            </Button>
            <ButtonLink variant="ghost" to="/home">
              Not now
            </ButtonLink>
          </div>
        </>
      )}
    </div>
  )
}
