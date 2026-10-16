/**
 * The story bible: what an author's own chapters establish, kept so the
 * writing assistant can be held to it.
 *
 * ## The path a chapter takes
 *
 * 1. **Hash it.** A chapter whose text and prompt version match its
 *    `ChapterExtraction` row is not read again, whoever asks and however
 *    often. Everything below is the uncommon case.
 * 2. **Read it in sections** (`sectionsOf`), one structured call each, asking
 *    for facts with the chapter's own words for each one.
 * 3. **Ground every fact.** A fact whose quote the chapter does not contain is
 *    dropped (`quoteLocator`) and counted, never stored on a model's word.
 * 4. **Apply the author's precedence** -- see below.
 * 5. **Replace the chapter's extracted rows** in one transaction, then embed
 *    the new ones so selection can find them by meaning.
 *
 * ## Extraction is a draft the author corrects
 *
 * A model's reading of a chapter is a proposal. The author can change a fact,
 * add one, or remove one, and three rules make those edits outlive the next
 * extraction of the same chapter:
 *
 * - **A corrected fact becomes the author's.** It is converted in place
 *   (`origin = author`), keeping its chapter and its quote. From then on no
 *   extracted fact with the same key is stored for that chapter: the author
 *   has said what is true about that subject there.
 * - **A removed fact leaves a tombstone.** Deleting the row would let the next
 *   extraction of the same unchanged sentence put it straight back, so it is
 *   kept with `rejected = true`, shown to nobody and sent to no model, and it
 *   suppresses the same claim -- key and value -- in that chapter.
 * - **A correction that changes what the fact is about leaves one too**, for
 *   the claim it replaced: correcting "Mira: age 30" into "Mara: age 30" must
 *   not have the model's Mira back on the next pass.
 *
 * A tombstone is dropped when the sentence it was about leaves the chapter;
 * there is then nothing left for it to suppress.
 *
 * ## Relevance is the engineering
 *
 * A bible for a forty-chapter novel does not fit in a prompt, and one that did
 * would be summarised rather than respected. `factsForPrompt` picks at most
 * `BIBLE_FACT_LIMIT` facts for the passage in hand -- by the names it
 * mentions, by what happened recently, and by embedding similarity -- and
 * `bible-facts.ts` is where that budget and its reasons live.
 *
 * ## Private to the author
 *
 * Every function here that takes a `userId` asserts ownership of the story
 * through `assertStoryOwned`. A bible is read from drafts as well as published
 * chapters, so anybody else reading it would be reading unpublished writing.
 */

import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { db } from "../../prisma/db.js";
import { assertStoryOwned } from "../authoring.js";
import { toIso } from "../stories.js";
import {
  embeddingTextOf,
  factKeyOf,
  quoteLocator,
  sectionsOf,
  selectFacts,
  valueKeyOf,
  type BibleFact,
  type FactOrigin,
} from "./bible-facts.js";
import { loadAiConfig, loadAiEmbedConfig } from "./config.js";
import {
  BIBLE_EXTRACTION_SYSTEM_PROMPT,
  BIBLE_PROMPT_VERSION,
  bibleExtractionMessage,
} from "./prompts/story-bible.js";
import { aiEmbedder, aiProvider } from "./provider.js";
import {
  chapterFactsSchema,
  type ExtractedFact,
  type FactKind,
} from "./schemas.js";

/** Keyed on in every usage record extraction produces. */
const FEATURE = "bible.extract";

/** The embedding of the passage an assistant request is about. */
const SELECT_FEATURE = "bible.select";

/** Twenty-five short objects with a quote each; see `MAX_FACTS_PER_SECTION`. */
const EXTRACTION_MAX_TOKENS = 3000;

/**
 * How many names from the rest of the story an extraction is shown.
 *
 * Enough for a cast, not a census: the list is there so "Mira" in chapter nine
 * is spelled the way chapter two spelled her, and a model shown two hundred
 * names starts finding them in chapters they are not in.
 */
const KNOWN_NAMES_LIMIT = 60;

