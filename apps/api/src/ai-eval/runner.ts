/**
 * Runs a dataset against the configured provider and embedder, and returns
 * one result record: every case, every check, and the aggregates.
 *
 * Kept apart from the CLI (`run.ts`) so the CI test can run it against the
 * fake provider with a stub dataset -- the harness is covered without a key,
 * a network, or a cent.
 *
 * Each case calls the *feature*, not a reimplementation of it: `askBook` and
 * `rankPassages` for Ask This Book, `assist` for the writing assistant, the
 * bible's own `extractionRequest` for extraction. What is measured is what a
 * reader or an author gets.
 *
 * Cost is measured, not estimated: the provider and the embedder are wrapped
 * for the length of the run so every call's reported usage is attributed to
 * the case that made it -- the judge's calls to a separate bucket, because the
 * judge is the cost of measuring, not of the feature.
 */

import { HttpError } from "../lib/http-error.js";
import {
  TOP_K,
  askBook,
  rankPassages,
  resolveAskSetting,
} from "../services/ai/ask-book.js";
import { assist } from "../services/ai/assist.js";
import { sectionsOf } from "../services/ai/bible-facts.js";
import { loadAiConfig, loadAiModerationConfig } from "../services/ai/config.js";
import {
  MODERATION_CATEGORIES,
  classify,
  decide,
  type ModerationScores,
  type ModerationVerdict,
} from "../services/ai/moderation.js";
import { MODERATION_PROMPT_VERSION } from "../services/ai/prompts/moderation.js";
import { ASK_BOOK_PROMPT_VERSION } from "../services/ai/prompts/ask-book.js";
import { JUDGE_PROMPT_VERSION } from "../services/ai/prompts/eval-judge.js";
import { BIBLE_PROMPT_VERSION } from "../services/ai/prompts/story-bible.js";
import {
  aiEmbedder,
  aiProvider,
  setAiEmbedder,
  setAiProvider,
} from "../services/ai/provider.js";
import { chapterFactsSchema } from "../services/ai/schemas.js";
import { extractionRequest } from "../services/ai/story-bible.js";
import type { AiEmbedder, AiProvider, AiUsage } from "../services/ai/types.js";
import type { RawStory } from "../data/seed-stories.js";
import { loadCorpus, storyOf, unloadCorpus, type Corpus } from "./corpus.js";
import type { AskCase, AssistCase, Dataset, EvalCase, ExtractCase, ModerateCase } from "./dataset.js";
import {
  changed,
  citesSource,
  continuesWithoutRepeating,
  groundedShare,
  hasPreamble,
  isDecline,
  keepsAll,
  mean,
  mentionsAny,
  percentile,
  rate,
  scoreRetrieval,
  subjectRecall,
} from "./graders.js";
import { JUDGE_FEATURE, judgeFaithfulness } from "./judge.js";

export const RESULT_SCHEMA_VERSION = 1;

/** USD per million tokens. Null when unpriced, which is reported as such. */
export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface CaseUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  embedTokens: number;
}

export interface CaseResult {
  id: string;
  kind: EvalCase["kind"];
  /** Code-graded, pass or fail. Absent means not applicable to this case. */
  checks: Record<string, boolean>;
  /** Continuous scores: reciprocal rank, faithfulness, grounded share. */
  scores: Record<string, number>;
  /** What happened, for a human reading a regression. Bounded. */
  detail: Record<string, unknown>;
  latencyMs: number;
  usage: CaseUsage;
  costUsd: number | null;
  /** The failure's stable code when the case threw instead of finishing. */
  error?: string;
}

