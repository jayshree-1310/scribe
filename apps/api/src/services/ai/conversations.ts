/**
 * Ask This Book as a conversation, so "what happened after that?" works.
 *
 * Storage is the easy part. The feature is **context selection**: a twelve-turn
 * conversation plus six retrieved passages will not fit in a small local
 * context, and stuffing it in degrades the answer as well as the bill -- a
 * model handed every turn starts answering the conversation instead of the
 * question. So each turn assembles its context from three pieces, each its own
 * function below because each is a decision:
 *
 * - **`rewriteQuestion`** turns the follow-up into a standalone question
 *   *before* anything is embedded. "What happened after that?" retrieves
 *   nothing on its own; "What happened after Anya received the message?" does.
 *   The rewrite is what retrieval searches with, and it is stored beside the
 *   reader's own words so a wrong answer can be traced to a wrong rewrite.
 * - **`foldIntoSummary`** keeps a rolling summary of turns that have left the
 *   recent window, instead of the turns themselves. It runs only when enough
 *   old turns have piled up, so most turns pay nothing for it, and the prompt
 *   stays the same size however long the conversation gets.
 * - **`selectHistory`** chooses which earlier exchanges go back to the model
 *   verbatim by *relevance*, not recency: the latest exchange always (it is
 *   what a follow-up refers to), plus whichever older ones are nearest the
 *   question in embedding space. An exchange from twenty turns ago about the
 *   same character is worth more than the one before last about the weather.
 *
 * Everything else is Ask This Book unchanged: the same spoiler bound
 * (resolved again each turn, since the reader's position moves while they
 * talk), the same retrieval, the same decline-without-a-model, the same
 * citations. A conversation adds memory, not a second way to answer.
 *
 * **Conversations are private.** Every read looks the row up by id *and*
 * owner, so another reader's id is a 404, never a 403 that confirms it
 * exists -- and re-checks the story, because a conversation quotes chapters
 * and a story since unlisted should not keep being quoted through one.
 */

