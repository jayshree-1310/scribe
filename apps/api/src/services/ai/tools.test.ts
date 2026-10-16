/**
 * Tool calling below the agent: how each provider puts tools and tool turns
 * on the wire and reads tool calls back, and how a tool's zod schema becomes
 * the JSON schema the model is shown. No database and no network -- `fetch`
 * is injected, as in `openai-compatible.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { loadAiConfig, type AiConfig } from "./config.js";
import { createOllamaProvider, type FetchLike } from "./ollama.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { AGENT_TOOLS, toolDefinitions } from "./tools.js";
import type { AiRequest } from "./types.js";

const config = (provider: "openai" | "ollama"): AiConfig => ({
  ...loadAiConfig(),
  provider,
  baseUrl: "https://models.invalid/v1",
  apiKey: "test-key",
  model: "test-model",
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** A request mid-loop: one tool already called and answered. */
const request: AiRequest = {
  feature: "agent",
  system: "Rules.",
  tools: [
    {
      name: "get_story_summary",
      description: "Details of a story.",
      parameters: { type: "object", properties: { storyId: { type: "string" } } },
    },
  ],
  messages: [
    { role: "user", content: "Tell me about it." },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "get_story_summary", arguments: '{"storyId":"s1"}' }],
    },
    { role: "tool", toolCallId: "call_1", name: "get_story_summary", content: '{"title":"T"}' },
  ],
};

function capture(reply: unknown): { fetchImpl: FetchLike; sent: () => Record<string, unknown> } {
  let body: Record<string, unknown> = {};
  return {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json(reply);
    },
    sent: () => body,
  };
}

describe("OpenAI-compatible tool calling", () => {
  it("sends tools and tool turns in the chat-completions shape", async () => {
    const { fetchImpl, sent } = capture({ choices: [{ message: { content: "Answer." } }] });
    await createOpenAiCompatibleProvider(config("openai"), fetchImpl).complete(request);

    expect(sent()).toMatchObject({
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "get_story_summary" } }],
      messages: [
        { role: "system", content: "Rules." },
        { role: "user", content: "Tell me about it." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_story_summary", arguments: '{"storyId":"s1"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"title":"T"}' },
      ],
    });
  });

  it("reads tool calls back with the arguments left as the model's text", async () => {
    const { fetchImpl } = capture({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c9", type: "function", function: { name: "search_stories", arguments: '{"query":"grief"' } },
              { id: "c10", type: "function", function: {} },
            ],
          },
        },
      ],
    });

    const result = await createOpenAiCompatibleProvider(config("openai"), fetchImpl).complete(request);

    expect(result.text).toBe("");
    // Malformed JSON is passed through for the agent to refuse; a call with no
    // name is dropped because there is nothing it could run.
    expect(result.toolCalls).toEqual([{ id: "c9", name: "search_stories", arguments: '{"query":"grief"' }]);
  });

  it("forbids a call with tool_choice none, and sends no tools on a plain request", async () => {
    const first = capture({ choices: [{ message: { content: "ok" } }] });
    await createOpenAiCompatibleProvider(config("openai"), first.fetchImpl).complete({
      ...request,
      toolChoice: "none",
    });
    expect(first.sent()["tool_choice"]).toBe("none");

    const plain = capture({ choices: [{ message: { content: "ok" } }] });
    await createOpenAiCompatibleProvider(config("openai"), plain.fetchImpl).complete({
      feature: "chat",
      system: "Rules.",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(plain.sent()).not.toHaveProperty("tools");
    expect(plain.sent()).not.toHaveProperty("tool_choice");
  });
});

describe("Ollama tool calling", () => {
  it("sends tool turns in Ollama's shape: object arguments, results by name", async () => {
    const { fetchImpl, sent } = capture({ message: { content: "Answer." }, done: true });
    await createOllamaProvider(config("ollama"), fetchImpl).complete(request);

    expect(sent()).toMatchObject({
      tools: [{ type: "function", function: { name: "get_story_summary" } }],
      messages: [
        { role: "system" },
        { role: "user" },
        {
          role: "assistant",
          tool_calls: [{ function: { name: "get_story_summary", arguments: { storyId: "s1" } } }],
        },
        { role: "tool", tool_name: "get_story_summary", content: '{"title":"T"}' },
      ],
    });
  });

  it("re-serialises object arguments and makes up ids it was not sent", async () => {
    const { fetchImpl } = capture({
      message: {
        content: "",
        tool_calls: [{ function: { name: "search_stories", arguments: { query: "grief" } } }],
      },
      done: true,
    });

    const result = await createOllamaProvider(config("ollama"), fetchImpl).complete(request);
    expect(result.toolCalls).toEqual([
      { id: "call_0", name: "search_stories", arguments: '{"query":"grief"}' },
    ]);
  });

  it("expresses tool_choice none by offering no tools", async () => {
    const { fetchImpl, sent } = capture({ message: { content: "ok" }, done: true });
    await createOllamaProvider(config("ollama"), fetchImpl).complete({ ...request, toolChoice: "none" });
    expect(sent()).not.toHaveProperty("tools");
  });
});

describe("toolDefinitions", () => {
  it("derives a closed JSON schema for every tool from its zod schema", () => {
    const definitions = toolDefinitions();

    expect(definitions.map((tool) => tool.name)).toEqual(AGENT_TOOLS.map((tool) => tool.name));
    for (const definition of definitions) {
      expect(definition.name).toMatch(/^[a-z_]+$/);
      expect(definition.description.length).toBeGreaterThan(20);
      expect(definition.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }

    const search = definitions.find((tool) => tool.name === "search_chapters");
    expect(search?.parameters).toMatchObject({
      properties: { storyId: { type: "string" }, query: { type: "string" } },
      required: ["storyId", "query"],
    });
  });
});
