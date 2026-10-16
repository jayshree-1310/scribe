/**
 * The writing assistant: eight transformations of prose an author selected.
 *
 * The feature is not the model call. It is the two things around it:
 *
 * - **What gets sent.** The selection plus a bounded window either side of it,
 *   never the whole chapter and never the story. Cost is linear in what is
 *   sent, and -- less obviously -- a model handed six chapters starts
 *   summarising them instead of rewriting the paragraph it was asked about.
 *   `windowFor` is the one place that budget exists.
 * - **What happens to the answer.** Nothing, here. This module returns text; it
 *   never writes to a chapter. The author accepts or rejects in the editor, and
 *   a failed request has to leave the draft exactly as it was -- which is free
 *   if the service cannot write in the first place.
 *
 * The prose travels in the request body rather than being read from the
 * database by id. The editor's buffer is the truth while somebody is typing,
 * and the saved copy is a debounce behind -- so "continue from here" against
 * the stored chapter would continue from a paragraph the author had already
 * replaced. A `chapterId` may accompany it, and is never used to fetch text:
 * it says where in the story the passage sits, which is what lets the story
 * bible tell what has already happened from what has not.
 *
 * - **What the story already says.** When the story has a bible (Task AI 13),
 *   the few facts relevant to this passage go into the request, so a
 *   continuation does not rename a character or move them to a city they left
 *   two chapters ago. Which facts, and how few, is `story-bible.ts` and
 *   `bible-facts.ts`; a story without a bible is sent exactly what it was.
 */

import { assertStoryOwned } from "../authoring.js";
import {
  ASSIST_ACTIONS,
  type AssistAction,
  type AssistInput,
} from "./assist-types.js";
import {
  ASSIST_SYSTEM_PROMPT,
  ASSIST_SYSTEM_PROMPT_WITH_BIBLE,
  assistMessage,
} from "./prompts/assist/index.js";
import { bibleBlock } from "./prompts/story-bible.js";
import { aiProvider } from "./provider.js";
import { factsForPrompt } from "./story-bible.js";

export { ASSIST_ACTIONS };
export type { AssistAction, AssistInput };

/**
 * Budgets in characters, not tokens, because there is no tokeniser here and a
 * wrong one is worse than an honest approximation. Four characters to a token
 * is the usual rule of thumb, so the numbers below are roughly 1500 tokens of
 * passage and 300 either side of it.
 */
export const SELECTION_LIMIT = 6000;
export const CONTEXT_LIMIT = 1200;

/** Longer replies for the actions that are meant to produce them. */
const TOKEN_BUDGET: Record<AssistAction, number> = {
  improve: 1200,
  rewrite: 1200,
  grammar: 1200,
  tone: 1200,
  shorten: 900,
  expand: 1800,
  alternatives: 2400,
  continue: 1200,
};

/* The window ------------------------------------------------------------- */

/** Keeps the tail, starting at a word boundary so the model gets whole words. */
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const cut = text.slice(text.length - limit);
  const boundary = cut.search(/\s/);
  return boundary === -1 ? cut : cut.slice(boundary + 1);
}

/** Keeps the head, ending at a word boundary for the same reason. */
function head(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const cut = text.slice(0, limit);
  const boundary = cut.lastIndexOf(" ");
  return boundary === -1 ? cut : cut.slice(0, boundary);
}

/**
 * The bounded window: the passage, and as much either side of it as the budget
 * allows.
 *
 * Enforced here rather than trusted from the client even though the route's
 * schema also caps these fields. The schema stops an abusive request; this
 * stops an ordinary one from quietly costing five times what the next one does
 * because the author happened to select a long scene.
 */
export function windowFor(input: AssistInput): {
  text: string;
  before: string;
  after: string;
} {
  return {
    text: input.text.slice(0, SELECTION_LIMIT),
    // The window is asymmetric in what it keeps: the words immediately before
    // the selection and immediately after it are the ones that carry voice and
    // continuity, so each side keeps the end nearest the passage.
    before: tail(input.before, CONTEXT_LIMIT),
    after: head(input.after, CONTEXT_LIMIT),
  };
}

/* Cleaning the reply ----------------------------------------------------- */

const FENCE = /^```[a-z]*\n([\s\S]*?)\n?```$/i;

