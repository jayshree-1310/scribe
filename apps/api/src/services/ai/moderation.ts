/**
 * The automated content check: every new comment, scored after it is posted.
 *
 * ## The path one comment takes
 *
 * 1. `createComment` commits and calls `moderate("COMMENT", id)`, which returns
 *    at once. The reader already has their comment back; nothing below can
 *    slow that down or fail it.
 * 2. The text is read back through `services/moderation.ts` and hashed.
 * 3. **One structured call** asks the model for a confidence per category
 *    (`prompts/moderation.ts`). Numbers only -- the model does not choose what
 *    happens.
 * 4. `decide` turns the numbers into one of three outcomes against the two
 *    thresholds in `AiModerationConfig`. It is pure, which is where the policy
 *    is tested.
 * 5. Anything that needs a person is handed to `fileAutomatedReport`, which
 *    files it in the same queue a reader's report lands in and, for a reject,
 *    hides the content the way a moderator would.
 * 6. A decision row records what was concluded, by which model and prompt
 *    version, with every score -- whatever the outcome.
 *
 * ## The three outcomes
 *
 * - **ALLOW** -- nothing happens. The decision row is the only trace.
 * - **REVIEW** -- a report is filed and the comment *stays up*. This is the
 *   uncertain middle, and uncertain cases go to a person.
 * - **REJECT** -- the comment is hidden now *and* a report is filed, left open.
 *   Open, not resolved: a machine hiding something is still a claim a person
 *   has to confirm, and the queue is the only place that happens.
 *
 * ## When the model cannot be asked
 *
 * **The comment stays published and is recorded as `UNCHECKED`. No report is
 * filed.** This is a decision, not a default:
 *
 * - Holding comments while the model is down would make an AI outage an
 *   outage of commenting, which is the one thing the backlog forbids outright.
 * - Filing every unclassified comment for review instead would turn an hour of
 *   provider trouble into several hundred queue rows with nothing wrong with
 *   them, burying the reports readers filed -- the reports that were the whole
 *   of moderation before this file existed and still work without it.
 * - So an outage degrades to exactly what the site had before: people report
 *   what they see. `UNCHECKED` rows are what `moderatePending` picks up later,
 *   so the gap is closed when the model is back rather than forgotten.
 *
 * ## What a person's decision means here
 *
 * A moderator resolves an automated report with the same three actions as any
 * other. `DISMISS` restores a hidden comment and tells its author; and from
 * then on `fileAutomatedReport` refuses to act on that row again, so a re-run
 * cannot quietly reverse somebody's ruling. The decision rows are never
 * edited to match -- they say what the classifier thought, which is exactly
 * what is worth having when its threshold is being questioned.
 *
 * ## What this is not charged to
 *
 * Nobody's daily token budget. The check runs for the platform, not for the
 * commenter: charging them would let a reader talk their way out of being
 * moderated by exhausting their own budget first. What bounds the spend is the
 * comment rate limit, one call per comment, and `AI_MODERATION_MODEL`.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../../lib/http-error.js";
import { logger } from "../../lib/logger.js";
import { db } from "../../prisma/db.js";
import {
  fileAutomatedReport,
  readModerationTarget,
  type ReportReason,
  type ReportTarget,
} from "../moderation.js";
import { loadAiModerationConfig, type AiModerationConfig } from "./config.js";
import {
  MODERATION_PROMPT_VERSION,
  moderationSystemPrompt,
  moderationUserMessage,
} from "./prompts/moderation.js";
import { aiProvider } from "./provider.js";

/** Keyed on in every usage record this feature produces. */
const FEATURE = "moderation.classify";

/** Five numbers. Anything longer is the model explaining itself. */
const MAX_TOKENS = 200;

/**
 * How much of a post is scored.
 *
 * Comments are short and never reach this; a channel post can. What opens a
 * post is what a reader meets, and a classifier's cost should not be set by
 * the longest thing anybody ever pasted.
 */
const TEXT_LIMIT = 6_000;

/* Categories -------------------------------------------------------------- */

/**
 * When the automated check may hide something on its own.
 *
 * - `at-reject`: only above the reject threshold. The ordinary rule.
 * - `at-review`: as soon as it is worth a look at all. For harm that is not
 *   reduced by being visible for the hour a moderator takes to arrive.
 * - `never`: a person decides, however sure the model is.
 */
export type AutoHide = "at-reject" | "at-review" | "never";

export interface ModerationCategory {
  /** The key the model scores under, and what `ModerationScore` stores. */
  id: string;
  /** What a moderator reads in the queue. */
  label: string;
  /** What the model is told the category means. */
  describe: string;
  /** The closest reason a reader could have picked; what the report files as. */
  reason: ReportReason;
  autoHide: AutoHide;
}

