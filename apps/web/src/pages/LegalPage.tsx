import { Link } from 'react-router-dom'
import { formatDate } from '../lib/format'
import { PRIVACY, TERMS, type LegalDocument } from '../data/legal-content'
import { PublicShell } from '../components/layout/PublicShell'
import './legal.css'

/**
 * A legal document, rendered for reading rather than for scrolling past: one
 * measured column, numbered sections, and a contents list that stays put on
 * wide screens.
 */
function LegalDocumentView({ document }: { document: LegalDocument }) {
  return (
    <PublicShell>
      <div className="container legal">
        <header className="legal__head">
          <p className="legal__eyebrow">Legal</p>
          <h1 className="legal__title">{document.title}</h1>
          <p className="legal__summary">{document.summary}</p>
          <p className="legal__updated">
            Last updated{' '}
            <time dateTime={document.updatedAt}>{formatDate(document.updatedAt)}</time>
          </p>
        </header>

        <div className="legal__layout">
          <nav className="legal__toc" aria-label="On this page">
            <p className="legal__toc-label">On this page</p>
            <ol className="legal__toc-list">
              {document.sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`}>{section.heading}</a>
                </li>
              ))}
            </ol>
          </nav>

          <article className="legal__body">
            {document.sections.map((section, index) => (
              <section
                className="legal__section"
                key={section.id}
                id={section.id}
                aria-labelledby={`${section.id}-heading`}
              >
                <h2 className="legal__heading" id={`${section.id}-heading`}>
                  <span className="legal__number" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  {section.heading}
                </h2>

                {section.body.map((paragraph) => (
                  <p key={paragraph.slice(0, 40)}>{paragraph}</p>
                ))}

                {section.list ? (
                  <ul className="legal__list">
                    {section.list.map((item) => (
                      <li key={item.slice(0, 40)}>{item}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))}

            <footer className="legal__foot">
              <p>
                {document.title === TERMS.title ? (
                  <>
                    See also our <Link to="/privacy">Privacy Policy</Link>.
                  </>
                ) : (
                  <>
                    See also our <Link to="/terms">Terms of Service</Link>.
                  </>
                )}
              </p>
            </footer>
          </article>
        </div>
      </div>
    </PublicShell>
  )
}

export function TermsPage() {
  return <LegalDocumentView document={TERMS} />
}

export function PrivacyPage() {
  return <LegalDocumentView document={PRIVACY} />
}
