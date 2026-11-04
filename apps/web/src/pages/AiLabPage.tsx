import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  askAgent,
  chat,
  streamChat,
  type AgentAnswer,
  type ChatUsage,
} from '../data/ai-api'
import { ApiError } from '../lib/api-client'
import { Button } from '../components/ui/Button'
import { Card, SectionHead } from '../components/ui/Card'
import { Icon } from '../components/ui/Icon'
import { SegmentedControl } from '../components/ui/Tabs'
import { TextField } from '../components/ui/TextField'
import './pages.css'
import './ai-lab.css'

/**
 * The AI workbench: one prompt, one reply, and what it cost.
 *
 * Mounted only in development (see `App.tsx`) because it is a tool for
 * building the next AI feature rather than a feature itself. It is the
 * shortest path to the model — no retrieval, no schema, no context window — so
 * when something is slow, refused or malformed, this is where you find out
 * whether the provider or the feature is responsible.
 *
 * It does not need to be pretty. Its loading, error and cancellation states do
 * need to be real, because those are exactly the states it exists to expose:
 * a 3B model on a CPU takes tens of seconds, and the difference between
 * "thinking" and "broken" is the whole reason the streamed mode is here.
 */

const PROMPT_LIMIT = 4000

type Mode = 'stream' | 'complete' | 'agent'

const MODES: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: 'stream', label: 'Streamed' },
  { value: 'complete', label: 'One response' },
  { value: 'agent', label: 'Agent (tools)' },
]

/** The agent route's own cap, repeated so the field can say it. */
const AGENT_MESSAGE_LIMIT = 500

const STOPPED_BY: Record<AgentAnswer['stoppedBy'], string> = {
  answered: 'Answered',
  tool_limit: 'Lookup cap',
  model_call_limit: 'Model-call cap',
  token_budget: 'Token budget',
}

