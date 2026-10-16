import { useEffect, useState } from 'react'
import * as aiApi from '../../data/ai-api'
import { ApiError } from '../../lib/api-client'
import { formatRelative } from '../../lib/format'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import './continuity.css'

/**
 * Possible contradictions between this chapter and the rest of the story.
 *
 * Four rules, each of them a way this could have been annoying:
 *
 * - **It never blocks anything.** These are warnings beside the chapter, not
 *   in front of it. Saving and publishing do not wait for a check or look at
 *   its result.
 * - **Both pieces of evidence are always shown** — what this chapter says and
 *   what the other one says, each in the story's own words — so an author can
 *   judge a warning in a second instead of taking a model's word for it.
 * - **A warning can be dismissed for good.** "Not a mistake" is remembered by
 *   the pair of claims, so a deliberate reveal is flagged once, not on every
 *   save.
 * - **It says when it is out of date.** The check runs about a minute after
 *   the author stops writing; until then what is listed describes an older
 *   draft, and says so.
 *
 * Renders nothing for a story with no bible: there is nothing to be
 * inconsistent with, and an empty panel would be an advert, not a tool.
 */

/**
 * How long after a save to look again. The server checks a quiet minute after
 * the last save; a little over that is when its answer is there to read.
 */
const RECHECK_AFTER_SAVE_MS = 70_000

interface ContinuityPanelProps {
  /** Null until the chapter has been saved once. */
  chapterId: string | null
  /** When the editor last saved, so the panel knows to look again. */
  savedAt: string | null
  /** True while the editor holds changes the server has not seen. */
  unsaved: boolean
  /** Opens the chapter a contradicted fact came from. */
  onOpenChapter: (chapterId: string) => void
}

function claimLine(side: { subject: string; attribute: string; value: string }): string {
  return `${side.subject} — ${side.attribute}: ${side.value}`
}