/** How much of a passage is embedded to find facts near it. */
const SELECT_TEXT_LIMIT = 2000;

/** Facts the similarity query returns before the floor and the fusion. */
const SIMILAR_CANDIDATES = 40;

const FACT_NOT_FOUND = "That fact could not be found.";
const CHAPTER_NOT_FOUND = "That chapter could not be found.";

/* Shapes returned to the client ------------------------------------------ */

/** One fact as the story-bible panel shows it. Never a rejected one. */
export interface StoryFactView {
  id: string;
  kind: FactKind;
  subject: string;
  attribute: string;
  value: string;
  related: string | null;
  /** The chapter's own words; null for a fact the author typed in. */
  quote: string | null;
  /** `extracted` is a model's reading; `author` is the author's own. */
  origin: FactOrigin;
  chapterId: string | null;
  chapterNumber: number | null;
  chapterTitle: string | null;
  updatedAt: string | null;
}

/**
 * Where one chapter stands.
 *
 * - `missing`: never read.
 * - `stale`: read, but the text (or the prompt) has changed since.
 * - `current`: what is stored is a reading of what is there now.
 */
export type ChapterBibleState = "missing" | "stale" | "current";

export interface ChapterBibleStatus {
  chapterId: string;
  chapterNumber: number;
  title: string;
  state: ChapterBibleState;
  /** Facts kept from the last reading. */
  factCount: number;
  /** Facts the model offered whose quote was not in the chapter. */
  droppedCount: number;
  /** True when the chapter was longer than an extraction reads. */
  truncated: boolean;
  extractedAt: string | null;
}

export interface StoryBible {
  storyId: string;
  chapters: ChapterBibleStatus[];
  /** Chapters whose state is not `current`; what a refresh would read. */
  pending: number;
  facts: StoryFactView[];
}

/** What reading one chapter did. */
export interface ChapterExtractionResult {
  chapterId: string;
  chapterNumber: number;
  /** True when the stored reading already matched and no model was called. */
  unchanged: boolean;
  facts: number;
  dropped: number;
  truncated: boolean;
  tokensUsed: number;
}

export interface BibleRefresh {
  processed: ChapterExtractionResult[];
  bible: StoryBible;
  tokensUsed: number;
}

export interface FactInput {
  kind: FactKind;
  subject: string;
  attribute: string;
  value: string;
  related: string | null;
  /** The chapter it is true from; null for the whole story. */
  chapterId: string | null;
}

export type FactPatch = Partial<Omit<FactInput, "chapterId">>;

/* Reading ---------------------------------------------------------------- */

