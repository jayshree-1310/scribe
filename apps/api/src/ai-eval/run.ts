/**
 * `pnpm --filter api ai:eval` -- run the evaluation and compare with last time.
 *
 * Calls the real configured provider and embedder, so it costs whatever they
 * cost and is kept out of the unit suite for exactly that reason. Writes
 * `src/ai-eval/results/<timestamp>.json` and prints the comparison with the
 * previous result in that folder (or `--against <file>`).
 *
 * Flags:
 *   --no-judge             skip the faithfulness judge (no extra model calls)
 *   --judge-model <id>     grade with a different model than the one graded
 *   --only ask,assist      run only these kinds (ask, assist, extract)
 *   --against <file>       compare with this result instead of the latest
 *   --fail-on-regression   exit 1 when any case regressed (for CI with a key)
 *
 * Pricing is opt-in, because a number made up here would be worse than none:
 * set `AI_EVAL_INPUT_USD_PER_MTOK` and `AI_EVAL_OUTPUT_USD_PER_MTOK` to the
 * provider's published prices and cost per case is reported in dollars.
 */

// Before anything that reads the environment at import -- `lib/redis.ts` does.
import "dotenv/config";

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redis } from "../lib/redis.js";
import { db } from "../prisma/db.js";
import { compareRuns, formatComparison } from "./compare.js";
import { DATASET, type EvalCase } from "./dataset.js";
import { runEval, type EvalRun, type Pricing } from "./runner.js";

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function pricingFromEnv(): Pricing | null {
  const input = Number(process.env["AI_EVAL_INPUT_USD_PER_MTOK"]);
  const output = Number(process.env["AI_EVAL_OUTPUT_USD_PER_MTOK"]);
  if (!Number.isFinite(input) || !Number.isFinite(output) || process.env["AI_EVAL_INPUT_USD_PER_MTOK"] === undefined) {
    return null;
  }
  return { inputPerMTok: input, outputPerMTok: output };
}

/** The newest result file, by name -- names are ISO timestamps. */
async function latestResult(): Promise<string | null> {
  const files = (await readdir(RESULTS_DIR).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const last = files.at(-1);
  return last ? path.join(RESULTS_DIR, last) : null;
}

const show = (value: number | null, digits = 2) => (value === null ? "—" : value.toFixed(digits));

function summary(run: EvalRun): string {
  const m = run.metrics;
  return [
    `Model ${run.model} (${run.provider}), embeddings ${run.embedModel}, dataset v${run.datasetVersion}` +
      (run.judgePromptVersion === null ? ", no judge" : `, judge v${run.judgePromptVersion}`),
    "",
    `Retrieval   hit@1 ${show(m.retrieval.hitAt1)}  hit@3 ${show(m.retrieval.hitAt3)}  hit@K ${show(m.retrieval.hitAtK)}  MRR ${show(m.retrieval.mrr)}  (${m.retrieval.cases} cases)`,
    `Answers     cites right chapter ${show(m.answers.citesSource)}  addresses ${show(m.answers.addresses)}  false declines ${show(m.answers.falseDeclines)}  faithfulness ${show(m.answers.faithfulness)} (${m.answers.judged} judged)`,
    `Declines    correct ${show(m.declines.correct)}  (${m.declines.cases} cases)`,
    `Structured  parses first try ${show(m.structured.firstTryParse)}  grounded ${show(m.structured.grounded)}  subject recall ${show(m.structured.subjectRecall)}  (${m.structured.cases} cases)`,
    `Assistant   pass rate ${show(m.assist.passRate)}  (${m.assist.cases} cases)`,
    `Cost        ${m.cost.inputTokens} in / ${m.cost.outputTokens} out / ${m.cost.embedTokens} embed tokens` +
      (m.cost.costUsd === null ? ", unpriced" : `, $${m.cost.costUsd.toFixed(4)}`) +
      `; judge ${m.cost.judgeTokens} tokens; latency p50 ${show(m.cost.latencyP50Ms, 0)}ms p95 ${show(m.cost.latencyP95Ms, 0)}ms`,
    ...(m.errors > 0 ? [`Errors      ${m.errors} case(s) failed to complete — see their detail`] : []),
  ].join("\n");
}

async function main(): Promise<number> {
  const only = argument("--only")
    ?.split(",")
    .map((kind) => kind.trim()) as EvalCase["kind"][] | undefined;
  const judgeModel = argument("--judge-model");
  const against = argument("--against");

  const previousPath = against ?? (await latestResult());

  const run = await runEval({
    dataset: DATASET,
    judge: !process.argv.includes("--no-judge"),
    ...(judgeModel ? { judgeModel } : {}),
    ...(only ? { only } : {}),
    pricing: pricingFromEnv(),
    log: (line) => console.log(line),
  });

  await mkdir(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${run.startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify(run, null, 2)}\n`);

  console.log(`\n${summary(run)}\n\nWrote ${path.relative(process.cwd(), file)}`);

  if (!previousPath) {
    console.log("No previous result to compare with; this run is the baseline.");
    return 0;
  }

  const previous = JSON.parse(await readFile(previousPath, "utf8")) as EvalRun;
  const comparison = compareRuns(previous, run);
  console.log(`\nAgainst ${path.basename(previousPath)}:\n${formatComparison(comparison)}`);

  return process.argv.includes("--fail-on-regression") && comparison.regressions.length > 0 ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error(error);
} finally {
  await db.close();
  if (redis.isOpen) await redis.quit();
}
process.exit(code);
