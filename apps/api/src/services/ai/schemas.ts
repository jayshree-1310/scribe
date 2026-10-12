/**
 * The shapes generative features ask for.
 *
 * Each one is a zod schema and nothing else: the JSON schema the model is
 * constrained by is derived from it (`json-schema.ts`), and the same object
 * validates the reply. There is deliberately no second, hand-written copy of
 * any of these for the wire -- see that file's header for why.
 *
 * Two conventions worth keeping as this list grows:
 *
 * - **Every field is required, and optionality is nullability.** Hosted
 *   providers' strict mode demands it, and it is better prompting besides: a
 *   model allowed to omit a field omits it, and an omitted field is
 *   indistinguishable from one the model had nothing to say about.
 * - **Bounds live here, not in the prompt.** `max(120)` on a title is enforced
 *   on the way back whatever the model was told, which is the only enforcement
 *   that survives a provider that ignores the schema.
 *
 * Nothing consumes these yet. Task AI 5 builds the endpoints that do
 * (`/api/ai/generate/idea`, `/character`, `/outline`); this task owns the
 * shapes and the machinery that makes a model produce them.
 */

import { z } from "zod";

/** Ceilings, not targets -- a long list costs tokens to generate and to read. */
const MAX_CHARACTERS = 6;
const MAX_LIST_ITEMS = 5;
const MAX_SCENES = 8;

/** One sentence, the length a person reads without deciding to skip it. */
const sentence = z.string().trim().min(1).max(300);

/** A paragraph: a premise, a summary, the shape of an ending. */
const paragraph = z.string().trim().min(1).max(800);

const title = z.string().trim().min(1).max(120);

/** A person's name, whether a character's or one they are related to. */
const name = z.string().trim().min(1).max(80);

/* Story idea ------------------------------------------------------------- */

/**
 * A brainstormed premise, not a story.
 *
 * `genre` is a free string rather than an enum of the real genre list: this is
 * an idea an author may or may not act on, and the moment it becomes a story
 * the genre is chosen through the authoring API against real rows. Compare
 * `scribble.ts`, where the genre *is* a database filter and the model picks
 * from a closed list for exactly that reason.
 */
export const storyIdeaSchema = z.object({
  title,
  premise: paragraph.describe("Two or three sentences: what happens, and to whom."),
  genre: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe("A single genre name, such as Fantasy or Literary Fiction."),
  characters: z
    .array(
      z.object({
        name,
        role: sentence.describe("Who they are in this story, in one sentence."),
      }),
    )
    .min(1)
    .max(MAX_CHARACTERS),
  conflict: paragraph.describe("What stands in the way, and why it is hard."),
  setting: paragraph.describe("Where and when, and what that costs the characters."),
  ending: paragraph.describe(
    "Where this is heading. A direction, not a guarantee.",
  ),
});

export type StoryIdea = z.infer<typeof storyIdeaSchema>;

/* Character profile ------------------------------------------------------ */

export const characterProfileSchema = z.object({
  name,
  role: sentence.describe("Their place in the story: protagonist, rival, mentor."),
  personality: paragraph,
  motivations: z.array(sentence).min(1).max(MAX_LIST_ITEMS),
  strengths: z.array(sentence).min(1).max(MAX_LIST_ITEMS),
  /**
   * Required, and required to be non-empty. A generated character with no
   * weaknesses is the single most common way this output is useless, and a
   * schema is a cheaper place to insist than a prompt.
   */
  weaknesses: z.array(sentence).min(1).max(MAX_LIST_ITEMS),
  relationships: z
    .array(
      z.object({
        name,
        relationship: sentence.describe(
          "How they know each other, and what is unresolved between them.",
        ),
      }),
    )
    .max(MAX_LIST_ITEMS),
});

export type CharacterProfile = z.infer<typeof characterProfileSchema>;

/* Chapter outline -------------------------------------------------------- */

export const chapterOutlineSchema = z.object({
  title,
  summary: paragraph.describe("What this chapter does for the story."),
  scenes: z
    .array(
      z.object({
        title,
        summary: paragraph,
      }),
    )
    .min(1)
    .max(MAX_SCENES),
  /** Names only. The profiles live on their own, and repeating them here
   * would be two sources of truth for the same character. */
  characters: z.array(name).max(MAX_CHARACTERS),
  conflict: paragraph.describe("The tension this chapter turns on."),
  endingHook: sentence.describe(
    "The reason a reader starts the next chapter instead of stopping.",
  ),
});

