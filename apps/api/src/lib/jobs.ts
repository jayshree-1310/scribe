/**
 * A minimal job queue on the Redis the app already has (Task AI 20).
 *
 * Embedding a chapter, reading a whole story into its bible and pruning usage
 * rows are all too slow, or too periodic, for a request. Four job types do
 * not justify a queue library, so this is the smallest thing that has the
 * properties that matter:
 *
 * - **Status a person can read.** A job is a Redis hash with its type, status
 *   (`queued`, `running`, `done`, `failed` -- will retry -- or `dead`), attempt
 *   count, the user who caused it and the last error *code*. The author who
 *   asked for a bible reading polls it; nobody else can (`getJob` callers
 *   check the owner).
 * - **Bounded retries with backoff.** A failing job is rescheduled on a
 *   doubling delay, up to its type's `maxAttempts`, then moved to the
 *   dead-letter list, where `pnpm --filter api ai:jobs` lists, retries or
 *   drops it.
 * - **Idempotent handlers, by contract.** A job can run twice -- a retry after
 *   a timeout that actually succeeded, a worker that died mid-job -- so every
 *   handler must be safe to repeat. The AI ones are: each skips work whose
 *   input hash has not changed.
 * - **Debounce by key.** Enqueuing with a `dedupeKey` while an earlier job with
 *   that key is still waiting moves the earlier one later instead of adding a
 *   second: an author autosaving a published chapter every few seconds gets
 *   one embedding a quiet minute after they stop.
 *
 * **One worker, in the API process**, started by `server.ts` when
 * `AI_JOBS=on`. Not a separate process, because the deployment is one small
 * instance and a second service would be a second bill and a second thing to
 * keep alive for work that takes seconds. Claiming is atomic (`LMOVE`), so a
 * second instance would share the queue safely; what it would not share is the
 * start-up recovery below, which assumes one worker -- documented in
 * `docs/ai-operations.md`.
 *
 * Layout, under the `AI_JOBS_QUEUE` prefix (default `jobs`): `<p>:job:<id>`
 * (hash), `<p>:ready` (list), `<p>:delayed` (sorted set by run-at time),
 * `<p>:running` (list being worked), `<p>:dead` (list), `<p>:dedupe:<key>`
 * (string: the waiting job's id).
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "./http-error.js";
import { logger } from "./logger.js";
import { connectRedis, redis } from "./redis.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "dead";

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  /** Who caused it; the only person who may read it back. Null for the platform. */
  userId: string | null;
  /** The request that enqueued it, so its logs tie back to a user action. */
  requestId: string | null;
  /** Its debounce key, if it was enqueued with one. */
  dedupeKey: string | null;
  /** A stable code, never a message: it is shown to the user who asked. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** What the handler returned, for a status poll. Small and JSON. */
  result: unknown;
}

export interface JobContext {
  job: Job;
  /** Fired when the worker is stopping, so a long handler can give up early. */
  signal: AbortSignal;
}

export interface JobType {
  handler: (payload: Record<string, unknown>, context: JobContext) => Promise<unknown>;
  /** Attempts in all, the first included. */
  maxAttempts: number;
}

/**
 * The queue's key prefix, `jobs` unless `AI_JOBS_QUEUE` names another. Two
 * environments sharing one Redis -- or the test suite beside a running dev
 * server, whose worker would otherwise take the suite's jobs -- each get a
 * queue of their own. Read per call, so a test can switch it.
 */
const prefix = () => process.env["AI_JOBS_QUEUE"]?.trim() || "jobs";

const KEY = {
  job: (id: string) => `${prefix()}:job:${id}`,
  get ready() {
    return `${prefix()}:ready`;
  },
  get delayed() {
    return `${prefix()}:delayed`;
  },
  get running() {
    return `${prefix()}:running`;
  },
  get dead() {
    return `${prefix()}:dead`;
  },
  dedupe: (key: string) => `${prefix()}:dedupe:${key}`,
};

/** A finished job is kept a day for status polls; a dead one a week, for a person. */
const DONE_TTL_SECONDS = 60 * 60 * 24;
const DEAD_TTL_SECONDS = 60 * 60 * 24 * 7;

const DEFAULT_MAX_ATTEMPTS = 3;

/** Retry delay after attempt n (1-based): 5s, 10s, 20s ... capped at ten minutes. */
export function retryDelayMs(attempt: number): number {
  return Math.min(10 * 60_000, 5_000 * 2 ** (attempt - 1));
}

const types = new Map<string, JobType>();

export function registerJobType(type: string, definition: JobType): void {
  types.set(type, definition);
}

/* Reading and writing a job ----------------------------------------------- */

