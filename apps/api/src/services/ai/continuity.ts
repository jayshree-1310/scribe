/**
 * The continuity checker: does this chapter contradict the author's own story?
 *
 * **This feature is judged on its false positives.** An author deliberately
 * revealing that a character lied will be warned by anything that merely
 * compares values, and the third wrong warning teaches them to ignore every
 * warning after it. So most of this file is ways of *not* reporting:
 *
 * - **Only against a bible, and only about the same subject.** A chapter's
 *   claims are compared with established facts that share a subject with one
 *   of them, and a reported pair about two different people is dropped
 *   whatever the model said (`shareSubject`). That guard is deterministic.
 * - **Only above a confidence floor**, `AI_CONTINUITY_MIN_CONFIDENCE`, high by
 *   default. Below it a finding is never stored, so it is never shown.
 * - **By label, never by quotation.** The model answers "N3 contradicts E7";
 *   the evidence an author sees is copied from the rows that were sent, so a
 *   reply cannot misquote a chapter into a contradiction that is not in it. A
 *   label that names nothing that was sent is dropped.
 * - **Never twice.** A finding the author dismisses is remembered by the
 *   *pair of claims* (`fingerprintOf`), not by its row, so it stays dismissed
 *   when either chapter is edited elsewhere and re-checked.
 *
 * ## The path a check takes
 *
 * 1. The chapter is re-read into facts if its text changed (`extractChapter`,
 *    which is free when it has not).
 * 2. Its facts are the *claims*; the *established* facts are the ones from
 *    every other chapter that are about the same people and places.
 * 3. If the text and that comparison set are what the last check saw, nothing
 *    is asked.
 * 4. One structured call compares the two lists.
 * 5. What survives the guards above replaces the chapter's findings, with
 *    both pieces of evidence copied onto each row.
 *
 * ## A save never waits on this
 *
 * `continuity-queue.ts` schedules `runScheduledCheck` a quiet minute after the
 * last save. Nothing here is awaited by a save, and a check that fails records
 * that it failed and leaves the previous findings alone: a check that could
 * not run is neither a clean bill of health nor a reason to hide what the
 * last one found. It is retried on the next save.
 */

