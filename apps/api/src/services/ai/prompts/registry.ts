/**
 * Every prompt, by id.
 *
 * What makes a stored artefact traceable: a row carries `promptId` and
 * `promptVersion`, and `resolvePrompt` turns that pair into the definition --
 * what the prompt was for, what it was tuned against, and what changed in the
 * version that wrote the row. "Every recap written by the prompt we just
 * fixed" is then a `WHERE promptId = 'recap' AND promptVersion < 3`.
 *
 * A prompt that is not listed here cannot be resolved, and `prompts.test.ts`
 * fails when a module defines one that is missing.
 */

import { AGENT_PROMPT } from "./agent.js";
import { ASK_BOOK_CONVERSATION_PROMPT, ASK_BOOK_PROMPT } from "./ask-book.js";
import { ASSIST_PROMPT } from "./assist/index.js";
import type { PromptDefinition } from "./base.js";
import { CHAT_PROMPT } from "./chat.js";
import { CONTINUITY_PROMPT } from "./continuity.js";
import { CONVERSATION_REWRITE_PROMPT, CONVERSATION_SUMMARY_PROMPT } from "./conversation.js";
import { JUDGE_PROMPT } from "./eval-judge.js";
import { EXPLAIN_PROMPT } from "./explain.js";
import { GENERATE_PROMPT, GENERATE_REFINE_PROMPT } from "./generate.js";
import { MODERATION_PROMPT } from "./moderation.js";
import { RECAP_PROMPT } from "./recap.js";
import { REPAIR_PROMPT } from "./repair.js";
import { SCRIBBLE_INTENT_PROMPT, SCRIBBLE_NARRATION_PROMPT } from "./scribble.js";
import { BIBLE_EXTRACTION_PROMPT } from "./story-bible.js";

export const PROMPTS: readonly PromptDefinition[] = [
  AGENT_PROMPT,
  ASK_BOOK_PROMPT,
  ASK_BOOK_CONVERSATION_PROMPT,
  ASSIST_PROMPT,
  CHAT_PROMPT,
  CONTINUITY_PROMPT,
  CONVERSATION_REWRITE_PROMPT,
  CONVERSATION_SUMMARY_PROMPT,
  EXPLAIN_PROMPT,
  GENERATE_PROMPT,
  GENERATE_REFINE_PROMPT,
  JUDGE_PROMPT,
  MODERATION_PROMPT,
  RECAP_PROMPT,
  REPAIR_PROMPT,
  SCRIBBLE_INTENT_PROMPT,
  SCRIBBLE_NARRATION_PROMPT,
  BIBLE_EXTRACTION_PROMPT,
];

const byId = new Map(PROMPTS.map((prompt) => [prompt.id, prompt]));

export interface ResolvedPrompt {
  prompt: PromptDefinition;
  version: number;
  /** What that version changed. */
  change: string;
  /** False when a newer version exists: the row is a candidate for regeneration. */
  current: boolean;
}

/** The prompt and version a stored row names, or null when it names nothing known. */
export function resolvePrompt(id: string, version: number): ResolvedPrompt | null {
  const prompt = byId.get(id);
  const change = prompt?.history[version];
  if (!prompt || change === undefined) return null;
  return { prompt, version, change, current: version === prompt.version };
}
