/**
 * Scribble: conversational discovery over the catalogue.
 *
 * **The model never produces a book.** It does two narrow jobs -- turning a
 * sentence into filters, and writing one sentence about each row that came
 * back -- and Postgres does the recommending in between. Title, author,
 * description and URL are copied off the row and never pass through a
 * completion.
 *
 * That is not a stylistic preference. A model asked to *recommend* books will
 * produce plausible titles that do not exist, by authors who did not write
 * them, at URLs that 404, and it will do so most confidently when the
 * catalogue is small. Asking it only to route and to narrate makes that class
 * of failure structurally impossible rather than something we prompt against.
 *
 * Stage 2 does no model work at all; see `retrieve`.
 */

import { z } from "zod";
import { HttpError } from "../../lib/http-error.js";
import { listBooks, listGenres, type GenreSummary } from "../books.js";
import { listStories } from "../stories.js";
import { createNarrationScanner } from "./json-stream.js";
import {
  NARRATION_SYSTEM_PROMPT,
  candidateBlock,
  intentSystemPrompt,
} from "./prompts/scribble.js";
import { aiProvider } from "./provider.js";
import type {
  Candidate,
  Recommendation,
  ScribbleContext,
  ScribbleReply,
} from "./scribble-types.js";

export type { Candidate, Recommendation, ScribbleContext, ScribbleReply };

/** Hard ceiling on what one turn may return, whatever the model asks for. */
const MAX_RECOMMENDATIONS = 6;

/**
 * The empty answer, naming what was looked for.
 *
 * "No thriller books by Amara Okonkwo" is a useful answer; "I could not find
 * anything" leaves a reader unable to tell a missing book from a
 * misunderstood question -- which matters most after a refinement, where the
 * filters came from two turns and only one of them was just typed.
 */
function noMatchIntro(intent: Intent): string {
  return `I could not find any ${describeQuery(intent)} in Scribe's library. Try widening it \u2014 a genre on its own, or a mood.`;
}

/**
 * The model answered and kept nothing usable. Falling back to the rows beats
 * an empty list: retrieval already found real matches, and only the sentence
 * about them is missing.
 */
const FALLBACK_INTRO = "Here is what Scribe's library has along those lines.";

/**
 * Answer to "hi".
 *
 * Without this, a greeting reaches retrieval with no filters at all and comes
 * back with the whole catalogue -- so saying hello produced a confident list
 * of books nobody asked for. A reply that recommends nothing is the correct
 * answer to a message that requested nothing.
 */
const GREETING_INTRO =
  "Hello. Tell me what you feel like reading \u2014 a genre, a mood, an author or a title \u2014 and I will find something in Scribe's library.";

/* Parsing model output --------------------------------------------------- */

/**
 * Model output is untrusted input and is validated exactly like a request
 * body. `.catch()` on the optional fields means one malformed member degrades
 * to its default instead of failing the whole turn -- a 3B model gets the
 * shape right far more often than it gets every field right.
 */
const intentSchema = z.object({
  /**
   * Defaults to `books` when the model fails to classify: a missed greeting
   * is a clumsy answer, a missed *request* is a broken feature.
   */
  kind: z.enum(["books", "other"]).catch("books"),
  /** `refine` inherits the previous turn's filters; see `mergeContext`. */
  mode: z.enum(["new", "refine"]).catch("new"),
  genre: z.string().trim().min(1).nullish().catch(null),
  kidsAppropriate: z.boolean().nullish().catch(false),
  completed: z.boolean().nullish().catch(null),
  search: z.string().trim().min(1).max(120).nullish().catch(null),
  limit: z.coerce.number().int().min(1).max(MAX_RECOMMENDATIONS).catch(5),
});

const narrationSchema = z.object({
  intro: z.string().trim().max(400).catch(""),
  picks: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        reason: z.string().trim().max(400).catch(""),
      }),
    )
    .catch([]),
});

/**
 * Small models wrap JSON in prose or a markdown fence however firmly the
 * prompt asks them not to. Taking the outermost brace-delimited span recovers
 * the common cases without pretending to be a parser.
 */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw HttpError.upstream("The assistant's reply could not be understood.");
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw HttpError.upstream("The assistant's reply could not be understood.");
  }
}

/* Stage 1: intent -------------------------------------------------------- */

