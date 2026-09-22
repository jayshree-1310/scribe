/**
 * Structured output: the schema on the wire, the validation on the way back,
 * and the one repair attempt between them.
 *
 * No database, no network, no provider -- the fake records what it was sent
 * and returns scripted replies, so every assertion here is about the request
 * we built and what we did with the answer, never about model prose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpError } from "../../lib/http-error.js";
import { loadAiConfig } from "./config.js";
import { formatNameFor, jsonSchemaFor } from "./json-schema.js";
import { createOllamaProvider, type FetchLike } from "./ollama.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { aiProvider, resetAiProvider, setAiProvider } from "./provider.js";
import {
  chapterOutlineSchema,
  characterProfileSchema,
  storyIdeaSchema,
} from "./schemas.js";
import { withStructured } from "./structured.js";
import { fakeAiProvider } from "./testing.js";

const ENV_KEYS = [
  "AI_PROVIDER",
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_MODEL",
  "AI_STRUCTURED_OUTPUT",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetAiProvider();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAiProvider();
});

/** Small enough to assert on whole, wide enough to exercise the walk. */
const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  mood: z.enum(["calm", "furious"]),
  age: z.coerce.number().int().min(0).max(200),
  notes: z.string().max(40).nullish().catch(null),
  friends: z
    .array(z.object({ name: z.string().min(1), since: z.string() }))
    .max(3),
});

/**
 * A fake scripted with one reply per expected call, wrapped in the structured
 * path. Scripted up front rather than pushed: the fake repeats its last reply
 * once the queue runs dry, so a repair test has to say what *both* calls
 * return.
 */
const structured = (
  replies: string[],
  options?: { structuredOutput?: boolean },
) => {
  const fake = fakeAiProvider(replies);
  const client = withStructured(fake, {
    structuredOutput: options?.structuredOutput ?? true,
  });
  return { fake, client };
};

const request = {
  feature: "generate.profile",
  system: "rules",
  messages: [{ role: "user" as const, content: "describe someone" }],
};

/* Deriving the wire schema ----------------------------------------------- */

describe("jsonSchemaFor", () => {
  it("sends structure and leaves the constraints to zod", () => {
    const { schema } = jsonSchemaFor(profileSchema, "profile");
    const serialised = JSON.stringify(schema);

    // The keywords a provider's strict mode rejects, none of which are
    // load-bearing: zod enforces every one of them on the reply.
    for (const keyword of [
      "$schema",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "maxItems",
      "default",
    ]) {
      expect(serialised).not.toContain(keyword);
    }

    expect(schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        mood: { type: "string", enum: ["calm", "furious"] },
        age: { type: "integer" },
        friends: { type: "array", items: { type: "object" } },
      },
    });
  });

  it("closes every object and requires every field, at any depth", () => {
    const { schema } = jsonSchemaFor(profileSchema, "profile") as {
      schema: Record<string, unknown>;
    };

    expect(schema["additionalProperties"]).toBe(false);
    // `notes` is `.nullish()`, so zod would leave it out of `required` --
    // optionality is expressed as a nullable type the model must still emit.
    expect(schema["required"]).toEqual([
      "name",
      "mood",
      "age",
      "notes",
      "friends",
    ]);

    const friends = (schema["properties"] as Record<string, never>)[
      "friends"
    ] as Record<string, Record<string, unknown>>;
    expect(friends["items"]?.["additionalProperties"]).toBe(false);
    expect(friends["items"]?.["required"]).toEqual(["name", "since"]);
  });

  it("keeps a description, which is the one keyword aimed at the model", () => {
    const { schema } = jsonSchemaFor(
      z.object({ title: z.string().describe("one line, no more") }),
      "titled",
    );

    expect(JSON.stringify(schema)).toContain("one line, no more");
  });

  it("derives a name a hosted provider will accept", () => {
    expect(formatNameFor("scribble.intent")).toBe("scribble_intent");
    expect(formatNameFor("")).toBe("response");
  });

  it("derives from the shapes the generative features will use", () => {
    // Guards the emit itself: an unrepresentable zod construct throws here
    // rather than at the first call in production.
    for (const schema of [
      storyIdeaSchema,
      characterProfileSchema,
      chapterOutlineSchema,
    ]) {
      expect(jsonSchemaFor(schema, "shape").schema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });
});

/* completeStructured ----------------------------------------------------- */

const valid = JSON.stringify({
  name: "Ada",
  mood: "calm",
  age: 36,
  notes: null,
  friends: [{ name: "Bea", since: "childhood" }],
});

