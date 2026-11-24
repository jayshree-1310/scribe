import { Temporal } from "temporal-polyfill";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainDeferredWrites } from "../services/deferred.js";
import { TestApi, databaseAvailable } from "../test/harness.js";
import {
  anchorParagraph,
  commentableParagraphs,
  type ParagraphCommentSummary,
} from "../services/paragraph-comments.js";
import type { Comment, Page } from "../services/engagement.js";
import type { NotificationPage } from "../services/notifications.js";

const api = new TestApi();
const available = await databaseAvailable();

let author: string;
let reader: string;
let other: string;
let story: { id: string; slug: string };
let chapterId: string;
let draftId: string;

const FIRST = "The lamp went **cold** at midnight, and nobody in the house noticed it.";
const SECOND = "She counted the stairs twice on the way down to the cellar door.";
const THIRD = "Nobody answered.";

const TEXT = ["# The cellar", "", FIRST, "", SECOND, "", THIRD].join("\n");

function at(line: string, content = TEXT): number {
  const start = content.indexOf(line);
  if (start === -1) throw new Error(`fixture text has no "${line}"`);
  return start;
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  author = await api.createUser("pcauth", { isAuthor: true });
  reader = await api.createUser("pcread");
  other = await api.createUser("pcothr");

  story = await api.createStory({ title: "Paragraph fixture", authorId: author });
  chapterId = await api.createChapter({ storyId: story.id, number: 1, content: TEXT });
  draftId = await api.createChapter({
    storyId: story.id,
    number: 2,
    content: "Draft paragraph.",
    published: false,
  });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

async function setContent(content: string): Promise<void> {
  const { db } = await import("../prisma/db.js");
  await db.orm.content.Chapter.where((row) => row.id.eq(chapterId)).update({ content });
}

async function post(as: string, body: Record<string, unknown>) {
  return api.request<{ comment: Comment }>(`/api/stories/${story.slug}/comments`, {
    method: "POST",
    as,
    body,
  });
}

async function summary(query = "", as?: string) {
  const response = await api.request<ParagraphCommentSummary>(
    `/api/chapters/${chapterId}/paragraph-comments${query}`,
    as === undefined ? {} : { as },
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function listOn(paragraph: number) {
  const response = await api.request<Page<Comment>>(
    `/api/stories/${story.slug}/comments?chapterId=${chapterId}&paragraph=${paragraph}`,
  );
  expect(response.status).toBe(200);
  return response.body;
}

describe("commentableParagraphs", () => {
  it("finds each prose line where the renderer draws one, without headings or attachments", () => {
    const content = [
      "# Title",
      "## Part",
      "First line.",
      "  Second line, indented.",
      "",
      "[media:abc-123]",
      "",
      "> A quotation.",
      "- One",
      "- Two",
      "   ",
      "### Not a heading here.",
    ].join("\n");

    expect(commentableParagraphs(content).map((paragraph) => paragraph.text)).toEqual([
      "First line.",
      "  Second line, indented.",
      "> A quotation.",
      "- One",
      "- Two",
      "### Not a heading here.",
    ]);
    for (const paragraph of commentableParagraphs(content)) {
      expect(content.slice(paragraph.start, paragraph.end)).toBe(paragraph.text);
    }
  });

  it("agrees with the web's copy on the fixture its renderer test draws", () => {
    // The same chapter as `apps/web/src/lib/chapter-paragraphs.test.tsx`,
    // which checks these lines against the blocks the renderer really draws.
    const chapter = [
      "# The cellar",
      "## Before",
      "The lamp went **cold** at *midnight*.",
      "  She counted the stairs, twice.",
      "",
      "[media:gone-row]",
      "",
      "> Nobody answered.",
      "- One stair",
      "- Two stairs",
      "",
      "",
      "   ### Not a heading, a line with hashes.",
      "",
      "Nobody answered.",
    ].join("\n");

    const paragraphs = commentableParagraphs(chapter);
    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "The lamp went **cold** at *midnight*.",
      "  She counted the stairs, twice.",
      "> Nobody answered.",
      "- One stair",
      "- Two stairs",
      "### Not a heading, a line with hashes.",
      "Nobody answered.",
    ]);
    expect(paragraphs[2]!.start).toBe(chapter.indexOf("> Nobody answered."));
    expect(paragraphs[6]!.start).toBe(chapter.lastIndexOf("Nobody answered."));
  });

  it("starts a run after the whitespace the renderer trims from it", () => {
    const content = "One.\n\n\n   Two.";
    expect(commentableParagraphs(content)).toEqual([
      { start: 0, end: 4, text: "One." },
      { start: content.indexOf("Two."), end: content.length, text: "Two." },
    ]);
  });
});

describe("anchorParagraph", () => {
  const long = "the lamp went cold at midnight and nobody noticed";
  const paragraphs = commentableParagraphs(["Intro.", "", long, "", "Short.", "", long].join("\n"));

  it("keeps the stored place while the line is still there", () => {
    const second = paragraphs[3]!.start;
    expect(anchorParagraph(paragraphs, long, second)).toBe(second);
  });

  it("moves to the identical line nearest the stored place", () => {
    expect(anchorParagraph(paragraphs, long, 2)).toBe(paragraphs[1]!.start);
    expect(anchorParagraph(paragraphs, "Short.", 0)).toBe(paragraphs[2]!.start);
  });

  it("follows a paragraph through a small edit", () => {
    const edited = commentableParagraphs(
      "Intro.\n\nThe lamp went cold at midnight, and nobody noticed it.",
    );
    expect(anchorParagraph(edited, long, 8)).toBe(edited[1]!.start);
  });

  it("lets go of a paragraph that was rewritten, and of a short line that changed", () => {
    const rewritten = commentableParagraphs("Intro.\n\nMorning came, bright and loud, over the harbour.");
    expect(anchorParagraph(rewritten, long, 8)).toBeNull();
    expect(anchorParagraph(commentableParagraphs("Shorter."), "Short.", 0)).toBeNull();
  });
});

describe.skipIf(!available)("paragraph comments", () => {
  let thread: Comment;

  it("starts a thread on a paragraph and counts it there", async () => {
    const response = await post(reader, {
      content: "Why did nobody notice?",
      chapterId,
      paragraph: at(FIRST),
    });
    expect(response.status).toBe(201);
    thread = response.body.comment;

    const reply = await post(other, { content: "The house was asleep.", parentId: thread.id });
    expect(reply.status).toBe(201);

    expect(await summary()).toEqual({
      paragraphs: [{ start: at(FIRST), count: 2 }],
      focus: null,
    });
  });

  it("is public: anybody may read the counts and the threads", async () => {
    expect((await summary("", undefined)).paragraphs).toHaveLength(1);

    const page = await listOn(at(FIRST));
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ id: thread.id, replyCount: 1, chapterId });
  });

  it("keeps paragraph threads out of the story's and the chapter's lists", async () => {
    const chapterWide = await post(other, { content: "Lovely chapter.", chapterId });
    expect(chapterWide.status).toBe(201);

    const storyList = await api.request<Page<Comment>>(`/api/stories/${story.slug}/comments`);
    expect(storyList.body.items.map((item) => item.id)).toEqual([chapterWide.body.comment.id]);

    const chapterList = await api.request<Page<Comment>>(
      `/api/stories/${story.slug}/comments?chapterId=${chapterId}`,
    );
    expect(chapterList.body.items.map((item) => item.id)).toEqual([chapterWide.body.comment.id]);
    expect(chapterList.body.total).toBe(1);
  });

  it("lists nothing for a paragraph nobody has commented on", async () => {
    expect((await listOn(at(SECOND))).items).toEqual([]);
  });

  it("refuses an offset where no paragraph starts, and a heading", async () => {
    const middle = await post(reader, { content: "Hm.", chapterId, paragraph: at(FIRST) + 3 });
    expect(middle.status).toBe(400);

    const heading = await post(reader, { content: "Hm.", chapterId, paragraph: 0 });
    expect(heading.status).toBe(400);
  });

  it("refuses a paragraph without its chapter", async () => {
    const response = await post(reader, { content: "Hm.", paragraph: at(FIRST) });
    expect(response.status).toBe(400);

    const list = await api.request(`/api/stories/${story.slug}/comments?paragraph=4`);
    expect(list.status).toBe(400);
  });

  it("locates a linked thread, or a linked reply's thread", async () => {
    expect((await summary(`?comment=${thread.id}`)).focus).toBe(at(FIRST));

    const replies = await api.request<Page<Comment>>(
      `/api/stories/${story.slug}/comments?parentId=${thread.id}`,
    );
    const replyId = replies.body.items[0]!.id;
    expect((await summary(`?comment=${replyId}`)).focus).toBe(at(FIRST));
  });

  it("links the author's and the replied-to reader's notifications at the paragraph", async () => {
    await drainDeferredWrites();
    const href = `/read/${story.slug}/1?comment=${thread.id}`;

    const authorInbox = await api.request<NotificationPage>("/api/notifications", { as: author });
    expect(authorInbox.body.items.map((item) => item.href)).toContain(href);

    const readerInbox = await api.request<NotificationPage>("/api/notifications", { as: reader });
    expect(readerInbox.body.items[0]?.href).toBe(href);
  });

  it("follows its paragraph when the author edits the chapter", async () => {
    const edited = [
      "# The cellar",
      "",
      "A new opening line.",
      "",
      FIRST.replace("noticed it", "noticed"),
      "",
      SECOND,
      "",
      THIRD,
    ].join("\n");
    await setContent(edited);

    const moved = at(FIRST.replace("noticed it", "noticed"), edited);
    expect((await summary()).paragraphs).toEqual([{ start: moved, count: 2 }]);
    expect((await listOn(moved)).items.map((item) => item.id)).toEqual([thread.id]);
  });

  it("keeps a thread whose paragraph was rewritten, and shows it again when it returns", async () => {
    await setContent(["# The cellar", "", "Something else entirely happened here today.", "", THIRD].join("\n"));
    expect((await summary()).paragraphs).toEqual([]);

    await setContent(TEXT);
    expect((await summary()).paragraphs).toEqual([{ start: at(FIRST), count: 2 }]);
  });

  it("drops a hidden thread from the counts", async () => {
    const hidden = await post(other, { content: "Spam spam.", chapterId, paragraph: at(THIRD) });
    expect((await summary()).paragraphs).toContainEqual({ start: at(THIRD), count: 1 });

    const { db } = await import("../prisma/db.js");
    await db.orm.engagement.Comment.where((row) => row.id.eq(hidden.body.comment.id)).update({
      hiddenAt: Temporal.Now.instant(),
    });
    expect((await summary()).paragraphs.map((paragraph) => paragraph.start)).toEqual([at(FIRST)]);
  });

  it("closes an unpublished chapter's paragraphs to readers", async () => {
    const counts = await api.request(`/api/chapters/${draftId}/paragraph-comments`, { as: reader });
    expect(counts.status).toBe(404);

    const response = await post(reader, { content: "Early!", chapterId: draftId, paragraph: 0 });
    expect(response.status).toBe(404);
  });
});
