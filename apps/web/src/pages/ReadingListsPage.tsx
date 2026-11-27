import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useAuth } from '../lib/auth'
import * as listsApi from '../data/reading-lists-api'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Tabs } from '../components/ui/Tabs'
import { EmptyState, ErrorState } from '../components/ui/States'
import { ListCard, ListCardSkeleton } from '../components/lists/ListCard'
import { ListFormDialog } from '../components/lists/ListFormDialog'
import { MAX_LISTS_PER_USER, type ReadingListPage } from '../types/reading-lists'
import './pages.css'

const TABS = ['popular', 'recent', 'mine', 'following'] as const

type Tab = (typeof TABS)[number]

/** Lists per page when browsing; an owner's lists come whole. */
const PAGE_SIZE = 24

function isTab(value: string | null): value is Tab {
  return (TABS as readonly string[]).includes(value ?? '')
}

/**
 * Reading lists: the public ones to browse, the reader's own, and the ones
 * they follow. The tab lives in the URL (`?tab=mine`) so "Manage your lists"
 * in the Add to list dialog can open straight onto the reader's own.
 */
export function ReadingListsPage() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab: Tab = isTab(params.get('tab')) ? (params.get('tab') as Tab) : 'popular'
  const username = session?.user.username ?? ''

  const [page, setPage] = useState({ tab, number: 1 })
  if (page.tab !== tab) setPage({ tab, number: 1 })

  const lists = useAsync((): Promise<ReadingListPage> => {
    if (tab === 'mine') {
      return listsApi.listReadingLists({ owner: username, limit: MAX_LISTS_PER_USER })
    }
    if (tab === 'following') {
      return listsApi.listReadingLists({ followed: true, limit: 48 })
    }
    return listsApi.listReadingLists({ sort: tab, page: page.number, limit: PAGE_SIZE })
  }, [tab, username, page.number])

  const [creating, setCreating] = useState(false)
  // Re-keys the dialog so each opening starts empty.
  const [dialogKey, setDialogKey] = useState(0)

  function openCreate() {
    setDialogKey((key) => key + 1)
    setCreating(true)
  }

  const data = lists.data
  const items = data?.items ?? []

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Reading lists</h1>
          <p className="page-head__sub">
            Stories gathered by readers around a theme — follow a list and hear
            when something new is added.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate} startIcon={<Icon name="plus" size="1em" />}>
          New list
        </Button>
      </header>

      <Tabs
        items={[
          { id: 'popular', label: 'Popular' },
          { id: 'recent', label: 'Recently updated' },
          { id: 'mine', label: 'Your lists' },
          { id: 'following', label: 'Following' },
        ]}
        active={tab}
        onChange={(next) => setParams(next === 'popular' ? {} : { tab: next }, { replace: true })}
        label="Reading lists"
      />

      <div className="page-section">
        {lists.status === 'error' ? (
          <ErrorState message={lists.error} onRetry={lists.reload} />
        ) : lists.status === 'loading' && !data ? (
          <div className="card-grid card-grid--wide" aria-busy="true">
            {Array.from({ length: 4 }, (_, index) => (
              <ListCardSkeleton key={index} />
            ))}
          </div>
        ) : items.length === 0 ? (
          tab === 'mine' ? (
            <EmptyState
              icon="list"
              title="No lists yet"
              description="Start one, then add stories from any story's page with Add to list."
              action={
                <Button variant="primary" onClick={openCreate}>
                  New list
                </Button>
              }
            />
          ) : tab === 'following' ? (
            <EmptyState
              icon="list"
              title="You follow no lists yet"
              description="Follow a list and you'll hear when a story is added to it."
              action={
                <Button onClick={() => setParams({}, { replace: true })}>Browse popular lists</Button>
              }
            />
          ) : (
            <EmptyState
              icon="list"
              title="No public lists yet"
              description="Be the first: gather a few stories you love and make the list public."
              action={
                <Button variant="primary" onClick={openCreate}>
                  New list
                </Button>
              }
            />
          )
        ) : (
          <>
            <div className="card-grid card-grid--wide">
              {items.map((list) => (
                <ListCard key={list.id} list={list} hideOwner={tab === 'mine'} />
              ))}
            </div>

            {(tab === 'popular' || tab === 'recent') && data && data.totalPages > 1 ? (
              <div className="list-pager">
                <Button
                  variant="ghost"
                  disabled={page.number <= 1 || lists.status === 'loading'}
                  onClick={() => setPage({ tab, number: page.number - 1 })}
                  startIcon={<Icon name="chevron-left" size="1em" />}
                >
                  Previous
                </Button>
                <span className="list-pager__label">
                  Page {data.page} of {data.totalPages}
                </span>
                <Button
                  variant="ghost"
                  disabled={!data.hasMore || lists.status === 'loading'}
                  onClick={() => setPage({ tab, number: page.number + 1 })}
                  endIcon={<Icon name="chevron-right" size="1em" />}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <ListFormDialog
        key={dialogKey}
        open={creating}
        onClose={() => setCreating(false)}
        list={null}
        onSaved={(list) => {
          setCreating(false)
          navigate(`/lists/${list.slug}`)
        }}
      />
    </>
  )
}