/**
 * What is checked for. Data, so the prompt, the reply schema, the stored
 * scores and the policy are all read from one list and cannot disagree.
 *
 * Adding one is a row here and a `MODERATION_PROMPT_VERSION` bump. Order
 * matters only as a tie-break in `decide`: earlier is more serious.
 */
export const MODERATION_CATEGORIES = [
  {
    id: "sexual_minors",
    label: "Sexual content involving minors",
    describe:
      "Sexualises anybody under 18, or anybody described as a child, in any form.",
    reason: "SEXUAL",
    // Zero tolerance: not left up while somebody gets to it.
    autoHide: "at-review",
  },
  {
    id: "harassment",
    label: "Harassment",
    describe:
      "Attacks, demeans or threatens a real person -- the author or another reader -- rather than criticising the writing.",
    reason: "HARASSMENT",
    autoHide: "at-reject",
  },
  {
    id: "graphic_violence",
    label: "Graphic violence",
    describe:
      "Threatens real violence, or dwells on gore for its own sake rather than discussing what happens in a story.",
    reason: "VIOLENCE",
    autoHide: "at-reject",
  },
  {
    id: "self_harm",
    label: "Self-harm",
    describe:
      "The writer expresses an intention to harm themselves, or encourages somebody else to.",
    reason: "OTHER",
    // Somebody saying they are in danger is not somebody to silence
    // automatically and send a "your comment was hidden" notice to.
    autoHide: "never",
  },
  {
    id: "spam",
    label: "Spam",
    describe:
      "Advertising, a link to somewhere unrelated, or a message plainly written to be posted everywhere.",
    reason: "SPAM",
    autoHide: "at-reject",
  },
] as const satisfies readonly ModerationCategory[];

export type ModerationCategoryId = (typeof MODERATION_CATEGORIES)[number]["id"];

export type ModerationScores = Record<ModerationCategoryId, number>;

/**
 * The reply: one confidence per category, every one required.
 *
 * Built from the list above. The bounds are enforced here because the schema
 * on the wire carries structure only -- a model that answers 7 or -1 is caught
 * on the way back, repaired once, and then treated as no answer at all.
 */
export const moderationScoresSchema = z.object(
  Object.fromEntries(
    MODERATION_CATEGORIES.map((category) => [
      category.id,
      z.number().min(0).max(1).describe(category.describe),
    ]),
  ) as Record<ModerationCategoryId, z.ZodNumber>,
);

/* The decision ------------------------------------------------------------ */

export type ModerationVerdict = "ALLOW" | "REVIEW" | "REJECT";

export interface ModerationRuling {
  outcome: ModerationVerdict;
  /** The category that decided it. Null for `ALLOW`. */
  category: ModerationCategory | null;
  confidence: number;
}

const SEVERITY: Record<ModerationVerdict, number> = {
  ALLOW: 0,
  REVIEW: 1,
  REJECT: 2,
};

/** What one category's score means on its own, before the others are weighed. */
function verdictFor(
  category: ModerationCategory,
  confidence: number,
  thresholds: Pick<AiModerationConfig, "reviewThreshold" | "rejectThreshold">,
): ModerationVerdict {
  if (confidence < thresholds.reviewThreshold) return "ALLOW";

  if (category.autoHide === "at-review") return "REJECT";
  if (category.autoHide === "never") return "REVIEW";

  return confidence >= thresholds.rejectThreshold ? "REJECT" : "REVIEW";
}

/**
 * Scores in, one outcome out.
 *
 * The most severe verdict any category reaches is the outcome, and the
 * category named is the one that reached it with the highest confidence --
 * list order breaking ties -- so the reason filed is the reason it was filed.
 * A comment that is 0.95 spam and 0.6 harassment is rejected *as spam*.
 *
 * Pure, and the only place a threshold is compared with anything.
 */
export function decide(
  scores: ModerationScores,
  thresholds: Pick<AiModerationConfig, "reviewThreshold" | "rejectThreshold">,
): ModerationRuling {
  let ruling: ModerationRuling = {
    outcome: "ALLOW",
    category: null,
    confidence: 0,
  };

  for (const category of MODERATION_CATEGORIES) {
    const confidence = scores[category.id];
    const outcome = verdictFor(category, confidence, thresholds);
    if (outcome === "ALLOW") continue;

    const moreSevere = SEVERITY[outcome] > SEVERITY[ruling.outcome];
    const surer =
      SEVERITY[outcome] === SEVERITY[ruling.outcome] &&
      confidence > ruling.confidence;

    if (moreSevere || surer) ruling = { outcome, category, confidence };
  }

  return ruling;
}

