/**
 * AI configuration, read from the environment.
 *
 * Deliberately *not* validated at import time the way `lib/jwt.ts` validates
 * its secrets. The app has to boot and serve every non-AI route on a machine
 * with no model server and no API key -- that is the normal state of this repo
 * for anyone who has not set AI up -- so a missing configuration is a 503 from
 * the AI routes, not a failure to start.
 *
 * Read through `loadAiConfig()` rather than touching `process.env` elsewhere:
 * tests set the variables per case, so nothing may capture them at module
 * scope.
 */

/**
 * `openai` means "anything speaking the OpenAI chat-completions wire format" —
 * Groq, OpenRouter, Together, vLLM — selected by `AI_BASE_URL`, not by vendor.
 * It is the only one that can serve a deployment with no model server of its
 * own; see `openai-compatible.ts`.
 */
export const AI_PROVIDERS = ["ollama", "openai", "anthropic"] as const;

export type AiProviderName = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  provider: AiProviderName;
  /** Base URL of the model server. Only meaningful for self-hosted providers. */
  baseUrl: string;
  /** Absent for `ollama`, which needs no credential. */
  apiKey: string | undefined;
  /** Only sent when set; see `readEffort`. */
  reasoningEffort: "low" | "medium" | "high" | undefined;
  model: string;
  /** Cheaper/faster model for bulk work: extraction, classification, titles. */
  fastModel: string;
  maxTokens: number;
  /**
   * Generous by hosted-API standards because the default provider runs on the
   * CPU of whatever machine this is: a 7B model writing a few hundred words
   * takes tens of seconds, and a 10s timeout would make every interesting call
   * look like a failure.
   */
  timeoutMs: number;
  /** Attempts *after* the first, for transient failures only. */
  maxRetries: number;
  /**
   * Whether a structured call sends its JSON schema to the provider.
   *
   * On by default, because a constrained reply is worth far more than a
   * well-worded request for one. Off is the escape hatch for a provider that
   * rejects `response_format` outright: the prompts still ask for JSON and zod
   * still validates, so the feature degrades rather than breaking, and nobody
   * needs a deploy to find that out.
   */
  structuredOutput: boolean;
  /**
   * Per-user daily ceiling, checked before every model call made on a
   * person's behalf (`provider.ts`, `withPolicy`). 0 disables the check.
   */
  dailyTokenBudget: number;
  /**
   * A model per feature, from `AI_FEATURE_MODELS` (`bible.extract=<model>,
   * moderation=<model>`). Matched on the longest feature prefix, and only
   * when the caller did not name a model itself. Empty by default: a route
   * is moved to a cheaper model after `ai:eval` says it can be, never on a
   * guess.
   */
  featureModels: Record<string, string>;
  /** Whether usage is written to `ai.UsageEvent` as well as logged. */
  usagePersist: boolean;
  /** USD per million tokens, for the spend view. Null when not configured. */
  pricing: { inputPerMTok: number; outputPerMTok: number } | null;
  /** How long a deterministic-enough result is reused; 0 turns the cache off. */
  resultCacheSeconds: number;
  /**
   * Whether saving a chapter schedules a continuity check (Task AI 14).
   *
   * An operator switch rather than a per-story setting: a story opts in by
   * having a bible at all (see `continuity.ts`), and this is the way to stop
   * every background check on a server without a deploy.
   */
  continuityChecks: boolean;
  /**
   * How long a chapter must go unsaved before it is checked.
   *
   * The editor autosaves a second and a half after typing stops, so a check
   * per save would be a model call per pause. A minute of quiet is "the author
   * has stopped working on this paragraph", which is the moment a warning is
   * worth reading rather than an interruption.
   */
  continuityQuietMs: number;
  /**
   * The confidence below which a reported contradiction is never shown.
   *
   * High on purpose. The cost of a missed contradiction is one the author
   * would probably have caught on a read-through; the cost of a wrong one is
   * an author who stops reading the warnings. Re-tune against a stronger
   * model rather than lowering it to make a weak one look useful.
   */
  continuityMinConfidence: number;
}

