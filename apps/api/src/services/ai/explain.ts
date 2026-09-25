/**
 * "What does this mean?": a reader highlights a passage and asks.
 *
 * This is the reader-side counterpart to `assist.ts`, and the differences
 * between the two are more interesting than the similarity. Both take a
 * selection and a window around it and stream a reply. But the assistant
 * *transforms* an author's prose for the author, while this one *talks about*
 * a stranger's published prose for somebody reading it -- and that inversion
 * changes three things that matter.
 *
 * **The guard is visibility, not ownership.** `assist.ts` asserts the caller
 * owns the story, which is exactly the wrong question here: a reader owns
 * nothing they read. The rule instead is the one every read path in
 * `services/stories.ts` applies -- a draft is visible to its author and to
 * nobody else -- and it is applied by calling that file rather than by
 * restating it. Copying the assistant's guard would lock every reader out;
 * forgetting a guard would leak unpublished writing to anybody who could guess
 * a chapter id.
 *
 * **The passage arrives as offsets, not as text.** The assistant takes prose
 * in the request body because the author's unsaved editor buffer is the truth.
 * For a reader the opposite holds: the published chapter is the truth, there
 * is no buffer, and a request body carrying arbitrary text would make this
 * endpoint a general-purpose model proxy behind the site's own API key. So the
 * client sends a chapter id and a `[start, end)` pair, the server reads the
 * chapter itself, and the only thing that can ever be explained is fiction
 * somebody published on Scribe. The offsets are checked against the stored
 * body, so a selection that does not match one is a 400 rather than a prompt.
 *
 * **The window leans backwards.** The assistant windows symmetrically because
 * an author can see their whole chapter anyway. A reader is part-way down it,
 * and the text after their selection is text they have not read yet -- so the
 * forward half of the window is deliberately much smaller than the backward
 * half. It is not zero, because a sentence is sometimes only explicable from
 * the one after it, but it is small enough that an explanation cannot be built
 * out of several paragraphs the reader has not reached.
 */

import { HttpError } from "../../lib/http-error.js";
import { findVisibleChapterText } from "../stories.js";
import {
  EXPLAIN_MODES,
  EXPLAIN_SYSTEM_PROMPT,
  explainMessage,
  type ExplainMode,
} from "./prompts/explain.js";
import { aiProvider } from "./provider.js";
import type { AiRequest } from "./types.js";

export { EXPLAIN_MODES };
export type { ExplainMode };

/**
 * Budgets in characters, matching `assist.ts` -- there is no tokeniser here
 * and an honest approximation beats a wrong one.
 *
 * The selection cap is far tighter than the assistant's 6000. An author
 * rewrites a scene; a reader asks about a sentence or a paragraph they tripped
 * over. A selection of two thousand characters is already several paragraphs,
 * and past that the honest answer is "read on" rather than a summary --
 * summarising what the reader is in the middle of is the one thing this
 * feature must not drift into.
 */
export const SELECTION_LIMIT = 2000;

/** How much precedes the passage in the prompt. See the header on asymmetry. */
export const CONTEXT_BEFORE_LIMIT = 1500;

/** And how much follows it. Deliberately a fraction of the above. */
export const CONTEXT_AFTER_LIMIT = 400;

/**
 * Short replies, because a reader is stopped mid-chapter. `define` is tighter
 * still: a definition that runs to three hundred tokens has stopped being one.
 */
const TOKEN_BUDGET: Record<ExplainMode, number> = {
  explain: 500,
  simplify: 500,
  define: 300,
};

export interface ExplainInput {
  chapterId: string;
  /** Character offset into the stored chapter body, inclusive. */
  start: number;
  /** Character offset, exclusive. */
  end: number;
  mode: ExplainMode;
}

export interface ExplainContext {
  passage: string;
  before: string;
  after: string;
  chapterTitle: string;
  chapterNumber: number;
  storyId: string;
}

/* The window ------------------------------------------------------------- */

/** Keeps the tail, starting at a word boundary so whole words reach the model. */
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
 * Resolves the request against the stored chapter, or refuses it.
 *
 * Every rejection here is a 400 or a 404 and happens before any model call, so
 * a malformed or hostile request costs nothing. The offsets are validated
 * against the real body rather than trusted, which is what makes "the client
 * sends offsets" a security property instead of a convention.
 */
