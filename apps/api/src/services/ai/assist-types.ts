/**
 * The writing assistant's shapes.
 *
 * Split from `assist.ts` so `prompts/assist/` can name an action without
 * importing the service, exactly as `scribble-types.ts` and
 * `generate-types.ts` do.
 */

export const ASSIST_ACTIONS = [
  "improve",
  "rewrite",
  "grammar",
  "tone",
  "shorten",
  "expand",
  "alternatives",
  "continue",
] as const;

export type AssistAction = (typeof ASSIST_ACTIONS)[number];

export interface AssistInput {
  action: AssistAction;
  /**
   * The passage to work on: the author's selection, or -- for `continue` --
   * the prose immediately before the caret.
   */
  text: string;
  /** Prose before the selection, for voice and continuity. Trimmed to budget. */
  before: string;
  /** Prose after it. Trimmed the same way. */
  after: string;
  /** Only meaningful for the `tone` action. */
  tone: string | null;
  /**
   * The story the passage belongs to, when it has been saved at all.
   * Ownership is asserted on it; see `assist.ts`.
   */
  storyId: string | null;
}