/** Defaults describe the free local stack, because that is the default path. */
const DEFAULTS = {
  provider: "ollama" as AiProviderName,
  baseUrl: "http://localhost:11434",
  model: "llama3.2:3b",
  fastModel: "llama3.2:3b",
  maxTokens: 1024,
  timeoutMs: 120_000,
  maxRetries: 1,
  structuredOutput: true,
  dailyTokenBudget: 200_000,
  resultCacheSeconds: 60 * 60 * 24,
  continuityChecks: true,
  continuityQuietMs: 60_000,
  continuityMinConfidence: 0.8,
};

/**
 * How much a reasoning model may think before answering.
 *
 * Unset for providers that do not take the parameter -- a server that has
 * never seen it rejects the whole request. It matters for the models that do:
 * `gpt-oss-120b` spent 196 of a 200-token budget reasoning and returned an
 * empty completion, which surfaced as "the assistant's reply could not be
 * understood". Nothing here wants deliberation; it wants a JSON object.
 */
function readEffort(): "low" | "medium" | "high" | undefined {
  const raw = process.env["AI_REASONING_EFFORT"]?.trim().toLowerCase();
  return raw === "low" || raw === "medium" || raw === "high" ? raw : undefined;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  // A typo in an env var must not silently become NaN and then a broken
  // request body; fall back and let the default stand.
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

/** Opt *out* only: anything but an explicit denial leaves the default on. */
function readFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return !(raw === "off" || raw === "false" || raw === "0" || raw === "no");
}

function readProvider(): AiProviderName {
  const raw = process.env["AI_PROVIDER"]?.trim().toLowerCase();
  return AI_PROVIDERS.find((name) => name === raw) ?? DEFAULTS.provider;
}

/** `feature=model,feature=model`, tolerant of spaces; malformed pairs are dropped. */
function readFeatureModels(): Record<string, string> {
  const entries = (process.env["AI_FEATURE_MODELS"] ?? "")
    .split(",")
    .map((pair) => pair.split("=").map((part) => part.trim()))
    .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== "" && pair[1] !== "");
  return Object.fromEntries(entries);
}

/** Both prices or neither: a cost computed from one is a wrong number. */
function readPricing(): AiConfig["pricing"] {
  const input = Number(process.env["AI_INPUT_USD_PER_MTOK"]);
  const output = Number(process.env["AI_OUTPUT_USD_PER_MTOK"]);
  const set = (name: string) => (process.env[name]?.trim() ?? "") !== "";
  if (!set("AI_INPUT_USD_PER_MTOK") || !set("AI_OUTPUT_USD_PER_MTOK")) return null;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  return { inputPerMTok: input, outputPerMTok: output };
}

