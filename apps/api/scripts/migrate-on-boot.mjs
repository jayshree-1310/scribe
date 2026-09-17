/**
 * Bring the database up to the contract this image carries, before the API
 * serves anything.
 *
 * Migrations used to be a manual step and the failure mode was silent: a
 * commit adds a migration, the deploy succeeds, the health check passes, and
 * the instance serves 500s on whichever route first touches the new column.
 * Badges did that for a day; view counting did it for two without anyone
 * noticing, because `recordStoryView` is fire-and-forget. A release that
 * cannot migrate should fail as a release, not as a route.
 *
 * Why here and not a Render pre-deploy command: that hook is paid-tier only.
 *
 * Why the target is the contract on disk rather than a `production` ref: both
 * the migrations and the contract travel in this image, so "the contract on
 * disk" is by construction what this release expects. A ref would be a second
 * artifact to keep in sync, and forgetting to advance it is the same class of
 * mistake that caused the outage. Nothing to remember is the point.
 *
 * Idempotent by construction: `prisma_contract.contract` holds one row per
 * applied contract state, so a database already at the target reports
 * "Already up to date" and no DDL runs. That is what makes this safe on every
 * cold start rather than only on deploys.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const API_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The CLI's own executable, rather than `pnpm exec prisma`.
 *
 * Corepack resolves pnpm on first use by *downloading* it, so going through
 * pnpm would put a registry fetch on the critical path of every cold start --
 * and this instance cold-starts whenever it has been idle 15 minutes. The
 * binary is already in the image; nothing needs to be fetched to run it.
 */
const PRISMA_BIN = path.join(API_ROOT, "node_modules", ".bin", "prisma");

/** Runs the Prisma CLI, inheriting stdio unless we need to parse its output. */
function prisma(args, { capture = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PRISMA_BIN, [...args], {
      cwd: API_ROOT,
      env: { ...process.env, ...env },
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });

    let out = "";
    if (capture) child.stdout.on("data", (chunk) => (out += chunk));

    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

/**
 * The CLI streams newline-delimited progress objects and ends with one whose
 * `kind` is `result`. Parsing only that line keeps this working when new step
 * events are added.
 */
function resultOf(stdout) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.kind === "result") return parsed.envelope;
    } catch {
      // A partial line, or human-formatted output. Neither is the result.
    }
  }
  return null;
}

/**
 * How many operations in a migration drop or otherwise destroy something.
 *
 * Read from the migration's own `ops.json`, which classifies every operation
 * -- `prisma migration status --json` reports an operation *count* but not the
 * class breakdown in this CLI version, and the class is the whole question.
 */
async function destructiveOps(dirName) {
  const file = path.join(API_ROOT, "migrations", "app", dirName, "ops.json");

  try {
    const ops = JSON.parse(await readFile(file, "utf8"));
    return ops.filter((op) => op?.operationClass === "destructive");
  } catch (error) {
    // A migration whose classification cannot be read is treated as
    // destructive: the gate below then asks for a human, which is the safe
    // direction to fail in.
    console.error(`migrate: could not classify ${dirName} (${error.message})`);
    return [{ label: "unclassified — ops.json unreadable" }];
  }
}

async function main() {
  if (process.env["MIGRATE_ON_BOOT"] === "false") {
    console.log("migrate: MIGRATE_ON_BOOT=false — skipping");
    return;
  }

  /*
   * DDL through PgBouncer in transaction mode does not work, and Render's
   * DATABASE_URL is Neon's pooled host. MIGRATE_DATABASE_URL is the same
   * database reached on its direct endpoint.
   */
  const direct = process.env["MIGRATE_DATABASE_URL"];
  const url = direct ?? process.env["DATABASE_URL"];

  if (!url) throw new Error("neither MIGRATE_DATABASE_URL nor DATABASE_URL is set");

  if (!direct && /-pooler\./.test(url)) {
    throw new Error(
      "DATABASE_URL is the pooled endpoint and MIGRATE_DATABASE_URL is unset.\n" +
        "       PgBouncer in transaction mode breaks migration DDL. Set\n" +
        "       MIGRATE_DATABASE_URL to the same database on its direct host\n" +
        "       (no '-pooler' in the name). See docs/DEPLOYMENT.md.",
    );
  }

  // The CLI reads DATABASE_URL through prisma.config.ts. Passing it this way
  // rather than as `--db` keeps the credentials out of the process list.
  const env = { DATABASE_URL: url };

  const status = await prisma(["migration", "status", "--json"], { capture: true, env });
  const envelope = resultOf(status.out);

  if (status.code !== 0 || !envelope?.result) {
    throw new Error("could not read migration status — is the database reachable?");
  }

  /*
   * `migration status` exits 0 even when it reports a problem, so the warnings
   * have to be read off the envelope. These mean the database is somewhere the
   * migration graph does not describe -- applying anything on top would
   * compound it.
   */
  const blocking = (envelope.result.diagnostics ?? []).filter((d) => d.severity === "warn");
  if (blocking.length > 0) {
    for (const d of blocking) console.error(`migrate: ${d.code} — ${d.message ?? d.summary}`);
    throw new Error("the database is in a state the migration graph does not cover");
  }

  const pending = (envelope.result.spaces ?? []).flatMap((space) =>
    (space.migrations ?? [])
      .filter((migration) => migration.status === "pending")
      .map((migration) => migration.name),
  );

  if (pending.length === 0) {
    console.log("migrate: already up to date — nothing to run");
    return;
  }

  console.log(`migrate: ${pending.length} pending migration(s):`);
  for (const name of pending) console.log(`migrate:   ${name}`);

  /*
   * Destructive operations are the one class worth a human. `prisma db
   * migrate` has no confirmation prompt of its own -- whatever the planner put
   * in the graph is what runs -- so an unattended boot would happily drop a
   * table. Additive migrations, which is nearly all of them, still go through
   * untouched; this only stops the ones that can lose data.
   */
  const risky = [];
  for (const name of pending) {
    const ops = await destructiveOps(name);
    if (ops.length > 0) risky.push({ name, ops });
  }

  if (risky.length > 0 && process.env["MIGRATE_ALLOW_DESTRUCTIVE"] !== "true") {
    console.error("\nmigrate: REFUSING — pending migrations drop or destroy schema:");
    for (const { name, ops } of risky) {
      console.error(`migrate:   ${name}`);
      for (const op of ops) console.error(`migrate:     - ${op.label ?? op.id ?? "destructive op"}`);
    }
    console.error(
      "\nmigrate: Take a backup, confirm the loss is intended, then redeploy with\n" +
        "migrate: MIGRATE_ALLOW_DESTRUCTIVE=true set on the service. Unset it afterwards.\n",
    );
    throw new Error("destructive migration pending; refusing to apply unattended");
  }

  const applied = await prisma(["db", "migrate", "--yes"], { env });
  if (applied.code !== 0) throw new Error("migration failed");

  console.log("migrate: done");
}

try {
  await main();
} catch (error) {
  /*
   * Fatal on purpose. Render keeps the previous deploy serving when the new
   * one never becomes healthy, and the old release against a consistent
   * database beats a new one that 500s on every route touching the migration.
   */
  console.error(`\nmigrate: FATAL — ${error.message}`);
  console.error("migrate: refusing to start the API.\n");
  process.exit(1);
}