interface ChapterRow {
  id: string;
  storyId: string;
  chapterNumber: number;
  title: string;
  content: string;
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function chaptersOf(storyId: string): Promise<ChapterRow[]> {
  const rows = await db.orm.content.Chapter.select(
    "id",
    "storyId",
    "chapterNumber",
    "title",
    "content",
  )
    .where((chapter) => chapter.storyId.eq(storyId))
    .orderBy((chapter) => chapter.chapterNumber.asc())
    .all();

  return rows as ChapterRow[];
}

interface FactRow {
  id: string;
  storyId: string;
  chapterId: string | null;
  kind: string;
  subject: string;
  attribute: string;
  value: string;
  related: string | null;
  quote: string | null;
  factKey: string;
  valueKey: string;
  origin: string;
  rejected: boolean;
  updatedAt: unknown;
}

function factsBase() {
  return db.orm.ai.StoryFact.select(
    "id",
    "storyId",
    "chapterId",
    "kind",
    "subject",
    "attribute",
    "value",
    "related",
    "quote",
    "factKey",
    "valueKey",
    "origin",
    "rejected",
    "updatedAt",
  );
}

function toBibleFact(row: FactRow, chapterNumber: number | null): BibleFact {
  return {
    id: row.id,
    kind: row.kind as FactKind,
    subject: row.subject,
    attribute: row.attribute,
    value: row.value,
    related: row.related,
    quote: row.quote,
    origin: row.origin as FactOrigin,
    chapterId: row.chapterId,
    chapterNumber,
    factKey: row.factKey,
    valueKey: row.valueKey,
  };
}

/**
 * Every live fact of a story, in the shape selection and the prompts use.
 *
 * "Live" is the one filter that matters: a rejected row is a tombstone, and a
 * tombstone that reached a prompt would be the author's deleted fact coming
 * back through the assistant.
 *
 * Exported for the continuity checker, which compares these with each other.
 */
export async function liveFacts(storyId: string): Promise<BibleFact[]> {
  const [rows, chapters] = await Promise.all([
    factsBase()
      .where((fact) => fact.storyId.eq(storyId))
      .where((fact) => fact.rejected.eq(false))
      .all(),
    db.orm.content.Chapter.select("id", "chapterNumber")
      .where((chapter) => chapter.storyId.eq(storyId))
      .all(),
  ]);

  const numbers = new Map(chapters.map((row) => [row.id, row.chapterNumber]));

  return (rows as FactRow[]).map((row) =>
    toBibleFact(
      row,
      row.chapterId === null ? null : (numbers.get(row.chapterId) ?? null),
    ),
  );
}

/** Whether any chapter of this story has been read: what "has a bible" means. */
export async function hasBible(storyId: string): Promise<boolean> {
  const row = await db.orm.ai.ChapterExtraction.select("id")
    .where((extraction) => extraction.storyId.eq(storyId))
    .first();

  return row !== null && row !== undefined;
}

/* Embedding facts -------------------------------------------------------- */

/**
 * Embeds these facts, best effort.
 *
 * A fact without a vector is still a fact: it is found by name and by
 * recency, only not by meaning, and `embedModel` stays null so the next
 * reading of its chapter tries again. So an embedder that is down or not
 * configured is logged and survived -- extraction is the expensive half, and
 * throwing it away because the cheap half failed would be the wrong way round.
 */
async function embedFacts(
  facts: { id: string; text: string }[],
  signal?: AbortSignal,
): Promise<void> {
  if (facts.length === 0) return;

  try {
    const embedder = aiEmbedder();
    const { batchSize } = loadAiEmbedConfig();

    for (let at = 0; at < facts.length; at += batchSize) {
      const batch = facts.slice(at, at + batchSize);
      const result = await embedder.embed({
        feature: FEATURE,
        texts: batch.map((fact) => fact.text),
        ...(signal ? { signal } : {}),
      });

      for (const [index, fact] of batch.entries()) {
        const vector = result.vectors[index];
        // A vector of the wrong width is an answer about another corpus;
        // leaving the fact unembedded is the honest state.
        if (!vector || vector.length !== embedder.dimensions) continue;

        await db.runtime().query(
          db.raw.sql`
            UPDATE "ai"."storyFact"
               SET "embedding" = ${`[${vector.join(",")}]`}::vector,
                   "embedModel" = ${embedder.model}
             WHERE "id" = ${fact.id}
          `
            .affectedCount()
            .build(),
        );
      }
    }
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    logger.warn({ err: error }, "story bible: facts stored without embeddings");
  }
}

/* Extraction ------------------------------------------------------------- */

/**
 * The names the rest of the story already uses, most-mentioned first.
 *
 * From other chapters only: the chapter being read is about to have its own
 * facts replaced, and showing the model its previous answers would teach it to
 * repeat them.
 */
function knownNames(facts: BibleFact[], chapterId: string): string[] {
  const counts = new Map<string, number>();

  for (const fact of facts) {
    if (fact.chapterId === chapterId || fact.kind === "event") continue;
    for (const name of [fact.subject, fact.related]) {
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, KNOWN_NAMES_LIMIT)
    .map(([name]) => name);
}

interface GroundedFact extends ExtractedFact {
  /** The chapter's own text for it, cut from the chapter rather than copied. */
  evidence: string;
  factKey: string;
  valueKey: string;
}

/**
 * Reads one chapter into facts, doing nothing at all if it has not changed.
 *
 * Takes the chapter rather than an id so a caller holding it does not read it
 * twice, and so this has no opinion about ownership -- its two callers (the
 * author's refresh and the continuity check on their own save) have each
 * already established whose chapter it is.
 *
 * A provider failure throws and stores nothing: the previous reading stays
 * exactly as it was, still marked with the hash of the text it was a reading
 * of, so the chapter simply remains stale.
 */
export async function extractChapter(
  chapter: ChapterRow,
  signal?: AbortSignal,
): Promise<ChapterExtractionResult> {
  const contentHash = hashOf(chapter.content);

  const existing = await db.orm.ai.ChapterExtraction.select(
    "id",
    "contentHash",
    "promptVersion",
    "factCount",
    "droppedCount",
    "truncated",
  )
    .where((row) => row.chapterId.eq(chapter.id))
    .first();

  if (
    existing &&
    existing.contentHash === contentHash &&
    existing.promptVersion === BIBLE_PROMPT_VERSION
  ) {
    return {
      chapterId: chapter.id,
      chapterNumber: chapter.chapterNumber,
      unchanged: true,
      facts: existing.factCount,
      dropped: existing.droppedCount,
      truncated: existing.truncated,
      tokensUsed: 0,
    };
  }

  const { sections, truncated } = sectionsOf(chapter.content);
  const names = knownNames(await liveFacts(chapter.storyId), chapter.id);

  const offered: ExtractedFact[] = [];
  let tokensUsed = 0;
  let model = loadAiConfig().model;

  // Sequential for the reason generation's alternatives are: on a local model
  // concurrent calls are the same calls queued, with more memory.
  for (const [index, text] of sections.entries()) {
    const { value, usage } = await aiProvider().completeStructured(
      chapterFactsSchema,
      {
        feature: FEATURE,
        system: BIBLE_EXTRACTION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: bibleExtractionMessage({
              chapterNumber: chapter.chapterNumber,
              chapterTitle: chapter.title,
              section: index + 1,
              sections: sections.length,
              text,
              knownNames: names,
            }),
          },
        ],
        maxTokens: EXTRACTION_MAX_TOKENS,
        ...(signal ? { signal } : {}),
      },
    );

    offered.push(...value.facts);
    tokensUsed += usage.inputTokens + usage.outputTokens;
    model = usage.model;
  }