export interface Intent {
  /** `other` means the message was not a request for something to read. */
  kind: "books" | "other";
  mode: "new" | "refine";
  /**
   * True when `search` was carried from the previous turn rather than produced
   * by this one. It decides whether the term may be relaxed; see `retrieve`.
   */
  searchInherited: boolean;
  genreId: string | null;
  genreName: string | null;
  kidsAppropriate: boolean;
  completed: boolean | null;
  search: string | null;
  limit: number;
}

/**
 * Sentence in, filters out.
 *
 * The genre arrives as a *name* and is resolved against the real list here. A
 * name that is not on that list is dropped rather than queried: a hallucinated
 * filter must widen the search, never empty it, and never reach the database.
 */
export async function interpret(
  message: string,
  context?: ScribbleContext | undefined,
  signal?: AbortSignal,
): Promise<Intent> {
  const genres = await listGenres();

  const completion = await aiProvider().complete({
    feature: "scribble.intent",
    system: intentSystemPrompt(genres, context),
    messages: [{ role: "user", content: message }],
    /**
     * Filters are a few dozen tokens, but a reasoning model spends its budget
     * thinking before it writes any of them -- at 200 `gpt-oss-120b` used 196
     * on reasoning and emitted nothing. The cap is a runaway guard, not a
     * target, so it can afford the headroom.
     */
    maxTokens: 600,
    ...(signal ? { signal } : {}),
  });

  const parsed = intentSchema.parse(extractJson(completion.text));

  const matched = parsed.genre
    ? genres.find(
        (genre) => genre.name.toLowerCase() === parsed.genre?.toLowerCase(),
      )
    : undefined;

  const fresh: Intent = {
    kind: parsed.kind,
    mode: parsed.mode,
    searchInherited: false,
    genreId: matched?.id ?? null,
    genreName: matched?.name ?? null,
    kidsAppropriate: parsed.kidsAppropriate ?? false,
    completed: parsed.completed ?? null,
    search: parsed.search ?? null,
    limit: parsed.limit,
  };

  if (fresh.kind !== "books" || fresh.mode !== "refine" || !context) {
    return fresh;
  }

  return mergeContext(fresh, context, genres);
}

/**
 * Lays this turn's filters over the previous turn's.
 *
 * A field this turn set wins; a field it left empty is inherited. So "books by
 * A" then "the thrillers" asks the database for thrillers *by A*, and when
 * that is empty the reader is told exactly that rather than being shown
 * thrillers by somebody else.
 *
 * The consequence worth knowing: a refinement narrows but cannot widen. "Any
 * genre now" cannot clear an inherited genre -- the model is expected to call
 * that a new search instead, which is what `mode` is for.
 */
function mergeContext(
  intent: Intent,
  context: ScribbleContext,
  genres: GenreSummary[],
): Intent {
  const carried = context.genre
    ? genres.find(
        (genre) => genre.name.toLowerCase() === context.genre?.toLowerCase(),
      )
    : undefined;

  return {
    ...intent,
    genreId: intent.genreId ?? carried?.id ?? null,
    genreName: intent.genreName ?? carried?.name ?? null,
    kidsAppropriate: intent.kidsAppropriate || context.kidsAppropriate,
    completed: intent.completed ?? context.completed,
    search: intent.search ?? context.search,
    searchInherited: intent.search === null && context.search !== null,
  };
}

/**
 * Names what was actually asked for, so an empty result can say so.
 *
 * Built from the merged filters in code rather than written by the model: the
 * point is to state a fact about the query, and a generated sentence about an
 * empty result set is exactly where a model starts inventing.
 */
function describeQuery(intent: Intent): string {
  const parts = [intent.genreName, "books"].filter(Boolean) as string[];
  if (intent.kidsAppropriate) parts.push("for children");
  if (intent.completed === true) parts.push("that are finished");
  if (intent.completed === false) parts.push("still being written");
  if (intent.search) parts.push(`matching \u201c${intent.search}\u201d`);

  return parts.join(" ");
}

/* Stage 2: retrieval ----------------------------------------------------- */

/**
 * No model here at all -- this is the stage that decides what gets
 * recommended, and it is two ordinary queries.
 *
 * Both halves of the corpus are searched. The catalogue is what a reader means
 * by "books", but the stories serialised on Scribe are the reason the platform
 * exists, and a concierge that cannot surface them is a search box for
 * somebody else's library.
 *
 * `listStories` applies `visibleTo`, so a draft reaches a recommendation only
 * for its own author. Retrieval inherits every authorisation rule of the data;
 * there is a test that says so.
 */
