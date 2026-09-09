import { useAsync } from '../hooks/useAsync'
import * as api from '../data/api'
import { Logo } from '../components/layout/Logo'
import { StoryCover } from '../components/story/StoryCover'
import { Skeleton } from '../components/ui/Skeleton'

const COPY = {
  login: {
    statement: 'Everything you were reading is still open.',
    lede: 'Your shelves, your streak, your margins — waiting exactly where you left them.',
    quote:
      'The tide went out further than it had any right to, and kept going, until the seabed lay open like a book nobody had asked to have read aloud.',
    attribution: 'The Salt-Glass Coast — Chapter 14',
  },
  register: {
    statement: 'A quiet place to read, and to be read.',
    lede: 'Follow serials chapter by chapter, keep what moved you, and publish in public when you are ready.',
    quote:
      'She wrote it all down because writing it down was the only way she knew to make a thing stop happening to her and start being hers.',
    attribution: 'The Ledger Keepers — Chapter 3',
  },
} as const

/**
 * The editorial half of the auth screens. It deliberately shows real covers
 * pulled from the same API the signed-in app uses, rather than a stock
 * illustration — the first screen should already look like the product.
 */
export function AuthAside({ variant }: { variant: keyof typeof COPY }) {
  const stories = useAsync(() => api.getTrendingStories(3), [])
  const copy = COPY[variant]

  return (
    <aside className="auth__aside" aria-label="About Scribe">
      <div className="auth__aside-inner">
        <Logo to="/" className="auth__aside-logo" />

        <div className="auth__statement">
          <h2>{copy.statement}</h2>
          <p>{copy.lede}</p>

          <div className="auth__covers" aria-hidden="true">
            {stories.data
              ? stories.data.map((story, index) => (
                  <div className="auth__cover" key={story.id} data-index={index}>
                    <StoryCover story={story} size="lg" />
                  </div>
                ))
              : [0, 1, 2].map((index) => (
                  <div className="auth__cover" key={index} data-index={index}>
                    <Skeleton
                      className="auth__cover-skeleton"
                      width="100%"
                      height="100%"
                      radius="var(--radius-sm)"
                    />
                  </div>
                ))}
          </div>
        </div>

        <figure className="auth__quote">
          <blockquote>{copy.quote}</blockquote>
          <figcaption>{copy.attribution}</figcaption>
        </figure>
      </div>
    </aside>
  )
}