  /*
   * Grounding. The quote is looked for in the chapter and the chapter's own
   * text is what is kept, so stored evidence is the author's words even when
   * the model straightened a quote mark or dropped an emphasis.
   */
  const locate = quoteLocator(chapter.content);
  const grounded = new Map<string, GroundedFact>();
  let dropped = 0;

  for (const fact of offered) {
    const evidence = locate(fact.quote);
    if (evidence === null) {
      dropped += 1;
      continue;
    }

    // `related` means something only for a relationship; a model that fills
    // it in for a character fact would otherwise change that fact's key.
    const related = fact.kind === "relationship" ? fact.related : null;
    const factKey = factKeyOf({ ...fact, related });
    const valueKey = valueKeyOf(fact.value);

    // The same claim twice -- two sections, or a model repeating itself -- is
    // one fact. First wins: it is the one nearer the start of the chapter.
    const identity = `${factKey}\u0000${valueKey}`;
    if (!grounded.has(identity)) {
      grounded.set(identity, { ...fact, related, evidence, factKey, valueKey });
    }
  }

  /*
   * Precedence. What the author has said about this chapter decides what a
   * new reading of it may add.
   */
  const standing = (await factsBase()
    .where((fact) => fact.chapterId.eq(chapter.id))
    .all()) as FactRow[];

  // The author's own facts, live or removed: a key they have ruled on.
  const authorKeys = new Set(
    standing.filter((row) => row.origin === "author").map((row) => row.factKey),
  );
  // Extracted claims the author removed: that claim, not the whole key.
  const tombstones = standing.filter(
    (row) => row.origin === "extracted" && row.rejected,
  );
  const rejectedClaims = new Set(
    tombstones.map((row) => `${row.factKey}\u0000${row.valueKey}`),
  );

