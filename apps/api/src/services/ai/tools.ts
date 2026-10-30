/**
 * The tools the assistant may call (Task AI 15).
 *
 * **A tool is deterministic code.** The model chooses which one and with what
 * arguments; this file decides what that means. Each tool is a zod schema plus
 * a plain function over a service call that already exists -- search, Ask This
 * Book's retrieval, the story bible, the continuity checker -- and none of them
 * calls a model. A tool that generated text would put a second probabilistic
 * step inside the first, and its cost inside a loop that is already bounded by
 * tokens.
 *
 * Three rules every tool here keeps, all tested in `routes/ai-agent.test.ts`:
 *
 * - **Arguments are untrusted input.** The model wrote them. They are parsed
 *   by `runTool` with the tool's zod schema before `run` sees them, exactly as
 *   a route parses a body, and `run` receives only the parsed value.
 * - **Every tool runs as the caller.** `ToolContext.userId` comes from the
 *   session, never from an argument, and each tool reaches data only through
 *   the service function the matching route uses -- so a draft that 404s on
 *   `GET /api/stories/:id` 404s here, and a bible that is its author's alone
 *   is refused to anybody else. The refusal is the service's, not a line in the
 *   prompt asking the model to behave.
 * - **Failure is a result, not an exception.** A refused story, an embedder
 *   that is down, an argument that does not parse: each comes back to the model
 *   as `{ error }`, so it can say so or try something else. A thrown exception
 *   would end the whole request over one lookup that did not work.
 *
 * What the tools deliberately cannot do: widen a reader's spoiler bound
 * (`search_chapters` takes no chapter limit -- it uses the reader's own, as Ask
 * This Book does), run a fresh continuity check (that is a model call; the
 * tool reports the stored findings), or write anything.
 *
 * `propose_edit` (Task AI 21) is the one that looks like an exception and is
 * not. A proposal is *output*: the tool checks it and records it for the
 * answer, and the author applies it in the editor or does not. Nothing here
 * writes a chapter, so "the model cannot write" stays a property of the code
 * rather than an instruction in the prompt -- which matters most at the point
 * the model starts suggesting writes.
 */

