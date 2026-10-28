/**
 * Ask This Book conversations end to end, against the real database, a fake
 * embedder that knows a few concepts, and a fake provider that answers by
 * feature -- a turn may summarise, rewrite and answer, and a reply queue would
 * test the call order rather than the behaviour.
 *
 * What is asserted is the context each call was given: what the rewrite saw,
 * what retrieval searched with, which earlier exchanges went back to the
 * answer, and that a long conversation's prompts stop growing. Never the
 * model's prose; see `services/ai/testing.ts`.
 */

/** See `ai.test.ts`: `lib/redis.ts` reads `REDIS_URL` at module scope. */
import "dotenv/config";

import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { HttpError } from "../lib/http-error.js";
import { connectRedis, redis } from "../lib/redis.js";
import { db } from "../prisma/db.js";
import {
  HISTORY_SLOTS,
  RECENT_EXCHANGES,
  FOLD_BATCH,
  FOLD_CHUNK,
} from "../services/ai/conversations.js";
import { embedChapter } from "../services/ai/embeddings.js";
import {
  ASK_BOOK_CONVERSATION_SYSTEM_PROMPT,
  ASK_BOOK_MARKERS,
} from "../services/ai/prompts/ask-book.js";
import {
  resetAiEmbedder,
  resetAiProvider,
  setAiEmbedder,
  setAiProvider,
} from "../services/ai/provider.js";
import {
  fakeAiEmbedder,
  fakeAiProvider,
  type FakeAiEmbedder,
  type FakeAiProvider,
} from "../services/ai/testing.js";
import type { AiRequest } from "../services/ai/types.js";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

const CONCEPTS = {
  beacon: ["lighthouse", "beacon", "lamp"],
  knock: ["knocked", "knock", "door"],
  murder: ["killer", "murdered", "culprit"],
};

function prose(sentence: string): string {
  return Array.from(
    { length: 6 },
    (_, index) =>
      `${sentence} It was the ${index + 1}th evening of the season, ` +
      "and the kitchen clock kept its own counsel on the wall above the sink. ".repeat(3),
  ).join("\n");
}

const LAMP = "Mira climbed the lighthouse stair and found the lamp cold.";
const KNOCK = "Someone knocked three times on the door below.";
const SPOILER = "In the end the keeper was the killer all along.";

let ownerId: string;
let strangerId: string;
let story: { id: string; slug: string };
let draft: { id: string; slug: string };
let embedder: FakeAiEmbedder;
let provider: FakeAiProvider;

/** Rewrites the fake returns, by latest question; anything else comes back unchanged. */
let rewrites: Record<string, string> = {};
/** Set to make the rewrite reply unusable, to exercise the fallback. */
let rewriteBroken = false;
let summaries = 0;

const LATEST = /<<<THE READER'S LATEST QUESTION>>>\n([\s\S]*?)\n<<<END LATEST QUESTION>>>/;

function respond(request: AiRequest): string | undefined {
  if (request.feature === "ask.conversation.rewrite") {
    if (rewriteBroken) return "I would rather not.";
    const latest = LATEST.exec(String(request.messages[0]?.content))?.[1] ?? "";
    return JSON.stringify({ question: rewrites[latest] ?? latest });
  }
  if (request.feature === "ask.conversation.summary") {
    summaries += 1;
    return `Summary ${summaries}: the reader asked about the lamp, the knock and the killer.`;
  }
  return undefined;
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  embedder = fakeAiEmbedder(768, { model: "fake-conv", concepts: CONCEPTS });
  setAiEmbedder(embedder);

  ownerId = await api.createUser("cvo");
  strangerId = await api.createUser("cvs");

  story = await api.createStory({ title: "The Lamp Room", authorId: strangerId });
  for (const [number, sentence] of [LAMP, KNOCK, SPOILER].entries()) {
    const id = await api.createChapter({
      storyId: story.id,
      number: number + 1,
      title: `Part ${number + 1}`,
      content: prose(sentence),
    });
    await embedChapter({ id, storyId: story.id, content: prose(sentence) });
  }

  draft = await api.createStory({ title: "Not Yet", authorId: strangerId, listed: false });
});