import { createHash } from "node:crypto";
import { HttpError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { db } from "../../prisma/db.js";
import { assertStoryOwned } from "../authoring.js";
import { toIso } from "../stories.js";
import {
  fingerprintOf,
  shareSubject,
  type BibleFact,
  type FactOrigin,
} from "./bible-facts.js";
import { assertWithinDailyBudget, recordTokenUsage } from "./budget.js";
import { loadAiConfig } from "./config.js";
import {
  CONTINUITY_PROMPT_VERSION,
  CONTINUITY_SYSTEM_PROMPT,
  continuityMessage,
} from "./prompts/continuity.js";
import { aiProvider } from "./provider.js";
import {
  continuityFindingsSchema,
  type ContinuityFindings,
  type ContinuityKind,
} from "./schemas.js";
import { extractChapterById, hasBible, liveFacts } from "./story-bible.js";
import type { AiStructuredCompletion } from "./types.js";

/** Keyed on in every usage record a check produces. */
const FEATURE = "continuity.check";

/** Eight findings of one sentence each, and their labels. */
const MAX_TOKENS = 1200;

/**
 * How much of the bible one check compares.
 *
 * The same reasoning as the assistant's budget: a model handed four hundred
 * facts finds contradictions among them that are not there. Thirty claims is
 * more than a chapter usually establishes; forty established facts is the
 * ones most likely to be contradicted, chosen in `comparisonFor`.
 */
const CLAIM_LIMIT = 30;
const ESTABLISHED_LIMIT = 40;

const CHAPTER_NOT_FOUND = "That chapter could not be found.";
const FINDING_NOT_FOUND = "That finding could not be found.";

/* Shapes returned to the client ------------------------------------------ */

export interface ContinuityFindingView {
  id: string;
  kind: ContinuityKind;
  /** Generated: one sentence on what does not add up. */
  explanation: string;
  /** 0-100, as the model reported it. */
  confidence: number;
  /** What this chapter says. */
  claim: {
    subject: string;
    attribute: string;
    value: string;
    quote: string;
  };
  /** What the rest of the story says, and where. */
  fact: {
    subject: string;
    attribute: string;
    value: string;
    quote: string | null;
    /** `author` when the contradicted fact is one the author confirmed. */
    origin: FactOrigin;
    /** Null for a story-wide fact, or a chapter that has since gone. */
    chapterId: string | null;
    chapterNumber: number | null;
    chapterTitle: string | null;
  };
  createdAt: string | null;
}

export interface ChapterContinuity {
  chapterId: string;
  /** False when the story has no bible, or checks are switched off. */
  enabled: boolean;
  /** Null when this chapter has never been checked. */
  check: {
    outcome: "ok" | "failed";
    checkedAt: string | null;
    /** True when the chapter's text has changed since it was checked. */
    stale: boolean;
    /** Established facts the chapter was compared against. */
    compared: number;
  } | null;
  findings: ContinuityFindingView[];
}

/** What running a check did. */
export interface ContinuityCheckResult {
  /**
   * - `skipped`: nothing to check against -- the story has no bible.
   * - `unchanged`: the last check already covers this text and these facts.
   * - `ok`: checked; `findings` is what is now stored.
   * - `failed`: the model could not be asked; previous findings stand.
   */
  outcome: "skipped" | "unchanged" | "ok" | "failed";
  findings: number;
  tokensUsed: number;
}

/* Choosing what to compare ------------------------------------------------ */

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const at = (fact: BibleFact): number => fact.chapterNumber ?? 0;

/**
 * The claims worth checking and the facts worth checking them against.
 *
 * A claim about somebody the rest of the story never mentions cannot
 * contradict anything, and an established fact about somebody this chapter
 * never mentions cannot be contradicted by it; both are left out before the
 * model sees them. Among what remains, the facts most likely to be
 * contradicted come first -- the same attribute of the same subject, then what
 * the author confirmed, then the nearest chapters -- so the cap cuts the
 * least likely.
 *
 * Pure, so the selection is tested without a model.
 */
export function comparisonFor(
  facts: BibleFact[],
  chapterId: string,
  chapterNumber: number,
): { claims: BibleFact[]; established: BibleFact[] } {
  const own = facts.filter((fact) => fact.chapterId === chapterId);
  const others = facts.filter((fact) => fact.chapterId !== chapterId);

  const claimKeys = new Set(own.map((fact) => fact.factKey));
  const otherKeys = new Set(others.map((fact) => fact.factKey));

  const established = others
    .filter((fact) => own.some((claim) => shareSubject(claim, fact)))
    .sort(
      (a, b) =>
        (claimKeys.has(a.factKey) ? 0 : 1) - (claimKeys.has(b.factKey) ? 0 : 1) ||
        (a.origin === "author" ? 0 : 1) - (b.origin === "author" ? 0 : 1) ||
        Math.abs(at(a) - chapterNumber) - Math.abs(at(b) - chapterNumber) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, ESTABLISHED_LIMIT);

  const claims = own
    .filter((claim) => established.some((fact) => shareSubject(claim, fact)))
    .sort(
      (a, b) =>
        (otherKeys.has(a.factKey) ? 0 : 1) - (otherKeys.has(b.factKey) ? 0 : 1) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, CLAIM_LIMIT);

  return { claims, established };
}

/**
 * What a check was run against, as one hash.
 *
 * Built from each fact's chapter, key and value rather than its row id --
 * re-extracting an unchanged chapter replaces the rows and must not make every
 * other chapter's check look stale. The floor and the prompt version are part
 * of it because changing either can change what would be reported.
 */
function contextHashOf(
  claims: BibleFact[],
  established: BibleFact[],
  minConfidence: number,
): string {
  const line = (fact: BibleFact) =>
    `${fact.chapterId ?? "story"}|${fact.factKey}|${fact.valueKey}|${fact.origin}`;

  return hashOf(
    [
      `v${CONTINUITY_PROMPT_VERSION}`,
      `min${minConfidence}`,
      "claims",
      ...claims.map(line).sort(),
      "established",
      ...established.map(line).sort(),
    ].join("\n"),
  );
}

/* Storing ----------------------------------------------------------------- */

interface CheckRecord {
  chapterId: string;
  storyId: string;
  contentHash: string;
  contextHash: string;
  outcome: "ok" | "failed";
  comparedCount: number;
  model: string | null;
}

async function storeCheck(record: CheckRecord, existingId: string | null): Promise<void> {
  if (existingId === null) {
    await db.orm.ai.ContinuityCheck.create({
      ...record,
      promptVersion: CONTINUITY_PROMPT_VERSION,
    });
    return;
  }

  await db.orm.ai.ContinuityCheck.where((row) => row.id.eq(existingId)).update({
    contentHash: record.contentHash,
    contextHash: record.contextHash,
    outcome: record.outcome,
    comparedCount: record.comparedCount,
    model: record.model,
    promptVersion: CONTINUITY_PROMPT_VERSION,
  });

  await db.runtime().query(
    db.raw.sql`
      UPDATE "ai"."continuityCheck" SET "updatedAt" = now()
       WHERE "id" = ${existingId}
    `
      .affectedCount()
      .build(),
  );
}

interface NewFinding {
  fingerprint: string;
  kind: ContinuityKind;
  explanation: string;
  confidence: number;
  claim: BibleFact;
  fact: BibleFact;
}

/** Replaces a chapter's findings with exactly these, in one transaction. */
async function replaceFindings(
  chapterId: string,
  storyId: string,
  findings: NewFinding[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      db.raw.sql`
        DELETE FROM "ai"."continuityFinding" WHERE "chapterId" = ${chapterId}
      `
        .affectedCount()
        .build(),
    );

    for (const finding of findings) {
      await tx.orm.ai.ContinuityFinding.create({
        storyId,
        chapterId,
        otherChapterId: finding.fact.chapterId,
        fingerprint: finding.fingerprint,
        kind: finding.kind,
        explanation: finding.explanation,
        confidence: Math.round(finding.confidence * 100),
        claimSubject: finding.claim.subject,
        claimAttribute: finding.claim.attribute,
        claimValue: finding.claim.value,
        claimQuote: finding.claim.quote ?? "",
        factSubject: finding.fact.subject,
        factAttribute: finding.fact.attribute,
        factValue: finding.fact.value,
        factQuote: finding.fact.quote,
        factOrigin: finding.fact.origin,
      });
    }
  });
}