import { randomUUID } from "node:crypto";
import { z, type ZodType } from "zod";
import { HttpError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { assertStoryOwned, listMyChapters } from "../authoring.js";
import { getStory, listChapters, type Story } from "../stories.js";
import {
  QUESTION_LIMIT,
  readableQuote,
  resolveAskSetting,
  retrievePassages,
} from "./ask-book.js";
import { SELECTION_LIMIT } from "./assist.js";
import { normalise } from "./bible-facts.js";
import { getChapterContinuity } from "./continuity.js";
import { jsonSchemaFor } from "./json-schema.js";
import { literalSearch } from "./literal-search.js";
import { QUERY_LIMIT, search } from "./search.js";
import { getBible } from "./story-bible.js";
import type { AiToolCall, AiToolDefinition } from "./types.js";

/** Who is asking. Built by the route from the session -- never from the model. */
export interface ToolContext {
  userId: string;
  signal?: AbortSignal;
  /**
   * Present only when the story on screen is the caller's own: see
   * `editingFor`. Its absence is what keeps `propose_edit` from being offered.
   */
  editing?: EditingContext;
}

/** An edit the assistant proposed and the author has not yet decided on. */
export interface EditProposal {
  id: string;
  chapterId: string;
  chapterNumber: number;
  /** The author's text, exactly, occurring once in the chapter when proposed. */
  quote: string;
  replacement: string;
  reason: string;
}

export interface EditingContext {
  /** The one story `propose_edit` may anchor to. Never an argument. */
  storyId: string;
  /** What `propose_edit` accepted in this request, in order. */
  proposals: EditProposal[];
}

export interface AgentTool<Args> {
  name: string;
  /** What the model reads when choosing. Says what the tool will refuse, too. */
  description: string;
  schema: ZodType<Args>;
  /** Whether this request is shown the tool at all. Absent means always. */
  offered?(context: ToolContext): boolean;
  /** Returns something JSON-serialisable. Throws `HttpError` to refuse. */
  run(args: Args, context: ToolContext): Promise<unknown>;
}

/** Keeps `Args` tied to the schema, so `run` is typed by what zod parses. */
function defineTool<Args>(tool: AgentTool<Args>): AgentTool<Args> {
  return tool;
}

/**
 * The most a single result may put into the conversation.
 *
 * Every tool is bounded by construction (a few stories, six passages, forty
 * facts); this is the backstop for a story with a pathological chapter list.
 * Six thousand characters is about 1,500 tokens -- a result the size of Ask
 * This Book's whole passage block.
 */
export const RESULT_LIMIT = 6000;

/** Passages one `search_chapters` call returns, whichever way they were found. */
const PASSAGE_LIMIT = 6;

/** A story by slug or id, as every story route accepts. */
const storyKey = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("The story's id or slug, from a search result or the page context.");

const authorName = (story: Story): string =>
  story.author.displayName ?? story.author.username;

const clip = (text: string | null, limit: number): string | null =>
  text === null ? null : text.length > limit ? `${text.slice(0, limit)}…` : text;

/* The tools -------------------------------------------------------------- */

const searchStories = defineTool({
  name: "search_stories",
  description:
    "Find stories on Scribe by what they are about, their title or their author. " +
    "Returns a few stories, each with an id to pass to the other tools and, where meaning matched, a short passage showing why.",
  schema: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(QUERY_LIMIT)
      .describe("A few words describing what to look for."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5)
      .nullish()
      .describe("How many stories, 1-5. Defaults to 5."),
  }),
  async run(args, context) {
    const page = await search(
      { q: args.query, mode: "hybrid", page: 1, limit: args.limit ?? 5 },
      context.userId,
      context.signal,
    );

    return {
      // `keyword` means meaning search was down; the model should know its
      // results are title matches only.
      basis: page.basis,
      stories: page.items.map((story) => ({
        storyId: story.id,
        slug: story.slug,
        title: story.title,
        author: authorName(story),
        genres: story.genres.map((genre) => genre.name),
        completed: story.isCompleted,
        chapterCount: story.chapterCount,
        description: clip(story.description, 300),
        passages: story.passages.slice(0, 2).map((passage) => ({
          chapterNumber: passage.chapterNumber,
          chapterTitle: passage.chapterTitle,
          excerpt: passage.excerpt,
        })),
      })),
    };
  },
});

const searchChapters = defineTool({
  name: "search_chapters",
  description:
    "Search the text of one story's chapters for passages relevant to a question. " +
    "Only searches chapters the reader has reached, so it cannot spoil later ones. " +
    "For the user's own story it also searches every chapter, drafts included, for the question's words. " +
    "Returns up to six passages in reading order, or none when nothing is relevant.",
  schema: z.object({
    storyId: storyKey,
    query: z
      .string()
      .trim()
      .min(3)
      .max(QUESTION_LIMIT)
      .describe("What to look for, phrased as a standalone question or description."),
  }),
  async run(args, context) {
    // The setting is the authorisation: a story the caller cannot see is a
    // 404 here, before anything is embedded. `null` is the reader's own bound.
    const setting = await resolveAskSetting(context.userId, args.storyId, null);
    const passages = await retrievePassages(
      setting,
      args.query,
      context.userId,
      context.signal,
      "agent.tool.search_chapters",
    );

    const found = passages.map((passage) => ({
      chapterNumber: passage.chapterNumber,
      chapterTitle: passage.chapterTitle,
      text: clip(readableQuote(passage.text), 900) ?? "",
    }));

    /**
     * The author's drafts, by their words. Drafts are never embedded (see
     * `literal-search.ts`), so for the one person who may read them the
     * search by meaning above sees only what is published. `listMyChapters`
     * is the editor's own read and re-checks ownership; nothing it returns
     * reaches anyone but the author.
     */
    if (setting.scope.basis === "author") {
      const chapters = await listMyChapters(context.userId, setting.story.id);
      const byWords = literalSearch(
        chapters.map((chapter) => ({
          chapterNumber: chapter.number,
          chapterTitle: chapter.title,
          content: readableQuote(chapter.content),
        })),
        args.query,
        PASSAGE_LIMIT,
      );
      for (const hit of byWords) {
        if (found.length >= PASSAGE_LIMIT) break;
        const text = clip(hit.text, 900) ?? "";
        if (found.some((passage) => passage.text.includes(text.slice(0, 120)))) continue;
        found.push({ chapterNumber: hit.chapterNumber, chapterTitle: hit.chapterTitle, text });
      }
      found.sort((a, b) => a.chapterNumber - b.chapterNumber);
    }

    return {
      story: setting.story.title,
      // Which chapters were searched, so the model can say so rather than
      // implying the story is silent on something it simply has not reached.
      searchedUpToChapter: setting.scope.upToChapter,
      passages: found,
    };
  },
});