export async function resolveSelection(
  userId: string | null,
  input: ExplainInput,
): Promise<ExplainContext> {
  const chapter = await findVisibleChapterText(input.chapterId, userId);
  // The same answer for a chapter that does not exist and one this caller may
  // not read: a distinguishable 403 would confirm that a draft exists.
  if (!chapter) throw HttpError.notFound("That chapter could not be found.");

  const { content } = chapter;

  if (input.start >= input.end) {
    throw HttpError.badRequest("Select some text first.");
  }
  /**
   * The chapter was edited between the page loading and the reader
   * highlighting something, so the offsets point into prose that has changed.
   * Reloading is the fix, and saying so is better than explaining whatever now
   * happens to sit at those offsets.
   */
  if (input.end > content.length) {
    throw HttpError.conflict(
      "This chapter changed while you were reading. Reload the page and try again.",
    );
  }
  if (input.end - input.start > SELECTION_LIMIT) {
    throw HttpError.badRequest(
      `That selection is too long — highlight a sentence or a paragraph at a time (up to ${SELECTION_LIMIT} characters).`,
    );
  }

  const passage = content.slice(input.start, input.end);
  if (passage.trim().length === 0) {
    throw HttpError.badRequest("Select some text first.");
  }

  return {
    passage,
    before: tail(content.slice(0, input.start), CONTEXT_BEFORE_LIMIT),
    after: head(content.slice(input.end), CONTEXT_AFTER_LIMIT),
    chapterTitle: chapter.title,
    chapterNumber: chapter.number,
    storyId: chapter.storyId,
  };
}

/* The feature ------------------------------------------------------------ */

function requestFor(
  mode: ExplainMode,
  context: ExplainContext,
  signal?: AbortSignal,
): AiRequest {
  return {
    // Per mode, so a `define` that is quietly costing as much as an `explain`
    // shows up in the usage log rather than hiding inside one total.
    feature: `explain.${mode}`,
    system: EXPLAIN_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: explainMessage(
          mode,
          context.passage,
          context.before,
          context.after,
        ),
      },
    ],
    maxTokens: TOKEN_BUDGET[mode],
    ...(signal ? { signal } : {}),
  };
}

export interface Explanation {
  mode: ExplainMode;
  /** The passage as the *server* read it, so the client can show what it asked about. */
  passage: string;
  /** Generated. Always labelled as such. */
  text: string;
  tokensUsed: number;
}

export async function explain(
  userId: string,
  input: ExplainInput,
  signal?: AbortSignal,
): Promise<Explanation> {
  const context = await resolveSelection(userId, input);

  const completion = await aiProvider().complete(
    requestFor(input.mode, context, signal),
  );

  return {
    mode: input.mode,
    passage: context.passage,
    text: completion.text.trim(),
    tokensUsed:
      completion.usage.inputTokens + completion.usage.outputTokens,
  };
}

export type ExplainEvent =
  | { type: "text"; text: string }
  | { type: "done"; tokensUsed: number };

/**
 * The same work, streamed.
 *
 * **Nothing is yielded before the provider's first delta**, and that is a
 * deliberate restraint rather than an oversight. Scribble can send its
 * candidate cards early because by then its intent call has already succeeded,
 * so the provider is known to be reachable; this feature makes exactly one
 * model call, so the first thing it could yield would arrive *before* anything
 * had been asked of the provider. Emitting it would commit the response to
 * `200 text/event-stream` (see `writeEvent` in `routes/ai.ts`) and turn an
 * unreachable Ollama -- the common local failure -- from an honest 503 into a
 * fake success carrying an error frame.
 *
 * Nothing is lost by the restraint: the one thing there would have been to
 * send early is the passage, and the client selected it, so it already has it.
 * It renders its own selection with no round trip at all, which is faster than
 * being told.
 */
export async function* explainStream(
  userId: string,
  input: ExplainInput,
  signal?: AbortSignal,
): AsyncGenerator<ExplainEvent> {
  const context = await resolveSelection(userId, input);

  for await (const event of aiProvider().stream(
    requestFor(input.mode, context, signal),
  )) {
    if (event.type === "text") {
      yield { type: "text", text: event.text };
    } else {
      yield {
        type: "done",
        tokensUsed: event.usage.inputTokens + event.usage.outputTokens,
      };
    }
  }
}