import { Temporal } from "temporal-polyfill";
import { HttpError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { db } from "../../prisma/db.js";
import { findVisibleChapterIds, findVisibleStoryId, toIso } from "../stories.js";
import {
  citationsFor,
  cleanMarkers,
  declineMessage,
  namesIn,
  resolveAskSetting,
  retrievePassages,
  type AskCitation,
  type AskScope,
  type AskScopeBasis,
  type NumberedPassage,
} from "./ask-book.js";
import {
  ASK_BOOK_CONVERSATION_PROMPT,
  ASK_BOOK_CONVERSATION_SYSTEM_PROMPT,
  askBookMessage,
  type RecalledExchange,
} from "./prompts/ask-book.js";
import {
  CONVERSATION_SUMMARY_PROMPT,
  REWRITE_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  rewriteMessage,
  summaryMessage,
} from "./prompts/conversation.js";
import { aiEmbedder, aiProvider } from "./provider.js";
import { standaloneQuestionSchema } from "./schemas.js";
import { embedQuery } from "./search.js";
import type { AiUsage } from "./types.js";

/** The prefix on every usage record: `.rewrite`, `.summary`, `.query`, `.history`, or bare for the answer. */
const FEATURE = "ask.conversation";

/* The numbers ------------------------------------------------------------ */

/**
 * Exchanges kept out of the summary however many have piled up: the ones a
 * follow-up is most likely to lean on, so they reach the rewrite verbatim.
 */
export const RECENT_EXCHANGES = 2;

/**
 * Old exchanges that must pile up before they are folded into the summary.
 * Folding costs a model call; doing it every turn would make every turn after
 * the third cost two answers' worth. In batches of two, half of them do.
 */
export const FOLD_BATCH = 2;

/** About 120 words. The summary is a memory aid, not a transcript. */
export const SUMMARY_LIMIT = 1200;

/** Exchanges sent back to the answer verbatim: the latest plus up to two relevant ones. */
export const HISTORY_SLOTS = 3;

/** How far back relevance looks. The summary covers everything beyond it. */
const HISTORY_CANDIDATES = 20;

/**
 * How near, in cosine similarity, an older question must be to the current
 * one to be recalled verbatim.
 *
 * Measured with `nomic-embed-text` on the dev corpus: questions about the
 * same character or event scored 0.72-0.83 against each other, unrelated ones
 * 0.38-0.48 -- except 0.62 for an unrelated pair that shared a name, and
 * 0.61 for a related pair worded very differently. 0.65 favours precision,
 * because the cost of a miss is small: the latest exchange is always sent, and
 * the summary carries the gist of the rest. Re-measure on a model change.
 */
export const HISTORY_MIN_SIMILARITY = 0.65;

/** An earlier answer, recalled, is context; past this it is a second document. */
const RECALLED_ANSWER_LIMIT = 600;

/** A conversation this long has stopped being one; start another. */
export const MAX_MESSAGES = 200;

const REWRITE_MAX_TOKENS = 200;
const SUMMARY_MAX_TOKENS = 400;
const ANSWER_MAX_TOKENS = 700;

/* Shapes ----------------------------------------------------------------- */

export interface ConversationSummaryView {
  id: string;
  storyId: string;
  /** The opening question; empty until one has been asked. */
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageView {
  id: string;
  ordinal: number;
  role: "user" | "assistant";
  content: string;
  /** User turns: what retrieval actually searched with. Null on the first turn. */
  standaloneQuestion: string | null;
  /** Assistant turns: false when the app declined without asking a model. */
  answerable: boolean;
  /** Assistant turns: the spoiler bound the answer was drawn under. */
  scope: AskScope | null;
  /** Assistant turns: per message, re-authorised on every read. */
  citations: AskCitation[];
  createdAt: string;
}

export interface ConversationView extends ConversationSummaryView {
  messages: ConversationMessageView[];
}

interface ConversationRow {
  id: string;
  userId: string;
  storyId: string;
  title: string;
  summary: string;
  summarizedThrough: number;
  createdAt: unknown;
  updatedAt: unknown;
}

interface MessageRow {
  id: string;
  ordinal: number;
  role: string;
  content: string;
  standaloneQuestion: string | null;
  upToChapter: number | null;
  scopeBasis: string | null;
  answerable: boolean;
  createdAt: unknown;
}

/** A question and the answer to it. Turns are only ever stored in pairs. */
interface Exchange {
  question: MessageRow;
  answer: MessageRow;
}

const NOT_FOUND = "That conversation could not be found.";

/* Ownership -------------------------------------------------------------- */

/**
 * The conversation, if it is this caller's -- and, unless `forDeletion`, if
 * its story is still one they may see.
 *
 * Deletion skips the story check on purpose: a reader whose story was
 * unlisted under them can no longer open the conversation, but must still be
 * able to throw it away.
 */
async function ownedConversation(
  userId: string,
  conversationId: string,
  forDeletion = false,
): Promise<ConversationRow> {
  const row = await db.orm.ai.Conversation.select(
    "id",
    "userId",
    "storyId",
    "title",
    "summary",
    "summarizedThrough",
    "createdAt",
    "updatedAt",
  )
    .where((conversation) => conversation.id.eq(conversationId))
    .where((conversation) => conversation.userId.eq(userId))
    .first();

  if (!row) throw HttpError.notFound(NOT_FOUND);

  if (!forDeletion) {
    const visible = await findVisibleStoryId(row.storyId, userId);
    if (!visible) throw HttpError.notFound(NOT_FOUND);
  }

  return row as ConversationRow;
}

async function loadMessages(conversationId: string): Promise<MessageRow[]> {
  const rows = await db.orm.ai.ConversationMessage.select(
    "id",
    "ordinal",
    "role",
    "content",
    "standaloneQuestion",
    "upToChapter",
    "scopeBasis",
    "answerable",
    "createdAt",
  )
    .where((message) => message.conversationId.eq(conversationId))
    .orderBy((message) => message.ordinal.asc())
    .all();

  return rows as MessageRow[];
}

/** Pairs consecutive question/answer rows. A stray unpaired row is skipped. */
function exchangesOf(messages: MessageRow[]): Exchange[] {
  const exchanges: Exchange[] = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const question = messages[index];
    const answer = messages[index + 1];
    if (question?.role === "user" && answer?.role === "assistant") {
      exchanges.push({ question, answer });
      index += 1;
    }
  }
  return exchanges;
}

/**
 * An exchange as it goes back into a prompt.
 *
 * The question is the standalone form where there is one -- out of its
 * original context, "and him?" means nothing. The answer loses its citation
 * markers, which referred to passages numbered in a prompt that no longer
 * exists, and is cut to a paragraph.
 */
function recalled(exchange: Exchange): RecalledExchange {
  const answer = cleanMarkers(exchange.answer.content, 0);
  return {
    question: exchange.question.standaloneQuestion ?? exchange.question.content,
    answer:
      answer.length <= RECALLED_ANSWER_LIMIT
        ? answer
        : `${answer.slice(0, answer.lastIndexOf(" ", RECALLED_ANSWER_LIMIT))}…`,
  };
}

/* Usage ------------------------------------------------------------------ */

/** Every model call one turn makes, summed, for the message row and the budget. */
class UsageTally {
  inputTokens = 0;
  outputTokens = 0;

  add(usage: AiUsage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }

  get total(): number {
    return this.inputTokens + this.outputTokens;
  }
}

/* 1. Rolling summary ----------------------------------------------------- */

interface Memory {
  summary: string;
  summarizedThrough: number;
}

/**
 * Folds exchanges that have left the recent window into the summary, once
 * `FOLD_BATCH` of them have piled up.
 *
 * "Left the recent window" means everything but the last `RECENT_EXCHANGES`.
 * Those stay verbatim for the rewrite, because the turn just before a
 * follow-up is the one it most often points at, and a summary is lossy in
 * exactly the details ("the second message") a follow-up names.
 *
 * Persisted as soon as it is written, not with the turn: a summary is correct
 * whether or not this turn's answer then succeeds, and throwing it away on a
 * failed answer would pay for it twice.
 *
 * The summary is model output. It is validated here (trimmed, capped, and
 * discarded if empty -- in which case the old one stands and nothing is
 * marked as folded) and fenced when it goes back into a prompt.
 */
async function foldIntoSummary(
  conversation: ConversationRow,
  exchanges: Exchange[],
  usage: UsageTally,
  signal?: AbortSignal,
): Promise<Memory> {
  const memory = {
    summary: conversation.summary,
    summarizedThrough: conversation.summarizedThrough,
  };

  const pending = exchanges
    .slice(0, Math.max(0, exchanges.length - RECENT_EXCHANGES))
    .filter((exchange) => exchange.answer.ordinal > memory.summarizedThrough);

  if (pending.length < FOLD_BATCH) return memory;

  const completion = await aiProvider().complete({
    feature: `${FEATURE}.summary`,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: summaryMessage({
          summary: memory.summary,
          exchanges: pending.map(recalled),
        }),
      },
    ],
    maxTokens: SUMMARY_MAX_TOKENS,
    ...(signal ? { signal } : {}),
  });
  usage.add(completion.usage);

  const text = clampSummary(completion.text);
  if (text === "") return memory;

  const next = {
    summary: text,
    summarizedThrough: pending.at(-1)?.answer.ordinal ?? memory.summarizedThrough,
  };

  await db.orm.ai.Conversation.where((row) => row.id.eq(conversation.id)).update({
    ...next,
    summaryPromptId: CONVERSATION_SUMMARY_PROMPT.id,
    summaryPromptVersion: CONVERSATION_SUMMARY_PROMPT.version,
  });

  return next;
}

