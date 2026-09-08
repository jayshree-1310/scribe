import { useAsync } from '../hooks/useAsync'
import * as api from '../data/api'
import { Logo } from '../components/layout/Logo'
import { StoryCover } from '../components/story/StoryCover'
import { Icon } from '../components/ui/Icon'

const COPY = {
  login: {
    quote:
      'The tide went out further than it had any right to, and kept going, until the seabed lay open like a book nobody had asked to have read aloud.',
    attribution: 'The Salt-Glass Coast — Chapter 14',
  },
  register: {
    quote:
      'She wrote it all down because writing it down was the only way she knew to make a thing stop happening to her and start being hers.',
    attribution: 'The Ledger Keepers — Chapter 3',
  },
} as const

/**
 * The editorial half of the auth screens: real covers and a passage from a
 * story on Scribe, rather than a generic product illustration.
 */
export function AuthAside({ variant }: { variant: keyof typeof COPY }) {
  const stories = useAsync(() => api.getTrendingStories(3), [])
  const copy = COPY[variant]

  return (
    <aside className="auth__aside" aria-label="About Scribe">
      <div className="auth__aside-inner">
        <Logo to="/" size="lg" className="auth__aside-logo" />

        <blockquote className="auth__quote">
          <Icon name="quote" size="1.5rem" />
          <p>{copy.quote}</p>
          <footer>{copy.attribution}</footer>
        </blockquote>

        <div className="auth__covers" aria-hidden="true">
          {stories.data?.map((story, index) => (
            <div className="auth__cover" key={story.id} data-index={index}>
              <StoryCover story={story} size="lg" />
            </div>
          ))}
        </div>

        <p className="auth__aside-foot">
          Join 2.4M readers · 91,400 stories · free to read and publish
        </p>
      </div>
    </aside>
  )
}