/**
 * Removes the wrapper a model adds despite being told not to.
 *
 * Only the wrapper: a code fence around the whole reply, or quotation marks
 * around the whole reply. Anything more aggressive would edit the author's
 * prose on their behalf, which is the one thing this feature must not do --
 * and a passage that genuinely begins and ends with a quotation mark is
 * dialogue, so that case is left alone when it is not the *entire* reply.
 */
export function stripWrapper(text: string): string {
  const trimmed = text.trim();
  const unfenced = FENCE.exec(trimmed)?.[1] ?? trimmed;
  const quoted =
    unfenced.length > 1 &&
    unfenced.startsWith('"') &&
    unfenced.endsWith('"') &&
    !unfenced.slice(1, -1).includes('"');

  return (quoted ? unfenced.slice(1, -1) : unfenced).trim();
}

/* The feature ------------------------------------------------------------ */

type AssistRequest = Parameters<ReturnType<typeof aiProvider>["complete"]>[0];

/**
 * The request, and how many bible facts went into it.
 *
 * The facts are chosen against the same window the model will see -- what is
 * relevant to prose that was trimmed away is not relevant to this call. Only
 * for a saved story: an unsaved one has no bible to read, and `authorise` has
 * already established that this one is the caller's.
 */
async function requestFor(
  input: AssistInput,
  signal?: AbortSignal,
): Promise<{ request: AssistRequest; facts: number }> {
  const windowed = windowFor(input);

  const facts = input.storyId
    ? await factsForPrompt(
        input.storyId,
        [windowed.before, windowed.text, windowed.after]
          .filter((part) => part !== "")
          .join("\n"),
        input.chapterId,
        signal,
      )
    : [];

  const request: AssistRequest = {
    // Per action, so per-action cost is visible in the usage log rather than
    // one undifferentiated `assist` line.
    feature: `assist.${input.action}`,
    system:
      facts.length > 0 ? ASSIST_SYSTEM_PROMPT_WITH_BIBLE : ASSIST_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: assistMessage(
          input.action,
          input.tone,
          windowed.text,
          windowed.before,
          windowed.after,
          bibleBlock(facts),
        ),
      },
    ],
    maxTokens: TOKEN_BUDGET[input.action],
    ...(signal ? { signal } : {}),
  };

  return { request, facts: facts.length };
}

/**
 * Asserts the caller may do this at all.
 *
 * A story id is optional because a story that has never been saved does not
 * have one yet -- the editor's "new story" route is a real case, and refusing
 * it would mean the assistant only works on prose that is already on disk.
 * When there *is* an id, it is checked: generating against somebody else's
 * story is refused before a single token is spent.
 */
async function authorise(userId: string, input: AssistInput): Promise<void> {
  if (input.storyId) await assertStoryOwned(userId, input.storyId);
}

export async function assist(
  userId: string,
  input: AssistInput,
  signal?: AbortSignal,
): Promise<{ action: AssistAction; text: string; facts: number }> {
  await authorise(userId, input);

  const { request, facts } = await requestFor(input, signal);
  const completion = await aiProvider().complete(request);

  return { action: input.action, text: stripWrapper(completion.text), facts };
}

export type AssistEvent =
  | { type: "text"; text: string }
  /**
   * Carries the cleaned whole, which is the authority; see below. `facts` is
   * how many story-bible facts the model was shown, so the panel can say a
   * suggestion was checked against the story rather than leave it implied.
   */
  | { type: "done"; text: string; facts: number };

/**
 * The same work, streamed.
 *
 * Deltas are for responsiveness and the terminal `done` is the authority: a
 * wrapper the model opened in its first delta and closed in its last cannot be
 * recognised until the last one has arrived, so the client renders the deltas
 * as they land and replaces them with `done.text` when it ends. Same division
 * as Scribble's narration scanner, for the same reason.
 *
 * Nothing is yielded until authorisation has passed, so a 403 is still an
 * ordinary HTTP status rather than an error frame inside a 200.
 */
export async function* assistStream(
  userId: string,
  input: AssistInput,
  signal?: AbortSignal,
): AsyncGenerator<AssistEvent> {
  await authorise(userId, input);

  const { request, facts } = await requestFor(input, signal);
  let accumulated = "";

  for await (const event of aiProvider().stream(request)) {
    if (event.type !== "text") continue;
    accumulated += event.text;
    yield { type: "text", text: event.text };
  }

  yield { type: "done", text: stripWrapper(accumulated), facts };
}