/* The check --------------------------------------------------------------- */

/**
 * Checks one chapter and stores what it finds.
 *
 * Null when the chapter no longer exists. Has no opinion about who is asking:
 * its callers are the author's own request and the timer their own save set.
 */
export async function checkChapter(
  chapterId: string,
  signal?: AbortSignal,
): Promise<ContinuityCheckResult | null> {
  const located = await db.orm.content.Chapter.select("id", "storyId")
    .where((row) => row.id.eq(chapterId))
    .first();

  if (!located) return null;

  // A story opts in by having a bible. Without one there is nothing to be
  // inconsistent *with*, and reading the chapter to find out would spend an
  // author's tokens on a feature they never turned on.
  if (!(await hasBible(located.storyId))) {
    return { outcome: "skipped", findings: 0, tokensUsed: 0 };
  }

  const config = loadAiConfig();
  const existing = await db.orm.ai.ContinuityCheck.select(
    "id",
    "contentHash",
    "contextHash",
    "outcome",
    "promptVersion",
  )
    .where((row) => row.chapterId.eq(chapterId))
    .first();

  let tokensUsed = 0;
  let extracted: Awaited<ReturnType<typeof extractChapterById>>;

  try {
    extracted = await extractChapterById(chapterId, signal);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;

    // The chapter could not even be read. Recorded against no text at all, so
    // nothing can mistake it for a check of the current draft.
    await storeCheck(
      {
        chapterId,
        storyId: located.storyId,
        contentHash: "",
        contextHash: "",
        outcome: "failed",
        comparedCount: 0,
        model: null,
      },
      existing?.id ?? null,
    );
    return { outcome: "failed", findings: 0, tokensUsed };
  }

  if (!extracted) return null;

  const { chapter } = extracted;
  tokensUsed += extracted.result.tokensUsed;

  const facts = await liveFacts(chapter.storyId);
  const { claims, established } = comparisonFor(
    facts,
    chapter.id,
    chapter.chapterNumber,
  );

  const contentHash = hashOf(chapter.content);
  const contextHash = contextHashOf(
    claims,
    established,
    config.continuityMinConfidence,
  );

  if (
    existing &&
    existing.outcome === "ok" &&
    existing.contentHash === contentHash &&
    existing.contextHash === contextHash &&
    existing.promptVersion === CONTINUITY_PROMPT_VERSION
  ) {
    const stored = await db.orm.ai.ContinuityFinding.select("id")
      .where((row) => row.chapterId.eq(chapterId))
      .all();

    return { outcome: "unchanged", findings: stored.length, tokensUsed };
  }

  const record: CheckRecord = {
    chapterId,
    storyId: chapter.storyId,
    contentHash,
    contextHash,
    outcome: "ok",
    comparedCount: established.length,
    model: null,
  };

  // Nothing in this chapter is about anything the rest of the story mentions:
  // a clean result, reached without a model.
  if (claims.length === 0 || established.length === 0) {
    await replaceFindings(chapterId, chapter.storyId, []);
    await storeCheck(record, existing?.id ?? null);
    return { outcome: "ok", findings: 0, tokensUsed };
  }

  let reply: AiStructuredCompletion<ContinuityFindings>;

  try {
    reply = await aiProvider().completeStructured(continuityFindingsSchema, {
      feature: FEATURE,
      system: CONTINUITY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: continuityMessage({
            chapterNumber: chapter.chapterNumber,
            claims,
            established,
          }),
        },
      ],
      maxTokens: MAX_TOKENS,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;

    // Previous findings are left exactly as they were; see the header.
    await storeCheck(
      { ...record, outcome: "failed", contextHash: "" },
      existing?.id ?? null,
    );
    return { outcome: "failed", findings: 0, tokensUsed };
  }

  tokensUsed += reply.usage.inputTokens + reply.usage.outputTokens;

  const dismissed = new Set(
    (
      await db.orm.ai.ContinuityDismissal.select("fingerprint")
        .where((row) => row.storyId.eq(chapter.storyId))
        .all()
    ).map((row) => row.fingerprint),
  );

  const labelled = (prefix: string, label: string, list: BibleFact[]) => {
    const match = new RegExp(`^${prefix}(\\d+)$`, "i").exec(label.trim());
    return match ? list[Number(match[1]) - 1] : undefined;
  };

  const kept = new Map<string, NewFinding>();

  for (const finding of reply.value.findings) {
    if (finding.confidence < config.continuityMinConfidence) continue;

    const claim = labelled("N", finding.claim, claims);
    const fact = labelled("E", finding.fact, established);
    // A label for something that was never sent.
    if (!claim || !fact) continue;

    // Two claims about different people cannot contradict each other,
    // whatever confidence came with the pairing.
    if (!shareSubject(claim, fact)) continue;

    const fingerprint = fingerprintOf(claim, fact);
    if (dismissed.has(fingerprint)) continue;

    const previous = kept.get(fingerprint);
    if (!previous || finding.confidence > previous.confidence) {
      kept.set(fingerprint, {
        fingerprint,
        kind: finding.kind,
        explanation: finding.explanation,
        confidence: finding.confidence,
        claim,
        fact,
      });
    }
  }

  await replaceFindings(chapterId, chapter.storyId, [...kept.values()]);
  await storeCheck({ ...record, model: reply.usage.model }, existing?.id ?? null);

  return { outcome: "ok", findings: kept.size, tokensUsed };
}