afterAll(async () => {
  if (!available) return;
  resetAiEmbedder();
  resetAiProvider();
  await api.stop();
});

beforeEach(async () => {
  if (!available) return;
  setAiEmbedder(embedder);
  embedder.reset();
  rewrites = {};
  rewriteBroken = false;
  summaries = 0;
  provider = fakeAiProvider(["It is in the passage [1]."], { respond });
  setAiProvider(provider);

  await connectRedis();
  for (const id of [ownerId, strangerId]) {
    await redis.del(`ai:ask:${id}`);
    await redis.del(`ai:tokens:${id}`);
    await redis.del(`ai:conversation:create:${id}`);
  }
});

afterEach(() => {
  resetAiProvider();
});

/* Helpers ---------------------------------------------------------------- */

async function start(as = ownerId, storyId = story.id): Promise<string> {
  const response = await api.request<{ id: string }>("/api/ai/conversations", {
    method: "POST",
    as,
    body: { storyId },
  });
  expect(response.status).toBe(201);
  return response.body.id;
}

interface SseResult {
  status: number;
  events: Record<string, any>[];
}

async function say(
  conversationId: string,
  content: string,
  as = ownerId,
  upToChapter: number | null = 3,
  replaceFrom: string | null = null,
): Promise<SseResult> {
  const response = await fetch(
    `${api.baseUrl}/api/ai/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-scribe-user-id": as },
      body: JSON.stringify({ content, upToChapter, replaceFrom }),
    },
  );
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    await response.text();
    return { status: response.status, events: [] };
  }
  const events = (await response.text())
    .split("\n\n")
    .map((frame) => frame.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((json) => JSON.parse(json) as Record<string, any>);
  return { status: response.status, events };
}

/**
 * Drops these texts' cached query vectors, so a test asserting on what the
 * embedder was sent sees a call rather than a cache hit left by a previous
 * run. The key is `embedQuery`'s own: model, width and text.
 */
async function forgetQueries(...texts: string[]): Promise<void> {
  for (const text of texts) {
    await redis.del(
      "ai:search:query:" +
        createHash("sha256")
          .update(`${embedder.model}\u0000${embedder.dimensions}\u0000${text}`)
          .digest("hex"),
    );
  }
}

const done = (result: SseResult) => result.events.find((event) => event.type === "done");

/** Asks `content` in place of the question `replaceFrom`, and what followed it. */
const sayAgain = (conversationId: string, content: string, replaceFrom: string) =>
  say(conversationId, content, ownerId, 3, replaceFrom);

async function messagesOf(conversationId: string): Promise<{ id: string; ordinal: number; role: string; content: string }[]> {
  const view = await api.request<any>(`/api/ai/conversations/${conversationId}`, { as: ownerId });
  expect(view.status).toBe(200);
  return view.body.messages;
}

async function memoryOf(conversationId: string) {
  return db.orm.ai.Conversation.select("title", "summary", "summarizedThrough")
    .where((conversation) => conversation.id.eq(conversationId))
    .first();
}

/** Calls of one feature, in order. */
const callsOf = (feature: string) =>
  provider.calls.filter((call) => call.feature === feature);

const textOf = (call: { messages: AiRequest["messages"] } | undefined) =>
  String(call?.messages[0]?.content ?? "");

/** The earlier exchanges an answer prompt was given, as one block. */
function historyBlock(message: string): string {
  const open = message.indexOf(ASK_BOOK_MARKERS.historyOpen);
  const close = message.indexOf(ASK_BOOK_MARKERS.historyClose);
  return open === -1 ? "" : message.slice(open, close);
}

const countReaders = (block: string) => block.split("Reader: ").length - 1;

/* Tests ------------------------------------------------------------------ */

describe.skipIf(!available)("/api/ai/conversations", () => {
  it("requires a signed-in caller", async () => {
    const response = await api.request("/api/ai/conversations", {
      method: "POST",
      body: { storyId: story.id },
    });
    expect(response.status).toBe(401);
  });

  it("will not start a conversation about a story the caller cannot see", async () => {
    const response = await api.request("/api/ai/conversations", {
      method: "POST",
      as: ownerId,
      body: { storyId: draft.id },
    });
    expect(response.status).toBe(404);
  });

  it("answers a first turn without rewriting it, and stores both halves", async () => {
    const id = await start();
    await forgetQueries("Who knocked on the door?");

    const turn = await say(id, "Who knocked on the door?");
    expect(turn.status).toBe(200);
    expect(done(turn)).toMatchObject({ standaloneQuestion: null, answerable: true });

    // Nothing to resolve on a first turn: one call, the answer.
    expect(provider.calls.map((call) => call.feature)).toEqual(["ask.conversation"]);
    expect(embedder.calls[0]?.texts).toEqual(["Who knocked on the door?"]);
    expect(provider.calls[0]?.system).toBe(ASK_BOOK_CONVERSATION_SYSTEM_PROMPT);

    const view = await api.request<any>(`/api/ai/conversations/${id}`, { as: ownerId });
    expect(view.status).toBe(200);
    expect(view.body.title).toBe("Who knocked on the door?");
    expect(view.body.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(view.body.messages[1].content).toBe("It is in the passage [1].");
    expect(view.body.messages[1].scope).toEqual({ upToChapter: 3, basis: "request" });
  });

  it("resolves a follow-up through query rewriting before retrieving", async () => {
    const id = await start();
    await say(id, "Who knocked on the door?");

    rewrites["What happened after that?"] =
      "What happened after someone knocked on the door?";
    provider.reset();
    embedder.reset();
    await forgetQueries("What happened after someone knocked on the door?");

    const turn = await say(id, "What happened after that?");

    // The rewrite saw the previous exchange, and the follow-up.
    const rewrite = callsOf("ask.conversation.rewrite")[0];
    expect(textOf(rewrite)).toContain("Reader: Who knocked on the door?");
    expect(textOf(rewrite)).toContain("What happened after that?");

    // Retrieval searched with the rewrite, not with the reader's words --
    // which on their own mean nothing and would retrieve nothing.
    expect(embedder.calls[0]?.texts).toEqual([
      "What happened after someone knocked on the door?",
    ]);
    expect(done(turn)?.standaloneQuestion).toBe(
      "What happened after someone knocked on the door?",
    );

    // The answer was asked the reader's question, with the rewrite beside it.
    const answer = textOf(callsOf("ask.conversation")[0]);
    expect(answer).toContain("What happened after that?");
    expect(answer).toContain("(In the context of the conversation: What happened after someone knocked on the door?)");
    expect(answer).toContain(KNOCK);

    const view = await api.request<any>(`/api/ai/conversations/${id}`, { as: ownerId });
    expect(view.body.messages[2].standaloneQuestion).toBe(
      "What happened after someone knocked on the door?",
    );
  });

  it("does not rewrite a follow-up that already stands on its own", async () => {
    const id = await start();
    await say(id, "Who knocked on the door?");
    provider.reset();

    const turn = await say(id, "Where did Mira find the lamp?");

    expect(callsOf("ask.conversation.rewrite")).toHaveLength(0);
    expect(done(turn)?.standaloneQuestion).toBeNull();
  });

  it("searches with the reader's own words when the rewrite is unusable", async () => {
    const id = await start();
    await say(id, "Who knocked on the door?");

    rewriteBroken = true;
    embedder.reset();
    await forgetQueries("Was the door locked?");
    const turn = await say(id, "Was the door locked?");

    expect(turn.status).toBe(200);
    expect(done(turn)?.standaloneQuestion).toBeNull();
    expect(embedder.calls[0]?.texts).toEqual(["Was the door locked?"]);
  });

  it("keeps citations per message", async () => {
    const id = await start();
    await say(id, "Who knocked on the door?");
    await say(id, "What was the lamp like?");

    const view = await api.request<any>(`/api/ai/conversations/${id}`, { as: ownerId });
    const [, first, , second] = view.body.messages;

    expect(first.citations.map((c: any) => c.chapterNumber)).toEqual([2]);
    expect(first.citations[0].quote).toContain("knocked three times");
    expect(second.citations.map((c: any) => c.chapterNumber)).toEqual([1]);
    expect(second.citations[0].quote).toContain("lamp cold");
    // Questions carry none.
    expect(view.body.messages[0].citations).toEqual([]);
  });

  it("recalls earlier exchanges by relevance, not recency", async () => {
    const id = await start();
    await say(id, "What was the lamp like?"); // beacon
    await say(id, "Who knocked on the door?"); // knock
    await say(id, "Who was the killer?"); // murder -- the latest

    provider.reset();
    await say(id, "Tell me about the lamp again.");

    const history = historyBlock(textOf(callsOf("ask.conversation")[0]));
    // The latest, always; the older one about the lamp, because it is near.
    expect(history).toContain("Who was the killer?");
    expect(history).toContain("What was the lamp like?");
    // The one before last is more recent than the lamp question, and irrelevant.
    expect(history).not.toContain("Who knocked on the door?");
  });

  it("summarises a long conversation rather than letting it grow", async () => {
    const id = await start();
    const questions = [
      "What was the lamp like?",
      "Who knocked on the door?",
      "Who was the killer?",
      "Was the lamp ever lit?",
      "Did anyone answer the door?",
      "Why was he the killer?",
      "Where was the lighthouse?",
    ];

    const answerSizes: number[] = [];
    for (const [index, question] of questions.entries()) {
      provider.reset();
      const turn = await say(id, question);
      expect(turn.status).toBe(200);

      const answer = textOf(callsOf("ask.conversation")[0]);
      answerSizes.push(answer.length);
      // Bounded on every turn, however long the conversation is.
      expect(countReaders(historyBlock(answer))).toBeLessThanOrEqual(HISTORY_SLOTS);

      const rewrite = callsOf("ask.conversation.rewrite")[0];
      if (index > 0) {
        expect(countReaders(textOf(rewrite))).toBeLessThanOrEqual(
          RECENT_EXCHANGES + FOLD_BATCH - 1,
        );
      }
      // Turns 5 and 7 are the ones with a batch of old exchanges to fold.
      expect(callsOf("ask.conversation.summary")).toHaveLength(
        index === 4 || index === 6 ? 1 : 0,
      );
    }

    // The fold built on the previous summary rather than starting again.
    expect(summaries).toBe(2);

    const row = await db.orm.ai.Conversation.select("summary", "summarizedThrough")
      .where((conversation) => conversation.id.eq(id))
      .first();
    expect(row?.summary).toMatch(/^Summary 2:/);
    // Four exchanges folded: eight messages.
    expect(row?.summarizedThrough).toBe(8);

    // The summary goes back to the answer...
    expect(answerSizes.length).toBe(7);
    provider.reset();
    await say(id, "And the lamp?");
    const last = textOf(callsOf("ask.conversation")[0]);
    expect(last).toContain("Summary 2:");
    // ...and the prompt has stopped growing with the conversation.
    expect(last.length).toBeLessThan((answerSizes[3] ?? 0) * 1.5);
  });

  it("stores a declined turn without asking the model to answer", async () => {
    const id = await start();
    const turn = await say(id, "What colour was the bicycle?", ownerId, 2);

    expect(done(turn)?.answerable).toBe(false);
    expect(callsOf("ask.conversation")).toHaveLength(0);

    const view = await api.request<any>(`/api/ai/conversations/${id}`, { as: ownerId });
    expect(view.body.messages[1]).toMatchObject({ answerable: false, citations: [] });
  });

  it("answers a pleasantry as one, without searching, and keeps it out of memory", async () => {
    const id = await start();
    await say(id, "Who knocked on the door?");
    provider.reset();
    embedder.reset();

    const thanks = await say(id, "okay thanks");
    expect(thanks.events[0]?.text).toMatch(/^You're welcome/);
    expect(done(thanks)).toMatchObject({ answerable: false, scope: null, tokensUsed: 0 });
    // No model, no embedding: nothing was searched.
    expect(provider.calls).toHaveLength(0);
    expect(embedder.calls).toHaveLength(0);

    const view = await api.request<any>(`/api/ai/conversations/${id}`, { as: ownerId });
    expect(view.body.messages[3]).toMatchObject({ role: "assistant", scope: null });
    expect(view.body.messages[3].content).toMatch(/^You're welcome/);

    // The next follow-up resolves against the real exchange, not the thanks.
    await say(id, "What happened after that?");
    const rewrite = textOf(callsOf("ask.conversation.rewrite")[0]);
    expect(rewrite).toContain("Reader: Who knocked on the door?");
    expect(rewrite).not.toContain("okay thanks");
  });

  describe("privacy", () => {
    it("answers another reader's conversation with 404 on every route", async () => {
      const id = await start();
      await say(id, "Who knocked on the door?");
      provider.reset();

      const read = await api.request(`/api/ai/conversations/${id}`, { as: strangerId });
      expect(read.status).toBe(404);

      const turn = await say(id, "Who was the killer?", strangerId);
      expect(turn.status).toBe(404);
      expect(provider.calls).toHaveLength(0);

      const removed = await api.request(`/api/ai/conversations/${id}`, {
        method: "DELETE",
        as: strangerId,
      });
      expect(removed.status).toBe(404);

      // Still there for its owner.
      const mine = await api.request(`/api/ai/conversations/${id}`, { as: ownerId });
      expect(mine.status).toBe(200);
    });

    it("lists only the caller's own conversations about the story", async () => {
      const mine = await start(ownerId);
      const theirs = await start(strangerId);

      const list = await api.request<{ items: { id: string }[] }>(
        `/api/ai/conversations?storyId=${story.id}`,
        { as: ownerId },
      );
      const ids = list.body.items.map((item) => item.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
    });

    it("stops opening a conversation whose story was unlisted, but still deletes it", async () => {
      const hidden = await api.createStory({ title: "Withdrawn", authorId: strangerId });
      const id = await start(ownerId, hidden.id);

      await db.orm.content.Story.where((row) => row.id.eq(hidden.id)).update({
        listedAt: null,
      });

      const read = await api.request(`/api/ai/conversations/${id}`, { as: ownerId });
      expect(read.status).toBe(404);

      const removed = await api.request(`/api/ai/conversations/${id}`, {
        method: "DELETE",
        as: ownerId,
      });
      expect(removed.status).toBe(204);
    });
  });

  describe("asking again", () => {
    it("regenerates the last answer in place", async () => {
      const id = await start();
      await say(id, "What was the lamp like?");
      await say(id, "Who knocked on the door?");
      const [, , question] = await messagesOf(id);

      provider = fakeAiProvider(["A second reading of it [1]."], { respond });
      setAiProvider(provider);
      const again = await sayAgain(id, question!.content, question!.id);

      expect(again.status).toBe(200);
      const messages = await messagesOf(id);
      expect(messages.map((message) => [message.ordinal, message.role])).toEqual([
        [1, "user"],
        [2, "assistant"],
        [3, "user"],
        [4, "assistant"],
      ]);
      expect(messages[2]?.content).toBe("Who knocked on the door?");
      expect(messages[3]?.content).toContain("A second reading");
    });

    it("edits an earlier question, and drops everything that followed it", async () => {
      const id = await start();
      await say(id, "What was the lamp like?");
      await say(id, "Who knocked on the door?");
      await say(id, "Who was the killer?");
      const [first] = await messagesOf(id);

      await sayAgain(id, "Was the lamp ever lit?", first!.id);

      const messages = await messagesOf(id);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.content).toBe("Was the lamp ever lit?");
      // The opening question is the title, so editing it renames the conversation.
      expect((await memoryOf(id))?.title).toBe("Was the lamp ever lit?");
    });

    it("keeps the old turn when the new answer never completes", async () => {
      const id = await start();
      await say(id, "Who knocked on the door?");
      const before = await messagesOf(id);

      provider.failNext(HttpError.upstream("The model could not complete that request."));
      const failed = await sayAgain(id, "Who knocked on the door?", before[0]!.id);

      expect(failed.status).not.toBe(200);
      expect(await messagesOf(id)).toEqual(before);
    });

    it("rebuilds the summary from scratch when it covered a replaced turn", async () => {
      const id = await start();
      for (const question of [
        "What was the lamp like?",
        "Who knocked on the door?",
        "Who was the killer?",
        "Was the lamp ever lit?",
        "Did anyone answer the door?",
        "Why was he the killer?",
        "Where was the lighthouse?",
      ]) {
        await say(id, question);
      }
      expect((await memoryOf(id))?.summarizedThrough).toBe(8);
      const messages = await messagesOf(id);

      // The fourth question (ordinal 7) is inside the summary, which covers
      // through ordinal 8. Replacing it forgets the summary: three exchanges
      // remain before it, too few to fold yet.
      provider.reset();
      await sayAgain(id, "Was the lamp lit at dusk?", messages[6]!.id);

      expect(await memoryOf(id)).toMatchObject({ summary: "", summarizedThrough: 0 });
      expect(textOf(callsOf("ask.conversation")[0])).not.toContain("Summary 2:");
      expect(await messagesOf(id)).toHaveLength(8);

      // The next turn rebuilds it from those exchanges -- from empty, not by
      // extending what was forgotten.
      provider.reset();
      await say(id, "And the door?");

      const [fold] = callsOf("ask.conversation.summary");
      expect(fold).toBeDefined();
      expect(textOf(fold)).not.toContain("Summary 2:");
      expect((await memoryOf(id))?.summarizedThrough).toBe(4);
    });

    it("rebuilds a long summary in calls of FOLD_CHUNK, not one prompt the size of the conversation", async () => {
      const id = await start();
      for (let turn = 1; turn <= 15; turn += 1) {
        await say(id, `Was the lamp lit on night ${turn}?`);
      }
      // Folded every other turn from the fifth: through ordinal 24.
      expect((await memoryOf(id))?.summarizedThrough).toBe(24);
      const messages = await messagesOf(id);

      // Replacing the twelfth question (ordinal 23) leaves eleven exchanges,
      // nine of them to fold from scratch: one call of eight, one of one.
      provider.reset();
      await sayAgain(id, "Was the lamp lit at dawn?", messages[22]!.id);

      const folds = callsOf("ask.conversation.summary");
      expect(folds.map((call) => countReaders(textOf(call)))).toEqual([FOLD_CHUNK, 1]);
      expect((await memoryOf(id))?.summarizedThrough).toBe(18);
    });

    it("leaves the summary alone when the replaced turn was not in it", async () => {
      const id = await start();
      for (const question of [
        "What was the lamp like?",
        "Who knocked on the door?",
        "Who was the killer?",
        "Was the lamp ever lit?",
        "Did anyone answer the door?",
      ]) {
        await say(id, question);
      }
      const before = await memoryOf(id);
      // Folded once, before the fifth answer: the first two exchanges.
      expect(before?.summarizedThrough).toBe(4);
      const messages = await messagesOf(id);

      provider.reset();
      await sayAgain(id, "Did anyone open the door?", messages[8]!.id);

      expect(callsOf("ask.conversation.summary")).toHaveLength(0);
      expect(await memoryOf(id)).toMatchObject({
        summary: before?.summary,
        summarizedThrough: 4,
      });
    });

    it("only replaces a question in this conversation", async () => {
      const id = await start();
      await say(id, "Who knocked on the door?");
      const [question, answer] = await messagesOf(id);
      const other = await start();

      expect((await sayAgain(id, "Again?", answer!.id)).status).toBe(404);
      expect((await sayAgain(other, "Again?", question!.id)).status).toBe(404);
      expect(await messagesOf(id)).toHaveLength(2);
    });
  });

  it("deletes a conversation with its messages and citations", async () => {
    const id = await start();
    await say(id, "Who knocked on the door?");

    const removed = await api.request(`/api/ai/conversations/${id}`, {
      method: "DELETE",
      as: ownerId,
    });
    expect(removed.status).toBe(204);

    const read = await api.request(`/api/ai/conversations/${id}`, { as: ownerId });
    expect(read.status).toBe(404);

    const left = await db.orm.ai.ConversationMessage.select("id")
      .where((message) => message.conversationId.eq(id))
      .all();
    expect(left).toHaveLength(0);
  });
});