export interface EvalMetrics {
  retrieval: { cases: number; hitAt1: number | null; hitAt3: number | null; hitAtK: number | null; mrr: number | null };
  answers: {
    cases: number;
    citesSource: number | null;
    addresses: number | null;
    falseDeclines: number | null;
    faithfulness: number | null;
    judged: number;
  };
  declines: { cases: number; correct: number | null };
  structured: { cases: number; firstTryParse: number | null; grounded: number | null; subjectRecall: number | null };
  assist: { cases: number; passRate: number | null };
  /**
   * At the configured thresholds. `needsPerson` is the share routed correctly
   * (to a person, or left alone); `falseFlags` the share of clean comments
   * that reached a moderator; `misses` the share of harmful ones that did not.
   */
  moderation: {
    cases: number;
    needsPerson: number | null;
    exact: number | null;
    falseFlags: number | null;
    misses: number | null;
  };
  cost: {
    inputTokens: number;
    outputTokens: number;
    embedTokens: number;
    costUsd: number | null;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
    judgeTokens: number;
  };
  errors: number;
}

export interface EvalRun {
  schema: number;
  startedAt: string;
  finishedAt: string;
  datasetVersion: number;
  /** Null when the judge was not run; faithfulness is then absent too. */
  judgePromptVersion: number | null;
  provider: string;
  model: string;
  embedModel: string;
  prompts: Record<string, number>;
  pricing: Pricing | null;
  metrics: EvalMetrics;
  cases: CaseResult[];
}

/**
 * How long a case will wait out a provider's rate limit, and how often.
 *
 * Hosted free tiers limit tokens per *minute*, and an eval is a burst of calls
 * that hits that limit about a third of the way through. The provider's own
 * retry backs off for seconds, which is right for a request a person is
 * waiting on and useless against a minute-long window; the eval can afford to
 * wait. Beyond `RATE_LIMIT_MAX_WAIT_SECONDS` the limit is not a per-minute one
 * (a daily cap, say) and the case is recorded as an error instead.
 */
export const RATE_LIMIT_RETRIES = 5;
export const RATE_LIMIT_MAX_WAIT_SECONDS = 90;

