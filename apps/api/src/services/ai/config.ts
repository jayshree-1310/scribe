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
  /** Per-user daily ceiling, enforced by the routes. 0 disables the check. */
  dailyTokenBudget: number;
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