/**
 * The check a save scheduled, run on the author's account.
 *
 * Charged to the author's daily budget like the features they trigger by
 * hand, and skipped outright when that budget is spent: a background check is
 * the first thing that should stop when somebody is over their allowance, not
 * the thing that put them there.
 */
export async function runScheduledCheck(chapterId: string): Promise<void> {
  const chapter = await db.orm.content.Chapter.select("storyId")
    .where((row) => row.id.eq(chapterId))
    .first();
  if (!chapter) return;

  const story = await db.orm.content.Story.select("authorId")
    .where((row) => row.id.eq(chapter.storyId))
    .first();
  if (!story) return;

  if (!(await hasBible(chapter.storyId))) return;

  try {
    await assertWithinDailyBudget(story.authorId);
  } catch (error) {
    if (error instanceof HttpError) return;
    throw error;
  }

  const result = await checkChapter(chapterId);
  if (!result) return;

  await recordTokenUsage(story.authorId, result.tokensUsed);

  if (result.outcome === "failed") {
    logger.warn({ chapterId }, "continuity: check could not run");
  }
}

/* Reading and dismissing -------------------------------------------------- */

async function ownedChapter(
  userId: string,
  chapterId: string,
): Promise<{ id: string; storyId: string; content: string }> {
  const chapter = await db.orm.content.Chapter.select("id", "storyId", "content")
    .where((row) => row.id.eq(chapterId))
    .first();

  if (!chapter) throw HttpError.notFound(CHAPTER_NOT_FOUND);

  await assertStoryOwned(userId, chapter.storyId);
  return chapter;
}

