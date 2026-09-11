import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { formatCount, formatDate, formatRelative } from '../lib/format'
import * as api from '../data/api'
import * as books from '../data/books-api'
import * as clubsApi from '../data/clubs-api'
import * as usersApi from '../data/users-api'
import { READING_STATUS_LABELS } from '../types/books'
import type { FollowPage, FollowState } from '../types/users'
import { AppShell } from '../components/layout/AppShell'
import { Avatar } from '../components/ui/Avatar'
import { Button, ButtonLink } from '../components/ui/Button'
import { Card, SectionHead, StatTile } from '../components/ui/Card'
import { StatusBadge } from '../components/ui/Chip'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { Lightbox } from '../components/ui/Lightbox'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { BadgeTile, ClubCard } from '../components/story/Cards'
import { StoryCard } from '../components/story/StoryCard'
import { StoryCover } from '../components/story/StoryCover'
import './pages.css'

type ProfileTab =
  | 'overview'
  | 'stories'
  | 'followers'
  | 'following'
  | 'activity'
  | 'badges'
  | 'clubs'

/** A display name, falling back to the handle for password signups. */
function nameOf(user: { displayName: string | null; username: string }): string {
  return user.displayName || user.username
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'That did not work. Try again.'
}

/**
 * One reader's profile, public or their own.
 *
 * The same component serves `/profile/:username` and `/profile`; the only
 * difference is where the handle comes from. Everything below is then decided
 * by the API's answer rather than by which route was matched — including the
 * story list, which returns the caller's own drafts to them and nobody else's
 * to anybody.
 *
 * Four sections are the *caller's own* data and so are hidden on somebody
 * else's profile: currently-reading, reading activity, badges and clubs. They
 * read the signed-in reader's library, the mock badge list and `listClubs({
 * mine: true })` — none of which can be asked about another person. A
 * badges-by-username endpoint arrives with the badge engine; the rest want
 * endpoints that do not exist.
 */
