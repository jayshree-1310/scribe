/**
 * The structured-output repair turn (`structured.ts`).
 *
 * Phrased as a correction of the assistant's own previous message rather than
 * as a fresh request, because the model has the context to fix what it wrote
 * and re-asking from scratch throws that away -- and often reproduces the same
 * mistake.
 *
 * The problems list is built by code from zod's issues, but the issues are
 * *about* model output -- field paths it chose, values it wrote -- so it is
 * fenced like any other text from outside the code.
 */

import { definePrompt, fence, fenced } from "./base.js";

export const REPAIR_PROMPT = definePrompt({
  id: "structured.repair",
  version: 2,
  tunedAgainst: ["llama3.2:3b", "openai/gpt-oss-120b"],
  purpose: "Ask a model to correct a JSON reply that failed its schema, once.",
  rationale:
    "Small models fix their own reply well when shown exactly which fields were wrong; a second failure is an upstream error, never a partial object.",
  history: {
    1: "Initial, inline in structured.ts.",
    2: "Moved to prompts/; the problems list is fenced.",
  },
});

const PROBLEMS = fence("<<<VALIDATION PROBLEMS>>>", "<<<END VALIDATION PROBLEMS>>>");

export function repairMessage(problems: string): string {
  return [
    "That reply was not valid. The problems are listed below.",
    fenced(PROBLEMS, problems),
    "",
    "Reply again with the corrected JSON object alone: no explanation, no markdown fence, no other text.",
  ].join("\n");
}