async function continuityOf(chapter: {
  id: string;
  storyId: string;
  content: string;
}): Promise<ChapterContinuity> {
  const [check, rows, bible] = await Promise.all([
    db.orm.ai.ContinuityCheck.select(
      "outcome",
      "contentHash",
      "comparedCount",
      "updatedAt",
    )
      .where((row) => row.chapterId.eq(chapter.id))
      .first(),
    db.orm.ai.ContinuityFinding.select(
      "id",
      "otherChapterId",
      "kind",
      "explanation",
      "confidence",
      "claimSubject",
      "claimAttribute",
      "claimValue",
      "claimQuote",
      "factSubject",
      "factAttribute",
      "factValue",
      "factQuote",
      "factOrigin",
      "createdAt",
    )
      .where((row) => row.chapterId.eq(chapter.id))
      .all(),
    hasBible(chapter.storyId),
  ]);

  const otherIds = [
    ...new Set(rows.flatMap((row) => (row.otherChapterId ? [row.otherChapterId] : []))),
  ];
  const others =
    otherIds.length === 0
      ? []
      : await db.orm.content.Chapter.select("id", "chapterNumber", "title")
          .where((row) => row.id.in(otherIds))
          .all();
  const byId = new Map(others.map((row) => [row.id, row]));

  const findings: ContinuityFindingView[] = rows
    .map((row) => {
      const other = row.otherChapterId ? byId.get(row.otherChapterId) : undefined;

      return {
        id: row.id,
        kind: row.kind as ContinuityKind,
        explanation: row.explanation,
        confidence: row.confidence,
        claim: {
          subject: row.claimSubject,
          attribute: row.claimAttribute,
          value: row.claimValue,
          quote: row.claimQuote,
        },
        fact: {
          subject: row.factSubject,
          attribute: row.factAttribute,
          value: row.factValue,
          quote: row.factQuote,
          origin: row.factOrigin as FactOrigin,
          chapterId: row.otherChapterId,
          chapterNumber: other?.chapterNumber ?? null,
          chapterTitle: other?.title ?? null,
        },
        createdAt: toIso(row.createdAt),
      };
    })
    // Surest first: if an author reads one, it should be the likeliest.
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));

  return {
    chapterId: chapter.id,
    enabled: bible && loadAiConfig().continuityChecks,
    check: check
      ? {
          outcome: check.outcome === "failed" ? "failed" : "ok",
          checkedAt: toIso(check.updatedAt),
          stale: check.contentHash !== hashOf(chapter.content),
          compared: check.comparedCount,
        }
      : null,
    findings,
  };
}

/** What the editor shows beside a chapter. Never calls a model. */
export async function getChapterContinuity(
  userId: string,
  chapterId: string,
): Promise<ChapterContinuity> {
  return continuityOf(await ownedChapter(userId, chapterId));
}

/**
 * Checks a chapter now, because its author asked.
 *
 * The same check the quiet timer would run, without the wait -- for an author
 * who has just built a bible and wants to know, rather than save and hope.
 */
export async function checkChapterNow(
  userId: string,
  chapterId: string,
  signal?: AbortSignal,
): Promise<{ continuity: ChapterContinuity; tokensUsed: number }> {
  const chapter = await ownedChapter(userId, chapterId);
  const result = await checkChapter(chapterId, signal);

  return {
    continuity: await continuityOf(chapter),
    tokensUsed: result?.tokensUsed ?? 0,
  };
}

/**
 * "This is not a mistake", permanently.
 *
 * Stored by the pair of claims, for the story, so it outlives the row it was
 * made from: the next check that finds the same two claims in the same two
 * chapters stays silent. Every copy of the finding in the story goes with it
 * -- the same pair can have been raised from either chapter's check.
 */
export async function dismissFinding(
  userId: string,
  findingId: string,
): Promise<void> {
  const finding = await db.orm.ai.ContinuityFinding.select(
    "id",
    "storyId",
    "fingerprint",
  )
    .where((row) => row.id.eq(findingId))
    .first();

  if (!finding) throw HttpError.notFound(FINDING_NOT_FOUND);

  await assertStoryOwned(userId, finding.storyId);

  // `ON CONFLICT DO NOTHING`: two tabs dismissing the same warning is one
  // dismissal, not a unique-index error.
  await db.runtime().query(
    db.raw.sql`
      INSERT INTO "ai"."continuityDismissal"
        ("id", "storyId", "fingerprint", "createdAt")
      VALUES (gen_random_uuid()::text, ${finding.storyId},
              ${finding.fingerprint}, now())
      ON CONFLICT ("storyId", "fingerprint") DO NOTHING
    `
      .affectedCount()
      .build(),
  );

  await db.runtime().query(
    db.raw.sql`
      DELETE FROM "ai"."continuityFinding"
       WHERE "storyId" = ${finding.storyId}
         AND "fingerprint" = ${finding.fingerprint}
    `
      .affectedCount()
      .build(),
  );
}
