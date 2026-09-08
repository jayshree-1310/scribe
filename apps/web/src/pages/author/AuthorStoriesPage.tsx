import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '../../hooks/useAsync'
import { useToast } from '../../lib/toast'
import { formatCount, formatRating, formatRelative } from '../../lib/format'
import * as api from '../../data/api'
import type { StoryWithMeta } from '../../types/domain'
import { AppShell } from '../../components/layout/AppShell'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { StatusBadge } from '../../components/ui/Chip'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { DropdownMenu, MenuItem, MenuSeparator } from '../../components/ui/DropdownMenu'
import { Icon } from '../../components/ui/Icon'
import { Skeleton } from '../../components/ui/Skeleton'
import { EmptyState, ErrorState } from '../../components/ui/States'
import { StoryCover } from '../../components/story/StoryCover'
import '../pages.css'
import './author.css'

export function AuthorStoriesPage() {
  const stories = useAsync(() => api.getMyStories(), [])
  const { showToast } = useToast()

  const [pendingDelete, setPendingDelete] = useState<StoryWithMeta | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [removed, setRemoved] = useState<Set<string>>(new Set())

  const shown = stories.data?.filter((story) => !removed.has(story.id)) ?? []

  async function onDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 500))
      setRemoved((current) => new Set(current).add(pendingDelete.id))
      showToast({ message: `“${pendingDelete.title}” deleted.` })
      setPendingDelete(null)
    } catch {
      showToast({ tone: 'error', message: 'We could not delete that story.' })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AppShell variant="author">
      <header className="page-head">
        <div>
          <h1 className="page-head__title">My stories</h1>
          <p className="page-head__sub">Drafts, works in progress and everything published.</p>
        </div>
        <ButtonLink
          variant="primary"
          to="/author/stories/new"
          startIcon={<Icon name="plus" size="1em" />}
        >
          Create New Story
        </ButtonLink>
      </header>

      {stories.status === 'error' ? (
        <ErrorState message={stories.error} onRetry={stories.reload} />
      ) : stories.status === 'loading' ? (
        <Skeleton height="16rem" radius="var(--radius-lg)" />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="pen"
          title="No stories yet"
          description="Every story starts as a draft nobody can see. Begin whenever you like."
          action={
            <ButtonLink variant="primary" to="/author/stories/new">
              Create your first story
            </ButtonLink>
          }
        />
      ) : (
        <Card padded={false} className="table-card">
          {/*
            A real table on desktop for scanning columns; each row becomes a
            stacked card under 56rem, with the column name as a label.
          */}
          <table className="data-table">
            <caption className="visually-hidden">Your stories</caption>
            <thead>
              <tr>
                <th scope="col">Story</th>
                <th scope="col">Status</th>
                <th scope="col">Chapters</th>
                <th scope="col">Views</th>
                <th scope="col">Rating</th>
                <th scope="col">Updated</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((story) => (
                <tr key={story.id}>
                  <td data-label="Story">
                    <Link className="data-table__story" to={`/author/stories/${story.slug}`}>
                      <StoryCover story={story} size="xs" />
                      <span>
                        <strong>{story.title}</strong>
                        <span>{story.genres.map((genre) => genre.name).join(' · ')}</span>
                      </span>
                    </Link>
                  </td>
                  <td data-label="Status">
                    <StatusBadge tone={story.status === 'completed' ? 'success' : 'brand'}>
                      {story.status}
                    </StatusBadge>
                  </td>
                  <td data-label="Chapters">{story.chapterCount}</td>
                  <td data-label="Views">{formatCount(story.viewCount)}</td>
                  <td data-label="Rating">
                    <span className="data-table__rating">
                      <Icon name="star-filled" size="0.85em" />
                      {formatRating(story.ratingAverage)}
                    </span>
                  </td>
                  <td data-label="Updated">{formatRelative(story.updatedAt)}</td>
                  <td data-label="Actions">
                    <div className="data-table__actions">
                      <ButtonLink size="sm" to={`/author/stories/${story.slug}`}>
                        Edit
                      </ButtonLink>
                      <DropdownMenu
                        label={`Actions for ${story.title}`}
                        trigger={(props) => (
                          <Button
                            {...props}
                            variant="ghost"
                            size="sm"
                            iconOnly
                            aria-label={`More actions for ${story.title}`}
                            startIcon={<Icon name="more" />}
                          />
                        )}
                      >
                        <MenuItem icon={<Icon name="eye" size="1rem" />}>
                          <Link to={`/story/${story.slug}`}>View public page</Link>
                        </MenuItem>
                        <MenuItem icon={<Icon name="trend" size="1rem" />}>
                          <Link to="/author/analytics">Analytics</Link>
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          icon={<Icon name="trash" size="1rem" />}
                          tone="danger"
                          onSelect={() => setPendingDelete(story)}
                        >
                          Delete story
                        </MenuItem>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this story?"
        message={`“${pendingDelete?.title ?? ''}” and all of its chapters will be permanently deleted. Readers will lose their progress. This cannot be undone.`}
        confirmLabel="Delete story"
        pending={deleting}
        onConfirm={onDelete}
        onCancel={() => {
          if (!deleting) setPendingDelete(null)
        }}
      />
    </AppShell>
  )
}