  const kept = [...grounded.entries()]
    .filter(
      ([identity, fact]) =>
        !authorKeys.has(fact.factKey) && !rejectedClaims.has(identity),
    )
    .map(([, fact]) => ({ id: randomUUID(), ...fact }));

  // A tombstone whose sentence has left the chapter suppresses nothing.
  const spent = tombstones.filter(
    (row) => row.quote === null || locate(row.quote) === null,
  );

  await db.transaction(async (tx) => {
    await tx.query(
      db.raw.sql`
        DELETE FROM "ai"."storyFact"
         WHERE "chapterId" = ${chapter.id}
           AND "origin" = 'extracted'
           AND "rejected" = false
      `
        .affectedCount()
        .build(),
    );

    for (const row of spent) {
      await tx.query(
        db.raw.sql`DELETE FROM "ai"."storyFact" WHERE "id" = ${row.id}`
          .affectedCount()
          .build(),
      );
    }

    for (const fact of kept) {
      await tx.orm.ai.StoryFact.create({
        id: fact.id,
        storyId: chapter.storyId,
        chapterId: chapter.id,
        kind: fact.kind,
        subject: fact.subject,
        attribute: fact.attribute,
        value: fact.value,
        related: fact.related,
        quote: fact.evidence,
        factKey: fact.factKey,
        valueKey: fact.valueKey,
        origin: "extracted",
        rejected: false,
        model,
        promptVersion: BIBLE_PROMPT_VERSION,
      });
    }

    const record = {
      contentHash,
      model,
      promptVersion: BIBLE_PROMPT_VERSION,
      factCount: kept.length,
      droppedCount: dropped,
      truncated,
    };

    if (existing) {
      await tx.query(
        db.raw.sql`
          UPDATE "ai"."chapterExtraction"
             SET "contentHash" = ${record.contentHash},
                 "model" = ${record.model},
                 "promptVersion" = ${record.promptVersion},
                 "factCount" = ${record.factCount},
                 "droppedCount" = ${record.droppedCount},
                 "truncated" = ${record.truncated},
                 "updatedAt" = now()
           WHERE "id" = ${existing.id}
        `
          .affectedCount()
          .build(),
      );
    } else {
      await tx.orm.ai.ChapterExtraction.create({
        chapterId: chapter.id,
        storyId: chapter.storyId,
        ...record,
      });
    }
  });

  await embedFacts(
    kept.map((fact) => ({ id: fact.id, text: embeddingTextOf(fact) })),
    signal,
  );

  return {
    chapterId: chapter.id,
    chapterNumber: chapter.chapterNumber,
    unchanged: false,
    facts: kept.length,
    dropped,
    truncated,
    tokensUsed,
  };
}

/**
 * Reads the chapter a continuity check is about to check, by id.
 *
 * Null when the chapter is gone -- a check scheduled a minute ago can outlive
 * the chapter it was scheduled for.
 */
export async function extractChapterById(
  chapterId: string,
  signal?: AbortSignal,
): Promise<{ chapter: ChapterRow; result: ChapterExtractionResult } | null> {
  const chapter = (await db.orm.content.Chapter.select(
    "id",
    "storyId",
    "chapterNumber",
    "title",
    "content",
  )
    .where((row) => row.id.eq(chapterId))
    .first()) as ChapterRow | null | undefined;

  if (!chapter) return null;

  return { chapter, result: await extractChapter(chapter, signal) };
}

/* The bible, for its panel ----------------------------------------------- */