/** What the round trip looked like from here, rather than from the provider. */
interface Timing {
  /** Wall clock to the first visible token. Meaningless outside streaming. */
  firstTokenMs: number | null
  totalMs: number
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ai-lab__stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

const ms = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`

export function AiLabPage() {
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<Mode>('stream')
  const [reply, setReply] = useState('')
  const [usage, setUsage] = useState<ChatUsage | null>(null)
  const [storyId, setStoryId] = useState('')
  const [agent, setAgent] = useState<AgentAnswer | null>(null)
  const [timing, setTiming] = useState<Timing | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  /** Lets Stop cancel the request, and a second Send abandon the first. */
  const pending = useRef<AbortController | null>(null)

  async function run() {
    const trimmed = prompt.trim()
    if (trimmed.length === 0) return

    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller

    setReply('')
    setUsage(null)
    setAgent(null)
    setTiming(null)
    setError(null)
    setStatus('running')

    const startedAt = performance.now()
    let firstTokenMs: number | null = null

    try {
      if (mode === 'agent') {
        const answer = await askAgent(
          trimmed,
          storyId.trim() === '' ? null : storyId.trim(),
          controller.signal,
        )
        if (controller.signal.aborted) return
        setReply(answer.answer)
        setAgent(answer)
      } else if (mode === 'complete') {
        const answer = await chat(trimmed, controller.signal)
        if (controller.signal.aborted) return
        setReply(answer.text)
        setUsage(answer.usage)
      } else {
        for await (const event of streamChat(trimmed, controller.signal)) {
          if (event.type === 'text') {
            firstTokenMs ??= performance.now() - startedAt
            setReply((current) => current + event.text)
          } else if (event.type === 'done') {
            setUsage(event.usage)
          }
        }
        if (controller.signal.aborted) return
      }

      setTiming({ firstTokenMs, totalMs: performance.now() - startedAt })
      setStatus('idle')
    } catch (cause) {
      // An abort is the user pressing Stop, not a failure: whatever arrived
      // stays on screen and the page goes back to idle.
      if (controller.signal.aborted) {
        setTiming({ firstTokenMs, totalMs: performance.now() - startedAt })
        setStatus('idle')
        return
      }

      setError(
        cause instanceof ApiError
          ? `${cause.message} (${cause.code})`
          : 'The request failed before it reached the model.',
      )
      // A mid-stream failure keeps what arrived: the server could only report
      // it in-band, and throwing the partial reply away hides how far it got.
      setStatus('error')
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void run()
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void run()
    }
  }

  const running = status === 'running'

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-head__title">AI lab</h1>
          <p className="page-head__sub">
            One prompt straight to the model, with nothing in the way. A
            development workbench — it is not linked from anywhere and is not
            mounted in a production build.
          </p>
        </div>
      </header>

      <Card className="ai-lab__form">
        <form onSubmit={onSubmit}>
          <SegmentedControl
            label="How to receive the reply"
            items={MODES}
            value={mode}
            onChange={(next) => setMode(next)}
          />

          {mode === 'agent' ? (
            <TextField
              label="Story on screen (optional)"
              value={storyId}
              maxLength={200}
              placeholder="A story id or slug"
              hint="What “this story” means to the assistant. Each tool still checks you may see it."
              onChange={(event) => setStoryId(event.target.value)}
            />
          ) : null}

          <TextField
            label="Prompt"
            multiline
            rows={5}
            value={prompt}
            maxLength={mode === 'agent' ? AGENT_MESSAGE_LIMIT : PROMPT_LIMIT}
            counterMax={mode === 'agent' ? AGENT_MESSAGE_LIMIT : PROMPT_LIMIT}
            placeholder="Explain what Scribe is to somebody who has never used it."
            hint="⌘/Ctrl + Enter sends. The server caps the prompt at 4,000 characters."
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onKeyDown}
          />

          <div className="ai-lab__actions">
            <Button
              type="submit"
              variant="primary"
              loading={running}
              disabled={prompt.trim().length === 0}
              startIcon={<Icon name="sparkle" size="1em" />}
            >
              {running ? 'Generating…' : 'Send'}
            </Button>

            {/* Aborts the request, which closes the connection, which is what
                stops the server generating tokens nobody will read. */}
            <Button
              disabled={!running}
              onClick={() => pending.current?.abort()}
              startIcon={<Icon name="close" size="0.9em" />}
            >
              Stop
            </Button>

            <p className="ai-lab__note">
              A local model on a CPU answers in tens of seconds. Streamed mode
              shows the first token as it lands; one-response mode waits.
            </p>
          </div>

          {error !== null ? (
            <p className="ai-lab__error" role="alert">
              <Icon name="alert" size="0.95em" />
              {error}
            </p>
          ) : null}
        </form>
      </Card>

      {reply === '' && !running && error === null ? null : (
        <section className="ai-lab__result" aria-label="Model reply">
          <SectionHead
            title="Reply"
            action={
              <span className="ai-lab__notice">
                <Icon name="sparkle" size="0.9em" />
                AI-generated, unedited and ungrounded.
              </span>
            }
          />

          <Card className="ai-lab__reply">
            {reply === '' && running ? (
              <p className="ai-lab__waiting" role="status">
                Waiting for the first token&hellip;
              </p>
            ) : (
              <p className="ai-lab__text">
                {reply}
                {running ? <span className="ai-lab__caret" aria-hidden /> : null}
              </p>
            )}
          </Card>

          {agent !== null ? (
            <Card className="ai-lab__steps">
              <SectionHead title="What it looked up" />
              {agent.steps.length === 0 ? (
                <p className="ai-lab__waiting">
                  Nothing — it answered without a tool.
                </p>
              ) : (
                <ol className="ai-lab__step-list">
                  {agent.steps.map((step, index) => (
                    <li key={index} className="ai-lab__step">
                      <span className="ai-lab__step-name">{step.tool}</span>
                      <span
                        className={`ai-lab__step-outcome is-${step.outcome}`}
                      >
                        {step.outcome}
                        {step.code ? ` · ${step.code}` : ''}
                      </span>
                      <span className="ai-lab__step-time">
                        {ms(step.durationMs)}
                      </span>
                      <code className="ai-lab__step-args">
                        {JSON.stringify(step.arguments)}
                      </code>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          ) : null}

          {agent !== null ? (
            <dl className="ai-lab__stats">
              <Stat label="Stopped by" value={STOPPED_BY[agent.stoppedBy]} />
              <Stat label="Model calls" value={String(agent.modelCalls)} />
              <Stat label="Lookups" value={String(agent.steps.length)} />
              <Stat label="Total tokens" value={String(agent.tokensUsed)} />
            </dl>
          ) : null}

          {usage !== null || timing !== null ? (
            <dl className="ai-lab__stats">
              {usage !== null ? (
                <>
                  <Stat label="Model" value={usage.model} />
                  <Stat label="Input tokens" value={String(usage.inputTokens)} />
                  <Stat
                    label="Output tokens"
                    value={String(usage.outputTokens)}
                  />
                  <Stat label="Total tokens" value={String(usage.totalTokens)} />
                  <Stat label="Provider time" value={ms(usage.durationMs)} />
                </>
              ) : null}
              {timing !== null ? (
                <>
                  {timing.firstTokenMs !== null ? (
                    <Stat
                      label="First token"
                      value={ms(timing.firstTokenMs)}
                    />
                  ) : null}
                  <Stat label="Round trip" value={ms(timing.totalMs)} />
                </>
              ) : null}
            </dl>
          ) : null}
        </section>
      )}
    </>
  )
}
