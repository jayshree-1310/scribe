/**
 * Turns a zod schema into the JSON schema sent to a provider.
 *
 * **One definition, not two.** The schema that constrains the model and the
 * schema that validates its reply are the same object, derived here, because
 * two hand-written copies drift the first time a field is renamed -- and the
 * symptom of that drift is a model dutifully producing a shape the validator
 * then rejects, which looks like a model failure and is not.
 *
 * What comes out is deliberately smaller than what zod emits. Two reasons:
 *
 * - **Portability.** Every provider accepts a different subset of JSON Schema.
 *   `type`, `enum`, `properties`, `required`, `items` and `anyOf` are the
 *   common ground; `minLength`, `maximum`, `pattern`, `default` and friends are
 *   rejected outright by some hosted providers' strict mode. Sending structure
 *   and nothing else is what makes one derivation work across all of them.
 * - **Division of labour.** A wire schema's job is to tell the model what shape
 *   to write. Enforcement is zod's job, on the way back, where the reply is
 *   untrusted input like any request body. Dropping `maxLength: 200` from the
 *   wire costs nothing, because a 400-character reason is still caught -- by
 *   the only check that was ever load-bearing.
 */

import { z, type ZodType } from "zod";
import type { AiResponseFormat } from "./types.js";

/**
 * The keywords that survive the walk below. Everything else is a constraint
 * zod will apply itself, or metadata (`$schema`, `$id`) no provider needs.
 *
 * `description` stays: it is the one keyword that talks to the *model* rather
 * than to a validator, so `z.string().describe("one sentence")` reaches the
 * prompt without anyone writing the field out twice.
 */
const STRUCTURAL_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "anyOf",
  "description",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keeps the structural keywords, recursing into the three places a subschema
 * can hide, and closes every object.
 *
 * Objects come out `additionalProperties: false` with **every** property
 * required. That is the shape hosted providers demand in strict mode, and an
 * optional field is expressed the way those providers express it: as a
 * nullable type the model must still emit. It is also better prompting -- a
 * model told it may omit a field omits it, and a missing `completed` and a
 * deliberate `"completed": null` are not the same answer.
 */
function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune);
  if (!isPlainObject(node)) return node;

  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (!STRUCTURAL_KEYWORDS.has(key)) continue;

    if (key === "properties" && isPlainObject(value)) {
      output["properties"] = Object.fromEntries(
        Object.entries(value).map(([field, subschema]) => [
          field,
          prune(subschema),
        ]),
      );
      continue;
    }

    // `enum` and `required` are arrays of literals, not of subschemas, but
    // pruning a string is the identity, so they need no special case.
    output[key] = prune(value);
  }

  const properties = output["properties"];
  if (isPlainObject(properties)) {
    output["required"] = Object.keys(properties);
    output["additionalProperties"] = false;
  }

  return output;
}

/** Providers reject a format name with a dot or a space in it. */
export function formatNameFor(feature: string): string {
  const cleaned = feature.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
  return cleaned.length > 0 ? cleaned : "response";
}

/**
 * The wire schema for `schema`, named for the feature that asked for it.
 *
 * `io: "input"` is deliberate: the model writes what zod will *parse*, not what
 * zod produces. For a field with a default or a `.catch()` those differ, and
 * describing the output shape would ask the model for something the schema
 * does not accept.
 */
export function jsonSchemaFor(
  schema: ZodType,
  name: string,
): AiResponseFormat {
  const derived = z.toJSONSchema(schema, { io: "input" });

  return { name, schema: prune(derived) as Record<string, unknown> };
}
