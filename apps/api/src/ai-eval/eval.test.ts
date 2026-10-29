/**
 * The evaluation harness itself, against the fake provider and embedder and a
 * stub dataset: no key, no network, no cost. What it covers is the harness --
 * that a corpus is loaded and removed, that each kind of case calls its
 * feature and is graded, that usage is attributed, and that a worse second
 * run is reported as a regression -- not the model, which is the real run's
 * job.
 */

/** See `ai.test.ts`: `lib/redis.ts` reads `REDIS_URL` at module scope. */
import "dotenv/config";

import { afterEach, describe, expect, it } from "vitest";
import type { RawStory } from "../data/seed-stories.js";
import { HttpError } from "../lib/http-error.js";
import { db } from "../prisma/db.js";
import {
  resetAiEmbedder,
  resetAiProvider,
  setAiEmbedder,
  setAiProvider,
} from "../services/ai/provider.js";
import { fakeAiEmbedder, fakeAiProvider } from "../services/ai/testing.js";
import type { AiRequest } from "../services/ai/types.js";
import { databaseAvailable } from "../test/harness.js";
import { compareRuns, formatComparison } from "./compare.js";
import type { Dataset } from "./dataset.js";
import { JUDGE_FEATURE } from "./judge.js";
import { moderationSweep, runEval, type CaseResult } from "./runner.js";
import {
  MODERATION_CATEGORIES,
  type ModerationCategoryId,
} from "../services/ai/moderation.js";

const available = await databaseAvailable();

const STEPS = "She climbed the ninety-two steps in the dark, counting them the way her mother had taught her.";

const STORIES: RawStory[] = [
  {
    title: "Eval Fixture Lighthouse",
    description: "A fixture.",
    authorHandle: "unused",
    authorName: "Unused",
    genreNames: [],
    isCompleted: false,
    kidsAppropriate: true,
    viewCount: 0,
    likeCount: 0,
    chapters: [
      { title: "The stair", paragraphs: [STEPS, "The lamp room was cold and clean."] },
      { title: "The harbour", paragraphs: ["Fourteen keepers stood on the harbour wall at dawn."] },
    ],
  },
];

const DATASET: Dataset = {
  version: 99,
  cases: [
    { kind: "ask", id: "steps", story: "Eval Fixture Lighthouse", question: "How many steps did she climb?", sources: [1], mentions: ["ninety-two"] },
    { kind: "ask", id: "off-topic", story: "Eval Fixture Lighthouse", question: "What is the capital of France?", sources: [] },
    { kind: "assist", id: "grammar", action: "grammar", text: "She climb the steps.", keeps: ["steps"] },
    { kind: "extract", id: "extract", story: "Eval Fixture Lighthouse", chapter: 1, subjects: ["Mira"] },
    { kind: "moderate", id: "mod-clean", text: "Loved the stair scene.", expect: "ALLOW" },
    { kind: "moderate", id: "mod-spam", text: "BUY CHEAP FOLLOWERS NOW", expect: "REJECT" },
  ],
};

/** One reply per category, zero unless named. */
function moderationReply(over: Partial<Record<ModerationCategoryId, number>> = {}): string {
  return JSON.stringify(
    Object.fromEntries(MODERATION_CATEGORIES.map((category) => [category.id, over[category.id] ?? 0])),
  );
}

const CONCEPTS = { steps: ["steps", "climbed", "climb", "stair"] };

/** Answers each feature the way a well-behaved model would. */
function goodModel(request: AiRequest): string | undefined {
  if (request.feature === JUDGE_FEATURE) return JSON.stringify({ verdict: "supported", unsupported: [] });
  if (request.feature === "ask.book") return "She climbed ninety-two steps [1].";
  if (request.feature === "assist.grammar") return "She climbed the steps.";
  if (request.feature === "moderation.classify") {
    return String(request.messages[0]?.content).includes("BUY")
      ? moderationReply({ spam: 0.97 })
      : moderationReply();
  }
  if (request.feature === "bible.extract") {
    return JSON.stringify({
      facts: [
        {
          kind: "character",
          subject: "Mira",
          attribute: "habit",
          value: "counts the steps",
          related: null,
          quote: "counting them the way her mother had taught her",
        },
      ],
    });
  }
  return undefined;
}