export interface Retrieved {
  candidates: Candidate[];
  /**
   * The search term that had to be abandoned to find anything, or null.
   *
   * Carried all the way to the UI rather than swallowed: substituting other
   * books for the title somebody asked for, silently, is the difference
   * between a helpful fallback and a wrong answer.
   */
  droppedSearch: string | null;
}

export async function retrieve(
  intent: Intent,
  viewerId: string,
): Promise<Retrieved> {
  /**
   * Filters are dropped one at a time until something matches.
   *
   * `search` is the one that gets dropped, because it is the most destructive
   * and the least reliable. It matches a title or an author name, and is
   * ANDed with everything else -- so a small model that restates the whole
   * request in it empties the query: "fantasy books for kids" yields
   * `search: "kids fantasy"`, which is neither a title nor an author, while
   * `genre` and `kidsAppropriate` have already captured the same meaning. An
   * over-eager filter must widen the search, never empty it.
   *
   * `kidsAppropriate` is never relaxed, and neither is `genre`. Those are what
   * the reader actually asked for; `search` is the model's paraphrase of it.
   * Falling back past a request for children's books to the adult shelf is the
   * one failure here that would actually matter.
   */
  const attempts: Intent[] = [intent];

  /**
   * Only worth a second pass when something else still constrains the query.
   * If `search` was the *only* filter and it matched nothing, dropping it
   * would ask for "any book at all" -- and answering a question about a title
   * we do not carry with an arbitrary shelf is worse than saying so.
   *
   * And never when the term was **inherited**. Relaxation exists to rescue a
   * model that restated the whole request inside `search`; a carried term is
   * not a paraphrase, it is a filter the reader already saw work. Dropping it
   * would answer "which of those are thrillers" with thrillers by somebody
   * else -- which is not a narrower answer, it is a different question.
   */
  if (
    intent.search &&
    !intent.searchInherited &&
    (intent.genreId || intent.kidsAppropriate)
  ) {
    attempts.push({ ...intent, search: null });
  }

  for (const attempt of attempts) {
    const found = await runQuery(attempt, viewerId);
    if (found.length > 0) {
      return {
        candidates: found,
        droppedSearch:
          attempt.search === null && intent.search !== null
            ? intent.search
            : null,
      };
    }
  }

  return { candidates: [], droppedSearch: null };
}

async function runQuery(
  intent: Intent,
  viewerId: string,
): Promise<Candidate[]> {
  const shared = {
    ...(intent.genreId ? { genreId: intent.genreId } : {}),
    ...(intent.search ? { search: intent.search } : {}),
    ...(intent.kidsAppropriate ? { kidsAppropriate: true } : {}),
    page: 1,
    limit: intent.limit,
  };

  /**
   * `trending`, not a rating sort.
   *
   * "Highest rated" means *rated* in both services -- they add
   * `ratingAverage.isNotNull()` -- so sorting that way silently drops every
   * work nobody has rated yet. That is most of a young catalogue and all of a
   * newly published story, which made an author's own just-listed work
   * invisible to Scribble while being perfectly findable through
   * `/api/stories`. Ordering must not double as a filter.
   */
  const [books, stories] = await Promise.all([
    listBooks({
      ...shared,
      ...(intent.completed === null ? {} : { completed: intent.completed }),
      sort: "trending",
    }),
    listStories({ ...shared, sort: "trending" }, viewerId),
  ]);

  const fromCatalogue: Candidate[] = books.items.map((book) => ({
    id: book.id,
    slug: book.slug,
    title: book.title,
    description: book.description,
    coverUrl: book.coverUrl,
    source: "CATALOGUE" as const,
    kidsAppropriate: book.kidsAppropriate,
    ratingAverage: book.ratingAverage,
    // `BookAuthor` carries no display name -- the catalogue's author rows
    // are imported, not accounts -- so the username stands in.
    author: { username: book.author.username, displayName: null },
    genres: book.genres,
  }));

  const fromScribe: Candidate[] = stories.items.map((story) => ({
    id: story.id,
    slug: story.slug,
    title: story.title,
    description: story.description,
    coverUrl: story.coverUrl,
    source: story.source,
    kidsAppropriate: story.kidsAppropriate,
    ratingAverage: story.ratingAverage,
    author: {
      username: story.author.username,
      displayName: story.author.displayName,
    },
    genres: story.genres,
  }));

  /**
   * Interleave rather than concatenate: appended, Scribe stories would fall
   * off the end of every list the moment the catalogue filled the limit.
   *
   * Taken from the two arrays directly. Reading both from one concatenated
   * array -- `all[i]` for a book and `all[books.length + i]` for a story --
   * looks equivalent and is not: when one side is empty the two offsets
   * collapse onto the same element and every result is emitted twice.
   */
  const interleaved: Candidate[] = [];
  const rounds = Math.max(fromCatalogue.length, fromScribe.length);

  for (let index = 0; index < rounds; index += 1) {
    const book = fromCatalogue[index];
    const story = fromScribe[index];
    if (book) interleaved.push(book);
    if (story) interleaved.push(story);
  }

  return interleaved.slice(0, intent.limit);
}