async function buildBible(storyId: string): Promise<StoryBible> {
  const [chapters, extractions, rows] = await Promise.all([
    chaptersOf(storyId),
    db.orm.ai.ChapterExtraction.select(
      "chapterId",
      "contentHash",
      "promptVersion",
      "factCount",
      "droppedCount",
      "truncated",
      "updatedAt",
    )
      .where((row) => row.storyId.eq(storyId))
      .all(),
    factsBase()
      .where((fact) => fact.storyId.eq(storyId))
      .where((fact) => fact.rejected.eq(false))
      .all(),
  ]);

  const read = new Map(extractions.map((row) => [row.chapterId, row]));
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));

  const statuses: ChapterBibleStatus[] = chapters.map((chapter) => {
    const extraction = read.get(chapter.id);
    const state: ChapterBibleState = !extraction
      ? "missing"
      : extraction.contentHash === hashOf(chapter.content) &&
          extraction.promptVersion === BIBLE_PROMPT_VERSION
        ? "current"
        : "stale";

    return {
      chapterId: chapter.id,
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      state,
      factCount: extraction?.factCount ?? 0,
      droppedCount: extraction?.droppedCount ?? 0,
      truncated: extraction?.truncated ?? false,
      extractedAt: extraction ? toIso(extraction.updatedAt) : null,
    };
  });

  const facts: StoryFactView[] = (rows as FactRow[])
    .map((row) => {
      const chapter = row.chapterId === null ? undefined : byId.get(row.chapterId);

      return {
        id: row.id,
        kind: row.kind as FactKind,
        subject: row.subject,
        attribute: row.attribute,
        value: row.value,
        related: row.related,
        quote: row.quote,
        origin: row.origin as FactOrigin,
        chapterId: row.chapterId,
        chapterNumber: chapter?.chapterNumber ?? null,
        chapterTitle: chapter?.title ?? null,
        updatedAt: toIso(row.updatedAt),
      };
    })
    // By subject, then where in the story it was said: the order a person
    // looking something up reads in.
    .sort(
      (a, b) =>
        a.subject.localeCompare(b.subject) ||
        (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0) ||
        a.attribute.localeCompare(b.attribute) ||
        a.id.localeCompare(b.id),
    );

  return {
    storyId,
    chapters: statuses,
    pending: statuses.filter((status) => status.state !== "current").length,
    facts,
  };
}

export async function getBible(
  userId: string,
  storyId: string,
): Promise<StoryBible> {
  await assertStoryOwned(userId, storyId);
  return buildBible(storyId);
}

/**
 * Reads the next chapters that need it, and reports where the bible stands.
 *
 * **A few chapters per call, on purpose.** Reading a twenty-chapter story is
 * twenty model calls, which on a local model is several minutes -- too long
 * for one request to hold open, and there is no job runner to hand it to (Task
 * AI 20). So the client calls this in a loop, showing "chapter 4 of 21" as it
 * goes, and each call is short, resumable and safe to abandon: whatever was
 * read stays read, and the next call starts with whatever is still pending.
 *
 * Earliest chapter first, so the names later chapters are shown come from the
 * chapters that introduced them.
 */