const storySummary = defineTool({
  name: "get_story_summary",
  description:
    "Get a story's details: title, author, genres, whether it is finished, the author's own description, and its chapter list. " +
    "The description is the author's blurb, not a generated summary.",
  schema: z.object({ storyId: storyKey }),
  async run(args, context) {
    const story = await getStory(args.storyId, context.userId);
    // Visible chapters only: a reader is told about chapters they could open.
    const chapters = await listChapters(story.id, context.userId);

    return {
      storyId: story.id,
      slug: story.slug,
      title: story.title,
      author: authorName(story),
      isYourStory: story.author.id === context.userId,
      genres: story.genres.map((genre) => genre.name),
      completed: story.isCompleted,
      draft: story.listedAt === null,
      wordCount: story.wordCount,
      rating:
        story.ratingAverage === null
          ? null
          : { average: story.ratingAverage, count: story.ratingCount },
      description: clip(story.description, 1200),
      chapterCount: chapters.length,
      chapters: chapters
        .slice(0, 60)
        .map((chapter) => ({ number: chapter.number, title: chapter.title })),
    };
  },
});

/** A fact as the model needs it: the claim and where it was established. */
const FACT_LIMIT = 40;

const characterFacts = defineTool({
  name: "get_character_facts",
  description:
    "Get the story bible's facts about characters, places and objects in a story -- only for a story the current user wrote. " +
    "Optionally narrowed to one subject, such as a character's name.",
  schema: z.object({
    storyId: storyKey,
    subject: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .nullish()
      .describe("A name to narrow to, or null for every fact."),
  }),
  async run(args, context) {
    const story = await getStory(args.storyId, context.userId);
    // The bible's own check: it is read from drafts as well as published
    // chapters, so anybody else reading it would be reading unpublished work.
    const bible = await getBible(context.userId, story.id);

    const wanted = args.subject ? normalise(args.subject) : null;
    const matching = bible.facts.filter(
      (fact) =>
        wanted === null ||
        normalise(fact.subject).includes(wanted) ||
        (fact.related !== null && normalise(fact.related).includes(wanted)),
    );

    return {
      story: story.title,
      total: matching.length,
      // Chapters not yet read into the bible: facts from them are missing.
      chaptersNotYetRead: bible.pending,
      facts: matching.slice(0, FACT_LIMIT).map((fact) => ({
        kind: fact.kind,
        subject: fact.subject,
        attribute: fact.attribute,
        value: fact.value,
        related: fact.related,
        chapterNumber: fact.chapterNumber,
        confirmedByAuthor: fact.origin === "author",
      })),
    };
  },
});

const continuity = defineTool({
  name: "check_continuity",
  description:
    "Get the continuity findings for one chapter of a story the current user wrote: places where it contradicts what earlier chapters established. " +
    "Reports the most recent check; it does not run a new one.",
  schema: z.object({
    storyId: storyKey,
    chapterNumber: z.number().int().min(1).max(100000),
  }),
  async run(args, context) {
    const story = await getStory(args.storyId, context.userId);
    const chapter = (await listChapters(story.id, context.userId)).find(
      (row) => row.number === args.chapterNumber,
    );
    if (!chapter) throw HttpError.notFound("That chapter could not be found.");

    // Ownership is asserted here, by the checker's own read.
    const result = await getChapterContinuity(context.userId, chapter.id);

    return {
      story: story.title,
      chapterNumber: chapter.number,
      chapterTitle: chapter.title,
      checksEnabled: result.enabled,
      lastCheck: result.check,
      findings: result.findings.slice(0, 10).map((finding) => ({
        kind: finding.kind,
        explanation: finding.explanation,
        confidence: finding.confidence,
        thisChapterSays: `${finding.claim.subject} — ${finding.claim.attribute}: ${finding.claim.value}`,
        earlierSays: `${finding.fact.subject} — ${finding.fact.attribute}: ${finding.fact.value}`,
        earlierChapter: finding.fact.chapterNumber,
      })),
    };
  },
});

