/**
 * Brainstorming: premises, characters and chapter outlines, as validated
 * objects rather than prose.
 *
 * Every call goes through `completeStructured` (Task AI 4), so what a caller
 * gets is a value of a known shape or an error -- never a paragraph the client
 * has to parse. The interesting parts of this file are the two things that are
 * not the model call:
 *
 * - **Alternatives are generated one at a time**, each told what the previous
 *   ones were, so "three ideas" is three different ideas rather than three
 *   rewordings of the first. Cost is per variant and the count is capped,
 *   because this is the one endpoint where a client can multiply the bill by
 *   asking politely.
 * - **The conversation lives here, not in the client.** A refinement sends back
 *   a session id and an index; the object it is revising is the one the model
 *   actually wrote, read from Redis. A client that sent the object back could
 *   send a different one -- and the model would faithfully refine whatever it
 *   was handed, which is a way to launder arbitrary text through a feature that
 *   looks like it only edits its own output.
 */

import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { HttpError } from "../../lib/http-error.js";
import { connectRedis, redis } from "../../lib/redis.js";
import { getStoryContext, type StoryContext } from "../authoring.js";
import {
  avoidMessage,
  briefMessage,
  generateSystemPrompt,
  refineSystemPrompt,
} from "./prompts/generate.js";
import { aiProvider } from "./provider.js";
import {
  chapterOutlineSchema,
  characterProfileSchema,
  storyIdeaSchema,
} from "./schemas.js";
import type { AiMessage } from "./types.js";
import {
  GENERATION_KINDS,
  type GeneratedValue,
  type GenerationKind,
  type GenerationResult,
  type GenerationSeed,
  type RefinementResult,
} from "./generate-types.js";

export { GENERATION_KINDS };
export type {
  GeneratedValue,
  GenerationKind,
  GenerationResult,
  GenerationSeed,
  RefinementResult,
};

/**
 * The ceiling on alternatives per request.
 *
 * Three, not ten: each one is a whole model call, and a person comparing
 * options stops reading after three anyway. The cap is enforced here as well
 * as in the route's schema -- a service that trusts its caller to have
 * validated is a service that is one new caller away from being wrong.
 */
export const MAX_VARIANTS = 3;

/**
 * Long enough to think about three options and refine one; short enough that
 * abandoned brainstorms cost nothing. Refreshed on every refinement, so an
 * active conversation does not expire underneath its author.
 */
const SESSION_TTL_SECONDS = 30 * 60;

/**
 * Turns kept per variant before the middle is dropped. Six is three exchanges:
 * enough for a refinement to know what it already changed, bounded so a long
 * conversation cannot grow the prompt without limit.
 */
const MAX_HISTORY_TURNS = 6;

/** Per kind, sized to the shape: an outline with eight scenes is the long one. */
const TOKEN_BUDGET: Record<GenerationKind, number> = {
  idea: 1200,
  character: 1400,
  outline: 1800,
};

function schemaFor(kind: GenerationKind): ZodType<GeneratedValue> {
  switch (kind) {
    case "idea":
      return storyIdeaSchema;
    case "character":
      return characterProfileSchema;
    case "outline":
      return chapterOutlineSchema;
  }
}

/** What the next alternative is told to avoid repeating. */
function labelOf(value: GeneratedValue): string {
  return "title" in value ? value.title : value.name;
}

/* Sessions --------------------------------------------------------------- */

interface StoredVariant {
  value: GeneratedValue;
  /**
   * The conversation that produced it: the brief, what the model answered, and
   * every refinement since. Replayed on the next refinement so the model
   * revises its own words rather than starting again from a summary of them.
   */
  history: AiMessage[];
}

interface StoredSession {
  kind: GenerationKind;
  variants: StoredVariant[];
}

/**
 * The caller's id is part of the key, not a field inside the value.
 *
 * So a session id guessed or stolen from someone else's browser resolves to
 * nothing at all, rather than to a record this code then has to remember to
 * check the owner of.
 */
function sessionKey(userId: string, sessionId: string): string {
  return `ai:generate:${userId}:${sessionId}`;
}

async function saveSession(
  userId: string,
  sessionId: string,
  session: StoredSession,
): Promise<void> {
  await connectRedis();
  await redis.set(sessionKey(userId, sessionId), JSON.stringify(session), {
    EX: SESSION_TTL_SECONDS,
  });
}

/**
 * The expired case is the common one -- a tab left open over lunch -- so it
 * gets a message that says what happened and what to do, not a 404 the UI has
 * to guess at.
 */
