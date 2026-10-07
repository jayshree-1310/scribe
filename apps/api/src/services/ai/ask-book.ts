/**
 * Ask This Book: a reader asks a question about a story and gets an answer
 * grounded in its text, with citations they can follow back into it.
 *
 * This is the first feature where retrieval feeds generation, and the whole
 * design is about what is *allowed to reach the model*:
 *
 * ```
 * question ─▶ embedQuery ─┬▶ nearestPassages ──────────▶ floor ─┐
 *              (search's) │   (this story only,                 ├▶ RRF ─▶ re-authorise ─▶ top K
 *                         └▶ nearestPassages ────────────────────┘        (stories.ts)    │
 *                             (…and naming who was asked about)                           ▼
 *                                                   nothing left? ─▶ decline, no model call
 *                                                              else ─▶ prompt ─▶ stream
 *                                                                                  │
 *                                                  citations: the [n] it used ◀────┘
 * ```
 *
 * Retrieval is hybrid for the reason search is: **a name has no meaning to
 * embed.** "Who is Kabir?" is the most natural question a reader asks, and
 * measured on the dev corpus it scored 0.49 against the character outline
 * that answers it -- a window describing six people is about none of them in
 * particular. So the question's names are looked for literally as well, and
 * a passage that names who the reader asked about is admitted below the
 * floor. A name the story never mentions finds nothing, and still declines.
 *
 * Four rules, each of which is a way the obvious version would be wrong:
 *
 * - **One story.** Retrieval is filtered to the story in the scan, and every
 *   hit is checked against it again afterwards. A passage from another story
 *   is not extra context; it is a wrong answer that arrives with a citation.
 * - **A spoiler bound, applied to retrieval.** A reader on chapter 3 is
 *   answered from chapters 1-3, because chapters 4 onward are never
 *   *candidates* -- not because the model was handed chapter 30 and asked to
 *   keep it quiet. See `resolveScope` for where the bound comes from.
 * - **Nothing retrieved means no model call.** When no passage clears the
 *   similarity floor, the answer is a fixed sentence saying the story does not
 *   cover it. Sending an empty context and letting the model improvise is
 *   exactly where a RAG feature's hallucinations come from.
 * - **Citations are derived, not trusted.** The model is asked to cite
 *   passages by number; the service keeps only numbers it actually sent, and
 *   quotes the stored passage for each -- never text the model produced.
 *
 * Retrieved passages are untrusted input -- a member wrote them. The defence
 * is in `prompts/ask-book.ts`, and `ai-ask.test.ts` attacks it with a chapter
 * that tries to issue instructions.
 */

import { getProgress } from "../reading.js";
import { findVisibleChapterIds, getStory, listChapters } from "../stories.js";
import { loadAiEmbedConfig } from "./config.js";
import {
  ASK_BOOK_SYSTEM_PROMPT,
  askBookMessage,
} from "./prompts/ask-book.js";
import { aiEmbedder, aiProvider } from "./provider.js";
import {
  excerptOf,
  fuseRankings,
  type PassageHit,
} from "./search-ranking.js";
import { embedQuery, nearestPassages } from "./search.js";
import type { AiRequest } from "./types.js";

/** On the usage record for the answer; the question's embedding is `ask.book.query`. */
const FEATURE = "ask.book";

/** A question, not a document: long enough for a careful one, short enough to embed as one thought. */
export const QUESTION_LIMIT = 300;

/**
 * Passages sent to the model.
 *
 * Six windows is about 7,000 characters -- comfortably inside a small local
 * context alongside the rules and the answer, and enough to span several
 * scenes when a question ("why does Mira distrust the keeper?") is answered
 * across chapters. More is not better: past a handful, a small model starts
 * summarising the passages instead of answering from them.
 */
export const TOP_K = 6;

/**
 * Candidates fetched before the floor and the visibility re-check trim them.
 * Twice `TOP_K`, so a few rows dropped afterwards do not leave the answer
 * short of context it could have had.
 */
const CANDIDATES = TOP_K * 2;

/**
 * Room for a short paragraph and its citation markers. Reasoning models count
 * their thinking against this too, which is why it is not tighter.
 */
const MAX_TOKENS = 700;