/**
 * Proposals one request may carry. Three is a handful of fixes the author can
 * weigh one at a time; more reads as a rewrite, which is the writing
 * assistant's job, on a selection the author chose.
 */
export const MAX_PROPOSALS = 3;

/** How often `quote` occurs in `text`, counted only as far as two: all an anchor needs. */
function occurrences(text: string, quote: string): number {
  let count = 0;
  // Overlapping matches count: "aa" in "aaa" is two places, so ambiguous.
  for (let at = text.indexOf(quote); at !== -1 && count < 2; at = text.indexOf(quote, at + 1)) {
    count += 1;
  }
  return count;
}

const proposeEdit = defineTool({
  name: "propose_edit",
  description:
    "Propose replacing one passage of a chapter in the user's own story, the one on screen. " +
    "Use it whenever the author asks for something in their story to be fixed, changed or rewritten. " +
    "Nothing changes: the author sees the proposal beside their text and accepts or rejects it. " +
    "quote must be copied exactly from the chapter, character for character, and occur in it exactly once -- quote enough of the sentence to make it unique. " +
    `At most ${MAX_PROPOSALS} proposals per request.`,
  schema: z.object({
    chapterNumber: z.number().int().min(1).max(100000),
    // Not trimmed: the quote is matched exactly, and so is what replaces it.
    quote: z
      .string()
      .min(1)
      .max(SELECTION_LIMIT)
      .describe("The author's text to replace, exactly as it appears in the chapter."),
    replacement: z
      .string()
      .max(SELECTION_LIMIT)
      .describe("The text to put in its place."),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe("One sentence telling the author why."),
  }),
  offered: (context) => context.editing !== undefined,
  async run(args, context) {
    const editing = context.editing;
    // `runTool` does not run a tool that was not offered; this is the backstop.
    if (!editing) {
      throw HttpError.forbidden("Edits can only be proposed for your own story, open in the editor.");
    }
    if (editing.proposals.length >= MAX_PROPOSALS) {
      throw HttpError.conflict(
        `Only ${MAX_PROPOSALS} edits can be proposed at once. Tell the author about the rest instead.`,
      );
    }
    if (args.quote === args.replacement) {
      throw HttpError.badRequest("That replacement is the same as the quote, so it changes nothing.");
    }

    // The editor's read, drafts included. It re-checks ownership itself, so a
    // story that changed hands since the request began is refused here too.
    const chapter = (await listMyChapters(context.userId, editing.storyId)).find(
      (row) => row.number === args.chapterNumber,
    );
    if (!chapter) throw HttpError.notFound("That chapter could not be found.");

    // Anchored by content, not offsets: the author may be typing, and the
    // editor finds the quote again in its own buffer before applying it.
    const found = occurrences(chapter.content, args.quote);
    if (found === 0) {
      throw HttpError.badRequest(
        `That quote does not appear in chapter ${chapter.number}. Copy it exactly from the chapter's text.`,
      );
    }
    if (found > 1) {
      throw HttpError.badRequest(
        `That quote appears more than once in chapter ${chapter.number}. Quote more of the sentence so it is unique.`,
      );
    }

    const proposal: EditProposal = {
      id: randomUUID(),
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      quote: args.quote,
      replacement: args.replacement,
      reason: args.reason,
    };
    editing.proposals.push(proposal);

    return { accepted: true, proposalId: proposal.id };
  },
});

/**
 * The editing context for a request, when the story on screen is the
 * caller's own. Anything else -- no story, another author's, a catalogue
 * edition, a key that names nothing -- is `undefined`, and the request is
 * never shown `propose_edit`.
 */
export async function editingFor(
  storyKey: string | null,
  userId: string,
): Promise<EditingContext | undefined> {
  if (storyKey === null) return undefined;
  try {
    // The page context may be a slug; ownership is checked on the id.
    const story = await getStory(storyKey, userId);
    await assertStoryOwned(userId, story.id);
    return { storyId: story.id, proposals: [] };
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) return undefined;
    throw error;
  }
}