export function ContinuityPanel({
  chapterId,
  savedAt,
  unsaved,
  onOpenChapter,
}: ContinuityPanelProps) {
  /**
   * What the server last said, tagged with the chapter it said it about.
   *
   * Tagged rather than cleared on a chapter switch: `state` below is derived
   * from the tag, so the previous chapter's warnings can never be shown under
   * this one, and nothing has to be reset in an effect to guarantee it.
   */
  const [loaded, setLoaded] = useState<{
    chapterId: string
    data: aiApi.ChapterContinuity
  } | null>(null)
  const [checking, setChecking] = useState(false)
  const [dismissing, setDismissing] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ chapterId: string; message: string } | null>(
    null,
  )

  const state = loaded && loaded.chapterId === chapterId ? loaded.data : null
  const error = failure && failure.chapterId === chapterId ? failure.message : null

  /**
   * Reads the stored findings: when the chapter opens, straight after a save
   * (so "this describes an older draft" appears at once), and again when the
   * server's own check of that save should have finished.
   */
  useEffect(() => {
    if (!chapterId) return

    let active = true
    const read = () => {
      aiApi
        .getChapterContinuity(chapterId)
        .then((data) => {
          if (active) setLoaded({ chapterId, data })
        })
        .catch(() => {
          // A panel of warnings that cannot load is not itself worth a
          // warning: the chapter is fine, and the next save tries again.
        })
    }

    read()
    const timer = savedAt ? window.setTimeout(read, RECHECK_AFTER_SAVE_MS) : null

    return () => {
      active = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [chapterId, savedAt])

  if (!chapterId || !state || !state.enabled) return null

  async function onCheck() {
    if (!chapterId) return

    setChecking(true)
    setFailure(null)
    try {
      const data = await aiApi.checkChapterContinuity(chapterId)
      setLoaded({ chapterId, data })
    } catch (cause) {
      setFailure({
        chapterId,
        message:
          cause instanceof ApiError
            ? cause.message
            : 'The check could not run just now.',
      })
    } finally {
      setChecking(false)
    }
  }

  async function onDismiss(findingId: string) {
    if (!chapterId) return

    setDismissing(findingId)
    setFailure(null)
    try {
      await aiApi.dismissContinuityFinding(findingId)
      setLoaded((previous) =>
        previous
          ? {
              ...previous,
              data: {
                ...previous.data,
                findings: previous.data.findings.filter(
                  (item) => item.id !== findingId,
                ),
              },
            }
          : previous,
      )
    } catch (cause) {
      setFailure({
        chapterId,
        message:
          cause instanceof ApiError ? cause.message : 'That could not be dismissed.',
      })
    } finally {
      setDismissing(null)
    }
  }

  const { check, findings } = state

  const status = !check
    ? 'Not checked yet. It is checked about a minute after you stop writing.'
    : check.outcome === 'failed'
      ? 'The last check could not run. It will try again after your next save.'
      : check.stale
        ? 'The chapter has changed since this check. It will be checked again about a minute after you stop writing.'
        : findings.length === 0
          ? `No contradictions found${check.checkedAt ? ` · checked ${formatRelative(check.checkedAt)}` : ''}.`
          : `Checked ${check.checkedAt ? formatRelative(check.checkedAt) : 'recently'} against ${check.compared} ${check.compared === 1 ? 'fact' : 'facts'} from your other chapters.`

  return (
    <section className="continuity" aria-label="Continuity check">
      <header className="continuity__head">
        <Icon name="shield" className="continuity__mark" size="1rem" />
        <h3 className="continuity__title">Continuity</h3>
        <span className="continuity__badge">AI check</span>
        <Button
          size="sm"
          variant="ghost"
          loading={checking}
          disabled={unsaved}
          title={unsaved ? 'Checks the saved chapter — save first.' : undefined}
          onClick={() => void onCheck()}
        >
          Check now
        </Button>
      </header>

      <p className="continuity__status">{status}</p>

      {error ? (
        <p className="continuity__error" role="alert">
          <Icon name="alert" size="0.95em" />
          {error}
        </p>
      ) : null}

      {findings.length > 0 ? (
        <ul className="continuity__list">
          {findings.map((finding) => (
            <li key={finding.id} className="continuity__finding">
              <p className="continuity__explanation">{finding.explanation}</p>

              <div className="continuity__evidence">
                <div className="continuity__side">
                  <h4 className="continuity__side-head">This chapter</h4>
                  <p className="continuity__claim">{claimLine(finding.claim)}</p>
                  {finding.claim.quote ? (
                    <blockquote className="continuity__quote">
                      {finding.claim.quote}
                    </blockquote>
                  ) : null}
                </div>

                <div className="continuity__side">
                  <h4 className="continuity__side-head">
                    {finding.fact.chapterId && finding.fact.chapterNumber !== null ? (
                      <button
                        type="button"
                        className="continuity__link"
                        onClick={() => onOpenChapter(finding.fact.chapterId as string)}
                      >
                        Chapter {finding.fact.chapterNumber}
                        {finding.fact.chapterTitle ? `: ${finding.fact.chapterTitle}` : ''}
                      </button>
                    ) : (
                      'Your story bible'
                    )}
                    {finding.fact.origin === 'author' ? (
                      <span className="continuity__confirmed">confirmed by you</span>
                    ) : null}
                  </h4>
                  <p className="continuity__claim">{claimLine(finding.fact)}</p>
                  {finding.fact.quote ? (
                    <blockquote className="continuity__quote">
                      {finding.fact.quote}
                    </blockquote>
                  ) : null}
                </div>
              </div>

              <div className="continuity__actions">
                <span className="continuity__confidence">
                  {finding.confidence}% sure
                </span>
                <Button
                  size="sm"
                  loading={dismissing === finding.id}
                  onClick={() => void onDismiss(finding.id)}
                >
                  Not a mistake
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
