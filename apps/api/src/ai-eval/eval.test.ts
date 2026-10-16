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
import { runEval } from "./runner.js";

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
  ],
};

const CONCEPTS = { steps: ["steps", "climbed", "climb", "stair"] };

/** Answers each feature the way a well-behaved model would. */
function goodModel(request: AiRequest): string | undefined {
  if (request.feature === JUDGE_FEATURE) return JSON.stringify({ verdict: "supported", unsupported: [] });
  if (request.feature === "ask.book") return "She climbed ninety-two steps [1].";
  if (request.feature === "assist.grammar") return "She climbed the steps.";
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
    expect(run.cases.map((item) => item.id)).toEqual(["steps", "off-topic", "grammar", "extract"]);
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

    expect(run.metrics).toMatchObject({
      retrieval: { hitAt1: 1, mrr: 1 },
      answers: { citesSource: 1, faithfulness: 1, falseDeclines: 0 },
      declines: { correct: 1 },
      structured: { firstTryParse: 1, grounded: 1 },
      assist: { passRate: 1 },
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