export type ChapterOutline = z.infer<typeof chapterOutlineSchema>;

/* Conversation: the standalone question ---------------------------------- */

/**
 * A follow-up rewritten so it can be searched on its own.
 *
 * An object rather than bare text for the reason the other shapes here are
 * objects: a constrained, validated reply cannot arrive wrapped in "Sure!
 * Here's the rewritten question:", which a small model will otherwise add.
 * The cap matches the route's own limit on a question.
 */
export const standaloneQuestionSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("The reader's latest question, rewritten to make sense with no conversation before it."),
});

export type StandaloneQuestion = z.infer<typeof standaloneQuestionSchema>;

/* Story bible: what a chapter establishes -------------------------------- */

/**
 * The four kinds of fact a bible holds. A closed list because each one is
 * treated differently downstream: relationships are keyed by who they are
 * between, events are what "recent" means, and characters are what a name
 * match is looking for.
 */
export const FACT_KINDS = [
  "character",
  "location",
  "relationship",
  "event",
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

/**
 * Per extraction call, not per chapter: a long chapter is read in sections
 * (`story-bible.ts`), and a cap per section is what a model can be told.
 */
export const MAX_FACTS_PER_SECTION = 25;

/**
 * One fact, as a model reports it.
 *
 * `quote` is the field that makes the rest trustworthy. It is checked against
 * the chapter before anything is stored, and a fact whose quote the chapter
 * does not contain is dropped -- so the bounds here are generous enough for a
 * sentence and no more, because a long quote is a paraphrase waiting to fail
 * that check.
 */
export const extractedFactSchema = z.object({
  kind: z.enum(FACT_KINDS),
  subject: name.describe(
    "The person, place or event this fact is about, named exactly as the chapter names it.",
  ),
  attribute: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe(
      "A short label for what is being said: eye colour, age, occupation, status, whereabouts, lives in, sister of, what happened, when.",
    ),
  value: sentence.describe("The fact itself, in a few words."),
  related: name
    .nullable()
    .describe("For a relationship, the other person's name. Otherwise null."),
  quote: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe(
      "The shortest passage of the chapter that states this fact, copied word for word.",
    ),
});

export type ExtractedFact = z.infer<typeof extractedFactSchema>;

/**
 * An object around the list for the reason `standaloneQuestionSchema` is one:
 * a bare array invites "Here are the facts:" in front of it. An empty list is
 * a valid answer -- a chapter of pure mood establishes nothing to check.
 */
export const chapterFactsSchema = z.object({
  facts: z.array(extractedFactSchema).max(MAX_FACTS_PER_SECTION),
});

export type ChapterFacts = z.infer<typeof chapterFactsSchema>;

/* Continuity: what does not add up ---------------------------------------- */

export const CONTINUITY_KINDS = [
  "attribute",
  "whereabouts",
  "timeline",
  "death",
  "relationship",
  "other",
] as const;

export type ContinuityKind = (typeof CONTINUITY_KINDS)[number];

/** A ceiling, and a low one: a chapter with ten contradictions has a bigger problem. */
export const MAX_FINDINGS = 8;

/**
 * One reported contradiction, as references rather than restatements.
 *
 * `claim` and `fact` are the labels the prompt gave (`N3`, `E7`), never text:
 * the evidence an author is shown is looked up from what was *sent*, so a
 * model cannot misquote a chapter into a contradiction that is not there. A
 * label that names nothing that was sent is dropped by the service.
 */
export const continuityFindingsSchema = z.object({
  findings: z
    .array(
      z.object({
        claim: z
          .string()
          .trim()
          .max(8)
          .describe("The label of the new claim, such as N2."),
        fact: z
          .string()
          .trim()
          .max(8)
          .describe("The label of the established fact it contradicts, such as E5."),
        kind: z.enum(CONTINUITY_KINDS),
        explanation: sentence.describe(
          "One sentence an author can act on: what does not add up, and why.",
        ),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe("How sure you are that the two cannot both be true, from 0 to 1."),
      }),
    )
    .max(MAX_FINDINGS),
});

export type ContinuityFindings = z.infer<typeof continuityFindingsSchema>;