/** A summary that respects its own limit, cut at a sentence or a word. */
function clampSummary(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= SUMMARY_LIMIT) return text;

  const cut = text.slice(0, SUMMARY_LIMIT);
  const sentence = cut.lastIndexOf(". ");
  return sentence > SUMMARY_LIMIT / 2
    ? cut.slice(0, sentence + 1)
    : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/* 0. Pleasantries -------------------------------------------------------- */

const THANKS = new Set("thanks thank thankyou thx ty tysm cheers appreciated appreciate".split(" "));
const FAREWELL = new Set("bye goodbye cya farewell goodnight".split(" "));
const GREETING = new Set("hi hello hey hiya heya".split(" "));
const ACK = new Set(
  "ok okay k kk cool great nice alright awesome perfect fine good sure yes yep yeah understood noted".split(" "),
);
/** Words that pad a pleasantry without making it a question. */
const FILLER = new Set(
  "you u so very much a lot for that the this your help it got i see makes sense oh ah well then and again all now there bro man".split(" "),
);

/** Longer than this is a sentence, and a sentence might be asking something. */
const PLEASANTRY_WORDS = 6;

/**
 * A reply to a message that is only a pleasantry -- "okay thanks", "hi",
 * "bye" -- or null when the message might be about the story.
 *
 * Without this, "okay thanks" is embedded, retrieves nothing, and is told the
 * story does not cover it, which is true and absurd. A conversation is a
 * place people say thank you.
 *
 * Fixed replies from the server rather than a model's, for the reason the
 * decline is: there is no passage to answer from, so a model would be
 * improvising -- and a reply that costs an embedding, a retrieval and a
 * generation to say "you're welcome" is a poor trade.
 *
 * Deliberately strict: *every* word must be a pleasantry or padding, and
 * there must be few of them. "Thanks, and who is Kabir?" is a question and is
 * treated as one. A false negative just falls through to the ordinary path.
 */
