import type { AssistAction } from '../../data/ai-api'

/**
 * The assistant's actions as the author sees them. Shared by the editor's
 * menu and the panel's heading; kept out of `AssistPanel.tsx` so that file
 * exports only components and keeps fast refresh.
 */
export const ASSIST_LABELS: Record<AssistAction, string> = {
  improve: 'Improve',
  rewrite: 'Rewrite',
  grammar: 'Fix grammar',
  tone: 'Change tone',
  shorten: 'Shorten',
  expand: 'Expand',
  alternatives: 'Alternatives',
  continue: 'Continue',
}

export const ASSIST_MENU: ReadonlyArray<{ action: AssistAction; label: string }> =
  (Object.keys(ASSIST_LABELS) as AssistAction[]).map((action) => ({
    action,
    label: ASSIST_LABELS[action],
  }))