/* Classifying ------------------------------------------------------------- */

/** What was read, without keeping it. */
function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Why there is no verdict, as a fixed word.
 *
 * Never the provider's message: it can quote the prompt, and the prompt
 * contains the comment.
 */
function failureOf(error: HttpError): string {
  if (error.status === 503) return "unavailable";
  if (error.status === 429) return "rate-limited";
  return "upstream";
}

/**
 * The model's scores for one text, and which model gave them.
 *
 * The system prompt is a function of the category list alone; the member's
 * text goes in the user message, fenced. Throws whatever the provider seam
 * throws -- the caller is what turns that into `UNCHECKED`.
 */
export async function classify(
  text: string,
  config: AiModerationConfig = loadAiModerationConfig(),
): Promise<{ scores: ModerationScores; model: string }> {
  const { value, usage } = await aiProvider().completeStructured(
    moderationScoresSchema,
    {
      feature: FEATURE,
      system: moderationSystemPrompt([...MODERATION_CATEGORIES]),
      messages: [
        { role: "user", content: moderationUserMessage(text.slice(0, TEXT_LIMIT)) },
      ],
      maxTokens: MAX_TOKENS,
      ...(config.model ? { model: config.model } : {}),
    },
  );

  return { scores: value as ModerationScores, model: usage.model };
}

/* Recording --------------------------------------------------------------- */

export type ModerationOutcome = ModerationVerdict | "UNCHECKED";

export interface ModerationResult {
  outcome: ModerationOutcome;
  /** The deciding category's id, when there was one. */
  category: ModerationCategoryId | null;
  /** The report the finding sits under; null when none was filed. */
  reportId: string | null;
}

interface DecisionInput {
  targetType: ReportTarget;
  targetId: string;
  outcome: ModerationOutcome;
  category: string | null;
  contentHash: string;
  model: string;
  failure: string | null;
  reportId: string | null;
  scores: ModerationScores | null;
  config: AiModerationConfig;
}

/** One decision and its scores, together or not at all. */
async function recordDecision(input: DecisionInput): Promise<void> {
  await db.transaction(async (tx) => {
    const decision = await tx.orm.ai.ModerationDecision.select("id").create({
      targetType: input.targetType,
      targetId: input.targetId,
      outcome: input.outcome,
      category: input.category,
      contentHash: input.contentHash,
      model: input.model,
      promptVersion: MODERATION_PROMPT_VERSION,
      reviewThreshold: String(input.config.reviewThreshold),
      rejectThreshold: String(input.config.rejectThreshold),
      failure: input.failure,
      reportId: input.reportId,
    });

    if (!input.scores) return;

    for (const category of MODERATION_CATEGORIES) {
      await tx.orm.ai.ModerationScore.create({
        decisionId: decision.id,
        category: category.id,
        confidence: String(input.scores[category.id]),
      });
    }
  });
}

/**
 * Whether this exact text has already been given a verdict by this prompt.
 *
 * What makes a re-run free. `UNCHECKED` does not count -- it is the absence of
 * a verdict, and the reason a re-run exists.
 */
async function alreadyJudged(
  targetType: ReportTarget,
  targetId: string,
  contentHash: string,
): Promise<boolean> {
  const latest = await db.orm.ai.ModerationDecision.select(
    "outcome",
    "contentHash",
    "promptVersion",
  )
    .where((row) => row.targetType.eq(targetType))
    .where((row) => row.targetId.eq(targetId))
    .orderBy([(row) => row.createdAt.desc(), (row) => row.id.desc()])
    .first();

  return (
    latest !== null &&
    latest !== undefined &&
    latest.outcome !== "UNCHECKED" &&
    latest.contentHash === contentHash &&
    latest.promptVersion === MODERATION_PROMPT_VERSION
  );
}

/** What a moderator reads under an automated report. */
function detailsFor(ruling: ModerationRuling): string {
  const label = ruling.category?.label.toLowerCase() ?? "a rule breach";
  const percent = Math.round(ruling.confidence * 100);

  return ruling.outcome === "REJECT"
    ? `Automated check: possible ${label} (${percent}% confidence). Hidden pending review.`
    : `Automated check: possible ${label} (${percent}% confidence). Still visible.`;
}

/**
 * Checks one piece of content, start to finish, and says what was concluded.
 *
 * Null means nothing was done and nothing recorded: the check is switched off,
 * the row is gone or already hidden, or this text already has a verdict.
 * Awaitable, for the backfill and for tests; `moderate` below is the
 * fire-and-forget spelling the write paths use.
 */