function encode(job: Job): Record<string, string> {
  return {
    id: job.id,
    type: job.type,
    payload: JSON.stringify(job.payload),
    status: job.status,
    attempts: String(job.attempts),
    maxAttempts: String(job.maxAttempts),
    userId: job.userId ?? "",
    requestId: job.requestId ?? "",
    dedupeKey: job.dedupeKey ?? "",
    error: job.error ?? "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: JSON.stringify(job.result ?? null),
  };
}

function decode(fields: Record<string, string>): Job | null {
  if (!fields["id"]) return null;
  return {
    id: fields["id"],
    type: fields["type"] ?? "",
    payload: JSON.parse(fields["payload"] ?? "{}") as Record<string, unknown>,
    status: (fields["status"] ?? "queued") as JobStatus,
    attempts: Number(fields["attempts"] ?? 0),
    maxAttempts: Number(fields["maxAttempts"] ?? 1),
    userId: fields["userId"] || null,
    requestId: fields["requestId"] || null,
    dedupeKey: fields["dedupeKey"] || null,
    error: fields["error"] || null,
    createdAt: fields["createdAt"] ?? "",
    updatedAt: fields["updatedAt"] ?? "",
    result: JSON.parse(fields["result"] ?? "null") as unknown,
  };
}

export async function getJob(id: string): Promise<Job | null> {
  await connectRedis();
  return decode(await redis.hGetAll(KEY.job(id)));
}

async function save(job: Job, ttlSeconds?: number): Promise<void> {
  const key = KEY.job(job.id);
  const write = redis.multi().hSet(key, encode({ ...job, updatedAt: new Date().toISOString() }));
  if (ttlSeconds) write.expire(key, ttlSeconds);
  else write.persist(key);
  await write.exec();
}

/* Enqueueing --------------------------------------------------------------- */

export interface EnqueueOptions {
  userId?: string | null;
  requestId?: string | null;
  /** Run no sooner than this many milliseconds from now. */
  delayMs?: number;
  /** While a job with this key is still waiting, push it later instead. */
  dedupeKey?: string;
}