export function pleasantryReply(message: string): string | null {
  const words = message.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0 || words.length > PLEASANTRY_WORDS) return null;

  const known = (word: string) =>
    THANKS.has(word) ||
    FAREWELL.has(word) ||
    GREETING.has(word) ||
    ACK.has(word) ||
    FILLER.has(word);
  if (!words.every(known)) return null;

  const has = (set: Set<string>) => words.some((word) => set.has(word));
  if (has(THANKS)) return "You're welcome! Ask me anything else about the story.";
  if (has(FAREWELL)) return "Goodbye — enjoy the story!";
  if (has(GREETING)) return "Hi! Ask me anything about this story.";
  if (has(ACK)) return "Glad that helped. Ask me anything else about the story.";
  // Padding alone ("so much", "and then") says nothing either way.
  return null;
}

/**
 * Whether a stored exchange was a pleasantry: answered without a model and
 * under no spoiler bound, because nothing was searched. Such exchanges are
 * kept for the thread and left out of memory -- "Reader: thanks / Answer:
 * you're welcome" is not context for the next question.
 */
function isPleasantry(exchange: Exchange): boolean {
  return !exchange.answer.answerable && exchange.answer.scopeBasis === null;
}

/* 2. Query rewriting ----------------------------------------------------- */

/**
 * Words that point back into a conversation rather than at the story.
 * "Me" and "I" are absent on purpose: they refer to the reader, who is here.
 */
const REFERRING = new Set(
  (
    "he she it they him her them his hers its their theirs himself herself " +
    "itself themselves that this those these there then former latter other " +
    "same"
  ).split(" "),
);

/** Up to this many words with no name in them is an ellipsis: "And the lamp?" */
const ELLIPSIS_WORDS = 4;

/**
 * Whether a question can only be understood with the conversation before it.
 *
 * Asked before the rewrite rather than left to it, for two reasons, both
 * measured: most turns in a real conversation stand on their own, so this
 * saves a model call on most of them; and a model handed a self-contained
 * question plus history does not reliably return it unchanged. Against
 * gpt-oss, "Who is Kabir?" came back as "Who is Kabir, the character who
 * whispered Arjun's name to Anya?" -- an earlier answer smuggled into the
 * search query, which then retrieves that scene instead of who Kabir is.
 *
 * A question needs rewriting when it uses a word that points back (he, that,
 * there...), or when it is short and names nobody, which is how an ellipsis
 * looks. A false positive costs one rewrite that returns the question as it
 * was; a false negative searches with the reader's own words, which is what
 * every single-question Ask This Book does anyway.
 */
