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

export const AI_PROVIDERS = ["ollama", "anthropic"] as const;

export type AiProviderName = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  provider: AiProviderName;
  /** Base URL of the model server. Only meaningful for self-hosted providers. */
  baseUrl: string;
  /** Absent for `ollama`, which needs no credential. */
  apiKey: string | undefined;
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
  dailyTokenBudget: 200_000,
};

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  // A typo in an env var must not silently become NaN and then a broken
  // request body; fall back and let the default stand.
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
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
    model,
    // Falls back to the main model rather than to a hardcoded name: a
    // single-model setup should not silently call something that is not pulled.
    fastModel: process.env["AI_FAST_MODEL"]?.trim() || model,
    maxTokens: readInt("AI_MAX_TOKENS", DEFAULTS.maxTokens),
    timeoutMs: readInt("AI_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxRetries: readInt("AI_MAX_RETRIES", DEFAULTS.maxRetries),
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
export function isAiConfigured(config: AiConfig = loadAiConfig()): boolean {
  if (config.provider === "anthropic") return config.apiKey !== undefined;
  // Self-hosted: no credential, and the base URL always has a default.
  return config.baseUrl.length > 0;
}