export function loadAiConfig(): AiConfig {
  const provider = readProvider();
  const model = process.env["AI_MODEL"]?.trim() || DEFAULTS.model;

  return {
    provider,
    baseUrl: (process.env["AI_BASE_URL"]?.trim() || DEFAULTS.baseUrl).replace(
      /\/$/,
      "",
    ),
    apiKey: process.env["AI_API_KEY"]?.trim() || undefined,
    reasoningEffort: readEffort(),
    model,
    // Falls back to the main model rather than to a hardcoded name: a
    // single-model setup should not silently call something that is not pulled.
    fastModel: process.env["AI_FAST_MODEL"]?.trim() || model,
    maxTokens: readInt("AI_MAX_TOKENS", DEFAULTS.maxTokens),
    timeoutMs: readInt("AI_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxRetries: readInt("AI_MAX_RETRIES", DEFAULTS.maxRetries),
    structuredOutput: readFlag(
      "AI_STRUCTURED_OUTPUT",
      DEFAULTS.structuredOutput,
    ),
    dailyTokenBudget: readInt(
      "AI_DAILY_TOKEN_BUDGET",
      DEFAULTS.dailyTokenBudget,
    ),
    featureModels: readFeatureModels(),
    usagePersist: readFlag("AI_USAGE_PERSIST", true),
    pricing: readPricing(),
    resultCacheSeconds: readInt("AI_RESULT_CACHE_SECONDS", DEFAULTS.resultCacheSeconds),
    continuityChecks: readFlag("AI_CONTINUITY", DEFAULTS.continuityChecks),
    continuityQuietMs: readInt(
      "AI_CONTINUITY_QUIET_MS",
      DEFAULTS.continuityQuietMs,
    ),
    continuityMinConfidence: readFraction(
      "AI_CONTINUITY_MIN_CONFIDENCE",
      DEFAULTS.continuityMinConfidence,
    ),
  };
}

/**
 * Whether the configuration is complete enough to attempt a call.
 *
 * "Configured" is not "working": a local server can be configured and not
 * running, which is a 503 discovered at call time. This only reports whether a
 * credential the provider requires is missing, which is a 503 we can report
 * without a round trip.
 */
/**
 * A description of the AI setup safe to serve publicly, for `/health`.
 *
 * Carries no key and no URL -- only which provider is selected, which model,
 * and whether a required credential is present. That is enough to tell the
 * three failures apart from outside the box, which otherwise all surface as
 * the same 503: a deployment still defaulting to `ollama` because
 * `AI_PROVIDER` was never set, a hosted provider with no key, and a provider
 * that is configured but unreachable.
 */
export function describeAiConfig(config: AiConfig = loadAiConfig()): {
  provider: AiProviderName;
  model: string;
  /** Host only -- enough to see what is being called, without a path or key. */
  endpoint: string;
  configured: boolean;
} {
  let endpoint: string;
  try {
    endpoint = new URL(config.baseUrl).host;
  } catch {
    endpoint = "invalid";
  }

  return {
    provider: config.provider,
    model: config.model,
    endpoint,
    configured: isAiConfigured(config),
  };
}

export function isAiConfigured(config: AiConfig = loadAiConfig()): boolean {
  // Hosted providers need a credential, and a missing one is a 503 we can
  // report without spending a round trip to learn it.
  if (config.provider === "anthropic" || config.provider === "openai") {
    return config.apiKey !== undefined && config.baseUrl.length > 0;
  }
  // Self-hosted: no credential, and the base URL always has a default.
  return config.baseUrl.length > 0;
}

/* Embeddings ------------------------------------------------------------- */

/**
 * Embeddings are configured **separately from chat**, and that is the point.
 *
 * `AI_PROVIDER` selects who writes prose; this selects who turns a passage
 * into a vector, and there is no reason for them to be the same service. The
 * setup this repo is developed against is exactly the split case: chat goes to
 * a hosted OpenAI-compatible endpoint that serves no embedding model at all,
 * while embeddings go to the Ollama container on this machine. Folding the two
 * into one provider would have made retrieval impossible to run here without
 * paying somebody.
 *
 * So the defaults below describe the local embedder regardless of what the
 * chat provider is set to, and a deployment that wants both from one service
 * sets `AI_EMBED_*` to match.
 */
export interface AiEmbedConfig {
  provider: AiProviderName;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /**
   * The width of the vectors this model returns.
   *
   * **This number is in the database.** The chunk column is `vector(N)`, so
   * changing the model to one of a different width is a migration plus a
   * re-embedding of the entire corpus -- not a config edit. It is kept here
   * rather than discovered at runtime so that a mismatch is caught on the
   * first reply (see `embeddings.ts`) instead of becoming a column-width error
   * halfway through a backfill.
   */
  dimensions: number;
  /**
   * How many passages go in one request.
   *
   * Both provider APIs take an array. Batching matters more locally than
   * hosted: each request to Ollama re-enters the model, so sixteen texts in
   * one call is markedly faster than sixteen calls, and small enough that a
   * failure costs little to retry.
   */
  batchSize: number;
  timeoutMs: number;
  maxRetries: number;
  /**
   * The cosine similarity below which a passage is not a search result.
   *
   * Nearest-neighbour search always returns neighbours: ask the index for
   * "chocolate cake recipe" and it hands back the closest chapters of a time
   * travel novel, ranked as confidently as a real match. Without a floor,
   * hybrid search would include the whole embedded corpus on every query.
   *
   * **This number belongs to the model, not to the feature**, which is why it
   * lives beside `model`. Measured on this corpus with `nomic-embed-text`:
   * on-topic queries scored 0.55-0.67 against their best passage, off-topic
   * ones 0.42-0.45 against theirs. 0.5 sits in the gap. A different model has a
   * different distribution and needs its own measurement -- see
   * `docs/ai-architecture.md`.
   */
  searchMinSimilarity: number;
  /**
   * The floor for a story-bible fact to count as near a passage.
   *
   * Separate from `searchMinSimilarity` because the comparison is different:
   * a one-line fact against a paragraph of prose, not a query against a
   * passage, and a short text scores lower against a long one for the same
   * relevance. Lower stakes too -- the similar list only supplements the facts
   * a passage names, inside a fixed budget -- so the floor is set to admit
   * rather than to exclude. Measured as for search; see `docs/ai-architecture.md`.
   */
  bibleMinSimilarity: number;
  /**
   * The band a story-to-story similarity is scored across, for
   * recommendations: nothing at or below `recommendMinSimilarity`, full marks
   * at `recommendFullSimilarity`, linear between.
   *
   * A third pair of numbers because this is a third comparison: a whole story
   * against a whole story, each the average of its passages' vectors. Averaging
   * pulls every story towards the middle of the space, so two novels with
   * nothing in common still score far above anything search would call a
   * match, and the useful range is narrow and high.
   *
   * Measured with `nomic-embed-text`, and thinly: the dev corpus has one
   * embedded story, so it was compared against six short passages written for
   * the purpose, one per genre. Fiction against unrelated fiction scored
   * 0.64-0.71 whatever the genres; the one real thematic match (a time-loop
   * passage against a time-travel novel) 0.78; two halves of the same novel
   * 0.94 and up. Run through the real chunker and the endpoint, that match
   * came out at 0.73 and five unrelated stories at or under 0.70. So 0.70 is
   * the top of "it is also fiction" and 0.85 is close enough that more
   * closeness should not buy more rank. Re-measure both once
   * there are a dozen embedded stories to measure between.
   */
  recommendMinSimilarity: number;
  recommendFullSimilarity: number;
}

const EMBED_DEFAULTS = {
  provider: "ollama" as AiProviderName,
  baseUrl: "http://localhost:11434",
  /** 768 dimensions, 137M parameters, fast on CPU. See `AI-BACKLOG.md`. */
  model: "nomic-embed-text",
  dimensions: 768,
  batchSize: 16,
  searchMinSimilarity: 0.5,
  bibleMinSimilarity: 0.45,
  recommendMinSimilarity: 0.7,
  recommendFullSimilarity: 0.85,
};

/** `readInt`'s rule for a fraction: a typo falls back rather than becoming NaN. */
function readFraction(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= -1 && parsed <= 1
    ? parsed
    : fallback;
}

function readEmbedProvider(): AiProviderName {
  const raw = process.env["AI_EMBED_PROVIDER"]?.trim().toLowerCase();
  return AI_PROVIDERS.find((name) => name === raw) ?? EMBED_DEFAULTS.provider;
}

export function loadAiEmbedConfig(): AiEmbedConfig {
  const chat = loadAiConfig();

  return {
    provider: readEmbedProvider(),
    baseUrl: (
      process.env["AI_EMBED_BASE_URL"]?.trim() || EMBED_DEFAULTS.baseUrl
    ).replace(/\/$/, ""),
    // Falls back to the chat key so that a deployment serving both from one
    // hosted provider needs one credential, not two spellings of it.
    apiKey: process.env["AI_EMBED_API_KEY"]?.trim() || chat.apiKey,
    model: process.env["AI_EMBED_MODEL"]?.trim() || EMBED_DEFAULTS.model,
    dimensions: readInt("AI_EMBED_DIMENSIONS", EMBED_DEFAULTS.dimensions),
    batchSize: Math.max(
      1,
      readInt("AI_EMBED_BATCH_SIZE", EMBED_DEFAULTS.batchSize),
    ),
    // Shared with chat: a timeout and a retry count describe this machine, not
    // this feature, and a second pair of knobs would only ever be set wrong.
    timeoutMs: chat.timeoutMs,
    maxRetries: chat.maxRetries,
    searchMinSimilarity: readFraction(
      "AI_SEARCH_MIN_SIMILARITY",
      EMBED_DEFAULTS.searchMinSimilarity,
    ),
    bibleMinSimilarity: readFraction(
      "AI_BIBLE_MIN_SIMILARITY",
      EMBED_DEFAULTS.bibleMinSimilarity,
    ),
    recommendMinSimilarity: readFraction(
      "AI_RECOMMEND_MIN_SIMILARITY",
      EMBED_DEFAULTS.recommendMinSimilarity,
    ),
    recommendFullSimilarity: readFraction(
      "AI_RECOMMEND_FULL_SIMILARITY",
      EMBED_DEFAULTS.recommendFullSimilarity,
    ),
  };
}

/** Same rule as `isAiConfigured`: only a missing credential is knowable here. */
export function isAiEmbedConfigured(
  config: AiEmbedConfig = loadAiEmbedConfig(),
): boolean {
  if (config.provider === "anthropic" || config.provider === "openai") {
    return config.apiKey !== undefined && config.baseUrl.length > 0;
  }
  return config.baseUrl.length > 0;
}

/* Moderation -------------------------------------------------------------- */

/**
 * The automated content check (Task AI 12).
 *
 * The two thresholds are the whole policy a deployment can tune without a
 * code change, which is why they are here and not beside the comparison they
 * feed: moving one is a judgement about how many wrong calls a queue of
 * humans can absorb, and that differs per community and per model.
 *
 * - At or above `reviewThreshold` a finding is filed for a person and the
 *   content stays up. Deliberately low: a false positive here costs a
 *   moderator ten seconds, a false negative costs somebody an abusive reply.
 * - At or above `rejectThreshold` the content is hidden at once *and* filed.
 *   Deliberately high: a false positive here silences somebody who did nothing
 *   wrong until a person undoes it.
 *
 * The defaults are starting points, not measurements -- nothing in the dev
 * corpus is abusive, so there was nothing to measure against. Task AI 16 is
 * where they get evidence.
 *
 * `model` lets this run on a smaller model than chat does. It is one call per
 * comment on every comment, which makes it the highest-volume feature here
 * and the first one worth right-sizing.
 */
export interface AiModerationConfig {
  enabled: boolean;
  reviewThreshold: number;
  rejectThreshold: number;
  /** Undefined means the chat model. */
  model: string | undefined;
}

const MODERATION_DEFAULTS = {
  enabled: true,
  reviewThreshold: 0.5,
  rejectThreshold: 0.9,
};

/** A confidence is 0 to 1; anything else falls back rather than being clamped. */
function readConfidence(name: string, fallback: number): number {
  const value = readFraction(name, fallback);
  return value >= 0 ? value : fallback;
}

export function loadAiModerationConfig(): AiModerationConfig {
  const review = readConfidence(
    "AI_MODERATION_REVIEW_THRESHOLD",
    MODERATION_DEFAULTS.reviewThreshold,
  );
  const reject = readConfidence(
    "AI_MODERATION_REJECT_THRESHOLD",
    MODERATION_DEFAULTS.rejectThreshold,
  );

  return {
    enabled: readFlag("AI_MODERATION", MODERATION_DEFAULTS.enabled),
    reviewThreshold: review,
    // A reject bar under the review bar would hide things nobody is asked to
    // look at. Whatever was configured, hiding is never the easier outcome.
    rejectThreshold: Math.max(reject, review),
    model: process.env["AI_MODERATION_MODEL"]?.trim() || undefined,
  };
}