export interface AskBookInput {
  /** Slug or id, as every story route accepts. */
  storyKey: string;
  question: string;
  /** The spoiler bound the reader chose, or null to use the default. */
  upToChapter: number | null;
}

/**
 * Where the spoiler bound came from, reported back so the UI can say which
 * chapters an answer was drawn from rather than leaving the reader to guess.
 *
 * - `request`: the reader chose it.
 * - `progress`: the chapter they last read, from their saved position.
 * - `start`: they have no saved position, so only the opening chapter.
 * - `author`: it is their own story, so there is nothing to spoil.
 */
export type AskScopeBasis = "request" | "progress" | "start" | "author";

export interface AskScope {
  /** Null means the whole story. */
  upToChapter: number | null;
  basis: AskScopeBasis;
}

export interface AskCitation {
  /** The `[n]` the answer uses for it. */
  marker: number;
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  /** From the stored passage, never from the model's output. */
  quote: string;
}

export interface NumberedPassage extends PassageHit {
  marker: number;
}

/**
 * Who is asking about what, and how far into it they may be answered from.
 * Resolved once per question; a conversation resolves it per turn, because a
 * reader's position moves while they talk.
 */
export interface AskSetting {
  story: { id: string; title: string; authorId: string };
  scope: AskScope;
  /** Whether the bound already reaches the last chapter this reader can open. */
  wholeStory: boolean;
  /** False when the reader can open no chapter at all. */
  hasChapters: boolean;
}

interface Prepared extends AskSetting {
  /** Empty when nothing cleared the floor -- the decline case. */
  passages: NumberedPassage[];
}

/* Scope ------------------------------------------------------------------ */

/**
 * The highest chapter this answer may draw on.
 *
 * In order: what the reader asked for; nothing at all for the story's own
 * author; the chapter of the reader's saved position; and, for a reader with
 * no position, the first chapter they can open.
 *
 * That last default is the conservative one on purpose. A reader asking from
 * the story page before reading a word has read nothing, and "who is the
 * killer?" answered from the final chapter is the exact failure this bound
 * exists to prevent. The opening chapter still answers "what is this about?",
 * and the panel lets them widen the range explicitly -- a choice they make,
 * not a default that spoils for them.
 */
async function resolveScope(
  story: { id: string; authorId: string },
  userId: string,
  requested: number | null,
  firstChapter: number,
): Promise<AskScope> {
  if (requested !== null) return { upToChapter: requested, basis: "request" };
  if (story.authorId === userId) return { upToChapter: null, basis: "author" };

  const progress = await getProgress(userId, story.id);
  if (progress?.chapterNumber) {
    return { upToChapter: progress.chapterNumber, basis: "progress" };
  }

  return { upToChapter: firstChapter, basis: "start" };
}

/* Retrieval -------------------------------------------------------------- */

/**
 * Capitalised words that start questions and sentences rather than naming
 * anybody. Small on purpose: a word missing from it costs one literal lookup
 * that finds nothing, while a name wrongly listed here is a question that
 * cannot be answered.
 */
const NOT_NAMES = new Set(
  (
    "who whom whose what when where why which how is are was were am be been " +
    "do does did done can could should would will shall may might must has " +
    "have had the a an and or but if then so of in on at to for from by with " +
    "about after before during tell explain describe i me my we you he she " +
    "it they them his her its their this that these those there here chapter " +
    "story book part yes no not"
  ).split(" "),
);

/** At most this many names are looked for; a question naming more is a list. */
const MAX_NAMES = 3;

/**
 * The proper names in a question, for the keyword half of retrieval.
 *
 * "A capitalised word that is not a question word" is a crude definition of a
 * name, and that is acceptable here because the cost of a false positive is a
 * literal lookup that matches nothing. The output is letters only, which is
 * what makes it safe to place in a regex: nothing a reader types can become
 * a metacharacter.
 */
export function namesIn(question: string): string[] {
  const names: string[] = [];
  for (const [word] of question.matchAll(/\p{Lu}[\p{L}\p{M}]+/gu)) {
    if (NOT_NAMES.has(word.toLowerCase()) || names.includes(word)) continue;
    names.push(word);
    if (names.length === MAX_NAMES) break;
  }
  return names;
}

