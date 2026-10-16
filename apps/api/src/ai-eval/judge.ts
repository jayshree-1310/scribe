/**
 * Faithfulness, graded by a model -- the one check code cannot make.
 *
 * Structured output, so the verdict is a value rather than prose to be
 * pattern-matched, and the same repair-once policy as every structured call.
 * The prompt is `prompts/eval-judge.ts`, versioned; see its header for what
 * the score can and cannot be trusted to mean.
 */

import { z } from "zod";
import {
  JUDGE_SYSTEM_PROMPT,
  judgeMessage,
  type JudgedPassage,
} from "../services/ai/prompts/eval-judge.js";
import { aiProvider } from "../services/ai/provider.js";

export const JUDGE_FEATURE = "eval.judge";

export const judgeVerdictSchema = z.object({
  verdict: z.enum(["supported", "partial", "unsupported"]),
  unsupported: z.array(z.string().max(300)).max(10),
});

export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

const SCORE: Record<JudgeVerdict["verdict"], number> = {
  supported: 1,
  partial: 0.5,
  unsupported: 0,
};

export async function judgeFaithfulness(input: {
  question: string;
  passages: JudgedPassage[];
  answer: string;
  model?: string;
}): Promise<{ score: number; verdict: JudgeVerdict }> {
  const { value } = await aiProvider().completeStructured(judgeVerdictSchema, {
    feature: JUDGE_FEATURE,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: judgeMessage(input) }],
    maxTokens: 600,
    ...(input.model ? { model: input.model } : {}),
  });

  return { score: SCORE[value.verdict], verdict: value };
}
