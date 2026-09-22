/**
 * Structured output: ask for a shape, get a typed value or an error.
 *
 * Three things happen here, and the order matters.
 *
 * 1. **Constrain.** The provider is handed a JSON schema derived from the zod
 *    schema, so the model is writing inside a grammar rather than being asked
 *    politely for JSON in a prompt.
 * 2. **Validate anyway.** A constrained reply is still model output crossing a
 *    trust boundary, and "constrained" means different things on different
 *    servers -- from a hard grammar to a hint the model may ignore. Nothing
 *    downstream may depend on which one answered.
 * 3. **Repair once, then fail.** A reply that fails validation is sent back
 *    with its own errors attached, which small models are surprisingly good at
 *    fixing. A second failure is an upstream error, never a partial object:
 *    half a story idea is not a smaller story idea, and a caller handed one
 *    would store it.
 *
 * Written once, over whichever `AiProvider` is configured, so an implementation
 * only ever implements `complete` and `stream`. That is also what lets the test
 * fake exercise the repair loop with no model anywhere.
 */

import type { ZodError, ZodType } from "zod";
import { HttpError } from "../../lib/http-error.js";
import { formatNameFor, jsonSchemaFor } from "./json-schema.js";
import type {
  AiClient,
  AiProvider,
  AiRequest,
  AiStructuredCompletion,
  AiUsage,
} from "./types.js";

/** One repair attempt. Two failures is a prompt problem, not a dice roll. */
const MAX_ATTEMPTS = 2;

/**
 * How much of a rejected reply is quoted back to the model.
 *
 * A bounded echo: the failure mode being repaired is a model that wrote too
 * much, and feeding all of it back doubles the cost of the very call that has
 * already gone wrong.
 */
const ECHO_LIMIT = 2000;

/** The same sentence whatever went wrong -- a provider's own words never leave. */
const UNUSABLE = "The assistant's reply could not be understood.";

/**
 * Pulls the JSON object out of a reply that may have prose around it.
 *
 * Constrained output should make this unnecessary and often does not: a model
 * that is only *asked* for JSON wraps it in a markdown fence or a sentence of
 * introduction however firmly the prompt says not to. Taking the outermost
 * brace-delimited span recovers those cases without pretending to be a parser.
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw HttpError.upstream(UNUSABLE);

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw HttpError.upstream(UNUSABLE);
  }
}

/**
 * The errors as the model should see them: field paths and what was wrong with
 * each, capped so a reply that failed every field does not become a prompt
 * longer than the schema.
 */
function describeIssues(error: ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.join(".");
      return `- ${path === "" ? "(root)" : path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * The repair turn.
 *
 * Phrased as a correction of the assistant's own previous message rather than
 * as a fresh request, because the model has the context to fix what it wrote
 * and re-asking from scratch throws that away -- and often reproduces the same
 * mistake.
 */
function repairInstruction(problem: string): string {
  return [
    "That reply was not valid. The problems were:",
    problem,
    "",
    "Reply again with the corrected JSON object alone: no explanation, no markdown fence, no other text.",
  ].join("\n");
}

function sum(total: AiUsage | null, next: AiUsage): AiUsage {
  if (!total) return next;

  return {
    provider: next.provider,
    model: next.model,
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    durationMs: total.durationMs + next.durationMs,
  };
}

export interface StructuredOptions {
  /**
   * Whether to send the schema at all.
   *
   * An operator switch, not a feature flag: a provider that rejects
   * `response_format` outright would otherwise break every structured feature
   * with no way back except a deploy. Off, the prompt still asks for JSON and
   * zod still validates, which is exactly the behaviour that existed before
   * this file -- degraded, not broken. See `AI_STRUCTURED_OUTPUT`.
   */
  structuredOutput: boolean;
}

/**
 * Adds `completeStructured` to a provider.
 *
 * Applied *above* the retry and usage wrapper in `provider.ts`, so each
 * attempt is retried and logged on its own: two attempts are two usage records
 * and two entries in the fake's call list, which is what makes the cost of a
 * repair visible rather than folded into one.
 */
export function withStructured(
  inner: AiProvider,
  options: StructuredOptions,
): AiClient {
  return {
    name: inner.name,
    complete: (request) => inner.complete(request),
    stream: (request) => inner.stream(request),

    async completeStructured<T>(
      schema: ZodType<T>,
      request: AiRequest,
    ): Promise<AiStructuredCompletion<T>> {
      const format = options.structuredOutput
        ? jsonSchemaFor(schema, formatNameFor(request.feature))
        : undefined;

      let messages = request.messages;
      let usage: AiUsage | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const completion = await inner.complete({
          ...request,
          messages,
          ...(format ? { format } : {}),
        });

        usage = sum(usage, completion.usage);

        let problem: string;
        try {
          const parsed = schema.safeParse(extractJson(completion.text));
          // Unknown keys are dropped rather than rejected: a model that adds a
          // helpful extra field has still answered the question, and zod's
          // stripping is what guarantees only declared fields reach a caller.
          if (parsed.success) {
            return { value: parsed.data, usage, attempts: attempt };
          }
          problem = describeIssues(parsed.error);
        } catch {
          // Nothing brace-delimited in there at all, or not parseable as JSON.
          problem = "- (root): the reply was not a JSON object.";
        }

        if (attempt === MAX_ATTEMPTS) break;

        messages = [
          ...messages,
          { role: "assistant", content: completion.text.slice(0, ECHO_LIMIT) },
          { role: "user", content: repairInstruction(problem) },
        ];
      }

      throw HttpError.upstream(UNUSABLE);
    },
  };
}