export function needsRewrite(question: string): boolean {
  const words = question.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (words.some((word) => REFERRING.has(word))) return true;
  return words.length <= ELLIPSIS_WORDS && namesIn(question).length === 0;
}

/**
 * The reader's latest question, rewritten to stand alone -- what retrieval
 * will search with. Null on the first turn, which has nothing to resolve, and
 * for a question that already stands alone (see `needsRewrite`).
 *
 * The rewrite sees the summary and every exchange not yet folded into it:
 * at most `RECENT_EXCHANGES + FOLD_BATCH - 1` of them, so this call is bounded
 * however long the conversation is.
 *
 * Constrained to a schema and validated, because its output is used as data
 * -- a query -- and "Sure! Here is the rewritten question:" embedded as one
 * retrieves nonsense. If the model's reply is unusable even after the repair
 * attempt, the turn **degrades rather than fails**: the reader's own words
 * are searched with, which is worse for a follow-up and exactly right for a
 * question that never needed rewriting. An unreachable model still fails the
 * turn, because the answer would need the same model a moment later.
 */
async function rewriteQuestion(
  memory: Memory,
  unsummarized: Exchange[],
  question: string,
  usage: UsageTally,
  signal?: AbortSignal,
): Promise<string | null> {
  if (unsummarized.length === 0 && memory.summary === "") return null;
  if (!needsRewrite(question)) return null;

  try {
    const result = await aiProvider().completeStructured(
      standaloneQuestionSchema,
      {
        feature: `${FEATURE}.rewrite`,
        system: REWRITE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: rewriteMessage({
              summary: memory.summary,
              recent: unsummarized.map(recalled),
              question,
            }),
          },
        ],
        maxTokens: REWRITE_MAX_TOKENS,
        ...(signal ? { signal } : {}),
      },
    );
    usage.add(result.usage);
    return result.value.question.replace(/\s+/g, " ").trim();
  } catch (error) {
    if (error instanceof HttpError && error.status === 502) {
      logger.warn({ err: error }, "question rewrite unusable; searching as asked");
      return null;
    }
    throw error;
  }
}

/* 3. History by relevance ------------------------------------------------ */

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  return left === 0 || right === 0 ? 0 : dot / Math.sqrt(left * right);
}

/**
 * The earlier exchanges worth sending back verbatim, oldest first.
 *
 * Always the latest -- a follow-up's antecedent is nearly always the turn
 * before it, and the rewrite may not have resolved every reference. Then, of
 * the up-to-`HISTORY_CANDIDATES` before that, whichever are nearest the
 * current question, if they clear `HISTORY_MIN_SIMILARITY`, up to
 * `HISTORY_SLOTS` in all.
 *
 * Nearness is measured between *questions*, standalone forms where there are
 * any, through `embedQuery` -- which caches by text, and every standalone
 * question was already embedded with exactly that text when it was asked. So
 * this almost never reaches the embedder; it reads vectors retrieval already
 * paid for. If the embedder is down anyway, it degrades to the latest
 * exchange alone rather than failing an answer that is otherwise ready.
 */
async function selectHistory(
  exchanges: Exchange[],
  question: string,
  signal?: AbortSignal,
): Promise<Exchange[]> {
  const latest = exchanges.at(-1);
  if (!latest) return [];

  const candidates = exchanges.slice(-HISTORY_CANDIDATES - 1, -1);
  if (candidates.length === 0 || HISTORY_SLOTS < 2) return [latest];

  const searchText = (exchange: Exchange) =>
    exchange.question.standaloneQuestion ?? exchange.question.content;

  try {
    const embedder = aiEmbedder();
    const vectorOf = async (text: string) =>
      JSON.parse(
        await embedQuery(text, embedder, signal, `${FEATURE}.history`),
      ) as number[];

    const target = await vectorOf(question);
    const scored = await Promise.all(
      candidates.map(async (exchange) => ({
        exchange,
        similarity: cosine(target, await vectorOf(searchText(exchange))),
      })),
    );

    const relevant = scored
      .filter((entry) => entry.similarity >= HISTORY_MIN_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, HISTORY_SLOTS - 1)
      .map((entry) => entry.exchange);

    return [...relevant, latest].sort(
      (a, b) => a.question.ordinal - b.question.ordinal,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status >= 500) {
      logger.warn({ err: error }, "history relevance unavailable; latest only");
      return [latest];
    }
    throw error;
  }
}

