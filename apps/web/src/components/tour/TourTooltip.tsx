import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { ScribeMark } from '../layout/Logo'
import type { TourStep } from './tour-config'

interface TourTooltipProps {
  step: TourStep
  index: number
  total: number
  direction: 1 | -1
  titleId: string
  descriptionId: string
  onNext: () => void
  onBack: () => void
  onSkip: () => void
  onFinish: () => void
  onRestart: () => void
  onExplore: () => void
}

/**
 * What the card says: the step's title and description, how far along the
 * tour is, and the controls.
 *
 * Only the text is keyed on the step, so it slides in on each one while the
 * controls stay mounted -- and with them keyboard focus, for somebody pressing
 * Enter on Next over and over.
 */
export function TourTooltip({
  step,
  index,
  total,
  direction,
  titleId,
  descriptionId,
  onNext,
  onBack,
  onSkip,
  onFinish,
  onRestart,
  onExplore,
}: TourTooltipProps) {
  const first = index === 0
  const last = index === total - 1

  return (
    <div className="tour__tooltip" data-hero={step.target === null ? '' : undefined}>
      <div
        className="tour__text"
        key={step.id}
        data-direction={direction === 1 ? 'forward' : 'back'}
      >
        {first ? (
          <span className="tour__badge tour__badge--mark" aria-hidden="true">
            <ScribeMark />
          </span>
        ) : null}
        {last ? (
          <span className="tour__badge tour__badge--done" aria-hidden="true">
            <Icon name="check-circle" size="1.6rem" />
          </span>
        ) : null}

        <h2 className="tour__title" id={titleId}>
          {step.title}
        </h2>
        <p className="tour__description" id={descriptionId}>
          {step.description}
        </p>
      </div>

      {last ? (
        <TourFinaleControls onFinish={onFinish} onRestart={onRestart} onExplore={onExplore} />
      ) : (
        <TourControls
          index={index}
          total={total}
          onNext={onNext}
          onBack={onBack}
          onSkip={onSkip}
        />
      )}
    </div>
  )
}

/** Where the reader is: "4 of 16". */
function TourProgress({ index, total }: { index: number; total: number }) {
  return (
    <span className="tour__count">
      {index + 1} of {total}
    </span>
  )
}

interface TourControlsProps {
  index: number
  total: number
  onNext: () => void
  onBack: () => void
  onSkip: () => void
}

function TourControls({ index, total, onNext, onBack, onSkip }: TourControlsProps) {
  return (
    <div className="tour__controls">
      <TourProgress index={index} total={total} />

      <button
        type="button"
        className="tour__skip"
        onClick={onSkip}
        aria-label="Skip product tour"
      >
        Skip tour
      </button>

      {index > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={onBack}
          aria-label="Back to the previous tour step"
        >
          Back
        </Button>
      ) : null}

      <Button
        size="sm"
        variant="primary"
        onClick={onNext}
        aria-label="Next tour step"
        data-tour-primary=""
        endIcon={<Icon name="arrow-right" size="1em" />}
      >
        Next
      </Button>
    </div>
  )
}

interface TourFinaleControlsProps {
  onFinish: () => void
  onRestart: () => void
  onExplore: () => void
}

function TourFinaleControls({ onFinish, onRestart, onExplore }: TourFinaleControlsProps) {
  return (
    <>
      <div className="tour__controls tour__controls--finale">
        <Button
          size="sm"
          onClick={onRestart}
          startIcon={<Icon name="retry" size="1em" />}
        >
          Take tour again
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={onFinish}
          aria-label="Finish tour"
          data-tour-primary=""
        >
          Finish
        </Button>
      </div>

      <button type="button" className="tour__explore" onClick={onExplore}>
        Explore Scribe
        <Icon name="arrow-right" size="1em" />
      </button>
    </>
  )
}