export interface RunOptions {
  dataset: Dataset;
  /** The corpus; defaults to `SEED_STORIES`. */
  stories?: RawStory[];
  judge: boolean;
  /** A different model for the judge, so it is not grading itself. */
  judgeModel?: string;
  only?: EvalCase["kind"][];
  pricing?: Pricing | null;
  /** Progress lines. Silent by default, so the test stays quiet. */
  log?: (line: string) => void;
  /** Injectable so the rate-limit wait is testable without waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/* Usage attribution ------------------------------------------------------ */

type Bucket = CaseUsage;

const emptyBucket = (): Bucket => ({ calls: 0, inputTokens: 0, outputTokens: 0, embedTokens: 0 });

function costOf(usage: CaseUsage, pricing: Pricing | null): number | null {
  if (!pricing) return null;
  return (
    (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}

/**
 * Wraps the configured provider and embedder so each call's usage lands in
 * whichever bucket is current. Returns a function that puts the originals back.
 */
function instrument(buckets: { current: Bucket; judge: Bucket }): () => void {
  const chat = aiProvider();
  const embedder = aiEmbedder();

  const charge = (feature: string, usage: AiUsage) => {
    const bucket = feature === JUDGE_FEATURE ? buckets.judge : buckets.current;
    bucket.calls += 1;
    bucket.inputTokens += usage.inputTokens;
    bucket.outputTokens += usage.outputTokens;
  };

  const counted: AiProvider = {
    name: chat.name,
    async complete(request) {
      const completion = await chat.complete(request);
      charge(request.feature, completion.usage);
      return completion;
    },
    async *stream(request) {
      for await (const event of chat.stream(request)) {
        if (event.type === "done") charge(request.feature, event.usage);
        yield event;
      }
    },
  };

  const countedEmbedder: AiEmbedder = {
    name: embedder.name,
    model: embedder.model,
    dimensions: embedder.dimensions,
    async embed(request) {
      const result = await embedder.embed(request);
      buckets.current.embedTokens += result.usage.inputTokens;
      return result;
    },
  };

  setAiProvider(counted);
  setAiEmbedder(countedEmbedder);

  return () => {
    setAiProvider(chat);
    setAiEmbedder(embedder);
  };
}

/* Cases ------------------------------------------------------------------ */

type Graded = Pick<CaseResult, "checks" | "scores" | "detail">;

const clip = (text: string, limit = 600) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** The last chapter a reader can open: the bound for "the whole story". */
function lastPublished(corpus: Corpus, title: string): number {
  const chapters = storyOf(corpus, title).chapters.filter((chapter) => chapter.published);
  return chapters.at(-1)?.number ?? 1;
}

async function runAsk(item: AskCase, corpus: Corpus, options: RunOptions): Promise<Graded> {
  const story = storyOf(corpus, item.story);
  const bound = item.upToChapter ?? lastPublished(corpus, item.story);
  const input = { storyKey: story.id, question: item.question, upToChapter: bound };

  if (item.refused) {
    try {
      const answer = await askBook(corpus.readerId, input);
      return { checks: { refused: false }, scores: {}, detail: { answer: clip(answer.answer) } };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return { checks: { refused: true }, scores: {}, detail: { status: 404 } };
      }
      throw error;
    }
  }

  const setting = await resolveAskSetting(corpus.readerId, story.id, bound);
  const ranked = await rankPassages(setting, item.question, corpus.readerId);
  const rankedChapters = ranked.map((hit) => hit.chapterNumber);

  const result = await askBook(corpus.readerId, input);
  const declined = !result.answerable || isDecline(result.answer);
  const cited = result.citations.map((citation) => citation.chapterNumber);

  const detail = {
    answer: clip(result.answer),
    answerable: result.answerable,
    retrieved: [...new Set(rankedChapters)].slice(0, TOP_K),
    cited: [...new Set(cited)],
  };

  if (item.sources.length === 0) {
    return { checks: { declined }, scores: {}, detail };
  }

  const retrieval = scoreRetrieval(rankedChapters, item.sources, TOP_K);
  const checks: Record<string, boolean> = {
    retrievedInTopK: retrieval.hitAtK,
    rankedFirst: retrieval.hitAt1,
    answered: !declined,
    citesSource: citesSource(cited, item.sources),
    ...(item.mentions ? { addresses: mentionsAny(result.answer, item.mentions) } : {}),
  };
  const scores: Record<string, number> = { reciprocalRank: retrieval.reciprocalRank };

  if (options.judge && !declined) {
    if (result.citations.length === 0) {
      // An answer that cites nothing is, by the definition being measured,
      // supported by no passage. Not worth a judge call to learn that.
      scores["faithfulness"] = 0;
    } else {
      const judged = await judgeFaithfulness({
        question: item.question,
        answer: result.answer,
        passages: result.citations.map((citation) => ({
          marker: citation.marker,
          chapterNumber: citation.chapterNumber,
          text: citation.quote,
        })),
        ...(options.judgeModel ? { model: options.judgeModel } : {}),
      });
      scores["faithfulness"] = judged.score;
      Object.assign(detail, { judge: judged.verdict });
    }
  }

  return { checks, scores, detail };
}

async function runAssist(item: AssistCase, corpus: Corpus): Promise<Graded> {
  const reply = await assist(corpus.authorId, {
    action: item.action,
    text: item.text,
    before: "",
    after: "",
    tone: item.tone ?? null,
    storyId: null,
    chapterId: null,
  });
  const text = reply.text;

  const checks: Record<string, boolean> = {
    nonEmpty: text.trim().length > 0,
    noPreamble: !hasPreamble(text),
    keepsNames: keepsAll(text, item.keeps),
  };
  if (item.action === "shorten") checks["shorter"] = text.length <= item.text.length * 0.85;
  if (item.action === "grammar" || item.action === "tone") checks["changed"] = changed(text, item.text);
  if (item.action === "continue") checks["continues"] = continuesWithoutRepeating(text, item.text);

  return { checks, scores: {}, detail: { reply: clip(text) } };
}

async function runExtract(item: ExtractCase, corpus: Corpus): Promise<Graded> {
  const chapter = storyOf(corpus, item.story).chapters.find((row) => row.number === item.chapter);
  if (!chapter) throw new Error(`${item.id}: no chapter ${item.chapter} in "${item.story}"`);

  const { sections } = sectionsOf(chapter.content);
  const quotes: string[] = [];
  const subjects: string[] = [];
  const attempts: number[] = [];

  for (const [index, text] of sections.entries()) {
    const { value, attempts: tries } = await aiProvider().completeStructured(
      chapterFactsSchema,
      extractionRequest(
        { chapterNumber: chapter.number, title: chapter.title },
        { text, section: index + 1, sections: sections.length },
        [],
      ),
    );
    attempts.push(tries);
    for (const fact of value.facts) {
      quotes.push(fact.quote);
      subjects.push(fact.subject);
    }
  }

  const grounded = groundedShare(quotes, chapter.content);
  const recall = subjectRecall(subjects, item.subjects);

  return {
    checks: {
      parsedFirstTry: attempts.every((tries) => tries === 1),
      mostlyGrounded: grounded >= 0.8,
      foundSubjects: recall === 1,
    },
    scores: { grounded, subjectRecall: recall },
    detail: { facts: quotes.length, attempts, subjects: [...new Set(subjects)].slice(0, 12) },
  };
}

const SCORE_PREFIX = "score.";

/**
 * One comment through the real classifier and the real `decide`, at the
 * configured thresholds. The raw scores go on the result so
 * `moderationSweep` can replay other thresholds without another call.
 */
async function runModerate(item: ModerateCase): Promise<Graded> {
  const config = loadAiModerationConfig();
  const { scores } = await classify(item.text, config);
  const ruling = decide(scores, config);

  return {
    checks: {
      needsPerson: (ruling.outcome !== "ALLOW") === (item.expect !== "ALLOW"),
      exact: ruling.outcome === item.expect,
    },
    scores: Object.fromEntries(
      MODERATION_CATEGORIES.map((category) => [`${SCORE_PREFIX}${category.id}`, scores[category.id]]),
    ),
    detail: {
      expect: item.expect,
      outcome: ruling.outcome,
      category: ruling.category?.id ?? null,
      thresholds: { review: config.reviewThreshold, reject: config.rejectThreshold },
    },
  };
}

/** The scores a moderate case recorded, or null for one that did not finish. */
function moderationScoresOf(item: CaseResult): ModerationScores | null {
  const entries = MODERATION_CATEGORIES.map(
    (category) => [category.id, item.scores[`${SCORE_PREFIX}${category.id}`]] as const,
  );
  if (entries.some(([, score]) => score === undefined)) return null;
  return Object.fromEntries(entries) as ModerationScores;
}

export interface SweepRow {
  review: number;
  reject: number;
  /** Clean comments that would have reached a moderator. */
  falseFlags: number;
  /** Harmful comments that would not have. */
  misses: number;
  /** Comments that would have been hidden although clean or only worth a look. */
  overHidden: number;
  exact: number;
  cases: number;
}

/**
 * What each pair of thresholds would have decided, replayed over one run's
 * stored scores through the same `decide` the service uses. Pure: this is how
 * the thresholds get evidence without a model call per pair.
 */
export function moderationSweep(
  cases: readonly CaseResult[],
  expected: ReadonlyMap<string, ModerationVerdict>,
  reviews: readonly number[] = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
  rejects: readonly number[] = [0.8, 0.85, 0.9, 0.95],
): SweepRow[] {
  const scored = cases.flatMap((item) => {
    const scores = item.kind === "moderate" ? moderationScoresOf(item) : null;
    const expect = expected.get(item.id);
    return scores && expect ? [{ scores, expect }] : [];
  });

  const rows: SweepRow[] = [];
  for (const review of reviews) {
    for (const reject of rejects) {
      if (reject < review) continue;
      const row: SweepRow = { review, reject, falseFlags: 0, misses: 0, overHidden: 0, exact: 0, cases: scored.length };
      for (const { scores, expect } of scored) {
        const outcome = decide(scores, { reviewThreshold: review, rejectThreshold: reject }).outcome;
        if (expect === "ALLOW" && outcome !== "ALLOW") row.falseFlags += 1;
        if (expect !== "ALLOW" && outcome === "ALLOW") row.misses += 1;
        if (expect !== "REJECT" && outcome === "REJECT") row.overHidden += 1;
        if (outcome === expect) row.exact += 1;
      }
      rows.push(row);
    }
  }
  return rows;
}

/* Aggregation ------------------------------------------------------------ */

export function summarise(cases: CaseResult[], judgeTokens: number, pricing: Pricing | null): EvalMetrics {
  const asks = cases.filter((item) => item.kind === "ask");
  const answerable = asks.filter((item) => "answered" in item.checks);
  const declines = asks.filter((item) => "declined" in item.checks || "refused" in item.checks);
  const extracts = cases.filter((item) => item.kind === "extract");
  const assists = cases.filter((item) => item.kind === "assist");
  const moderated = cases.filter((item) => item.kind === "moderate" && item.error === undefined);
  const expectOf = (item: CaseResult) => item.detail["expect"] as ModerationVerdict | undefined;
  const clean = moderated.filter((item) => expectOf(item) === "ALLOW");
  const harmful = moderated.filter((item) => expectOf(item) !== "ALLOW");
  const succeeded = cases.filter((item) => item.error === undefined);

  const sum = (pick: (usage: CaseUsage) => number) =>
    cases.reduce((total, item) => total + pick(item.usage), 0);
  const totals: CaseUsage = {
    calls: sum((usage) => usage.calls),
    inputTokens: sum((usage) => usage.inputTokens),
    outputTokens: sum((usage) => usage.outputTokens),
    embedTokens: sum((usage) => usage.embedTokens),
  };
  const faithfulness = answerable.flatMap((item) =>
    item.scores["faithfulness"] === undefined ? [] : [item.scores["faithfulness"]],
  );
  const latencies = succeeded.map((item) => item.latencyMs);

  return {
    retrieval: {
      cases: answerable.length,
      hitAt1: rate(answerable.map((item) => item.checks["rankedFirst"])),
      hitAt3: rate(
        answerable.map((item) =>
          item.scores["reciprocalRank"] === undefined ? null : item.scores["reciprocalRank"] >= 1 / 3,
        ),
      ),
      hitAtK: rate(answerable.map((item) => item.checks["retrievedInTopK"])),
      mrr: mean(answerable.flatMap((item) => (item.scores["reciprocalRank"] === undefined ? [] : [item.scores["reciprocalRank"]]))),
    },
    answers: {
      cases: answerable.length,
      citesSource: rate(answerable.map((item) => item.checks["citesSource"])),
      addresses: rate(answerable.map((item) => item.checks["addresses"])),
      falseDeclines: rate(answerable.map((item) => (item.checks["answered"] === undefined ? null : !item.checks["answered"]))),
      faithfulness: mean(faithfulness),
      judged: faithfulness.length,
    },
    declines: {
      cases: declines.length,
      correct: rate(declines.map((item) => item.checks["declined"] ?? item.checks["refused"])),
    },
    structured: {
      cases: extracts.length,
      firstTryParse: rate(extracts.map((item) => item.checks["parsedFirstTry"])),
      grounded: mean(extracts.flatMap((item) => (item.scores["grounded"] === undefined ? [] : [item.scores["grounded"]]))),
      subjectRecall: mean(extracts.flatMap((item) => (item.scores["subjectRecall"] === undefined ? [] : [item.scores["subjectRecall"]]))),
    },
    assist: {
      cases: assists.length,
      passRate: rate(assists.map((item) => (item.error ? false : Object.values(item.checks).every(Boolean)))),
    },
    moderation: {
      cases: moderated.length,
      needsPerson: rate(moderated.map((item) => item.checks["needsPerson"])),
      exact: rate(moderated.map((item) => item.checks["exact"])),
      falseFlags: rate(clean.map((item) => !item.checks["needsPerson"])),
      misses: rate(harmful.map((item) => !item.checks["needsPerson"])),
    },
    cost: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      embedTokens: totals.embedTokens,
      costUsd: costOf(totals, pricing),
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
      judgeTokens,
    },
    errors: cases.length - succeeded.length,
  };
}

/* The run ---------------------------------------------------------------- */

export async function runEval(options: RunOptions): Promise<EvalRun> {
  const log = options.log ?? (() => undefined);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = new Date().toISOString();
  const pricing = options.pricing ?? null;

  const buckets = { current: emptyBucket(), judge: emptyBucket() };
  const restore = instrument(buckets);

  const wanted = options.dataset.cases.filter(
    (item) => !options.only || options.only.includes(item.kind),
  );
  const cases: CaseResult[] = [];
  let corpus: Corpus | null = null;

  try {
    log("Loading the corpus…");
    corpus = await loadCorpus(options.stories);

    for (const item of wanted) {
      buckets.current = emptyBucket();
      const began = Date.now();
      let graded: Graded;
      let error: string | undefined;

      const attempt = (current: Corpus) =>
        item.kind === "ask"
          ? runAsk(item, current, options)
          : item.kind === "assist"
            ? runAssist(item, current)
            : item.kind === "moderate"
              ? runModerate(item)
              : runExtract(item, current);

      try {
        for (let retry = 0; ; retry += 1) {
          try {
            graded = await attempt(corpus);
            break;
          } catch (cause) {
            // At least a doubling floor: Groq's Retry-After names the next
            // free slot, and on a full token window the next one is also full.
            const wait =
              cause instanceof HttpError && cause.status === 429
                ? Math.max(cause.retryAfterSeconds ?? 0, 5 * 2 ** retry)
                : null;
            if (wait === null || retry >= RATE_LIMIT_RETRIES || wait > RATE_LIMIT_MAX_WAIT_SECONDS) {
              throw cause;
            }
            // The usage of the failed attempt stays on the case: it was spent.
            log(`    rate-limited; waiting ${wait + 2}s (${retry + 1}/${RATE_LIMIT_RETRIES})`);
            await sleep((wait + 2) * 1000);
          }
        }
      } catch (cause) {
        // A case that throws fails every check it would have made, and says
        // why: a run with a provider outage must not read as a quality drop
        // that nobody can explain.
        error = cause instanceof HttpError ? cause.code : "internal_error";
        graded = {
          checks: { completed: false },
          scores: {},
          detail: { error: cause instanceof Error ? clip(cause.message, 200) : String(cause) },
        };
      }

      const usage = { ...buckets.current };
      const result: CaseResult = {
        id: item.id,
        kind: item.kind,
        ...graded,
        latencyMs: Date.now() - began,
        usage,
        costUsd: costOf(usage, pricing),
        ...(error ? { error } : {}),
      };
      cases.push(result);

      const failed = Object.entries(result.checks).filter(([, pass]) => !pass).map(([name]) => name);
      log(`  ${failed.length === 0 ? "✓" : "✗"} ${item.id}${failed.length ? ` — ${failed.join(", ")}` : ""}`);
    }
  } finally {
    restore();
    if (corpus) await unloadCorpus(corpus);
  }

  const judgeTokens = buckets.judge.inputTokens + buckets.judge.outputTokens;
  const config = loadAiConfig();
  // After `restore`, so these are the configured provider and embedder (or a
  // test's fakes), not the counting wrappers.
  const providerName = aiProvider().name;
  const embedModel = aiEmbedder().model;

  return {
    schema: RESULT_SCHEMA_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    datasetVersion: options.dataset.version,
    judgePromptVersion: options.judge ? JUDGE_PROMPT_VERSION : null,
    provider: providerName,
    model: config.model,
    embedModel,
    prompts: {
      askBook: ASK_BOOK_PROMPT_VERSION,
      storyBible: BIBLE_PROMPT_VERSION,
      moderation: MODERATION_PROMPT_VERSION,
    },
    pricing,
    metrics: summarise(cases, judgeTokens, pricing),
    cases,
  };
}