export async function enqueue(
  type: string,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<string> {
  // Not required to be registered *here*: the process enqueuing (a request)
  // and the one running (the worker) need not be the same, and the worker
  // dead-letters a type it does not know rather than losing it.
  const definition = types.get(type);
  await connectRedis();

  const runAt = Date.now() + (options.delayMs ?? 0);

  if (options.dedupeKey) {
    const waiting = await redis.get(KEY.dedupe(options.dedupeKey));
    // Still waiting in the delayed set and never tried: move it later, and
    // that is the whole enqueue. A job already running reads the database
    // when it runs, after the write that caused this call committed.
    if (waiting && (await redis.zScore(KEY.delayed, waiting)) !== null) {
      const existing = await getJob(waiting);
      if (existing?.status === "queued") {
        await redis.zAdd(KEY.delayed, { score: runAt, value: waiting });
        return waiting;
      }
    }
  }

  const now = new Date().toISOString();
  const job: Job = {
    id: randomUUID(),
    type,
    payload,
    status: "queued",
    attempts: 0,
    maxAttempts: definition?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    userId: options.userId ?? null,
    requestId: options.requestId ?? null,
    dedupeKey: options.dedupeKey ?? null,
    error: null,
    createdAt: now,
    updatedAt: now,
    result: null,
  };

  await save(job);
  await redis.zAdd(KEY.delayed, { score: runAt, value: job.id });
  if (options.dedupeKey) {
    // Expires on its own if the job is lost; a stale key only costs a duplicate.
    await redis.set(KEY.dedupe(options.dedupeKey), job.id, { EX: 60 * 60 });
  }
  return job.id;
}

/* Working ------------------------------------------------------------------- */

/** Moves every delayed job whose time has come onto the ready list. */
async function promoteDue(): Promise<void> {
  const due = await redis.zRangeByScore(KEY.delayed, 0, Date.now());
  for (const id of due) {
    // ZREM first: only the caller that removed it gets to push it.
    if ((await redis.zRem(KEY.delayed, id)) === 1) await redis.rPush(KEY.ready, id);
  }
}

async function clearDedupe(job: Job): Promise<void> {
  if (job.dedupeKey && (await redis.get(KEY.dedupe(job.dedupeKey))) === job.id) {
    await redis.del(KEY.dedupe(job.dedupeKey));
  }
}

/**
 * Claims and runs one ready job. Returns false when there was nothing to run.
 * Exported so tests and `drainJobs` can run the queue without a timer.
 */
export async function runNextJob(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
  await connectRedis();
  await promoteDue();

  const id = await redis.lMove(KEY.ready, KEY.running, "LEFT", "RIGHT");
  if (!id) return false;

  const job = await getJob(id);
  if (!job) {
    await redis.lRem(KEY.running, 1, id);
    logger.warn({ job: { id } }, "job dropped: its record expired");
    return true;
  }
  const definition = types.get(job.type);
  if (!definition) {
    // Dead-lettered rather than dropped: a person can retry it on a worker
    // that knows the type.
    job.status = "dead";
    job.error = "unknown_job_type";
    await save(job, DEAD_TTL_SECONDS);
    await redis.multi().lRem(KEY.running, 1, id).rPush(KEY.dead, id).exec();
    logger.error({ job: { id, type: job.type } }, "job dead-lettered: unknown type");
    return true;
  }

  job.status = "running";
  job.attempts += 1;
  await save(job);
  const log = logger.child({ job: { id: job.id, type: job.type, attempt: job.attempts, requestId: job.requestId } });

  try {
    job.maxAttempts = definition.maxAttempts;
    job.result = (await definition.handler(job.payload, { job, signal })) ?? null;
    job.status = "done";
    job.error = null;
    await save(job, DONE_TTL_SECONDS);
    await clearDedupe(job);
    log.info("job done");
  } catch (error) {
    job.error = error instanceof HttpError ? error.code : "internal_error";

    if (job.attempts < job.maxAttempts) {
      job.status = "failed";
      await save(job);
      await redis.zAdd(KEY.delayed, { score: Date.now() + retryDelayMs(job.attempts), value: job.id });
      log.warn({ err: error }, "job failed; will retry");
    } else {
      job.status = "dead";
      await save(job, DEAD_TTL_SECONDS);
      await redis.rPush(KEY.dead, job.id);
      await clearDedupe(job);
      log.error({ err: error }, "job dead-lettered");
    }
  } finally {
    await redis.lRem(KEY.running, 1, job.id);
  }
  return true;
}

/** Runs ready and due jobs until none are left. For tests and `ai:jobs drain`. */
export async function drainJobs(limit = 1_000): Promise<number> {
  let ran = 0;
  while (ran < limit && (await runNextJob())) ran += 1;
  return ran;
}

let worker: { controller: AbortController; done: Promise<void> } | null = null;

/**
 * Starts the in-process worker. First puts back anything a previous process
 * was running when it stopped -- with one worker, a job still listed as
 * running at start-up is a job nobody is running.
 */
export async function startWorker(options: { pollMs?: number } = {}): Promise<void> {
  if (worker) return;
  await connectRedis();

  for (;;) {
    const orphan = await redis.lMove(KEY.running, KEY.ready, "LEFT", "RIGHT");
    if (!orphan) break;
    logger.warn({ job: { id: orphan } }, "job recovered from a previous worker");
  }

  const controller = new AbortController();
  const pollMs = options.pollMs ?? 1_000;

  const loop = async () => {
    while (!controller.signal.aborted) {
      try {
        const ran = await runNextJob(controller.signal);
        if (!ran) await new Promise((resolve) => setTimeout(resolve, pollMs));
      } catch (error) {
        // Redis away, most likely. Wait and try again rather than die.
        logger.error({ err: error }, "job worker error");
        await new Promise((resolve) => setTimeout(resolve, pollMs * 5));
      }
    }
  };

  worker = { controller, done: loop() };
  logger.info("job worker started");
}

/** Stops taking new jobs and waits for the current one to finish. */
export async function stopWorker(): Promise<void> {
  if (!worker) return;
  worker.controller.abort();
  await worker.done;
  worker = null;
}

/* Operations ------------------------------------------------------------- */

export interface QueueCounts {
  ready: number;
  delayed: number;
  running: number;
  dead: number;
}

export async function queueCounts(): Promise<QueueCounts> {
  await connectRedis();
  const [ready, delayed, running, dead] = await Promise.all([
    redis.lLen(KEY.ready),
    redis.zCard(KEY.delayed),
    redis.lLen(KEY.running),
    redis.lLen(KEY.dead),
  ]);
  return { ready, delayed, running, dead };
}

/** The dead-letter list, newest last, for a person to inspect. */
export async function deadJobs(limit = 50): Promise<Job[]> {
  await connectRedis();
  const ids = await redis.lRange(KEY.dead, -limit, -1);
  const jobs = await Promise.all(ids.map((id) => getJob(id)));
  return jobs.filter((job): job is Job => job !== null);
}

/** Gives a dead job a fresh set of attempts. False if it was not dead. */
export async function retryDeadJob(id: string): Promise<boolean> {
  await connectRedis();
  if ((await redis.lRem(KEY.dead, 1, id)) === 0) return false;
  const job = await getJob(id);
  if (!job) return false;
  job.status = "queued";
  job.attempts = 0;
  job.error = null;
  await save(job);
  await redis.rPush(KEY.ready, id);
  return true;
}

/** Drops every dead job. Returns how many. */
export async function purgeDeadJobs(): Promise<number> {
  await connectRedis();
  const ids = await redis.lRange(KEY.dead, 0, -1);
  for (const id of ids) await redis.del(KEY.job(id));
  await redis.del(KEY.dead);
  return ids.length;
}