async function loadSession(
  userId: string,
  sessionId: string,
): Promise<StoredSession> {
  await connectRedis();
  const raw = await redis.get(sessionKey(userId, sessionId));

  if (raw === null) {
    throw HttpError.notFound(
      "That brainstorm has expired. Generate again to keep refining.",
    );
  }

  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    // Only reachable if something else wrote this key, but a crash on a
    // malformed cache entry would be a 500 for a fixable state.
    throw HttpError.notFound(
      "That brainstorm could not be read. Generate again to keep refining.",
    );
  }
}

/**
 * Keeps the brief and the most recent turns, dropping the middle.
 *
 * The first message is never dropped: it carries the genre, the theme and the
 * author's own story, and a revision that has forgotten them stops fitting the
 * work it was generated for. What is safe to lose is the middle of a long
 * refinement chain, where each turn has already been folded into the object
 * that followed it.
 */
function trimHistory(history: AiMessage[]): AiMessage[] {
  if (history.length <= MAX_HISTORY_TURNS) return history;

  const [brief, ...rest] = history;
  const kept = rest.slice(-(MAX_HISTORY_TURNS - 1));

  return brief ? [brief, ...kept] : kept;
}

/* Generation ------------------------------------------------------------- */

export async function generate(
  userId: string,
  kind: GenerationKind,
  seed: GenerationSeed,
  count: number,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  // Asserts ownership; a story id belonging to someone else never reaches a
  // prompt. See `getStoryContext`.
  const story: StoryContext | null = seed.storyId
    ? await getStoryContext(userId, seed.storyId)
    : null;

  const schema = schemaFor(kind);
  const system = generateSystemPrompt(kind);
  const brief = briefMessage(seed, story, kind);
  const wanted = Math.min(Math.max(1, count), MAX_VARIANTS);

  const variants: StoredVariant[] = [];

  for (let index = 0; index < wanted; index += 1) {
    /**
     * One user message, not two.
     *
     * The brief and the "make it different" note are concatenated because
     * consecutive messages of the same role are rejected outright by some
     * providers -- a compatibility detail that has nothing to do with what is
     * being said, which is why it is handled here rather than in `prompts/`.
     */
    const content =
      index === 0
        ? brief
        : `${brief}\n\n${avoidMessage(variants.map((variant) => labelOf(variant.value)))}`;

    const messages: AiMessage[] = [{ role: "user", content }];

    /**
     * Sequential, not `Promise.all`.
     *
     * Each alternative has to know what the others were, which is what makes
     * them alternatives; and the default provider is a model on this machine's
     * CPU, where three concurrent requests are not three times faster, they
     * are three requests queued behind each other with three times the memory.
     */
    const { value } = await aiProvider().completeStructured(schema, {
      feature: `generate.${kind}`,
      system,
      messages,
      maxTokens: TOKEN_BUDGET[kind],
      ...(signal ? { signal } : {}),
    });

    variants.push({
      value,
      history: [...messages, { role: "assistant", content: JSON.stringify(value) }],
    });
  }

  const sessionId = randomUUID();
  await saveSession(userId, sessionId, { kind, variants });

  return {
    sessionId,
    kind,
    variants: variants.map((variant) => variant.value),
    expiresInSeconds: SESSION_TTL_SECONDS,
  };
}

/* Refinement ------------------------------------------------------------- */

export async function refine(
  userId: string,
  sessionId: string,
  index: number,
  instruction: string,
  signal?: AbortSignal,
): Promise<RefinementResult> {
  const session = await loadSession(userId, sessionId);
  const variant = session.variants[index];

  if (!variant) {
    throw HttpError.notFound("There is nothing at that position to refine.");
  }

  const messages: AiMessage[] = [
    ...variant.history,
    // The author's instruction, as an ordinary user turn. It is a directive
    // they are entitled to give about their own generated object -- unlike the
    // brief, which describes material and is fenced as data.
    { role: "user", content: instruction },
  ];

  const { value } = await aiProvider().completeStructured(
    schemaFor(session.kind),
    {
      feature: `generate.refine.${session.kind}`,
      system: refineSystemPrompt(session.kind),
      messages,
      maxTokens: TOKEN_BUDGET[session.kind],
      ...(signal ? { signal } : {}),
    },
  );

  // The revision replaces the variant in place, so a second refinement builds
  // on the first rather than on the original. Saving also refreshes the TTL.
  session.variants[index] = {
    value,
    history: trimHistory([
      ...messages,
      { role: "assistant", content: JSON.stringify(value) },
    ]),
  };
  await saveSession(userId, sessionId, session);

  return {
    sessionId,
    kind: session.kind,
    index,
    value,
    expiresInSeconds: SESSION_TTL_SECONDS,
  };
}