export async function moderateContent(
  targetType: ReportTarget,
  targetId: string,
): Promise<ModerationResult | null> {
  const config = loadAiModerationConfig();
  if (!config.enabled) return null;

  const target = await readModerationTarget(targetType, targetId);

  // Already taken down, by a moderator or by an earlier run: there is nothing
  // left for a classifier to protect anybody from.
  if (!target || target.hidden) return null;

  const contentHash = hashOf(target.body);
  if (await alreadyJudged(targetType, targetId, contentHash)) return null;

  let classified: Awaited<ReturnType<typeof classify>>;
  try {
    classified = await classify(target.body, config);
  } catch (error) {
    // Anything the provider seam raises is "the model could not be asked".
    // Anything else is a bug in this file and should look like one.
    if (!(error instanceof HttpError)) throw error;

    await recordDecision({
      targetType,
      targetId,
      outcome: "UNCHECKED",
      category: null,
      contentHash,
      model: "",
      failure: failureOf(error),
      reportId: null,
      scores: null,
      config,
    });

    return { outcome: "UNCHECKED", category: null, reportId: null };
  }

  const ruling = decide(classified.scores, config);

  const reportId =
    ruling.outcome === "ALLOW" || ruling.category === null
      ? null
      : await fileAutomatedReport({
          targetType,
          targetId,
          reason: ruling.category.reason,
          details: detailsFor(ruling),
          hide: ruling.outcome === "REJECT",
        });

  await recordDecision({
    targetType,
    targetId,
    outcome: ruling.outcome,
    category: ruling.category?.id ?? null,
    contentHash,
    model: classified.model,
    failure: null,
    reportId,
    scores: classified.scores,
    config,
  });

  return {
    outcome: ruling.outcome,
    category: (ruling.category?.id ?? null) as ModerationCategoryId | null,
    reportId,
  };
}

/* Fire and forget --------------------------------------------------------- */

/** In-flight checks, so a test, a shutdown or a deletion can wait for them. */
const pending = new Set<Promise<unknown>>();

/**
 * Schedules a check and returns immediately.
 *
 * `void`, like `notify`, so a write path cannot await it by accident and no
 * failure here can become a failed comment. Call it after the write commits.
 * The switch is read here as well as inside, so that with the check off this
 * costs nothing at all -- not a promise, not a query.
 */
export function moderate(targetType: ReportTarget, targetId: string): void {
  if (!loadAiModerationConfig().enabled) return;

  const work = moderateContent(targetType, targetId).catch((error: unknown) => {
    logger.warn({ err: error, targetType }, "moderation: check failed");
  });

  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/** Settles every check scheduled so far. See `services/deferred.ts`. */
export async function flushModeration(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/* Catching up ------------------------------------------------------------- */

export interface PendingSweep {
  examined: number;
  allowed: number;
  queued: number;
  hidden: number;
  unchecked: number;
}

/**
 * Checks comments that have no verdict yet: posted while the model was down,
 * or before this feature existed.
 *
 * Oldest first and bounded, so it can be run repeatedly. Stops at the first
 * `UNCHECKED` -- if the model is still unreachable, the next four hundred
 * calls will say the same thing more slowly. There is no job runner (Task AI
 * 20), so `pnpm moderation:pending` is what calls this.
 */
export async function moderatePending(limit: number): Promise<PendingSweep> {
  const plan = db.raw.sql`
    SELECT c."id"
      FROM "engagement"."comment" AS c
     WHERE c."hiddenAt" IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM "ai"."moderationDecision" AS d
          WHERE d."targetType" = 'COMMENT'
            AND d."targetId" = c."id"
            AND d."outcome" <> 'UNCHECKED'
       )
     ORDER BY c."createdAt", c."id"
     LIMIT ${limit}
  `
    .returnsRow({ id: "pg/text@1" })
    .build();

  const rows = (await db.runtime().query(plan)) as { id: string }[];
  const sweep: PendingSweep = {
    examined: 0,
    allowed: 0,
    queued: 0,
    hidden: 0,
    unchecked: 0,
  };

  for (const row of rows) {
    const result = await moderateContent("COMMENT", row.id);
    if (!result) continue;

    sweep.examined += 1;
    if (result.outcome === "ALLOW") sweep.allowed += 1;
    if (result.outcome === "REVIEW") sweep.queued += 1;
    if (result.outcome === "REJECT") sweep.hidden += 1;
    if (result.outcome === "UNCHECKED") {
      sweep.unchecked += 1;
      break;
    }
  }

  return sweep;
}