/* Stage 3: narration ----------------------------------------------------- */

/**
 * Where the reader lands.
 *
 * `App.tsx` routes catalogue titles by id (`/book/:id`) and Scribe stories by
 * slug (`/story/:slug`). One shape for both ships a link that 404s on half the
 * corpus, so the branch belongs here, once, rather than in each client.
 */
function urlFor(candidate: Candidate): string {
  return candidate.source === "CATALOGUE"
    ? `/book/${candidate.id}`
    : `/story/${candidate.slug}`;
}

/**
 * Asks for one sentence per candidate, then reassembles from the rows.
 *
 * Every id the model returns is looked up in the candidate set and dropped if
 * it is not there, so an invented id cannot become a recommendation. The
 * model's `reason` is the only field carried across.
 */
function narrationRequest(
  message: string,
  candidates: Candidate[],
  signal?: AbortSignal,
) {
  return {
    feature: "scribble.narrate",
    system: NARRATION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: [
          candidateBlock(candidates),
          "",
          `The reader asked: ${message}`,
        ].join("\n"),
      },
    ],
    maxTokens: 1500,
    ...(signal ? { signal } : {}),
  };
}

/**
 * Turns the model's picks into recommendations, dropping every id that was
 * not a candidate and every repeat. Shared by both paths, because this is the
 * check that stops an invented id becoming a book and it must not exist twice.
 */
function assemble(
  picks: { id: string; reason: string }[],
  candidates: Candidate[],
): Recommendation[] {
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const seen = new Set<string>();
  const recommendations: Recommendation[] = [];

  for (const pick of picks) {
    const candidate = byId.get(pick.id);
    if (!candidate || seen.has(pick.id)) continue;
    seen.add(pick.id);
    recommendations.push({
      ...candidate,
      reason: pick.reason,
      url: urlFor(candidate),
    });
  }

  return recommendations;
}

async function narrate(
  message: string,
  candidates: Candidate[],
  signal?: AbortSignal,
): Promise<{ intro: string; recommendations: Recommendation[] }> {
  const completion = await aiProvider().complete(
    narrationRequest(message, candidates, signal),
  );

  const parsed = narrationSchema.parse(extractJson(completion.text));

  return {
    intro: parsed.intro,
    recommendations: assemble(parsed.picks, candidates),
  };
}

/* The feature ------------------------------------------------------------ */

/** The empty interpretation, for a reply that ran no query. */
function none(): ScribbleReply["interpreted"] {
  return {
    genre: null,
    kidsAppropriate: false,
    completed: null,
    search: null,
    droppedSearch: null,
  };
}

/**
 * One turn: interpret, retrieve, narrate, assemble.
 *
 * When retrieval finds nothing, stage 3 is skipped entirely and a fixed
 * sentence is returned. Handing an empty candidate list to a model and letting
 * it fill the silence is precisely where invented books come from -- the same
 * failure Task AI 9 guards against with its similarity threshold.
 */
