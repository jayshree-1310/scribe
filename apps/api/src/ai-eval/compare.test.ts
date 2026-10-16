/**
 * Comparing two runs: that a regression is named by case and check, that
 * noise is not called a change, and that a changed dataset or judge is not
 * compared as if nothing had changed.
 */

import { describe, expect, it } from "vitest";
import { compareRuns, formatComparison } from "./compare.js";
import { summarise, type CaseResult, type EvalRun } from "./runner.js";

const usage = { calls: 1, inputTokens: 100, outputTokens: 20, embedTokens: 5 };

function askCase(id: string, checks: Record<string, boolean>, faithfulness?: number): CaseResult {
  return {
    id,
    kind: "ask",
    checks,
    scores: { reciprocalRank: checks["rankedFirst"] ? 1 : 0.5, ...(faithfulness === undefined ? {} : { faithfulness }) },
    detail: {},
    latencyMs: 1000,
    usage,
    costUsd: null,
  };
}

const good = { retrievedInTopK: true, rankedFirst: true, answered: true, citesSource: true, addresses: true };

function runOf(cases: CaseResult[], overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    schema: 1,
    startedAt: "2026-10-16T00:00:00.000Z",
    finishedAt: "2026-10-16T00:01:00.000Z",
    datasetVersion: 1,
    judgePromptVersion: 1,
    provider: "fake",
    model: "m",
    embedModel: "e",
    prompts: {},
    pricing: null,
    metrics: summarise(cases, 0, null),
    cases,
    ...overrides,
  };
}

describe("compareRuns", () => {
  it("names each case and check that went from pass to fail", () => {
    const before = runOf([askCase("a", good, 1), askCase("b", good, 1), askCase("c", good, 1)]);
    const after = runOf([
      askCase("a", good, 1),
      askCase("b", { ...good, citesSource: false }, 0.5),
      askCase("c", { ...good, addresses: false }, 1),
    ]);

    const comparison = compareRuns(before, after);

    expect(comparison.regressions).toEqual([
      { caseId: "b", check: "citesSource" },
      { caseId: "c", check: "addresses" },
    ]);
    const faithfulness = comparison.metrics.find((metric) => metric.name === "faithfulness");
    expect(faithfulness).toMatchObject({ before: 1, verdict: "worse" });

    const text = formatComparison(comparison);
    expect(text).toContain("faithfulness 1.00 → 0.83");
    expect(text).toContain("two regressions");
    expect(text).toContain("✗ b — citesSource");
  });

  it("reports improvements, and calls an unchanged run unchanged", () => {
    const before = runOf([askCase("a", { ...good, citesSource: false })]);
    const after = runOf([askCase("a", good)]);
    expect(compareRuns(before, after).improvements).toEqual([{ caseId: "a", check: "citesSource" }]);

    const same = compareRuns(after, after);
    expect(same.regressions).toEqual([]);
    expect(formatComparison(same)).toContain("no metric moved beyond noise; no regressions");
  });

  it("counts a case that now errors as losing what it used to pass", () => {
    const before = runOf([askCase("a", good)]);
    const failed: CaseResult = { ...askCase("a", { completed: false }), error: "upstream_error" };
    const comparison = compareRuns(before, runOf([failed]));
    expect(comparison.regressions.map((change) => change.check)).toEqual(
      expect.arrayContaining(["citesSource", "answered"]),
    );
  });

  it("refuses to compare across dataset versions", () => {
    const comparison = compareRuns(runOf([askCase("a", good)]), runOf([askCase("a", good)], { datasetVersion: 2 }));
    expect(comparison.comparable).toBe(false);
    expect(formatComparison(comparison)).toContain("Dataset version changed");
  });

  it("shows faithfulness under a new judge but never calls it a regression", () => {
    const before = runOf([askCase("a", good, 1)]);
    const after = runOf([askCase("a", good, 0)], { judgePromptVersion: 2 });
    const comparison = compareRuns(before, after);
    expect(comparison.metrics.find((metric) => metric.name === "faithfulness")?.verdict).toBe("incomparable");
    expect(comparison.notes.join(" ")).toContain("Judge version changed");
  });
});