/** A passage's identity within the candidate pool: one window of one chapter. */
const keyOf = (hit: PassageHit) => `${hit.chapterId}:${hit.ordinal}`;

/**
 * Authorise and bound: the story (a 404 for a draft that is not the caller's,
 * as on every story route) and the spoiler bound for this reader.
 *
 * Exported for conversations, which resolve it again on every turn.
 */
export async function resolveAskSetting(
  userId: string,
  storyKey: string,
  requested: number | null,
): Promise<AskSetting> {
  const story = await getStory(storyKey, userId);
  // Visible chapters only, so "the first" and "the last" are the reader's.
  const chapters = await listChapters(story.id, userId);
  const scope = await resolveScope(
    { id: story.id, authorId: story.author.id },
    userId,
    requested,
    chapters[0]?.number ?? 1,
  );
  const last = chapters.at(-1)?.number ?? 0;

  return {
    story: { id: story.id, title: story.title, authorId: story.author.id },
    scope,
    wholeStory: scope.upToChapter === null || scope.upToChapter >= last,
    hasChapters: chapters.length > 0,
  };
}

/**
 * Embed, retrieve, fuse, re-authorise, trim: the passages a question may be
 * answered from, numbered in reading order. Empty means decline.
 *
 * `question` is whatever should be *searched with*. For a single question
 * that is the question; for a turn in a conversation it is the turn rewritten
 * to stand alone, because "what happened after that?" retrieves nothing.
 * `feature` labels the embedding's usage record.
 */
export async function retrievePassages(
  setting: AskSetting,
  question: string,
  userId: string,
  signal?: AbortSignal,
  feature = `${FEATURE}.query`,
): Promise<NumberedPassage[]> {
  const { story, scope } = setting;

  // Nothing to read means nothing to retrieve -- and no embedding to pay for.
  if (!setting.hasChapters) return [];

  const embedder = aiEmbedder();
  const vector = await embedQuery(question, embedder, signal, feature);

  const filters = {
    genreId: null,
    source: null,
    storyId: story.id,
    maxChapterNumber: scope.upToChapter,
  };
  const names = namesIn(question);

  const [semantic, named] = await Promise.all([
    nearestPassages(vector, embedder, filters, userId, CANDIDATES),
    names.length === 0
      ? Promise.resolve([])
      : nearestPassages(
          vector,
          embedder,
          // Postgres word boundaries, so "Ana" does not match "Banana".
          { ...filters, textPattern: `\\m(${names.join("|")})\\M` },
          userId,
          CANDIDATES,
        ),
  ]);

  // Restated in code, after the SQL: these two are what this feature
  // promises, and a promise should not rest on one WHERE clause.
  const inScope = (hit: PassageHit) =>
    hit.storyId === story.id &&
    (scope.upToChapter === null || hit.chapterNumber <= scope.upToChapter);

  // The floor applies to meaning only. A passage that names who the reader
  // asked about is relevant by that fact, however its window embeds.
  const floor = loadAiEmbedConfig().searchMinSimilarity;
  const lists = [
    semantic.filter((hit) => hit.similarity >= floor && inScope(hit)),
    named.filter(inScope),
  ];

  const byKey = new Map(lists.flat().map((hit) => [keyOf(hit), hit]));
  // Reciprocal-rank fusion, as hybrid search fuses, and for the same reason:
  // a passage both halves found is the strongest evidence there is.
  const fused = fuseRankings(lists.map((list) => list.map(keyOf))).flatMap(
    (entry) => byKey.get(entry.id) ?? [],
  );

  // The authoritative visibility check, exactly as search applies it: the SQL
  // pre-filter mirrors the rule, `findVisibleChapterIds` *is* the rule.
  const readable = await findVisibleChapterIds(
    [...new Set(fused.map((hit) => hit.chapterId))],
    userId,
  );

  const chosen = fused
    .filter((hit) => readable.has(hit.chapterId))
    .slice(0, TOP_K)
    // Reading order, not relevance order, for the model: "what happened
    // after the storm?" is answerable only if the passages read forwards.
    .sort(
      (a, b) => a.chapterNumber - b.chapterNumber || a.ordinal - b.ordinal,
    );

  return chosen.map((hit, index) => ({ ...hit, marker: index + 1 }));
}