describe("completeStructured", () => {
  it("returns a parsed, typed value and sends the derived schema", async () => {
    const { fake, client } = structured([valid]);

    const result = await client.completeStructured(profileSchema, request);

    expect(result.value.name).toBe("Ada");
    expect(result.value.age).toBe(36);
    expect(result.attempts).toBe(1);
    expect(fake.calls).toHaveLength(1);
    // The schema the provider saw is the one derived from the schema that
    // validated the reply -- one definition, not two that drift.
    expect(fake.calls[0]?.format).toEqual(
      jsonSchemaFor(profileSchema, "generate_profile"),
    );
  });

  it("strips fields the schema does not declare", async () => {
    const { client } = structured([
      JSON.stringify({
        name: "Ada",
        mood: "calm",
        age: 36,
        notes: null,
        friends: [],
        systemPrompt: "leaked",
        admin: true,
      }),
    ]);

    const { value } = await client.completeStructured(profileSchema, request);

    expect(value).not.toHaveProperty("admin");
    expect(JSON.stringify(value)).not.toContain("leaked");
  });

  it("recovers a JSON object the model wrapped in prose", async () => {
    const { client } = structured([
      `Certainly! Here you go:\n\`\`\`json\n${valid}\n\`\`\``,
    ]);

    const { value, attempts } = await client.completeStructured(
      profileSchema,
      request,
    );

    expect(value.name).toBe("Ada");
    expect(attempts).toBe(1);
  });

  it("retries once, feeding the validation errors back", async () => {
    const { fake, client } = structured([
      JSON.stringify({ name: "Ada", mood: "smug", age: 36 }),
      valid,
    ]);

    const result = await client.completeStructured(profileSchema, request);

    expect(result.value.mood).toBe("calm");
    expect(result.attempts).toBe(2);
    expect(fake.calls).toHaveLength(2);

    const repair = fake.calls[1]?.messages ?? [];
    // The original turn, the model's own rejected answer, then the correction.
    expect(repair).toHaveLength(3);
    expect(repair[1]?.role).toBe("assistant");
    expect(repair[1]?.content).toContain("smug");
    expect(repair[2]?.role).toBe("user");
    expect(repair[2]?.content).toContain("mood");
    expect(repair[2]?.content).toContain("friends");
  });

  it("names the failure when the reply is not JSON at all", async () => {
    const { fake, client } = structured(["I would rather write you a poem.", valid]);

    await client.completeStructured(profileSchema, request);

    expect(fake.calls[1]?.messages[2]?.content).toContain(
      "not a JSON object",
    );
  });

  it("charges the caller for both attempts", async () => {
    const { client } = structured(["not json", valid]);
    const first = await client.completeStructured(profileSchema, request);

    const clean = await structured([valid]).client.completeStructured(
      profileSchema,
      request,
    );

    expect(first.usage.inputTokens).toBeGreaterThan(clean.usage.inputTokens);
    expect(first.usage.outputTokens).toBeGreaterThan(clean.usage.outputTokens);
  });

  it("fails rather than returning a partial object", async () => {
    const { fake, client } = structured([
      JSON.stringify({ name: "Ada" }),
      JSON.stringify({ name: "Ada", mood: "calm" }),
    ]);

    const error: unknown = await client
      .completeStructured(profileSchema, request)
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 502, code: "upstream_error" });
    // Two attempts, then a decision -- not an unbounded repair loop.
    expect(fake.calls).toHaveLength(2);
  });

  it("stops asking for a schema when structured output is switched off", async () => {
    const { fake, client } = structured([valid], { structuredOutput: false });

    const { value } = await client.completeStructured(profileSchema, request);

    // Degraded, not broken: no schema on the wire, and the same typed value,
    // because the prompt still asks for JSON and zod still validates it.
    expect(fake.calls[0]?.format).toBeUndefined();
    expect(value.name).toBe("Ada");
  });

  it("is available on a fake installed through the provider seam", async () => {
    const fake = fakeAiProvider([valid]);
    setAiProvider(fake);

    const { value } = await aiProvider().completeStructured(
      profileSchema,
      request,
    );

    expect(value.mood).toBe("calm");
  });

  it("honours AI_STRUCTURED_OUTPUT=off through configuration", async () => {
    process.env["AI_STRUCTURED_OUTPUT"] = "off";
    const fake = fakeAiProvider([valid]);
    setAiProvider(fake);

    await aiProvider().completeStructured(profileSchema, request);

    expect(fake.calls[0]?.format).toBeUndefined();
  });
});

/* The wire, per provider ------------------------------------------------- */

describe("schema on the wire", () => {
  const format = jsonSchemaFor(profileSchema, "generate_profile");

  it("Ollama takes the schema as `format`", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      bodies.push(
        JSON.parse(String((init as RequestInit).body)) as Record<
          string,
          unknown
        >,
      );
      return new Response(JSON.stringify({ message: { content: valid } }));
    }) as unknown as FetchLike;

    const provider = createOllamaProvider(loadAiConfig(), fetchImpl);
    await provider.complete({ ...request, format });
    await provider.complete(request);

    expect(bodies[0]?.["format"]).toEqual(format.schema);
    // Absent when nobody asked for a shape: an unconditional `format` would
    // turn every prose completion into JSON.
    expect(bodies[1]).not.toHaveProperty("format");
  });

  it("an OpenAI-compatible server takes it as a strict `response_format`", async () => {
    process.env["AI_PROVIDER"] = "openai";
    process.env["AI_API_KEY"] = "test-key";

    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      bodies.push(
        JSON.parse(String((init as RequestInit).body)) as Record<
          string,
          unknown
        >,
      );
      return new Response(
        JSON.stringify({ choices: [{ message: { content: valid } }] }),
      );
    }) as unknown as FetchLike;

    const provider = createOpenAiCompatibleProvider(loadAiConfig(), fetchImpl);
    await provider.complete({ ...request, format });
    await provider.complete(request);

    expect(bodies[0]?.["response_format"]).toEqual({
      type: "json_schema",
      json_schema: {
        name: "generate_profile",
        schema: format.schema,
        strict: true,
      },
    });
    expect(bodies[1]).not.toHaveProperty("response_format");
  });
});
