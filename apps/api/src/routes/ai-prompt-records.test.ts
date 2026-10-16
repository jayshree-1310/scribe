/**
 * Every AI-generated artefact Scribe stores names the prompt that wrote it
 * (Task AI 17): a recap, a story-bible reading, a continuity check, a
 * moderation decision and a conversation answer, each produced through its
 * real service against the fake provider, then read back and resolved
 * through `prompts/registry.ts`.
 *
 * Resolvable is the point. A row whose id and version name a known prompt is
 * a row that can be found and regenerated when that prompt turns out to be
 * wrong; a row that names nothing is evidence nobody can trace.
 */

/** See `ai.test.ts`: `lib/redis.ts` reads `REDIS_URL` at module scope. */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/db.js";
import { checkChapterNow } from "../services/ai/continuity.js";
import { cancelContinuityChecks } from "../services/ai/continuity-queue.js";
import { createConversation, sendMessageStream } from "../services/ai/conversations.js";
import { embedChapter } from "../services/ai/embeddings.js";
import { MODERATION_CATEGORIES, moderateContent } from "../services/ai/moderation.js";
import { resolvePrompt } from "../services/ai/prompts/registry.js";
import {
  resetAiEmbedder,
  resetAiProvider,
  setAiEmbedder,
  setAiProvider,
} from "../services/ai/provider.js";
import { generateChapterRecap } from "../services/ai/recap.js";
import { refreshBible } from "../services/ai/story-bible.js";
import { fakeAiEmbedder, fakeAiProvider } from "../services/ai/testing.js";
import { drainDeferredWrites } from "../services/deferred.js";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

const ONE = "Mira climbed the lighthouse stair. Her green eyes caught the cold lamp.";
const TWO = "Mira looked out over the harbour, and her green eyes found the boat.";

let author: string;
let reader: string;
let story: { id: string; slug: string };
const chapters: string[] = [];
let commentId = "";

beforeAll(async () => {
  if (!available) return;
  process.env["AI_CONTINUITY"] = "on";
  process.env["AI_MODERATION"] = "on";
  await api.start();

  setAiEmbedder(fakeAiEmbedder(768, { model: "fake-records", concepts: { eyes: ["eyes", "eye", "colour"] } }));
  setAiProvider(
    fakeAiProvider(["ok"], {
      respond: (request) => {
        switch (request.feature) {
          case "recap.chapter":
            return "Mira climbed to the lamp.";
          case "bible.extract":
            return JSON.stringify({
              facts: [
                {
                  kind: "character",
                  subject: "Mira",
                  attribute: "eye colour",
                  value: "green",
                  related: null,
                  quote: "green eyes",
                },
              ],
            });
          case "continuity.check":
            return JSON.stringify({ findings: [] });
          case "moderation.classify":
            return JSON.stringify(Object.fromEntries(MODERATION_CATEGORIES.map((category) => [category.id, 0])));
          case "ask.conversation":
            return "Her eyes are green [1].";
          default:
            return undefined;
        }
      },
    }),
  );

  author = await api.createUser("prw", { isAuthor: true });
  reader = await api.createUser("prr");
  story = await api.createStory({ title: "Recorded Prompts", authorId: author });
  for (const [index, content] of [ONE, TWO].entries()) {
    const id = await api.createChapter({ storyId: story.id, number: index + 1, title: `Part ${index + 1}`, content });
    await embedChapter({ id, storyId: story.id, content });
    chapters.push(id);
  }

  const posted = await api.request<{ comment: { id: string } }>(`/api/stories/${story.slug}/comments`, {
    method: "POST",
    as: reader,
    body: { content: "Loved the lighthouse." },
  });
  commentId = posted.body.comment.id;
  // The post scheduled its own check; let it land rather than race it.
  await drainDeferredWrites();
}, 30_000);

afterAll(async () => {
  if (!available) return;
  cancelContinuityChecks();
  process.env["AI_CONTINUITY"] = "off";
  process.env["AI_MODERATION"] = "off";
  // A decision belongs to no user, so the harness's sweep cannot reach it.
  await db.runtime().query(
    db.raw.sql`DELETE FROM "ai"."moderationDecision" WHERE "targetId" = ${commentId}`.affectedCount().build(),
  );
  await db.runtime().query(
    db.raw.sql`DELETE FROM "moderation"."report" WHERE "targetId" = ${commentId} AND "reporterId" IS NULL`
      .affectedCount()
      .build(),
  );
  resetAiProvider();
  resetAiEmbedder();
  await api.stop();
});

function expectResolvable(row: { promptId: string | null; promptVersion: number | null } | null | undefined) {
  expect(row).toBeTruthy();
  expect(row?.promptId).toBeTruthy();
  const resolved = resolvePrompt(row!.promptId!, row!.promptVersion!);
  expect(resolved, `${row?.promptId}@${row?.promptVersion}`).not.toBeNull();
  expect(resolved?.current).toBe(true);
}

describe.skipIf(!available)("stored AI artefacts name their prompt", () => {
  it("a chapter recap", async () => {
    await generateChapterRecap(story.slug, 2, reader);
    expectResolvable(
      await db.orm.ai.ChapterSummary.select("promptId", "promptVersion")
        .where((row) => row.chapterId.eq(chapters[0]!))
        .first(),
    );
  });

  it("a story-bible reading and a continuity check", async () => {
    await refreshBible(author, story.id, 5);
    const extractions = await db.orm.ai.ChapterExtraction.select("promptId", "promptVersion")
      .where((row) => row.storyId.eq(story.id))
      .all();
    expect(extractions).toHaveLength(2);
    extractions.forEach(expectResolvable);

    await checkChapterNow(author, chapters[1]!);
    expectResolvable(
      await db.orm.ai.ContinuityCheck.select("promptId", "promptVersion")
        .where((row) => row.chapterId.eq(chapters[1]!))
        .first(),
    );
  });

  it("a moderation decision", async () => {
    // Already decided by the post's own check, or decided now: either way a row.
    await moderateContent("COMMENT", commentId);
    expectResolvable(
      await db.orm.ai.ModerationDecision.select("promptId", "promptVersion")
        .where((row) => row.targetId.eq(commentId))
        .first(),
    );
  });

  it("a conversation answer, and only the model's turn", async () => {
    const conversation = await createConversation(reader, story.id);
    for await (const event of sendMessageStream(reader, conversation.id, {
      content: "What colour are Mira's eyes?",
      upToChapter: 2,
    })) {
      if (event.type === "done") expect(event.answerable).toBe(true);
    }

    const rows = await db.orm.ai.ConversationMessage.select("role", "promptId", "promptVersion")
      .where((row) => row.conversationId.eq(conversation.id))
      .all();
    const question = rows.find((row) => row.role === "user");
    const answer = rows.find((row) => row.role === "assistant");

    expect(question?.promptId).toBeNull();
    expectResolvable(answer);
    expect(answer?.promptId).toBe("ask-book.conversation");
  });
});
