import { useState, type FormEvent } from 'react'
import {
  CopilotKitProvider,
  ToolCallStatus,
  useAgent,
  useCopilotKit,
  useHumanInTheLoop,
  useRenderToolCall,
} from '@copilotkit/react-core/v2'
import type { EditProposal } from '../../data/ai-api'
import { freshAccessToken } from '../../lib/access-token'
import { API_BASE_URL } from '../../lib/api-client'
import { Button } from '../ui/Button'
import { Card, SectionHead } from '../ui/Card'
import { Icon } from '../ui/Icon'
import { TextField } from '../ui/TextField'
import { ProposalCard, type Decision } from './StoryAssistant'

/**
 * The CopilotKit trial (Task AI 25): Scribe's own agent, driven by
 * CopilotKit's headless v2 hooks, drawn with Scribe's own components.
 *
 * Loaded lazily from the AI lab, which is itself mounted in development only,
 * so none of CopilotKit reaches a production bundle. No prebuilt chat, no
 * licence key, no Intelligence; the inspector and the Intelligence indicator
 * are off. The server's `AI_COPILOTKIT` switch decides whether any of it
 * answers.
 */

const RUNTIME_URL = `${API_BASE_URL}/ai/copilotkit`

/** The agent's id on the runtime, as `services/ai/copilotkit.ts` registers it. */
const AGENT_ID = 'scribe'

/**
 * Built per request by CopilotKit. Its requests do not go through
 * `request()`, so a token about to expire is refreshed here instead of
 * being replayed after a 401.
 */
async function authHeaders(): Promise<Record<string, string>> {
  const token = await freshAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export default function CopilotKitTrial() {
  const [error, setError] = useState<string | null>(null)

  return (
    <CopilotKitProvider
      runtimeUrl={RUNTIME_URL}
      headers={authHeaders}
      enableInspector={false}
      showIntelligenceIndicator={false}
      // Every failure CopilotKit sees -- a refused request, a RUN_ERROR in a
      // stream that has already said 200 -- arrives here, not from runAgent.
      onError={({ error: failure, code }) => setError(`${failure.message} (${code})`)}
    >
      <TrialChat error={error} onClearError={() => setError(null)} />
    </CopilotKitProvider>
  )
}

interface ProposalRenderProps {
  args: Partial<EditProposal>
  status: ToolCallStatus
  result?: string
  respond?: (result: unknown) => Promise<void>
}

/**
 * A pending `propose_edit` call, as the story assistant draws a proposal.
 * The lab has no editor, so accepting records the decision and changes
 * nothing; `followUp: false` keeps that decision from calling the model.
 */
function ProposalRender({ args, status, result, respond }: ProposalRenderProps) {
  if (status === ToolCallStatus.InProgress || !args.id) {
    return <p className="ai-lab__waiting">Preparing a proposal&hellip;</p>
  }

  const decided = result ? (JSON.parse(result) as { accepted?: boolean }) : null
  const decision: Decision =
    decided === null
      ? { status: 'pending', note: null }
      : { status: decided.accepted ? 'applied' : 'rejected' }

  return (
    <ProposalCard
      proposal={args as EditProposal}
      decision={decision}
      appliedText="Accepted. The lab has no editor, so nothing was applied."
      onAccept={() => void respond?.({ accepted: true })}
      onReject={() => void respond?.({ accepted: false })}
    />
  )
}

type ToolMessage = Extract<
  ReturnType<typeof useAgent>['agent']['messages'][number],
  { role: 'tool' }
>

interface TrialChatProps {
  error: string | null
  onClearError: () => void
}

function TrialChat({ error, onClearError }: TrialChatProps) {
  const { agent } = useAgent({ agentId: AGENT_ID })
  const { copilotkit } = useCopilotKit()
  const [draft, setDraft] = useState('')
  const [storyId, setStoryId] = useState('')

  useHumanInTheLoop({
    name: 'propose_edit',
    description: 'An edit the assistant proposes; the author accepts or rejects it.',
    followUp: false,
    render: ProposalRender,
  })

  const renderToolCall = useRenderToolCall()

  async function send(event: FormEvent) {
    event.preventDefault()
    const message = draft.trim()
    if (message === '' || agent.isRunning) return
    onClearError()
    setDraft('')
    agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: message })
    // Failures are reported through the provider's `onError`.
    await copilotkit
      .runAgent({
        agent,
        forwardedProps: storyId.trim() ? { storyId: storyId.trim() } : {},
      })
      .catch(() => undefined)
  }

  return (
    <>
      <Card className="ai-lab__form">
        <form onSubmit={(event) => void send(event)}>
          <TextField
            label="Story on screen (optional)"
            value={storyId}
            maxLength={200}
            placeholder="A story id or slug"
            hint="Sent as forwardedProps.storyId. Each tool still checks you may see it."
            onChange={(event) => setStoryId(event.target.value)}
          />
          <TextField
            label="Message"
            multiline
            rows={3}
            value={draft}
            maxLength={500}
            counterMax={500}
            placeholder="In chapter 1, change her eyes to grey."
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="ai-lab__actions">
            <Button
              type="submit"
              variant="primary"
              loading={agent.isRunning}
              disabled={draft.trim().length === 0}
              startIcon={<Icon name="sparkle" size="0.9em" />}
            >
              Send
            </Button>
            <Button disabled={!agent.isRunning} onClick={() => agent.abortRun()}>
              Stop
            </Button>
            <p className="ai-lab__note">
              CopilotKit trial · <code>{RUNTIME_URL}</code> · needs{' '}
              <code>AI_COPILOTKIT=on</code> on the API.
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

      {agent.messages.length === 0 ? null : (
        <section className="ai-lab__result" aria-label="Conversation">
          <SectionHead
            title="Thread"
            action={
              <span className="ai-lab__notice">
                <Icon name="sparkle" size="0.9em" />
                Answers and proposals are AI-generated.
              </span>
            }
          />
          {agent.messages.map((message) => {
            if (message.role === 'user') {
              return (
                <Card key={message.id} className="ai-lab__reply">
                  <p className="ai-lab__text">
                    <strong>You: </strong>
                    {typeof message.content === 'string' ? message.content : ''}
                  </p>
                </Card>
              )
            }
            if (message.role !== 'assistant') return null
            const calls = message.toolCalls ?? []
            const lookups = calls.filter((call) => call.function.name !== 'propose_edit')
            return (
              <div key={message.id}>
                {lookups.length > 0 ? (
                  <ol className="ai-lab__step-list">
                    {lookups.map((call) => (
                      <li key={call.id} className="ai-lab__step">
                        <span className="ai-lab__step-name">{call.function.name}</span>
                        <code className="ai-lab__step-args">{call.function.arguments}</code>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {message.content ? (
                  <Card className="ai-lab__reply">
                    <p className="ai-lab__text">{message.content}</p>
                  </Card>
                ) : null}
                {calls
                  .filter((call) => call.function.name === 'propose_edit')
                  .map((call) => (
                    <div key={call.id}>
                      {renderToolCall({
                        toolCall: call,
                        toolMessage: agent.messages.find(
                          (other): other is ToolMessage =>
                            other.role === 'tool' && other.toolCallId === call.id,
                        ),
                      })}
                    </div>
                  ))}
              </div>
            )
          })}
        </section>
      )}
    </>
  )
}