/* Registry --------------------------------------------------------------- */

// `AgentTool<any>`: the registry holds tools of different argument types, and
// `runTool` is the one place that bridges them, by parsing with each tool's own
// schema before calling its `run`.
export const AGENT_TOOLS: readonly AgentTool<any>[] = [
  searchStories,
  searchChapters,
  storySummary,
  characterFacts,
  continuity,
  proposeEdit,
];

/** The tools this request may see and call. */
export function toolsFor(context: ToolContext): readonly AgentTool<any>[] {
  return AGENT_TOOLS.filter((tool) => tool.offered?.(context) ?? true);
}

/** The tools as the provider is told about them. Derived, never hand-written. */
export function toolDefinitions(
  tools: readonly AgentTool<unknown>[] = AGENT_TOOLS,
): AiToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: jsonSchemaFor(tool.schema, tool.name).schema,
  }));
}

/* Running one call ------------------------------------------------------- */

/**
 * - `ok`: ran and returned.
 * - `invalid`: no such tool, or the arguments did not parse -- `run` never ran.
 * - `refused`: the service said no (not found, not yours, too many requests).
 * - `error`: something broke that is nobody's fault the model can act on.
 */
export type ToolOutcome = "ok" | "invalid" | "refused" | "error";

export interface ToolRun {
  outcome: ToolOutcome;
  /** The arguments as parsed, or the raw text when they did not parse. */
  arguments: unknown;
  /** What goes back to the model: the result, or `{ error }`. */
  result: unknown;
  /** The stable code of a refusal or error, for the trace and the log. */
  code?: string;
  durationMs: number;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Raw arguments shown in a trace, bounded: they are model output. */
const rawArguments = (text: string): string =>
  text.length > 300 ? `${text.slice(0, 300)}…` : text;

/**
 * Validates and runs one tool call, and never throws.
 *
 * An abort is the one exception that is re-thrown: the client went away, and
 * reporting that to a model nobody is waiting on would only spend tokens.
 */
export async function runTool(
  call: AiToolCall,
  context: ToolContext,
): Promise<ToolRun> {
  const startedAt = Date.now();
  const done = (run: Omit<ToolRun, "durationMs">): ToolRun => ({
    ...run,
    durationMs: Date.now() - startedAt,
  });

  // A tool this request was not offered does not exist for it, so a model
  // cannot reach `propose_edit` by naming it on someone else's story.
  const offered = toolsFor(context);
  const tool = offered.find((candidate) => candidate.name === call.name);
  if (!tool) {
    return done({
      outcome: "invalid",
      arguments: rawArguments(call.arguments),
      result: {
        error: `There is no tool called "${call.name.slice(0, 60)}". Use one of: ${offered.map((t) => t.name).join(", ")}.`,
      },
      code: "unknown_tool",
    });
  }

  let json: unknown;
  try {
    // Some models send "" for a tool with no required arguments.
    json = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return done({
      outcome: "invalid",
      arguments: rawArguments(call.arguments),
      result: { error: "The arguments were not valid JSON. Send a JSON object." },
      code: "invalid_arguments",
    });
  }

  const parsed = tool.schema.safeParse(json);
  if (!parsed.success) {
    return done({
      outcome: "invalid",
      arguments: json,
      result: { error: `The arguments were not valid: ${describeIssues(parsed.error)}.` },
      code: "invalid_arguments",
    });
  }

  try {
    const result = await tool.run(parsed.data, context);
    return done({ outcome: "ok", arguments: parsed.data, result });
  } catch (error) {
    if (context.signal?.aborted) throw error;

    if (error instanceof HttpError) {
      // `HttpError` messages are written for the person on the other end of
      // the API -- "That story could not be found." -- so they are safe to
      // show a model that is about to explain the refusal to that person.
      const refused = error.status < 500;
      return done({
        outcome: refused ? "refused" : "error",
        arguments: parsed.data,
        result: { error: error.message },
        code: error.code,
      });
    }

    logger.error({ err: error, tool: tool.name }, "agent tool failed");
    return done({
      outcome: "error",
      arguments: parsed.data,
      result: { error: "That lookup failed unexpectedly." },
      code: "internal_error",
    });
  }
}
