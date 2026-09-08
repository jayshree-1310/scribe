import { useState } from 'react'
import { useAsync } from '../hooks/useAsync'
import { formatPercent, formatRelative } from '../lib/format'
import * as api from '../data/api'
import type { LibraryShelf } from '../types/domain'
import { AppShell } from '../components/layout/AppShell'
import { ButtonLink } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { ProgressBar } from '../components/ui/Progress'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { StoryCardSkeleton } from '../components/story/StoryCard'
import { StoryCover } from '../components/story/StoryCover'
import { Link } from 'react-router-dom'
import './pages.css'

type Shelf = LibraryShelf | 'bookmarks'

const TABS = [
  { id: 'reading' as const, label: 'Currently reading' },
  { id: 'completed' as const, label: 'Completed' },
  { id: 'saved' as const, label: 'Saved' },
  { id: 'bookmarks' as const, label: 'Bookmarks' },
]

const EMPTY_COPY: Record<Shelf, { title: string; description: string }> = {
  reading: {
    title: 'Nothing in progress',
    description: 'Stories you start will show up here with your place kept.',
  },
  completed: {
    title: 'No finished stories yet',
    description: 'Everything you read to the end lands here.',
  },
  saved: {
    title: 'Nothing saved',
    description: 'Save a story from its page to read it later.',
  },
  bookmarks: {
    title: 'No bookmarks',
    description: 'Bookmark a chapter while reading to jump back to it.',
  },
}

export function LibraryPage() {
  const [shelf, setShelf] = useState<Shelf>('reading')
  const entries = useAsync(() => api.getLibrary(shelf), [shelf])

  return (
    <AppShell>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">My library</h1>
          <p className="page-head__sub">
            Everything you're reading, everything you've finished, and everything
            you meant to get to.
          </p>
        </div>
        <ButtonLink to="/discover" startIcon={<Icon name="plus" size="1em" />}>
          Add a story
        </ButtonLink>
      </header>

      <div className="page-tabs">
        <Tabs items={TABS} active={shelf} onChange={setShelf} label="Library shelves" />
      </div>

      <TabPanel id={shelf}>
        {entries.status === 'error' ? (
          <ErrorState message={entries.error} onRetry={entries.reload} />
        ) : entries.status === 'loading' ? (
          <div className="row-list">
            {Array.from({ length: 3 }, (_, index) => (
              <div className="card card--padded" key={index}>
                <StoryCardSkeleton variant="row" />
              </div>
            ))}
          </div>
        ) : entries.data?.length === 0 ? (
          <EmptyState
            icon={shelf === 'bookmarks' ? 'bookmark' : 'library'}
            title={EMPTY_COPY[shelf].title}
            description={EMPTY_COPY[shelf].description}
            action={
              <ButtonLink variant="primary" to="/discover">
                Discover stories
              </ButtonLink>
            }
          />
        ) : (
          <ul className="library">
            {entries.data?.map(({ history, story, chapter }) => (
              <li className="library__row" key={history.id}>
                <Link to={`/story/${story.slug}`} className="library__cover" tabIndex={-1} aria-hidden="true">
                  <StoryCover story={story} size="sm" />
                </Link>

                <div className="library__body">
                  <h3 className="library__title">
                    <Link to={`/story/${story.slug}`}>{story.title}</Link>
                  </h3>
                  <p className="library__author">{story.author.displayName}</p>

                  <p className="library__chapter">
                    <Icon name="book-open" size="0.9em" />
                    Chapter {chapter.number} — {chapter.title}
                    {history.bookmarked ? (
                      <span className="library__flag">
                        <Icon name="bookmark-filled" size="0.85em" />
                        Bookmarked
                      </span>
                    ) : null}
                  </p>

                  <div className="library__progress">
                    <ProgressBar
                      value={history.storyProgress}
                      tone={history.storyProgress >= 1 ? 'success' : 'brand'}
                      label={`${formatPercent(history.storyProgress)} complete`}
                    />
                    <span>{formatPercent(history.storyProgress)}</span>
                  </div>
                </div>

                <div className="library__actions">
                  <ButtonLink
                    variant={history.storyProgress >= 1 ? 'secondary' : 'primary'}
                    size="sm"
                    to={`/read/${story.slug}/${chapter.number}`}
                  >
                    {history.storyProgress >= 1 ? 'Read again' : 'Continue'}
                  </ButtonLink>
                  <span className="library__when">{formatRelative(history.lastReadAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </TabPanel>
    </AppShell>
  )
}