/**
 * Everything up to the model call for a single question.
 *
 * Every refusal here -- a story the caller cannot see, an embedder that is
 * down -- happens before anything is yielded, so it reaches the client as an
 * ordinary HTTP status rather than an error frame.
 */
async function prepare(
  userId: string,
  input: AskBookInput,
  signal?: AbortSignal,
): Promise<Prepared> {
  const setting = await resolveAskSetting(
    userId,
    input.storyKey,
    input.upToChapter,
  );
  const passages = await retrievePassages(
    setting,
    input.question,
    userId,
    signal,
  );
  return { ...setting, passages };
}

/* Citations -------------------------------------------------------------- */

/**
 * The citation forms models actually write: `[2]`, `[1, 3]`, and the
 * fullwidth `【2】` / `【2†source】` that gpt-oss uses whatever it is told --
 * measured against it on Groq, every citation came back in that form, so a
 * parser for `[n]` alone produced answers with no citations at all.
 *
 * `apps/web/src/lib/ask-citations.ts` repeats this grammar, because a
 * streamed answer is rendered before the server could rewrite it.
 */
const MARKER_GROUP =
  /\s*[[【](\d{1,3}(?:\s*,\s*\d{1,3})*)(?:†[^\]】]*)?[\]】]/g;

/** The numbers in one marker group, as written. */
function numbersIn(group: string): number[] {
  return group.split(",").map((part) => Number(part.trim()));
}

/**
 * The passage numbers an answer cites, in order of first use, keeping only
 * numbers in `1..count`.
 *
 * Anything else is dropped rather than trusted: a model citing `[9]` when it
 * was sent six passages is pointing at nothing, and a citation chip that
 * leads nowhere is worse than none.
 */
export function citedMarkers(answer: string, count: number): number[] {
  const seen: number[] = [];
  for (const match of answer.matchAll(MARKER_GROUP)) {
    for (const marker of numbersIn(match[1] ?? "")) {
      if (marker >= 1 && marker <= count && !seen.includes(marker)) {
        seen.push(marker);
      }
    }
  }
  return seen;
}

/**
 * The answer with every marker that points at nothing removed, and the valid
 * ones normalised to plain `[n]` form whichever way they were written.
 *
 * Used for the JSON reply, which is delivered whole. The streamed reply has
 * already sent its text by the time the markers can be checked, so the client
 * applies the same rule against the citations in the terminal event.
 */
export function cleanMarkers(answer: string, count: number): string {
  return answer
    .replace(
      MARKER_GROUP,
      (whole: string, group: string, offset: number, text: string) => {
        const valid = numbersIn(group).filter(
          (marker) => marker >= 1 && marker <= count,
        );
        if (valid.length === 0) return "";
        // `【1】` arrives glued to the word before it; `[1]` usually does not.
        // One space either way, except between two markers in a row.
        const leading =
          whole.match(/^\s+/)?.[0] ??
          (offset === 0 || /[\]】]$/.test(text.slice(0, offset)) ? "" : " ");
        return leading + valid.map((marker) => `[${marker}]`).join("");
      },
    )
    .trim();
}

/**
 * A passage as the reader sees it on the page, not as the editor stores it.
 *
 * Chapters are markdown -- `**bold**`, `# Heading`, `> quoted line` -- and the
 * reader renders those away (`lib/chapter-markdown.tsx`). A quote that shows
 * the asterisks reads as broken and no longer matches the chapter the reader
 * is about to open. Only the marks are removed; every word stays, so the quote
 * is still the author's text.
 */
export function readableQuote(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
}

export function citationsFor(
  answer: string,
  passages: NumberedPassage[],
  question: string,
): AskCitation[] {
  return citedMarkers(answer, passages.length).flatMap((marker) => {
    const passage = passages[marker - 1];
    if (!passage) return [];
    return [
      {
        marker,
        chapterId: passage.chapterId,
        chapterNumber: passage.chapterNumber,
        chapterTitle: passage.chapterTitle,
        quote: excerptOf(readableQuote(passage.text), question),
      },
    ];
  });
}

/* The feature ------------------------------------------------------------ */