export async function ask(
  message: string,
  viewerId: string,
  context?: ScribbleContext | undefined,
  signal?: AbortSignal,
): Promise<ScribbleReply> {
  const intent = await interpret(message, context, signal);

  if (intent.kind === "other") {
    return { intro: GREETING_INTRO, recommendations: [], interpreted: none() };
  }

  const { candidates, droppedSearch } = await retrieve(intent, viewerId);

  const interpreted = {
    genre: intent.genreName,
    kidsAppropriate: intent.kidsAppropriate,
    completed: intent.completed,
    search: intent.search,
    droppedSearch,
  };

  if (candidates.length === 0) {
    return {
      intro: noMatchIntro(intent),
      recommendations: [],
      interpreted,
    };
  }

  const { intro, recommendations } = await narrate(message, candidates, signal);

  if (recommendations.length === 0) {
    return {
      intro: FALLBACK_INTRO,
      recommendations: candidates.map((candidate) => ({
        ...candidate,
        reason: "",
        url: urlFor(candidate),
      })),
      interpreted,
    };
  }

  return { intro, recommendations, interpreted };
}

/* The streaming path ----------------------------------------------------- */

/**
 * What a streaming caller receives, in order.
 *
 * `candidates` is the important one: the book cards are known the moment
 * retrieval returns, *before* the model is called at all, so a reader sees
 * real titles in a second or two rather than staring at a spinner for however
 * long a local model takes to write its sentences.
 */
export type ScribbleEvent =
  | { type: "meta"; interpreted: ScribbleReply["interpreted"] }
  | { type: "candidates"; candidates: Recommendation[] }
  | { type: "intro"; text: string }
  | { type: "pick"; id: string; reason: string }
  | { type: "done"; reply: ScribbleReply };

/**
 * The same three stages as `ask`, yielding as it goes.
 *
 * **Nothing is yielded until retrieval has succeeded.** Every
 * provider-availability failure -- not configured, unreachable, model not
 * pulled -- is raised by the *first* call, `interpret`, so a route that has
 * not yet written a byte can still answer it as an honest HTTP status. Once
 * the first event is out, the status line is already sent and a failure can
 * only be reported in-band.
 *
 * Streaming is never retried; `provider.ts` documents why. The non-streamed
 * `ask` keeps its retry, which is why both paths exist rather than one built
 * on the other.
 */
export async function* askStream(
  message: string,
  viewerId: string,
  context?: ScribbleContext | undefined,
  signal?: AbortSignal,
): AsyncGenerator<ScribbleEvent> {
  const intent = await interpret(message, context, signal);

  if (intent.kind === "other") {
    yield {
      type: "done",
      reply: {
        intro: GREETING_INTRO,
        recommendations: [],
        interpreted: none(),
      },
    };
    return;
  }

  const { candidates, droppedSearch } = await retrieve(intent, viewerId);

  const interpreted = {
    genre: intent.genreName,
    kidsAppropriate: intent.kidsAppropriate,
    completed: intent.completed,
    search: intent.search,
    droppedSearch,
  };

  yield { type: "meta", interpreted };

  if (candidates.length === 0) {
    const reply: ScribbleReply = {
      intro: noMatchIntro(intent),
      recommendations: [],
      interpreted,
    };
    yield { type: "done", reply };
    return;
  }

  // The cards, before a single token has been generated.
  const cards = candidates.map((candidate) => ({
    ...candidate,
    reason: "",
    url: urlFor(candidate),
  }));
  yield { type: "candidates", candidates: cards };

  const scanner = createNarrationScanner();
  const picks: { id: string; reason: string }[] = [];
  let intro = "";

  for await (const event of aiProvider().stream(
    narrationRequest(message, candidates, signal),
  )) {
    if (event.type !== "text") continue;

    for (const parsed of scanner.push(event.text)) {
      if (parsed.type === "intro") {
        intro = parsed.text;
        yield { type: "intro", text: intro };
        continue;
      }

      // Announced as it lands, but only after the same candidate-set check
      // the final assembly applies -- a streamed pick must not be a book the
      // catalogue does not have, however briefly.
      if (assemble([parsed], candidates).length === 1) {
        picks.push({ id: parsed.id, reason: parsed.reason });
        yield { type: "pick", id: parsed.id, reason: parsed.reason };
      }
    }
  }

  // The incremental scan is for responsiveness; this is the authority. The
  // whole object is validated exactly as the non-streaming path validates it,
  // so a reply that only looked well-formed in pieces is still rejected.
  const parsed = narrationSchema.parse(extractJson(scanner.text()));
  const recommendations = assemble(parsed.picks, candidates);

  yield {
    type: "done",
    reply:
      recommendations.length > 0
        ? { intro: parsed.intro || intro, recommendations, interpreted }
        : {
            intro: FALLBACK_INTRO,
            recommendations: cards,
            interpreted,
          },
  };
}
