/**
 * One instruction per action.
 *
 * Each is a single sentence of intent plus the constraint that stops the model
 * doing the thing it does by default -- which is what the second half of most
 * of these is. "Improve this" alone produces a longer, blander paragraph with a
 * new metaphor in it; the constraint is the prompt.
 *
 * Kept as data rather than as a switch so that Task AI 17 can version them
 * individually and a snapshot test can render every one of them.
 */

import type { AssistAction } from "../../assist-types.js";

export const ACTION_INSTRUCTIONS: Record<AssistAction, string> = {
  improve:
    "Rewrite the passage below so it reads better: clearer, sharper, better rhythm. Change as little as possible to achieve that, and do not make it longer.",

  rewrite:
    "Rewrite the passage below from scratch, saying the same things in a different way. Same events, same information, same length within a sentence or two.",

  grammar:
    "Correct only the grammar, spelling and punctuation of the passage below. Change nothing else — not a word choice, not a sentence break, not a comma the author put there deliberately. If it is already correct, return it unchanged.",

  tone: "Rewrite the passage below in a different tone, keeping the same events and the same information.",

  shorten:
    "Make the passage below shorter without losing anything that matters. Cut words, not events. Aim for roughly two thirds of the original length.",

  expand:
    "Expand the passage below using only what is already there: more detail on what is described, more of the sensory texture the author has begun. Do not add events, people or facts that are not present. Aim for roughly half again as long.",

  alternatives:
    "Give three different versions of the passage below, each a genuinely different approach rather than a reworded copy. Number them 1., 2. and 3., each on its own line, with no other commentary.",

  continue:
    "Continue the passage below in the author's voice, picking up exactly where it stops. Write one or two paragraphs. Do not repeat the passage, do not summarise it, and do not resolve anything — keep going in the direction it was already heading.",
};
