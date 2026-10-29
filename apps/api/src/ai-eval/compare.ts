/**
 * Two runs side by side: what moved, and which cases got worse.
 *
 * This is what makes a prompt change reviewable. Not "looks better", but
 * "faithfulness 0.86 → 0.91, two regressions: lantern-when (citesSource),
 * sisters-diner (addresses)" -- a number that moved and the cases that moved
 * it, each of which a reviewer can open in the result file.
 *
 * Only like is compared with like. A different dataset version means the
 * cases differ and the aggregates are not comparable at all; a different
 * judge version means faithfulness is a different ruler, so that one metric
 * is reported but never called a regression.
 */

import type { EvalMetrics, EvalRun } from "./runner.js";

/** Below this, a change in a rate or a mean is noise on a 30-case set. */
export const NOISE = 0.02;

type Direction = "higher" | "lower";

interface MetricSpec {
  name: string;
  pick: (metrics: EvalMetrics) => number | null;
  better: Direction;
  /** Shown as a ratio (0.86) rather than a count or a duration. */
  ratio: boolean;
  judged?: boolean;
}

const METRICS: MetricSpec[] = [
  { name: "retrieval hit@1", pick: (m) => m.retrieval.hitAt1, better: "higher", ratio: true },
  { name: "retrieval hit@3", pick: (m) => m.retrieval.hitAt3, better: "higher", ratio: true },
  { name: "retrieval hit@K", pick: (m) => m.retrieval.hitAtK, better: "higher", ratio: true },
  { name: "retrieval MRR", pick: (m) => m.retrieval.mrr, better: "higher", ratio: true },
  { name: "cites the right chapter", pick: (m) => m.answers.citesSource, better: "higher", ratio: true },
  { name: "addresses the question", pick: (m) => m.answers.addresses, better: "higher", ratio: true },
  { name: "false declines", pick: (m) => m.answers.falseDeclines, better: "lower", ratio: true },
  { name: "faithfulness", pick: (m) => m.answers.faithfulness, better: "higher", ratio: true, judged: true },
  { name: "declines when it should", pick: (m) => m.declines.correct, better: "higher", ratio: true },
  { name: "parses first try", pick: (m) => m.structured.firstTryParse, better: "higher", ratio: true },
  { name: "extraction grounded", pick: (m) => m.structured.grounded, better: "higher", ratio: true },
  { name: "extraction subject recall", pick: (m) => m.structured.subjectRecall, better: "higher", ratio: true },
  { name: "assistant pass rate", pick: (m) => m.assist.passRate, better: "higher", ratio: true },
  { name: "moderation routed right", pick: (m) => m.moderation?.needsPerson ?? null, better: "higher", ratio: true },
  { name: "moderation false flags", pick: (m) => m.moderation?.falseFlags ?? null, better: "lower", ratio: true },
  { name: "moderation misses", pick: (m) => m.moderation?.misses ?? null, better: "lower", ratio: true },
  { name: "latency p50 (ms)", pick: (m) => m.cost.latencyP50Ms, better: "lower", ratio: false },
  { name: "output tokens", pick: (m) => m.cost.outputTokens, better: "lower", ratio: false },
];

export interface MetricChange {
  name: string;
  before: number | null;
  after: number | null;
  /** "worse" only beyond noise, and never for a metric whose ruler changed. */
  verdict: "better" | "worse" | "same" | "incomparable";
}

export interface CaseChange {
  caseId: string;
  check: string;
}

export interface Comparison {
  comparable: boolean;
  notes: string[];
  metrics: MetricChange[];
  regressions: CaseChange[];
  improvements: CaseChange[];
}

function verdictOf(spec: MetricSpec, before: number | null, after: number | null): MetricChange["verdict"] {
  if (before === null || after === null) return "incomparable";
  const delta = after - before;
  // Counts and durations move a little on every run; only a tenth counts.
  const threshold = spec.ratio ? NOISE : Math.abs(before) * 0.1;
  if (Math.abs(delta) <= threshold) return "same";
  const improved = spec.better === "higher" ? delta > 0 : delta < 0;
  return improved ? "better" : "worse";
}

export function compareRuns(previous: EvalRun, current: EvalRun): Comparison {
  const notes: string[] = [];

  if (previous.datasetVersion !== current.datasetVersion) {
    return {
      comparable: false,
      notes: [
        `Dataset version changed (${previous.datasetVersion} → ${current.datasetVersion}); the cases differ, so nothing is compared.`,
      ],
      metrics: [],
      regressions: [],
      improvements: [],
    };
  }

  const judgeChanged = previous.judgePromptVersion !== current.judgePromptVersion;
  if (judgeChanged) {
    notes.push(
      `Judge version changed (${previous.judgePromptVersion ?? "none"} → ${current.judgePromptVersion ?? "none"}); faithfulness is shown but not compared.`,
    );
  }
  if (previous.model !== current.model) {
    notes.push(`Model changed (${previous.model} → ${current.model}).`);
  }

  const metrics = METRICS.map((spec) => {
    const before = spec.pick(previous.metrics);
    const after = spec.pick(current.metrics);
    return {
      name: spec.name,
      before,
      after,
      verdict: spec.judged && judgeChanged ? ("incomparable" as const) : verdictOf(spec, before, after),
    };
  });

  const before = new Map(previous.cases.map((item) => [item.id, item]));
  const regressions: CaseChange[] = [];
  const improvements: CaseChange[] = [];

  for (const item of current.cases) {
    const old = before.get(item.id);
    if (!old) continue;

    for (const [check, pass] of Object.entries(item.checks)) {
      const was = old.checks[check];
      if (was === true && pass === false) regressions.push({ caseId: item.id, check });
      if (was === false && pass === true) improvements.push({ caseId: item.id, check });
    }
    // A case that now throws has lost every check it used to pass.
    if (item.error && !old.error) {
      for (const [check, was] of Object.entries(old.checks)) {
        if (was && !(check in item.checks)) regressions.push({ caseId: item.id, check });
      }
    }
  }

  return { comparable: true, notes, metrics, regressions, improvements };
}

const format = (value: number | null, ratio: boolean) =>
  value === null ? "—" : ratio ? value.toFixed(2) : String(Math.round(value));

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const counted = (count: number, noun: string) =>
  `${NUMBERS[count] ?? count} ${noun}${count === 1 ? "" : "s"}`;

/** The review line, then the detail. */
export function formatComparison(comparison: Comparison): string {
  if (!comparison.comparable) return comparison.notes.join("\n");

  const moved = comparison.metrics.filter((metric) => metric.verdict === "better" || metric.verdict === "worse");
  const specs = new Map(METRICS.map((spec) => [spec.name, spec]));
  const describe = (metric: MetricChange) =>
    `${metric.name} ${format(metric.before, specs.get(metric.name)?.ratio ?? true)} → ${format(metric.after, specs.get(metric.name)?.ratio ?? true)}`;

  const headline = [
    moved.length === 0 ? "no metric moved beyond noise" : moved.map(describe).join(", "),
    counted(comparison.regressions.length, "regression"),
  ].join("; ");

  const lines = [headline];
  if (comparison.regressions.length > 0) {
    lines.push("", "Regressions:");
    for (const change of comparison.regressions) lines.push(`  ✗ ${change.caseId} — ${change.check}`);
  }
  if (comparison.improvements.length > 0) {
    lines.push("", "Improvements:");
    for (const change of comparison.improvements) lines.push(`  ✓ ${change.caseId} — ${change.check}`);
  }
  if (comparison.notes.length > 0) lines.push("", ...comparison.notes);
  return lines.join("\n");
}