/* Reads ------------------------------------------------------------------ */

function toSummaryView(row: ConversationRow): ConversationSummaryView {
  return {
    id: row.id,
    storyId: row.storyId,
    title: row.title,
    createdAt: toIso(row.createdAt) ?? "",
    updatedAt: toIso(row.updatedAt) ?? "",
  };
}

export async function createConversation(
  userId: string,
  storyKey: string,
): Promise<ConversationSummaryView> {
  const storyId = await findVisibleStoryId(storyKey, userId);
  if (!storyId) throw HttpError.notFound("That story could not be found.");

  const created = await db.orm.ai.Conversation.select("id").create({
    userId,
    storyId,
    title: "",
  });

  return toSummaryView(await ownedConversation(userId, created.id));
}

/** This reader's conversations about one story, most recently active first. */
export async function listConversations(
  userId: string,
  storyKey: string,
  limit = 20,
): Promise<{ items: ConversationSummaryView[] }> {
  const storyId = await findVisibleStoryId(storyKey, userId);
  if (!storyId) throw HttpError.notFound("That story could not be found.");

  const rows = await db.orm.ai.Conversation.select(
    "id",
    "userId",
    "storyId",
    "title",
    "summary",
    "summarizedThrough",
    "createdAt",
    "updatedAt",
  )
    .where((conversation) => conversation.userId.eq(userId))
    .where((conversation) => conversation.storyId.eq(storyId))
    .orderBy((conversation) => conversation.updatedAt.desc())
    .limit(limit)
    .all();

  return { items: (rows as ConversationRow[]).map(toSummaryView) };
}

/**
 * Citations for a set of assistant messages, joined to their chapters' current
 * number and title, and dropped where the chapter is no longer one this
 * reader may open -- the same re-authorisation retrieval applies, applied
 * again on the way back out.
 */
async function citationsByMessage(
  messageIds: string[],
  userId: string,
): Promise<Map<string, AskCitation[]>> {
  const byMessage = new Map<string, AskCitation[]>();
  if (messageIds.length === 0) return byMessage;

  const rows = await db.orm.ai.ConversationCitation.select(
    "messageId",
    "marker",
    "chapterId",
    "quote",
  )
    .where((citation) => citation.messageId.in(messageIds))
    .all();
  if (rows.length === 0) return byMessage;

  const chapterIds = [...new Set(rows.map((row) => row.chapterId))];
  const [chapters, readable] = await Promise.all([
    db.orm.content.Chapter.select("id", "chapterNumber", "title")
      .where((chapter) => chapter.id.in(chapterIds))
      .all(),
    findVisibleChapterIds(chapterIds, userId),
  ]);
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));

  for (const row of rows) {
    const chapter = chapterById.get(row.chapterId);
    if (!chapter || !readable.has(row.chapterId)) continue;
    const list = byMessage.get(row.messageId) ?? [];
    list.push({
      marker: row.marker,
      chapterId: row.chapterId,
      chapterNumber: chapter.chapterNumber,
      chapterTitle: chapter.title,
      quote: row.quote,
    });
    byMessage.set(row.messageId, list);
  }
  for (const list of byMessage.values()) list.sort((a, b) => a.marker - b.marker);

  return byMessage;
}

function scopeOf(row: MessageRow): AskScope | null {
  if (row.role !== "assistant" || row.scopeBasis === null) return null;
  return {
    upToChapter: row.upToChapter,
    basis: row.scopeBasis as AskScopeBasis,
  };
}

export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationView> {
  const conversation = await ownedConversation(userId, conversationId);
  const messages = await loadMessages(conversation.id);
  const citations = await citationsByMessage(
    messages.filter((row) => row.role === "assistant").map((row) => row.id),
    userId,
  );

  return {
    ...toSummaryView(conversation),
    messages: messages.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      standaloneQuestion: row.standaloneQuestion,
      answerable: row.answerable,
      scope: scopeOf(row),
      citations: citations.get(row.id) ?? [],
      createdAt: toIso(row.createdAt) ?? "",
    })),
  };
}