async function evalUsers(): Promise<number> {
  const rows = await db.orm.auth.User.select("id")
    .where((user) => user.email.like("%@ai-eval.invalid"))
    .all();
  return rows.length;
}

afterEach(() => {
  resetAiProvider();
  resetAiEmbedder();
});

describe.skipIf(!available)("runEval", () => {
  it("runs every kind of case through its feature, grades it, and cleans up", async () => {
    const usersBefore = await evalUsers();
    const provider = fakeAiProvider(["unused"], { respond: goodModel });
    setAiProvider(provider);
    setAiEmbedder(fakeAiEmbedder(768, { model: "fake-eval", concepts: CONCEPTS }));

    const run = await runEval({ dataset: DATASET, stories: STORIES, judge: true });

    expect(run.datasetVersion).toBe(99);
    expect(run.judgePromptVersion).toBe(1);
    expect(run.provider).toBe("fake");
    expect(run.cases.map((item) => item.id)).toEqual(["steps", "off-topic", "grammar", "extract", "mod-clean", "mod-spam"]);
    expect(run.metrics.errors).toBe(0);

    const steps = run.cases[0]!;
    expect(steps.checks).toEqual({
      retrievedInTopK: true,
      rankedFirst: true,
      answered: true,
      citesSource: true,
      addresses: true,
    });
    expect(steps.scores).toMatchObject({ reciprocalRank: 1, faithfulness: 1 });
    // Usage was attributed to the case; the judge's was kept apart.
    expect(steps.usage.calls).toBe(1);
    expect(steps.usage.outputTokens).toBeGreaterThan(0);
    expect(run.metrics.cost.judgeTokens).toBeGreaterThan(0);

    // Nothing cleared the floor, so the feature declined without asking.
    expect(run.cases[1]!.checks).toEqual({ declined: true });
    expect(run.cases[1]!.usage.calls).toBe(0);

    expect(run.cases[2]!.checks).toMatchObject({ nonEmpty: true, noPreamble: true, keepsNames: true, changed: true });
    expect(run.cases[3]!.checks).toEqual({ parsedFirstTry: true, mostlyGrounded: true, foundSubjects: true });
    // Moderation through the real `decide`, with the raw scores kept.
    expect(run.cases[4]!.checks).toEqual({ needsPerson: true, exact: true });
    expect(run.cases[5]!.detail).toMatchObject({ expect: "REJECT", outcome: "REJECT", category: "spam" });
    expect(run.cases[5]!.scores["score.spam"]).toBe(0.97);

    expect(run.metrics).toMatchObject({
      retrieval: { hitAt1: 1, mrr: 1 },
      answers: { citesSource: 1, faithfulness: 1, falseDeclines: 0 },
      declines: { correct: 1 },
      structured: { firstTryParse: 1, grounded: 1 },
      assist: { passRate: 1 },
      moderation: { cases: 2, needsPerson: 1, exact: 1, falseFlags: 0, misses: 0 },
    });

    // The corpus is gone again.
    expect(await evalUsers()).toBe(usersBefore);
  });

  it("reports a worse second run as named regressions", async () => {
    setAiEmbedder(fakeAiEmbedder(768, { model: "fake-eval", concepts: CONCEPTS }));

    setAiProvider(fakeAiProvider(["unused"], { respond: goodModel }));
    const baseline = await runEval({ dataset: DATASET, stories: STORIES, judge: false });

    // Same model, except it now refuses the answerable question and needs a
    // repair to produce valid extraction JSON.
    let extractCalls = 0;
    setAiProvider(
      fakeAiProvider(["unused"], {
        respond: (request) => {
          if (request.feature === "ask.book") return "The story doesn't say.";
          if (request.feature === "bible.extract" && (extractCalls += 1) === 1) return "not json";
          return goodModel(request);
        },
      }),
    );
    const worse = await runEval({ dataset: DATASET, stories: STORIES, judge: false });

    expect(worse.cases[3]!.detail).toMatchObject({ attempts: [2] });

    const comparison = compareRuns(baseline, worse);
    expect(comparison.regressions).toEqual(
      expect.arrayContaining([
        { caseId: "steps", check: "answered" },
        { caseId: "steps", check: "citesSource" },
        { caseId: "extract", check: "parsedFirstTry" },
      ]),
    );
    expect(formatComparison(comparison)).toMatch(/regressions/);
  });

  it("waits out a provider's rate limit and retries the case", async () => {
    const provider = fakeAiProvider(["unused"], { respond: goodModel });
    provider.failNext(HttpError.tooManyRequests("The model service is busy.", 7));
    setAiProvider(provider);
    setAiEmbedder(fakeAiEmbedder(768, { model: "fake-eval", concepts: CONCEPTS }));

    const waits: number[] = [];
    const run = await runEval({
      dataset: { version: 99, cases: [DATASET.cases[0]!] },
      stories: STORIES,
      judge: false,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    // Retry-After 7s, over the first retry's 5s floor, plus a 2s margin.
    expect(waits).toEqual([9000]);
    expect(run.cases[0]!.error).toBeUndefined();
    expect(run.cases[0]!.checks["citesSource"]).toBe(true);
  });

  it("records a case that throws as an error rather than ending the run", async () => {
    const provider = fakeAiProvider(["unused"], { respond: goodModel });
    setAiProvider(provider);
    setAiEmbedder(fakeAiEmbedder(768, { model: "fake-eval", concepts: CONCEPTS }));

    const run = await runEval({
      dataset: { version: 99, cases: [{ kind: "ask", id: "missing", story: "No Such Story", question: "Anything?", sources: [1] }] },
      stories: STORIES,
      judge: false,
    });

    expect(run.cases[0]).toMatchObject({ checks: { completed: false }, error: "internal_error" });
    expect(run.metrics.errors).toBe(1);
  });
});

describe("moderationSweep", () => {
  /** A finished moderate case with these scores. */
  const scored = (id: string, over: Partial<Record<ModerationCategoryId, number>>): CaseResult => ({
    id,
    kind: "moderate",
    checks: {},
    scores: Object.fromEntries(
      MODERATION_CATEGORIES.map((category) => [`score.${category.id}`, over[category.id] ?? 0]),
    ),
    detail: {},
    latencyMs: 0,
    usage: { calls: 1, inputTokens: 0, outputTokens: 0, embedTokens: 0 },
    costUsd: null,
  });

  const cases = [
    scored("clean-but-violent", { graphic_violence: 0.45 }),
    scored("rude", { harassment: 0.62 }),
    scored("spam", { spam: 0.92 }),
    scored("self-harm", { self_harm: 0.99 }),
  ];
  const expected = new Map([
    ["clean-but-violent", "ALLOW"],
    ["rude", "REVIEW"],
    ["spam", "REJECT"],
    ["self-harm", "REVIEW"],
  ] as const);

  it("replays each pair of thresholds through decide", () => {
    const rows = moderationSweep(cases, expected, [0.4, 0.5, 0.7], [0.9, 0.95]);
    const at = (review: number, reject: number) =>
      rows.find((row) => row.review === review && row.reject === reject)!;

    // Too low: the fiction discussion reaches a moderator.
    expect(at(0.4, 0.9)).toMatchObject({ falseFlags: 1, misses: 0, exact: 3 });
    expect(at(0.5, 0.9)).toMatchObject({ falseFlags: 0, misses: 0, overHidden: 0, exact: 4 });
    // Too high: the rude comment goes unseen, and spam is only queued.
    expect(at(0.7, 0.95)).toMatchObject({ falseFlags: 0, misses: 1, exact: 2 });
    // Self-harm is never hidden, however sure.
    expect(rows.every((row) => row.overHidden === 0)).toBe(true);
  });

  it("skips a reject bar under the review bar, and cases that did not finish", () => {
    const unfinished = { ...scored("broken", {}), scores: {} };
    const rows = moderationSweep([...cases, unfinished], expected, [0.9], [0.8, 0.95]);

    expect(rows.map((row) => [row.review, row.reject])).toEqual([[0.9, 0.95]]);
    expect(rows[0]!.cases).toBe(4);
  });
});
