import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { formatCount, formatDate, formatMinutes, formatRating, formatRelative } from '../lib/format'
import * as api from '../data/api'
import { AppShell } from '../components/layout/AppShell'
import { Avatar } from '../components/ui/Avatar'
import { Button, ButtonLink } from '../components/ui/Button'
import { Card, SectionHead, StatTile } from '../components/ui/Card'
import { StatusBadge } from '../components/ui/Chip'
import { Icon } from '../components/ui/Icon'
import { ProgressBar } from '../components/ui/Progress'
import { Skeleton } from '../components/ui/Skeleton'
import { Lightbox } from '../components/ui/Lightbox'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { BadgeTile, ClubCard } from '../components/story/Cards'
import { StoryCard } from '../components/story/StoryCard'
import { StoryCover } from '../components/story/StoryCover'
import './pages.css'

type ProfileTab = 'overview' | 'stories' | 'activity' | 'badges' | 'clubs'

const TABS = [
  { id: 'overview' as const, label: 'Overview' },
  { id: 'stories' as const, label: 'Stories' },
  { id: 'activity' as const, label: 'Reading activity' },
  { id: 'badges' as const, label: 'Badges' },
  { id: 'clubs' as const, label: 'Clubs' },
]

export function ProfilePage() {
  const { username = '' } = useParams()
  const { session } = useAuth()

  const authors = useAsync(() => api.getAuthors(), [])
  const badges = useAsync(() => api.getBadges(), [])
  const clubs = useAsync(() => api.getClubs(), [])
  const completed = useAsync(() => api.getLibrary('completed'), [])
  const reading = useAsync(() => api.getLibrary('reading'), [])

  const [tab, setTab] = useState<ProfileTab>('overview')
  const [following, setFollowing] = useState(false)
  const [viewingPicture, setViewingPicture] = useState(false)

  const isMe = !username || username === session?.user.username
  const profile = isMe
    ? session?.user
    : authors.data?.find((author) => author.username === username)

  const stories = useAsync(
    () => (profile ? api.getAuthorStories(profile.id) : Promise.resolve([])),
    [profile?.id],
  )

  if (!profile) {
    return (
      <AppShell>
        {authors.status === 'loading' ? (
          <Skeleton height="12rem" radius="var(--radius-lg)" />
        ) : (
          <ErrorState
            title="We couldn't find that profile"
            message={`No reader on Scribe goes by “${username}”.`}
          />
        )}
      </AppShell>
    )
  }

  const earnedBadges = badges.data?.filter((entry) => entry.earned) ?? []
  const myClubs = clubs.data?.filter((club) => club.membership !== null) ?? []

  return (
    <AppShell>
      {/* Header --------------------------------------------------------- */}
      <header className="profile">
        <div className="profile__identity">
          {profile.avatarUrl ? (
            /* A picture is worth opening at full size; a generated monogram
               is not, so only the former becomes a button. */
            <button
              type="button"
              className="profile__picture"
              onClick={() => setViewingPicture(true)}
              aria-label={`View ${isMe ? 'your' : `${profile.displayName}'s`} profile picture`}
            >
              <Avatar user={profile} size="xl" />
              <span className="profile__picture-hint" aria-hidden="true">
                <Icon name="maximize" size="1.1rem" />
              </span>
            </button>
          ) : (
            <Avatar user={profile} size="xl" />
          )}
          <div className="profile__ident-text">
            <div className="profile__name-row">
              <h1>{profile.displayName}</h1>
              {profile.isAuthor ? <StatusBadge tone="brand">Author</StatusBadge> : null}
            </div>
            <p className="profile__handle">@{profile.username}</p>
            <p className="profile__bio">{profile.bio || 'No bio yet.'}</p>
            <p className="profile__meta">
              <span>
                <Icon name="calendar" size="0.9em" />
                Joined {formatDate(profile.joinedAt)}
              </span>
              <span>
                <Icon name="users" size="0.9em" />
                {formatCount(profile.followerCount)} followers
              </span>
              <span>
                <Icon name="user" size="0.9em" />
                {formatCount(profile.followingCount)} following
              </span>
            </p>
          </div>
        </div>

        <div className="profile__actions">
          {isMe ? (
            <>
              <ButtonLink
                to="/settings?section=account"
                startIcon={<Icon name="settings" size="1em" />}
              >
                Edit profile
              </ButtonLink>
              <ButtonLink variant="primary" to="/author" startIcon={<Icon name="pen" size="1em" />}>
                Author studio
              </ButtonLink>
            </>
          ) : (
            <>
              <Button
                variant={following ? 'secondary' : 'primary'}
                onClick={() => setFollowing((current) => !current)}
                startIcon={<Icon name={following ? 'check' : 'user-plus'} size="1em" />}
              >
                {following ? 'Following' : 'Follow'}
              </Button>
              <Button iconOnly aria-label="Share profile" startIcon={<Icon name="share" />} />
            </>
          )}
        </div>
      </header>

      {/* Stats ---------------------------------------------------------- */}
      <div className="stat-row">
        <StatTile
          label="Stories read"
          value={formatCount(profile.stats.storiesRead)}
          icon="book"
        />
        <StatTile
          label="Chapters read"
          value={formatCount(profile.stats.chaptersRead)}
          icon="library"
        />
        <StatTile
          label="Reading streak"
          value={`${profile.stats.readingStreakDays} days`}
          icon="flame"
        />
        {profile.isAuthor ? (
          <StatTile
            label="Total reads"
            value={formatCount(profile.stats.totalViews)}
            icon="eye"
          />
        ) : (
          <StatTile
            label="This week"
            value={formatMinutes(profile.stats.minutesReadThisWeek)}
            icon="clock"
          />
        )}
      </div>

      <div className="page-tabs">
        <Tabs
          items={TABS.map((item) =>
            item.id === 'badges'
              ? { ...item, count: earnedBadges.length }
              : item.id === 'stories'
                ? { ...item, count: stories.data?.length }
                : item,
          )}
          active={tab}
          onChange={setTab}
          label="Profile sections"
        />
      </div>

      {/* Overview ------------------------------------------------------- */}
      {tab === 'overview' ? (
        <TabPanel id="overview">
          {profile.isAuthor ? (
            <section className="page-section">
              <SectionHead
                title="Published stories"
                subtitle={`${stories.data?.length ?? 0} on Scribe`}
                action={
                  <span className="profile__author-stats">
                    <Icon name="star-filled" size="0.9em" />
                    {profile.stats.averageRating
                      ? `${formatRating(profile.stats.averageRating)} average`
                      : 'Not yet rated'}
                  </span>
                }
              />
              <div className="story-grid">
                {stories.data?.slice(0, 5).map((story) => (
                  <StoryCard key={story.id} story={story} hideAuthor />
                ))}
              </div>
            </section>
          ) : null}

          <section className="page-section">
            <SectionHead title="Currently reading" to="/library" linkLabel="Library" />
            {reading.data?.length === 0 ? (
              <EmptyState size="sm" icon="book-open" title="Nothing in progress" />
            ) : (
              <ul className="mini-shelf">
                {reading.data?.slice(0, 6).map(({ story, history }) => (
                  <li key={story.id}>
                    <Link to={`/story/${story.slug}`}>
                      <StoryCover story={story} size="sm" />
                      <ProgressBar value={history.storyProgress} label="Progress" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="page-section">
            <SectionHead title="Recent badges" to="#" linkLabel="" />
            <div className="card-grid card-grid--tight">
              {earnedBadges.slice(0, 4).map((entry) => (
                <BadgeTile key={entry.badge.id} entry={entry} />
              ))}
            </div>
          </section>
        </TabPanel>
      ) : null}

      {tab === 'stories' ? (
        <TabPanel id="stories">
          {stories.status === 'error' ? (
            <ErrorState message={stories.error} onRetry={stories.reload} />
          ) : stories.data?.length === 0 ? (
            <EmptyState
              icon="pen"
              title="No published stories"
              description={
                isMe
                  ? 'Your published stories will appear here.'
                  : `${profile.displayName} hasn't published anything yet.`
              }
              action={
                isMe ? (
                  <ButtonLink variant="primary" to="/author/stories/new">
                    Start a story
                  </ButtonLink>
                ) : undefined
              }
            />
          ) : (
            <div className="story-grid">
              {stories.data?.map((story) => (
                <StoryCard key={story.id} story={story} hideAuthor />
              ))}
            </div>
          )}
        </TabPanel>
      ) : null}

      {tab === 'activity' ? (
        <TabPanel id="activity">
          <Card padded={false}>
            <ul className="activity">
              {[...(reading.data ?? []), ...(completed.data ?? [])].map(
                ({ history, story, chapter }) => (
                  <li key={history.id}>
                    <span className="activity__icon">
                      <Icon
                        name={history.storyProgress >= 1 ? 'check-circle' : 'book-open'}
                        size="1rem"
                      />
                    </span>
                    <span className="activity__body">
                      <span>
                        {history.storyProgress >= 1 ? 'Finished' : 'Read'}{' '}
                        <Link to={`/story/${story.slug}`}>{story.title}</Link>
                        {history.storyProgress < 1 ? ` — chapter ${chapter.number}` : ''}
                      </span>
                      <span className="activity__when">{formatRelative(history.lastReadAt)}</span>
                    </span>
                  </li>
                ),
              )}
            </ul>
          </Card>
        </TabPanel>
      ) : null}

      {tab === 'badges' ? (
        <TabPanel id="badges">
          <div className="card-grid card-grid--tight">
            {badges.data?.map((entry) => (
              <BadgeTile key={entry.badge.id} entry={entry} />
            ))}
          </div>
        </TabPanel>
      ) : null}

      {profile.avatarUrl ? (
        <Lightbox
          open={viewingPicture}
          onClose={() => setViewingPicture(false)}
          src={profile.avatarUrl}
          alt={`${profile.displayName}'s profile picture`}
        >
          {isMe ? (
            <ButtonLink
              to="/settings?section=account"
              startIcon={<Icon name="image" size="1em" />}
            >
              Change picture
            </ButtonLink>
          ) : null}
        </Lightbox>
      ) : null}

      {tab === 'clubs' ? (
        <TabPanel id="clubs">
          {myClubs.length === 0 ? (
            <EmptyState
              icon="users"
              title="Not in any clubs"
              action={<ButtonLink to="/clubs">Browse clubs</ButtonLink>}
            />
          ) : (
            <div className="card-grid card-grid--wide">
              {myClubs.map((club) => (
                <ClubCard key={club.id} club={club} />
              ))}
            </div>
          )}
        </TabPanel>
      ) : null}
    </AppShell>
  )
}