export async function deleteConversation(
  userId: string,
  conversationId: string,
): Promise<void> {
  const conversation = await ownedConversation(userId, conversationId, true);
  // Messages and citations go with it: every foreign key below cascades.
  await db.orm.ai.Conversation.where((row) => row.id.eq(conversation.id)).delete();
}

/* The turn --------------------------------------------------------------- */

/** Postgres reports a unique-constraint breach as SQLSTATE 23505. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as {
    code?: unknown;
    sqlState?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505" || candidate.sqlState === "23505") return true;

  return candidate.cause !== undefined && isUniqueViolation(candidate.cause);
}

interface Turn {
  conversation: ConversationRow;
  nextOrdinal: number;
  question: string;
  standalone: string | null;
  answer: string;
  answerable: boolean;
  /** Null for a pleasantry: nothing was searched, so no bound applied. */
  scope: AskScope | null;
  citations: AskCitation[];
  passages: NumberedPassage[];
  usage: UsageTally;
}

/**
 * Writes the question and its answer together, or neither.
 *
 * Only once the answer is complete: a turn the reader abandoned mid-stream
 * did not happen, and storing half of it would leave the next rewrite
 * resolving "that" against an answer that stops mid-sentence.
 *
 * The `(conversationId, ordinal)` unique constraint is what makes a question
 * submitted twice from two tabs safe: the second insert collides instead of
 * interleaving two answers into one thread.
 */
async function saveTurn(turn: Turn): Promise<{ questionId: string; answerId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const question = await tx.orm.ai.ConversationMessage.select("id").create({
        conversationId: turn.conversation.id,
        ordinal: turn.nextOrdinal,
        role: "user",
        content: turn.question,
        standaloneQuestion: turn.standalone,
      });

      const answer = await tx.orm.ai.ConversationMessage.select("id").create({
        conversationId: turn.conversation.id,
        ordinal: turn.nextOrdinal + 1,
        role: "assistant",
        content: turn.answer,
        upToChapter: turn.scope?.upToChapter ?? null,
        scopeBasis: turn.scope?.basis ?? null,
        answerable: turn.answerable,
        // Only a model's answer has a prompt; a pleasantry or the fixed
        // decline is the application's own text.
        promptId: turn.answerable ? ASK_BOOK_CONVERSATION_PROMPT.id : null,
        promptVersion: turn.answerable ? ASK_BOOK_CONVERSATION_PROMPT.version : null,
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
      });

      for (const citation of turn.citations) {
        await tx.orm.ai.ConversationCitation.create({
          messageId: answer.id,
          marker: citation.marker,
          chapterId: citation.chapterId,
          ordinal: turn.passages[citation.marker - 1]?.ordinal ?? 0,
          quote: citation.quote,
        });
      }

      await tx.orm.ai.Conversation.where((row) =>
        row.id.eq(turn.conversation.id),
      ).update({
        updatedAt: Temporal.Now.instant(),
        ...(turn.conversation.title === ""
          ? { title: turn.question.slice(0, 120) }
          : {}),
      });

      return { questionId: question.id, answerId: answer.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw HttpError.conflict(
        "This conversation changed in another tab. Reopen it and ask again.",
      );
    }
    throw error;
  }
}

export interface SendMessageInput {
  content: string;
  /** The spoiler bound for this turn, or null for the default. */
  upToChapter: number | null;
}

export type ConversationEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      questionId: string;
      answerId: string;
      /** What retrieval searched with, when it was not the reader's own words. */
      standaloneQuestion: string | null;
      answerable: boolean;
      citations: AskCitation[];
      /** Null when the turn was a pleasantry and nothing was searched. */
      scope: AskScope | null;
      /** Every model call this turn made: rewrite, summary and answer. */
      tokensUsed: number;
    };

