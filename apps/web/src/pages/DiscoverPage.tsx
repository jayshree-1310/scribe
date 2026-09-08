import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { formatCount } from '../lib/format'
import * as api from '../data/api'
import {
  DISCOVER_SORTS,
  DISCOVER_SORT_LABELS,
  type DiscoverSort,
  type StoryStatus,
} from '../types/domain'
import { AppShell } from '../components/layout/AppShell'
import { Button } from '../components/ui/Button'
import { SelectableChip } from '../components/ui/Chip'
import { Icon } from '../components/ui/Icon'
import { Select } from '../components/ui/Select'
import { Switch } from '../components/ui/Checkbox'
import { TextField } from '../components/ui/TextField'
import { EmptyState, ErrorState } from '../components/ui/States'
import { StoryCard, StoryCardSkeleton } from '../components/story/StoryCard'
import './pages.css'

const STATUS_OPTIONS: ReadonlyArray<{ value: StoryStatus | 'all'; label: string }> = [
  { value: 'all', label: 'Any status' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'completed', label: 'Completed' },
  { value: 'hiatus', label: 'On hiatus' },
]

const SORT_OPTIONS = DISCOVER_SORTS.map((sort) => ({
  value: sort,
  label: DISCOVER_SORT_LABELS[sort],
}))

function isSort(value: string | null): value is DiscoverSort {
  return value !== null && (DISCOVER_SORTS as readonly string[]).includes(value)
}

export function DiscoverPage() {
  const [params, setParams] = useSearchParams()

  const [search, setSearch] = useState(params.get('q') ?? '')
  const [sort, setSort] = useState<DiscoverSort>(
    isSort(params.get('sort')) ? (params.get('sort') as DiscoverSort) : 'trending',
  )
  const [status, setStatus] = useState<StoryStatus | 'all'>('all')
  const [kidsOnly, setKidsOnly] = useState(false)
  const [genreSlug, setGenreSlug] = useState<string | null>(params.get('genre'))
  const [showFilters, setShowFilters] = useState(false)

  const debouncedSearch = useDebouncedValue(search, 250)
  const genres = useAsync(() => api.getGenres(), [])

  const genreId = useMemo(
    () => genres.data?.find((genre) => genre.slug === genreSlug)?.id ?? null,
    [genres.data, genreSlug],
  )

  const results = useAsync(
    () =>
      api.discoverStories({
        search: debouncedSearch,
        genreId,
        sort,
        status,
        kidsOnly,
      }),
    [debouncedSearch, genreId, sort, status, kidsOnly],
  )

  /** Keeps the URL shareable as filters change. */
  function syncParams(next: { q?: string; sort?: string; genre?: string | null }) {
    const updated = new URLSearchParams(params)
    for (const [key, value] of Object.entries(next)) {
      if (value) updated.set(key, value)
      else updated.delete(key)
    }
    setParams(updated, { replace: true })
  }

  const activeFilterCount =
    (genreSlug ? 1 : 0) + (status !== 'all' ? 1 : 0) + (kidsOnly ? 1 : 0)

  function clearFilters() {
    setGenreSlug(null)
    setStatus('all')
    setKidsOnly(false)
    syncParams({ genre: null })
  }

  return (
    <AppShell>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Discover</h1>
          <p className="page-head__sub">
            {formatCount(91400)} stories across {genres.data?.length ?? 10} genres.
          </p>
        </div>
      </header>

      {/* Filter bar: one row above the results ------------------------- */}
      <div className="filters">
        <div className="filters__row">
          <TextField
            label="Search stories"
            hideLabel
            type="search"
            placeholder="Search titles, authors, genres…"
            value={search}
            startIcon={<Icon name="search" size="1.05rem" />}
            onChange={(event) => {
              setSearch(event.target.value)
              syncParams({ q: event.target.value })
            }}
          />

          <Select
            label="Sort by"
            hideLabel
            value={sort}
            options={SORT_OPTIONS}
            onChange={(next) => {
              setSort(next)
              syncParams({ sort: next })
            }}
          />

          <Button
            variant={activeFilterCount > 0 ? 'primary' : 'secondary'}
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
            startIcon={<Icon name="sliders" size="1em" />}
          >
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>
        </div>

        {showFilters ? (
          <div className="filters__panel">
            <div className="filters__group">
              <p className="filters__label">Genre</p>
              <div className="chip-row">
                {genres.data?.map((genre) => (
                  <SelectableChip
                    key={genre.id}
                    hue={genre.hue}
                    selected={genreSlug === genre.slug}
                    onToggle={() => {
                      const next = genreSlug === genre.slug ? null : genre.slug
                      setGenreSlug(next)
                      syncParams({ genre: next })
                    }}
                  >
                    {genre.name}
                  </SelectableChip>
                ))}
              </div>
            </div>

            <div className="filters__group filters__group--inline">
              <Select
                label="Status"
                value={status}
                options={STATUS_OPTIONS}
                onChange={setStatus}
                size="sm"
              />
              <Switch
                checked={kidsOnly}
                onChange={setKidsOnly}
                label="Kid-appropriate only"
              />
              {activeFilterCount > 0 ? (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <p className="filters__summary" aria-live="polite">
          {results.status === 'ready'
            ? `${results.data?.length ?? 0} ${results.data?.length === 1 ? 'story' : 'stories'}`
            : ''}
        </p>
      </div>

      {/* Results -------------------------------------------------------- */}
      {results.status === 'error' ? (
        <ErrorState message={results.error} onRetry={results.reload} />
      ) : results.status === 'loading' ? (
        <div className="story-grid">
          {Array.from({ length: 10 }, (_, index) => (
            <StoryCardSkeleton key={index} />
          ))}
        </div>
      ) : results.data?.length === 0 ? (
        <EmptyState
          icon="search"
          title="No stories match those filters"
          description={
            debouncedSearch.trim()
              ? `Nothing for “${debouncedSearch.trim()}”. Try a different word or clear your filters.`
              : 'Try widening your filters — there is plenty out there.'
          }
          action={
            <Button
              onClick={() => {
                setSearch('')
                clearFilters()
                syncParams({ q: '' })
              }}
            >
              Reset search
            </Button>
          }
        />
      ) : (
        <div className="story-grid">
          {results.data?.map((story) => (
            <StoryCard key={story.id} story={story} />
          ))}
        </div>
      )}
    </AppShell>
  )
}