export async function refreshBible(
  userId: string,
  storyId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<BibleRefresh> {
  await assertStoryOwned(userId, storyId);

  const chapters = await chaptersOf(storyId);
  const before = await buildBible(storyId);
  const stale = new Set(
    before.chapters
      .filter((status) => status.state !== "current")
      .map((status) => status.chapterId),
  );

  const processed: ChapterExtractionResult[] = [];

  for (const chapter of chapters) {
    if (processed.length >= limit) break;
    if (!stale.has(chapter.id)) continue;

    processed.push(await extractChapter(chapter, signal));
  }

  return {
    processed,
    bible: processed.length === 0 ? before : await buildBible(storyId),
    tokensUsed: processed.reduce((total, result) => total + result.tokensUsed, 0),
  };
}

/* The author's own edits -------------------------------------------------- */

async function ownedFact(userId: string, factId: string): Promise<FactRow> {
  const row = (await factsBase()
    .where((fact) => fact.id.eq(factId))
    .first()) as FactRow | null | undefined;

  // A tombstone is not a fact anybody can address: it reads as gone.
  if (!row || row.rejected) throw HttpError.notFound(FACT_NOT_FOUND);

  await assertStoryOwned(userId, row.storyId);
  return row;
}

async function viewOf(factId: string): Promise<StoryFactView> {
  const row = (await factsBase()
    .where((fact) => fact.id.eq(factId))
    .first()) as FactRow | null | undefined;

  if (!row) throw HttpError.notFound(FACT_NOT_FOUND);

  const chapter =
    row.chapterId === null
      ? null
      : await db.orm.content.Chapter.select("chapterNumber", "title")
          .where((item) => item.id.eq(row.chapterId as string))
          .first();

  return {
    id: row.id,
    kind: row.kind as FactKind,
    subject: row.subject,
    attribute: row.attribute,
    value: row.value,
    related: row.related,
    quote: row.quote,
    origin: row.origin as FactOrigin,
    chapterId: row.chapterId,
    chapterNumber: chapter?.chapterNumber ?? null,
    chapterTitle: chapter?.title ?? null,
    updatedAt: toIso(row.updatedAt),
  };
}

/** `related` belongs to relationships; anywhere else it would shift the key. */
function relatedFor(kind: FactKind, related: string | null): string | null {
  const trimmed = related?.trim() ?? "";
  return kind === "relationship" && trimmed !== "" ? trimmed : null;
}

/**
 * A fact the author states themselves.
 *
 * No quote, because nothing was quoted: the author is the evidence. Attached
 * to a chapter when it becomes true there, or to none when it is true of the
 * whole story.
 */
export async function addFact(
  userId: string,
  storyId: string,
  input: FactInput,
): Promise<StoryFactView> {
  await assertStoryOwned(userId, storyId);

  if (input.chapterId !== null) {
    const chapter = await db.orm.content.Chapter.select("id", "storyId")
      .where((row) => row.id.eq(input.chapterId as string))
      .first();

    if (!chapter || chapter.storyId !== storyId) {
      throw HttpError.notFound(CHAPTER_NOT_FOUND);
    }
  }

  const related = relatedFor(input.kind, input.related);
  const id = randomUUID();

  await db.orm.ai.StoryFact.create({
    id,
    storyId,
    chapterId: input.chapterId,
    kind: input.kind,
    subject: input.subject,
    attribute: input.attribute,
    value: input.value,
    related,
    quote: null,
    factKey: factKeyOf({ ...input, related }),
    valueKey: valueKeyOf(input.value),
    origin: "author",
    rejected: false,
    model: null,
    promptVersion: null,
  });

  await embedFacts([{ id, text: embeddingTextOf({ ...input, related }) }]);

  return viewOf(id);
}

/**
 * Corrects a fact, which makes it the author's.
 *
 * Converted in place rather than replaced, so the chapter and the quote it
 * was found with stay attached: the correction is "this sentence means
 * something else", not "forget this sentence".
 *
 * If the correction changes what the fact is *about* -- its subject or
 * attribute, and so its key -- the claim it replaces gets a tombstone, or the
 * next reading of the chapter would restore the model's version beside the
 * author's.
 */
export async function updateFact(
  userId: string,
  factId: string,
  patch: FactPatch,
): Promise<StoryFactView> {
  const row = await ownedFact(userId, factId);

  const kind = patch.kind ?? (row.kind as FactKind);
  const next = {
    kind,
    subject: patch.subject ?? row.subject,
    attribute: patch.attribute ?? row.attribute,
    value: patch.value ?? row.value,
    related: relatedFor(
      kind,
      patch.related === undefined ? row.related : patch.related,
    ),
  };

  const factKey = factKeyOf(next);
  const valueKey = valueKeyOf(next.value);

  await db.transaction(async (tx) => {
    if (
      row.origin === "extracted" &&
      row.chapterId !== null &&
      factKey !== row.factKey
    ) {
      await tx.orm.ai.StoryFact.create({
        storyId: row.storyId,
        chapterId: row.chapterId,
        kind: row.kind,
        subject: row.subject,
        attribute: row.attribute,
        value: row.value,
        related: row.related,
        quote: row.quote,
        factKey: row.factKey,
        valueKey: row.valueKey,
        origin: "extracted",
        rejected: true,
      });
    }

    await tx.orm.ai.StoryFact.where((fact) => fact.id.eq(factId)).update({
      ...next,
      factKey,
      valueKey,
      origin: "author",
      // The stored vector describes the old wording; `embedFacts` below
      // writes the new one, and until it does the fact has none.
      embedModel: null,
    });
  });

  await db.runtime().query(
    db.raw.sql`
      UPDATE "ai"."storyFact" SET "updatedAt" = now() WHERE "id" = ${factId}
    `
      .affectedCount()
      .build(),
  );

  await embedFacts([{ id: factId, text: embeddingTextOf(next) }]);

  return viewOf(factId);
}

/**
 * Removes a fact from the bible.
 *
 * A fact with a chapter's words behind it becomes a tombstone, so a later
 * reading of that chapter cannot restore it. One the author typed in has
 * nothing that could bring it back, and is simply deleted.
 */
export async function removeFact(userId: string, factId: string): Promise<void> {
  const row = await ownedFact(userId, factId);

  if (row.quote === null || row.chapterId === null) {
    await db.runtime().query(
      db.raw.sql`DELETE FROM "ai"."storyFact" WHERE "id" = ${factId}`
        .affectedCount()
        .build(),
    );
    return;
  }

  await db.orm.ai.StoryFact.where((fact) => fact.id.eq(factId)).update({
    rejected: true,
  });
}

/* Selection for the writing assistant ------------------------------------- */

/**
 * Fact ids near this text by embedding, nearest first, above the floor.
 *
 * Empty when there is no embedder, when it fails, or when no fact has a
 * vector from the configured model: similarity is one of three rankings, and
 * the other two do not need it.
 */
async function similarFactIds(
  storyId: string,
  text: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const embedder = aiEmbedder();
    const result = await embedder.embed({
      feature: SELECT_FEATURE,
      texts: [text.slice(-SELECT_TEXT_LIMIT)],
      ...(signal ? { signal } : {}),
    });

    const vector = result.vectors[0];
    if (!vector || vector.length !== embedder.dimensions) return [];

    const literal = `[${vector.join(",")}]`;
    const rows = (await db.runtime().query(
      db.raw.sql`
        SELECT f."id",
               (1 - (f."embedding" <=> ${literal}::vector))::float8 AS "similarity"
          FROM "ai"."storyFact" AS f
         WHERE f."storyId" = ${storyId}
           AND f."rejected" = false
           AND f."embedModel" = ${embedder.model}
           AND f."embedding" IS NOT NULL
         ORDER BY f."embedding" <=> ${literal}::vector
         LIMIT ${SIMILAR_CANDIDATES}
      `
        .returnsRow({ id: "pg/text@1", similarity: "pg/float8@1" })
        .build(),
    )) as { id: string; similarity: number }[];

    const floor = loadAiEmbedConfig().bibleMinSimilarity;
    return rows.filter((row) => row.similarity >= floor).map((row) => row.id);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    logger.warn({ err: error }, "story bible: selecting without similarity");
    return [];
  }
}

/**
 * The facts to show the writing assistant for this passage, within budget.
 *
 * Empty for a story with no bible, which is what keeps the assistant's request
 * for such a story byte-for-byte what it was before this existed.
 *
 * `chapterId` only says *where in the story* the passage is, so "recent" and
 * "already happened" mean something. The prose itself still travels in the
 * request, for the reason `assist.ts` gives. A chapter that is not this
 * story's is ignored rather than refused: the position is a hint.
 *
 * The caller has already asserted ownership of the story.
 */
export async function factsForPrompt(
  storyId: string,
  text: string,
  chapterId: string | null,
  signal?: AbortSignal,
): Promise<BibleFact[]> {
  const facts = await liveFacts(storyId);
  if (facts.length === 0) return [];

  let chapterNumber: number | null = null;
  if (chapterId !== null) {
    const chapter = await db.orm.content.Chapter.select("storyId", "chapterNumber")
      .where((row) => row.id.eq(chapterId))
      .first();

    if (chapter && chapter.storyId === storyId) {
      chapterNumber = chapter.chapterNumber;
    }
  }

  return selectFacts({
    facts,
    text,
    chapterNumber,
    similar: await similarFactIds(storyId, text, signal),
  });
}