/**
 * One turn, streamed: remember, rewrite, retrieve, recall, answer, store.
 *
 * Everything that can fail on availability -- the story check, the summary
 * and rewrite calls, the embedder -- runs before the first yield, so it
 * reaches the client as an ordinary status (see `askBookStream`). The decline
 * path yields at once and may, having no answer call left to fail.
 */
export async function* sendMessageStream(
  userId: string,
  conversationId: string,
  input: SendMessageInput,
  signal?: AbortSignal,
): AsyncGenerator<ConversationEvent> {
  const conversation = await ownedConversation(userId, conversationId);
  const setting = await resolveAskSetting(
    userId,
    conversation.storyId,
    input.upToChapter,
  );

  const messages = await loadMessages(conversation.id);
  if (messages.length >= MAX_MESSAGES) {
    throw HttpError.conflict(
      "This conversation is as long as one can get. Start a new one to keep asking.",
    );
  }
  const nextOrdinal = (messages.at(-1)?.ordinal ?? 0) + 1;
  const usage = new UsageTally();

  // "Okay thanks" is not a question about the story: answer it as what it
  // is, with no model, no embedding and no retrieval.
  const pleasantry = pleasantryReply(input.content);
  if (pleasantry !== null) {
    yield { type: "text", text: pleasantry };
    const saved = await saveTurn({
      conversation,
      nextOrdinal,
      question: input.content,
      standalone: null,
      answer: pleasantry,
      answerable: false,
      scope: null,
      citations: [],
      passages: [],
      usage,
    });
    yield {
      type: "done",
      questionId: saved.questionId,
      answerId: saved.answerId,
      standaloneQuestion: null,
      answerable: false,
      citations: [],
      scope: null,
      tokensUsed: 0,
    };
    return;
  }

  const exchanges = exchangesOf(messages).filter(
    (exchange) => !isPleasantry(exchange),
  );

  const memory = await foldIntoSummary(conversation, exchanges, usage, signal);
  const unsummarized = exchanges.filter(
    (exchange) => exchange.answer.ordinal > memory.summarizedThrough,
  );
  const standalone = await rewriteQuestion(
    memory,
    unsummarized,
    input.content,
    usage,
    signal,
  );
  const searchWith = standalone ?? input.content;

  const passages = await retrievePassages(
    setting,
    searchWith,
    userId,
    signal,
    `${FEATURE}.query`,
  );

  const turn: Turn = {
    conversation,
    nextOrdinal,
    question: input.content,
    standalone,
    answer: "",
    answerable: passages.length > 0,
    scope: setting.scope,
    citations: [],
    passages,
    usage,
  };

  if (passages.length === 0) {
    turn.answer = declineMessage(setting.scope, setting.wholeStory);
    yield { type: "text", text: turn.answer };
  } else {
    const history = await selectHistory(exchanges, searchWith, signal);

    let raw = "";
    for await (const event of aiProvider().stream({
      feature: FEATURE,
      system: ASK_BOOK_CONVERSATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: askBookMessage({
            storyTitle: setting.story.title,
            upToChapter: setting.scope.upToChapter,
            passages: passages.map((passage) => ({
              marker: passage.marker,
              chapterNumber: passage.chapterNumber,
              chapterTitle: passage.chapterTitle,
              text: passage.text,
            })),
            question: searchWith,
            memory: {
              summary: memory.summary,
              exchanges: history.map(recalled),
              askedAs: input.content,
            },
          }),
        },
      ],
      maxTokens: ANSWER_MAX_TOKENS,
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === "text") {
        raw += event.text;
        yield { type: "text", text: event.text };
      } else {
        usage.add(event.usage);
      }
    }

    turn.answer = cleanMarkers(raw.trim(), passages.length);
    turn.citations = citationsFor(raw, passages, searchWith);
  }

  const saved = await saveTurn(turn);

  yield {
    type: "done",
    questionId: saved.questionId,
    answerId: saved.answerId,
    standaloneQuestion: standalone,
    answerable: turn.answerable,
    citations: turn.citations,
    scope: turn.scope,
    tokensUsed: usage.total,
  };
}