export function ProfilePage() {
  const { username: routeUsername } = useParams()
  const { session, initialising } = useAuth()
  const { showToast } = useToast()

  /**
   * `/profile` has no handle in the path, so it borrows the session's. The
   * route is behind `RequireAuth`, so there is always one by the time this
   * renders — but not necessarily before the stored session is revalidated,
   * which is what `initialising` gates the request on.
   */
  const handle = routeUsername ?? session?.user.username ?? ''

  const profile = useAsync(
    () =>
      handle && !initialising
        ? usersApi.getProfile(handle)
        : Promise.resolve(null),
    [handle, initialising],
  )

  const data = profile.data

  /**
   * Whether this is the caller's own profile. `/profile` says so by having no
   * handle at all; `/profile/<your own handle>` — which is what clicking
   * yourself in a followers list gives — says so only once the API answers, so
   * both are folded into one flag rather than letting the two routes to the
   * same page behave differently.
   */
  const isMe = !routeUsername || data?.isMe === true

  const [viewingPicture, setViewingPicture] = useState(false)
  const [followBusy, setFollowBusy] = useState(false)

  /**
   * The open tab, and the follow button's state after a write — null while it
   * still reflects what the profile said. Both belong to *one* profile, so
   * they are stored with the handle they were derived from and reset during
   * render when it changes. That is the pattern `hooks/useAsync.ts` uses and
   * what React recommends over resetting in an effect; carrying them across a
   * navigation would show the previous person's follow state on this one, and
   * leave a tab open that this profile may not even have.
   *
   * `follow` is kept apart from `profile.data` rather than folded into it so
   * an optimistic flip has exactly one value to roll back to.
   */
  const [view, setView] = useState<{
    handle: string
    tab: ProfileTab
    follow: FollowState | null
  }>({ handle, tab: 'overview', follow: null })

  if (view.handle !== handle) {
    setView({ handle, tab: 'overview', follow: null })
  }

  const { tab, follow } = view

  function setTab(next: ProfileTab): void {
    setView((current) => ({ ...current, tab: next }))
  }

  function setFollow(next: FollowState | null): void {
    setView((current) => ({ ...current, follow: next }))
  }

  const following = follow?.following ?? data?.isFollowing ?? false
  const followerCount = follow?.followerCount ?? data?.followerCount ?? 0

  // Fired alongside the profile rather than after it: both are keyed on the
  // handle alone, and chaining them would put two round trips in front of the
  // Stories tab for no extra safety — a handle nobody holds 404s here too.
  const stories = useAsync(
    () =>
      handle && !initialising
        ? usersApi.listUserStories(handle, { limit: 24 })
        : Promise.resolve(null),
    [handle, initialising],
  )

  /**
   * The follow lists load when their tab is opened rather than with the page:
   * the counts come from the profile, so the tabs can be labelled without
   * them, and most visits never open either.
   */
  const followers = useAsync(
    () =>
      handle && !initialising && tab === 'followers'
        ? usersApi.listFollowers(handle, { limit: 48 })
        : Promise.resolve(null),
    [handle, initialising, tab === 'followers'],
  )
  const followingList = useAsync(
    () =>
      handle && !initialising && tab === 'following'
        ? usersApi.listFollowing(handle, { limit: 48 })
        : Promise.resolve(null),
    [handle, initialising, tab === 'following'],
  )

  // The caller's own data, so there is nothing to load on somebody else's page.
  const badges = useAsync(
    () => (isMe ? api.getBadges() : Promise.resolve([])),
    [isMe],
  )
  const clubs = useAsync(
    () =>
      isMe
        ? clubsApi.listClubs({ mine: true, limit: 24 }).then((page) => page.items)
        : Promise.resolve([]),
    [isMe],
  )
  const reading = useAsync(
    () =>
      isMe
        ? books.getLibrary({ status: 'READING' }).then((shelf) => shelf.items)
        : Promise.resolve([]),
    [isMe],
  )
  const completed = useAsync(
    () =>
      isMe
        ? books.getLibrary({ status: 'FINISHED' }).then((shelf) => shelf.items)
        : Promise.resolve([]),
    [isMe],
  )

  async function toggleFollow() {
    if (!data || followBusy) return

    const next = !following
    const previous = follow

    // Optimistic: the button flips now and the count moves with it, because a
    // follow that waits for a round trip reads as a button that did nothing.
    setFollow({
      following: next,
      followerCount: Math.max(0, followerCount + (next ? 1 : -1)),
    })
    setFollowBusy(true)

    try {
      // The server's count replaces the guess: somebody else may have followed
      // in the meantime, and it is the one that knows.
      setFollow(
        next
          ? await usersApi.followUser(handle)
          : await usersApi.unfollowUser(handle),
      )
    } catch (cause) {
      setFollow(previous)
      showToast({ message: messageOf(cause), tone: 'error' })
    } finally {
      setFollowBusy(false)
    }
  }

  if (!data) {
    return (
      <AppShell>
        {profile.status === 'error' ? (
          <ErrorState
            title="We couldn't find that profile"
            message={profile.error}
            onRetry={profile.reload}
          />
        ) : (
          <Skeleton height="12rem" radius="var(--radius-lg)" />
        )}
      </AppShell>
    )
  }

  const displayName = nameOf(data)
  const earnedBadges = badges.data?.filter((entry) => entry.earned) ?? []
  const myClubs = clubs.data ?? []

  const tabs = [
    { id: 'overview' as const, label: 'Overview' },
    { id: 'stories' as const, label: 'Stories', count: data.storyCount },
    { id: 'followers' as const, label: 'Followers', count: followerCount },
    { id: 'following' as const, label: 'Following', count: data.followingCount },
    ...(isMe
      ? [
          { id: 'activity' as const, label: 'Reading activity' },
          { id: 'badges' as const, label: 'Badges', count: earnedBadges.length },
          { id: 'clubs' as const, label: 'Clubs', count: myClubs.length },
        ]
      : []),
  ]

  return (
    <AppShell>
      {/* Header --------------------------------------------------------- */}
      <header className="profile">
        <div className="profile__identity">
          {data.avatarUrl ? (
            /* A picture is worth opening at full size; a generated monogram
               is not, so only the former becomes a button. */
            <button
              type="button"
              className="profile__picture"
              onClick={() => setViewingPicture(true)}
              aria-label={`View ${isMe ? 'your' : `${displayName}'s`} profile picture`}
            >
              <Avatar user={data} size="xl" />
              <span className="profile__picture-hint" aria-hidden="true">
                <Icon name="maximize" size="1.1rem" />
              </span>
            </button>
          ) : (
            <Avatar user={data} size="xl" />
          )}
          <div className="profile__ident-text">
            <div className="profile__name-row">
              <h1>{displayName}</h1>
              {data.isAuthor ? <StatusBadge tone="brand">Author</StatusBadge> : null}
            </div>
            <p className="profile__handle">@{data.username}</p>
            <p className="profile__bio">{data.bio || 'No bio yet.'}</p>
            <p className="profile__meta">
              <span>
                <Icon name="calendar" size="0.9em" />
                Joined {formatDate(data.joinedAt)}
              </span>
              <span>
                <Icon name="medal" size="0.9em" />
                Reader level {data.readerLevel}
              </span>
              {data.isAuthor ? (
                <span>
                  <Icon name="pen" size="0.9em" />
                  Author level {data.authorLevel}
                </span>
              ) : null}
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
                onClick={toggleFollow}
                startIcon={<Icon name={following ? 'check' : 'user-plus'} size="1em" />}
              >
                {following ? 'Following' : 'Follow'}
              </Button>
              <Button iconOnly aria-label="Share profile" startIcon={<Icon name="share" />} />
            </>
          )}
        </div>
      </header>

      {/* Stats ----------------------------------------------------------
          Every tile is a column the API really carries. The mock's reading
          aggregates — chapters read, minutes this week, total views — are
          gone rather than faked: nothing records a view or a chapter read
          yet, which is what the analytics task adds. */}
      <div className="stat-row">
        <StatTile
          label={data.isAuthor ? 'Stories' : 'Stories published'}
          value={formatCount(data.storyCount)}
          icon="book"
        />
        <StatTile label="Followers" value={formatCount(followerCount)} icon="users" />
        <StatTile
          label="Following"
          value={formatCount(data.followingCount)}
          icon="user"
        />
        <StatTile
          label="Reading streak"
          value={`${data.readingStreak} ${data.readingStreak === 1 ? 'day' : 'days'}`}
          icon="flame"
        />
      </div>

      <div className="page-tabs">
        <Tabs items={tabs} active={tab} onChange={setTab} label="Profile sections" />
      </div>

      {/* Overview ------------------------------------------------------- */}
      {tab === 'overview' ? (
        <TabPanel id="overview">
          {data.storyCount > 0 ? (
            <section className="page-section">
              <SectionHead
                title={isMe ? 'Your stories' : 'Stories'}
                subtitle={`${formatCount(data.storyCount)} on Scribe`}
                action={
                  data.storyCount > 5 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setTab('stories')}
                      endIcon={<Icon name="arrow-right" size="0.9em" />}
                    >
                      See all
                    </Button>
                  ) : undefined
                }
              />
              <div className="story-grid">
                {stories.data?.items.slice(0, 5).map((story) => (
                  <StoryCard key={story.id} story={story} hideAuthor />
                ))}
              </div>
            </section>
          ) : null}

          {isMe ? (
            <>
              <section className="page-section">
                <SectionHead title="Currently reading" to="/library" linkLabel="Library" />
                {reading.data?.length === 0 ? (
                  <EmptyState size="sm" icon="book-open" title="Nothing in progress" />
                ) : (
                  <ul className="mini-shelf">
                    {reading.data?.slice(0, 6).map((entry) => (
                      <li key={entry.id}>
                        <Link to={`/book/${entry.book.id}`}>
                          <StoryCover story={entry.book} size="sm" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="page-section">
                <SectionHead title="Recent badges" />
                <div className="card-grid card-grid--tight">
                  {earnedBadges.slice(0, 4).map((entry) => (
                    <BadgeTile key={entry.badge.id} entry={entry} />
                  ))}
                </div>
              </section>
            </>
          ) : data.storyCount === 0 ? (
            <EmptyState
              icon="user"
              title={`${displayName} is reading quietly`}
              description="Nothing published yet. Follow along and their stories will show up here."
            />
          ) : null}
        </TabPanel>
      ) : null}

      {/* Stories -------------------------------------------------------- */}
      {tab === 'stories' ? (
        <TabPanel id="stories">
          {stories.status === 'error' ? (
            <ErrorState message={stories.error} onRetry={stories.reload} />
          ) : stories.status === 'loading' ? (
            <Skeleton height="14rem" radius="var(--radius-lg)" />
          ) : stories.data?.items.length === 0 ? (
            <EmptyState
              icon="pen"
              title="No published stories"
              description={
                isMe
                  ? 'Your published stories will appear here.'
                  : `${displayName} hasn't published anything yet.`
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
              {stories.data?.items.map((story) => (
                <StoryCard key={story.id} story={story} hideAuthor />
              ))}
            </div>
          )}
        </TabPanel>
      ) : null}

      {/* Followers and following ---------------------------------------- */}
      {tab === 'followers' ? (
        <TabPanel id="followers">
          <PeopleList
            state={followers}
            emptyTitle={
              isMe ? 'No followers yet' : `Nobody follows ${displayName} yet`
            }
            emptyDescription={
              isMe
                ? 'Publish a story or join a club and readers will find you.'
                : undefined
            }
          />
        </TabPanel>
      ) : null}

      {tab === 'following' ? (
        <TabPanel id="following">
          <PeopleList
            state={followingList}
            emptyTitle={
              isMe ? 'You follow nobody yet' : `${displayName} follows nobody yet`
            }
            emptyDescription={
              isMe ? 'Follow an author and their new stories find you.' : undefined
            }
          />
        </TabPanel>
      ) : null}

      {/* The caller's own sections -------------------------------------- */}
      {tab === 'activity' ? (
        <TabPanel id="activity">
          <Card padded={false}>
            <ul className="activity">
              {[...(reading.data ?? []), ...(completed.data ?? [])].map((entry) => (
                <li key={entry.id}>
                  <span className="activity__icon">
                    <Icon
                      name={entry.status === 'FINISHED' ? 'check-circle' : 'book-open'}
                      size="1rem"
                    />
                  </span>
                  <span className="activity__body">
                    <span>
                      {READING_STATUS_LABELS[entry.status]}{' '}
                      <Link to={`/book/${entry.book.id}`}>{entry.book.title}</Link>
                    </span>
                    <span className="activity__when">
                      {formatRelative(entry.updatedAt)}
                    </span>
                  </span>
                </li>
              ))}
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

      {data.avatarUrl ? (
        <Lightbox
          open={viewingPicture}
          onClose={() => setViewingPicture(false)}
          src={data.avatarUrl}
          alt={`${displayName}'s profile picture`}
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
    </AppShell>
  )
}

/**
 * One side of the follow graph.
 *
 * Deliberately has no follow button of its own: the row already links to each
 * person's profile, where the button lives with the count it changes. A second
 * copy would have to keep its own optimistic state in step with that one.
 */
function PeopleList({
  state,
  emptyTitle,
  emptyDescription,
}: {
  state: ReturnType<typeof useAsync<FollowPage | null>>
  emptyTitle: string
  emptyDescription?: string
}) {
  if (state.status === 'error') {
    return <ErrorState message={state.error} onRetry={state.reload} />
  }

  if (state.status === 'loading' || !state.data) {
    return <Skeleton height="10rem" radius="var(--radius-lg)" />
  }

  if (state.data.items.length === 0) {
    return (
      <EmptyState icon="users" title={emptyTitle} description={emptyDescription} />
    )
  }

  return (
    <ul className="people-list">
      {state.data.items.map((entry) => (
        <li key={entry.user.id}>
          <Link to={`/profile/${entry.user.username}`} className="people-list__row">
            <Avatar user={entry.user} size="md" />
            <span className="people-list__text">
              <strong>{nameOf(entry.user)}</strong>
              <span>@{entry.user.username}</span>
            </span>
            {entry.isFollowing ? (
              <StatusBadge tone="neutral">Following</StatusBadge>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  )
}
