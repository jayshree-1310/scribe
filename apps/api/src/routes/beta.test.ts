import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { TestApi, databaseAvailable } from "../test/harness.js";
import type { BetaFeedback, BetaInvite, BetaLink, BetaOverview } from "../services/beta.js";
import type { ChapterSummary, StoryDetail } from "../services/stories.js";

const api = new TestApi();
const available = await databaseAvailable();

let author: string;
let reader: string;
let second: string;
let stranger: string;

/** A draft story: nobody but the author and its beta readers may see it. */
let draft: { id: string; slug: string };
let draftChapter: string;

/** A listed serial with an unpublished chapter 2 and a taken-down chapter 3. */
let serial: { id: string; slug: string };
let serialPublished: string;
let serialDraft: string;
let serialHidden: string;

const DRAFT_TEXT = "The ferry left without her.\n\nShe watched the wake close.";

beforeAll(async () => {
  if (!available) return;
  await api.start();

  author = await api.createUser("bauth", { isAuthor: true });
  reader = await api.createUser("bread");
  second = await api.createUser("bsecond");
  stranger = await api.createUser("bstrange");

  draft = await api.createStory({ title: "Beta draft", authorId: author, listed: false });
  draftChapter = await api.createChapter({
    storyId: draft.id,
    number: 1,
    content: DRAFT_TEXT,
    published: false,
  });

  serial = await api.createStory({ title: "Beta serial", authorId: author });
  serialPublished = await api.createChapter({ storyId: serial.id, number: 1 });
  serialDraft = await api.createChapter({
    storyId: serial.id,
    number: 2,
    content: "Not out yet.",
    published: false,
  });
  serialHidden = await api.createChapter({
    storyId: serial.id,
    number: 3,
    content: "Taken down.",
    published: false,
  });
  const { db } = await import("../prisma/db.js");
  await db.orm.content.Chapter.where((row) => row.id.eq(serialHidden)).update({
    hiddenAt: Temporal.Now.instant(),
  });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

async function makeLink(storyId: string, as = author): Promise<BetaLink> {
  const response = await api.request<{ link: BetaLink }>(`/api/beta/stories/${storyId}/link`, {
    method: "POST",
    as,
  });
  expect(response.status).toBe(201);
  return response.body.link;
}

async function join(token: string, as: string) {
  return api.request<{ slug: string }>(`/api/beta/invites/${token}/join`, {
    method: "POST",
    as,
  });
}

async function story(slug: string, as?: string) {
  return api.request<{ story: StoryDetail }>(`/api/stories/${slug}`, as ? { as } : {});
}

async function chapters(slug: string, as?: string) {
  return api.request<{ chapters: ChapterSummary[] }>(
    `/api/stories/${slug}/chapters`,
    as ? { as } : {},
  );
}

async function feedback(as: string, body: Record<string, unknown>) {
  return api.request<{ feedback: BetaFeedback }>("/api/beta/feedback", {
    method: "POST",
    as,
    body,
  });
}

async function listFeedback(storyKey: string, as: string) {
  const response = await api.request<{ feedback: BetaFeedback[] }>(
    `/api/beta/stories/${storyKey}/feedback`,
    { as },
  );
  expect(response.status).toBe(200);
  return response.body.feedback;
}

describe.skipIf(!available)("beta readers", () => {
  let draftLink: BetaLink;
  let serialLink: BetaLink;

  it("gives the author one link per story, and nobody else any", async () => {
    draftLink = await makeLink(draft.id);
    expect(draftLink.token).toMatch(/^[A-Za-z0-9_-]{24}$/);

    // Pressing again keeps the link already sent.
    expect((await makeLink(draft.id)).token).toBe(draftLink.token);

    // Somebody else's draft is a 404, as everywhere else in the authoring API.
    const theirs = await api.request(`/api/beta/stories/${draft.id}/link`, {
      method: "POST",
      as: stranger,
    });
    expect(theirs.status).toBe(404);

    serialLink = await makeLink(serial.id);
  });

  it("keeps a draft hidden from anybody who has not joined", async () => {
    expect((await story(draft.slug, stranger)).status).toBe(404);
    expect((await story(draft.slug, reader)).status).toBe(404);
  });

  it("shows the invite, then lets a signed-in reader join", async () => {
    const anonymous = await api.request(`/api/beta/invites/${draftLink.token}`);
    expect(anonymous.status).toBe(401);

    const preview = await api.request<BetaInvite>(`/api/beta/invites/${draftLink.token}`, {
      as: reader,
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      isAuthor: false,
      joined: false,
      story: { id: draft.id, title: "Beta draft", status: "draft", chapterCount: 1 },
    });

    const joined = await join(draftLink.token, reader);
    expect(joined.status).toBe(200);
    expect(joined.body.slug).toBe(draft.slug);

    // Joining twice is joining once.
    expect((await join(draftLink.token, reader)).status).toBe(200);

    const again = await api.request<BetaInvite>(`/api/beta/invites/${draftLink.token}`, {
      as: reader,
    });
    expect(again.body.joined).toBe(true);

    const bogus = await api.request("/api/beta/invites/AAAAAAAAAAAAAAAAAAAAAAAA", {
      as: reader,
    });
    expect(bogus.status).toBe(404);
  });

  it("lets a beta reader read the draft, without counting it as a read", async () => {
    const detail = await story(draft.slug, reader);
    expect(detail.status).toBe(200);
    expect(detail.body.story).toMatchObject({ access: "beta", chapterCount: 1 });

    const list = await chapters(draft.slug, reader);
    expect(list.body.chapters.map((chapter) => chapter.number)).toEqual([1]);

    const chapter = await api.request(`/api/stories/${draft.slug}/chapters/1`, { as: reader });
    expect(chapter.status).toBe(200);

    await api.settleBackgroundWrites();
    expect(await api.countStoryViews(draft.id)).toBe(0);
    expect(await api.countChapterReads(draftChapter)).toBe(0);
  });

  it("serves a beta reader the drafts past the shared public copy", async () => {
    // Fill the shared cache as the public, then read as a beta reader.
    const publicList = await chapters(serial.slug);
    expect(publicList.body.chapters.map((chapter) => chapter.number)).toEqual([1]);

    expect((await join(serialLink.token, reader)).status).toBe(200);

    const betaList = await chapters(serial.slug, reader);
    // Chapter 3 was taken down by a moderator: beta readers do not get it either.
    expect(betaList.body.chapters.map((chapter) => chapter.number)).toEqual([1, 2]);

    const hidden = await api.request(`/api/stories/${serial.slug}/chapters/3`, { as: reader });
    expect(hidden.status).toBe(404);

    // Somebody who never joined still gets the public answer.
    const strangerList = await chapters(serial.slug, stranger);
    expect(strangerList.body.chapters.map((chapter) => chapter.number)).toEqual([1]);

    // Published chapters a beta reader opens are ordinary reads.
    await api.request(`/api/stories/${serial.slug}/chapters/1`, { as: reader });
    await api.request(`/api/stories/${serial.slug}/chapters/2`, { as: reader });
    await api.settleBackgroundWrites();
    expect(await api.countChapterReads(serialPublished)).toBe(1);
    expect(await api.countChapterReads(serialDraft)).toBe(0);
  });

  it("keeps public engagement closed on unpublished work", async () => {
    const comment = await api.request(`/api/stories/${draft.id}/comments`, {
      method: "POST",
      as: reader,
      body: { content: "Lovely draft" },
    });
    expect(comment.status).toBe(404);

    const like = await api.request(`/api/chapters/${serialDraft}/like`, {
      method: "PUT",
      as: reader,
    });
    expect(like.status).toBe(404);
  });

  it("lets a beta reader highlight a draft chapter privately", async () => {
    const response = await api.request("/api/reading/highlights", {
      method: "POST",
      as: reader,
      body: { chapterId: draftChapter, start: 0, end: 9 },
    });
    expect(response.status).toBe(201);

    const list = await api.request<{ highlights: unknown[] }>(
      `/api/reading/highlights?storyId=${draft.id}`,
      { as: reader },
    );
    expect(list.body.highlights).toHaveLength(1);
  });

  let readerNote: BetaFeedback;

  it("takes feedback from beta readers only, quoting the chapter itself", async () => {
    const start = DRAFT_TEXT.indexOf("She watched");
    const created = await feedback(reader, {
      chapterId: draftChapter,
      body: "  This line hit hard.  ",
      start,
      end: start + "She watched the wake close.".length,
    });
    expect(created.status).toBe(201);
    readerNote = created.body.feedback;
    expect(readerNote).toMatchObject({
      chapterId: draftChapter,
      chapterNumber: 1,
      chapterPublished: false,
      body: "This line hit hard.",
      quote: "She watched the wake close.",
      mine: true,
    });

    // A reader of a published chapter who was never invited has comments.
    const uninvited = await feedback(stranger, { chapterId: serialPublished, body: "Hi" });
    expect(uninvited.status).toBe(403);

    // The author has the editor.
    const own = await feedback(author, { chapterId: draftChapter, body: "Note to self" });
    expect(own.status).toBe(403);

    // A draft the caller cannot see is a 404, not a 403.
    const hidden = await feedback(stranger, { chapterId: draftChapter, body: "Hi" });
    expect(hidden.status).toBe(404);

    const outside = await feedback(reader, {
      chapterId: draftChapter,
      body: "Out of range",
      start: 0,
      end: DRAFT_TEXT.length + 5,
    });
    expect(outside.status).toBe(400);

    await api.settleBackgroundWrites();
    const { db } = await import("../prisma/db.js");
    const notes = await db.orm.notifications.Notification.select("actorId", "href", "excerpt")
      .where((row) => row.userId.eq(author))
      .where((row) => row.type.eq("BETA_FEEDBACK"))
      .all();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      actorId: reader,
      href: `/author/stories/${draft.slug}/beta`,
      excerpt: "Chapter 1: Chapter 1",
    });
  });

  it("shows the author everything and each reader their own", async () => {
    expect((await join(draftLink.token, second)).status).toBe(200);
    const theirs = await feedback(second, { chapterId: draftChapter, body: "Slow start." });
    expect(theirs.status).toBe(201);

    const forAuthor = await listFeedback(draft.id, author);
    expect(forAuthor.map((item) => item.body)).toEqual(["This line hit hard.", "Slow start."]);
    expect(forAuthor.every((item) => !item.mine)).toBe(true);

    const forReader = await listFeedback(draft.slug, reader);
    expect(forReader.map((item) => item.body)).toEqual(["This line hit hard."]);

    const overview = await api.request<BetaOverview>(`/api/beta/stories/${draft.id}`, {
      as: author,
    });
    expect(overview.status).toBe(200);
    expect(overview.body.link?.token).toBe(draftLink.token);
    expect(
      overview.body.readers.map((entry) => [entry.user.id, entry.feedbackCount]),
    ).toEqual([
      [reader, 1],
      [second, 1],
    ]);

    const notAuthor = await api.request(`/api/beta/stories/${draft.id}`, { as: reader });
    expect(notAuthor.status).toBe(404);
  });

  it("lets only the writer edit, and the writer or author delete", async () => {
    const byOther = await api.request(`/api/beta/feedback/${readerNote.id}`, {
      method: "PATCH",
      as: second,
      body: { body: "Rewritten" },
    });
    expect(byOther.status).toBe(404);

    const byWriter = await api.request<{ feedback: BetaFeedback }>(
      `/api/beta/feedback/${readerNote.id}`,
      { method: "PATCH", as: reader, body: { body: "This line hit very hard." } },
    );
    expect(byWriter.status).toBe(200);
    expect(byWriter.body.feedback.body).toBe("This line hit very hard.");

    const secondNote = (await listFeedback(draft.id, author)).find(
      (item) => item.reader.id === second,
    )!;
    const deleteByOther = await api.request(`/api/beta/feedback/${secondNote.id}`, {
      method: "DELETE",
      as: reader,
    });
    expect(deleteByOther.status).toBe(404);

    const deleteByAuthor = await api.request(`/api/beta/feedback/${secondNote.id}`, {
      method: "DELETE",
      as: author,
    });
    expect(deleteByAuthor.status).toBe(204);
    expect(await listFeedback(draft.id, author)).toHaveLength(1);
  });

  it("refuses feedback from a suspended reader", async () => {
    await api.setSuspended(second, true);
    const response = await feedback(second, { chapterId: draftChapter, body: "Still here" });
    expect(response.status).toBe(403);
    await api.setSuspended(second, false);
  });

  it("keeps feedback when the chapter is published", async () => {
    const { db } = await import("../prisma/db.js");
    await db.orm.content.Chapter.where((row) => row.id.eq(draftChapter)).update({
      publishedAt: Temporal.Now.instant(),
    });

    const [kept] = await listFeedback(draft.id, author);
    expect(kept).toMatchObject({ id: readerNote.id, chapterPublished: true });

    await db.orm.content.Chapter.where((row) => row.id.eq(draftChapter)).update({
      publishedAt: null,
    });
  });

  it("shuts out a removed reader, and keeps what they wrote", async () => {
    const removed = await api.request(`/api/beta/stories/${draft.id}/readers/${reader}`, {
      method: "DELETE",
      as: author,
    });
    expect(removed.status).toBe(204);

    expect((await story(draft.slug, reader)).status).toBe(404);
    const edit = await api.request(`/api/beta/feedback/${readerNote.id}`, {
      method: "PATCH",
      as: reader,
      body: { body: "Too late" },
    });
    expect(edit.status).toBe(404);

    expect((await listFeedback(draft.id, author)).map((item) => item.id)).toEqual([
      readerNote.id,
    ]);
  });

  it("lets a reader leave on their own", async () => {
    const left = await api.request(`/api/beta/stories/${serial.id}/membership`, {
      method: "DELETE",
      as: reader,
    });
    expect(left.status).toBe(204);

    const list = await chapters(serial.slug, reader);
    expect(list.body.chapters.map((chapter) => chapter.number)).toEqual([1]);
  });

  it("revokes the link and everyone who joined through it", async () => {
    const revoked = await api.request(`/api/beta/stories/${draft.id}/link`, {
      method: "DELETE",
      as: author,
    });
    expect(revoked.status).toBe(204);

    expect((await story(draft.slug, second)).status).toBe(404);
    expect((await join(draftLink.token, stranger)).status).toBe(404);

    const fresh = await makeLink(draft.id);
    expect(fresh.token).not.toBe(draftLink.token);

    const overview = await api.request<BetaOverview>(`/api/beta/stories/${draft.id}`, {
      as: author,
    });
    expect(overview.body.readers).toEqual([]);
  });
});