/**
 * What the reader is told when nothing in range covers their question.
 *
 * Fixed text from the server, not a model's: there was nothing to answer from,
 * so there is nothing for a model to say that would not be invented. When the
 * range stopped short of the end, it says so -- the answer may simply be later
 * on -- and when it did not, it does not suggest widening a range that cannot
 * be widened.
 */
export function declineMessage(scope: AskScope, wholeStory: boolean): string {
  if (wholeStory || scope.upToChapter === null) {
    return "I couldn't find anything in this story that answers that. Try asking about a particular character, place or event.";
  }
  return `I couldn't find anything up to chapter ${scope.upToChapter} that answers that. It may come up later — widen the range if you don't mind spoilers — or try asking another way.`;
}

function requestFor(
  prepared: Prepared,
  question: string,
  signal?: AbortSignal,
): AiRequest {
  return {
    feature: FEATURE,
    system: ASK_BOOK_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: askBookMessage({
          storyTitle: prepared.story.title,
          upToChapter: prepared.scope.upToChapter,
          passages: prepared.passages.map((passage) => ({
            marker: passage.marker,
            chapterNumber: passage.chapterNumber,
            chapterTitle: passage.chapterTitle,
            text: passage.text,
          })),
          question,
        }),
      },
    ],
    maxTokens: MAX_TOKENS,
    ...(signal ? { signal } : {}),
  };
}

export interface AskBookAnswer {
  /** Generated, unless `answerable` is false. Always labelled in the UI. */
  answer: string;
  /** False when nothing in range cleared the floor and no model was asked. */
  answerable: boolean;
  citations: AskCitation[];
  scope: AskScope;
  tokensUsed: number;
}

export async function askBook(
  userId: string,
  input: AskBookInput,
  signal?: AbortSignal,
): Promise<AskBookAnswer> {
  const prepared = await prepare(userId, input, signal);

  if (prepared.passages.length === 0) {
    return {
      answer: declineMessage(prepared.scope, prepared.wholeStory),
      answerable: false,
      citations: [],
      scope: prepared.scope,
      tokensUsed: 0,
    };
  }

  const completion = await aiProvider().complete(
    requestFor(prepared, input.question, signal),
  );
  const raw = completion.text.trim();

  return {
    answer: cleanMarkers(raw, prepared.passages.length),
    answerable: true,
    citations: citationsFor(raw, prepared.passages, input.question),
    scope: prepared.scope,
    tokensUsed: completion.usage.inputTokens + completion.usage.outputTokens,
  };
}

export type AskBookEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      answerable: boolean;
      citations: AskCitation[];
      scope: AskScope;
      tokensUsed: number;
    };

/**
 * The same, streamed: the answer as it is written, then the citations.
 *
 * Citations come last because they cannot come first -- which passages the
 * answer leans on is only known once the answer exists. They ride on the
 * terminal `done` event, so a stream that ends without one is, as everywhere
 * else here, a failure the client treats as one.
 *
 * Nothing is yielded before the provider's first delta when there is a model
 * call to make, so an unreachable model is still an honest 503 (see
 * `explainStream`). The decline path yields at once, and may: it makes no
 * model call, so there is no later failure for an early 200 to disguise.
 */
export async function* askBookStream(
  userId: string,
  input: AskBookInput,
  signal?: AbortSignal,
): AsyncGenerator<AskBookEvent> {
  const prepared = await prepare(userId, input, signal);

  if (prepared.passages.length === 0) {
    yield {
      type: "text",
      text: declineMessage(prepared.scope, prepared.wholeStory),
    };
    yield {
      type: "done",
      answerable: false,
      citations: [],
      scope: prepared.scope,
      tokensUsed: 0,
    };
    return;
  }

  let answer = "";
  for await (const event of aiProvider().stream(
    requestFor(prepared, input.question, signal),
  )) {
    if (event.type === "text") {
      answer += event.text;
      yield { type: "text", text: event.text };
    } else {
      yield {
        type: "done",
        answerable: true,
        citations: citationsFor(answer, prepared.passages, input.question),
        scope: prepared.scope,
        tokensUsed: event.usage.inputTokens + event.usage.outputTokens,
      };
    }
  }
}
