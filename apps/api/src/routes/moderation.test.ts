import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainDeferredWrites } from "../services/deferred.js";
import { TestApi, databaseAvailable } from "../test/harness.js";
import type { Page, Report } from "../services/moderation.js";

const api = new TestApi();
const available = await databaseAvailable();

/**
 * Fan-out is fire-and-forget, so the notifications a comment caused are not
 * written when the `POST` answers. Every assertion about the sweep hiding
 * performs has to settle them first, or it is asserting against rows that had
 * not landed yet and would pass for the wrong reason. Badges first and not in
 * parallel, the order every other drain site uses.
 */
async function settle(): Promise<void> {
  await drainDeferredWrites();
}

async function fileReport(
  as: string,
  body: {
    targetType: string;
    targetId: string;
    reason?: string;
    details?: string;
  },
) {
  return api.request<{ report: Report }>("/api/reports", {
    method: "POST",
    as,
    body: { reason: "SPAM", ...body },
  });
}

async function queue(as: string, query = ""): Promise<Page<Report>> {
  const response = await api.request<Page<Report>>(
    `/api/moderation/reports${query}`,
    { as },
  );

  expect(response.status).toBe(200);
  return response.body;
}

async function resolve(
  as: string,
  reportId: string,
  action: string,
  note?: string,
) {
  return api.request<{ report: Report }>(
    `/api/moderation/reports/${reportId}/resolve`,
    { method: "POST", as, body: { action, ...(note ? { note } : {}) } },
  );
}

/** The ids a story's public comment list currently shows. */
async function visibleComments(storyId: string): Promise<string[]> {
  const response = await api.request<{ items: { id: string }[] }>(
    `/api/stories/${storyId}/comments`,
  );

  expect(response.status).toBe(200);
  return response.body.items.map((item) => item.id);
}

let moderator: string;
let author: string;
let offender: string;
let reporter: string;
let other: string;

let story: { id: string; slug: string };
let club: { id: string; slug: string };
let channel: { id: string; slug: string };

beforeAll(async () => {
  if (!available) return;
  await api.start();

  /**
   * Four characters of distinct label each: `createUser` truncates the
   * username to 30 and the per-run prefix eats most of that, so two labels
   * that agree on their opening are one account with two names.
   */
  moderator = await api.createUser("mgstaff");
  await api.setAdmin(moderator);

  author = await api.createUser("mgauthor", { isAuthor: true });
  offender = await api.createUser("mgoffend");
  reporter = await api.createUser("mgreport");
  other = await api.createUser("mgbystand");

  story = await api.createStory({ title: "Moderated Story", authorId: author });
  club = await api.createClub({ name: "Moderated Club", creatorId: author });
  await api.addClubMember({ clubId: club.id, userId: offender });
  await api.addClubMember({ clubId: club.id, userId: reporter });
  channel = await api.createChannel({
    name: "Moderated Channel",
    authorId: author,
  });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

describe.skipIf(!available)("filing a report", () => {
  it("records one, and refuses a second on the same target", async () => {
    const commentId = await api.createComment({
      storyId: story.id,
      userId: offender,
      content: "Buy my thing.",
    });

    const first = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: commentId,
      details: "Nothing to do with the story.",
    });

    expect(first.status).toBe(201);
    expect(first.body.report.status).toBe("OPEN");
    expect(first.body.report.action).toBeNull();
    expect(first.body.report.target?.excerpt).toBe("Buy my thing.");
    expect(first.body.report.target?.author.id).toBe(offender);
    expect(first.body.report.reporter.id).toBe(reporter);

    const second = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: commentId,
      reason: "HARASSMENT",
    });

    expect(second.status).toBe(409);

    // Somebody *else* reporting the same comment is not a duplicate: it is the
    // signal that makes a queue worth reading.
    const third = await fileReport(other, {
      targetType: "COMMENT",
      targetId: commentId,
    });

    expect(third.status).toBe(201);
  });

  it("refuses a target that does not exist, and one of your own", async () => {
    const missing = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: "00000000-0000-4000-8000-000000000000",
    });

    expect(missing.status).toBe(404);

    const mine = await api.createComment({
      storyId: story.id,
      userId: reporter,
      content: "My own words.",
    });

    const own = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: mine,
    });

    expect(own.status).toBe(400);
  });

  it("needs a signed-in caller", async () => {
    const commentId = await api.createComment({
      storyId: story.id,
      userId: offender,
    });

    const response = await api.request("/api/reports", {
      method: "POST",
      body: { targetType: "COMMENT", targetId: commentId, reason: "SPAM" },
    });

    expect(response.status).toBe(401);
  });
});

describe.skipIf(!available)("the moderation queue", () => {
  it("is closed to everybody but an administrator", async () => {
    const list = await api.request("/api/moderation/reports", { as: reporter });
    expect(list.status).toBe(403);

    const anonymous = await api.request("/api/moderation/reports");
    expect(anonymous.status).toBe(401);

    const commentId = await api.createComment({
      storyId: story.id,
      userId: offender,
    });
    const filed = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: commentId,
    });
    expect(filed.status).toBe(201);

    const act = await resolve(reporter, filed.body.report.id, "HIDE");
    expect(act.status).toBe(403);

    // And the content it named is still there, because the refusal happened
    // before anything was written.
    expect(await visibleComments(story.slug)).toContain(commentId);
  });

  it("defaults to open reports and filters on request", async () => {
    const commentId = await api.createComment({
      storyId: story.id,
      userId: offender,
      content: "Queue filter fixture.",
    });
    const filed = await fileReport(other, {
      targetType: "COMMENT",
      targetId: commentId,
      reason: "HATE",
    });
    expect(filed.status).toBe(201);

    const open = await queue(moderator);
    expect(open.items.every((item) => item.status === "OPEN")).toBe(true);
    expect(open.items.map((item) => item.id)).toContain(filed.body.report.id);

    const byReason = await queue(moderator, "?reason=HATE");
    expect(byReason.items.every((item) => item.reason === "HATE")).toBe(true);

    const byType = await queue(moderator, "?targetType=CHANNEL_POST");
    expect(
      byType.items.every((item) => item.targetType === "CHANNEL_POST"),
    ).toBe(true);
  });
});

describe.skipIf(!available)("hidden content", () => {
  it("leaves every public read path for a comment", async () => {
    const threadId = await api.createComment({
      storyId: story.id,
      userId: offender,
      content: "The thread that goes.",
    });
    const replyId = await api.createComment({
      storyId: story.id,
      userId: other,
      content: "A reply that stays.",
      parentId: threadId,
    });

    const before = await api.request<{
      items: { id: string; replyCount: number }[];
    }>(`/api/stories/${story.slug}/comments`);
    expect(before.body.items.map((item) => item.id)).toContain(threadId);
    expect(
      before.body.items.find((item) => item.id === threadId)?.replyCount,
    ).toBe(1);

    const filed = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: threadId,
      reason: "HARASSMENT",
    });
    expect(filed.status).toBe(201);

    const acted = await resolve(moderator, filed.body.report.id, "HIDE");
    expect(acted.status).toBe(200);
    expect(acted.body.report.status).toBe("RESOLVED");
    expect(acted.body.report.action).toBe("HIDE");
    expect(acted.body.report.target?.hidden).toBe(true);

    expect(await visibleComments(story.slug)).not.toContain(threadId);

    // The reply survives -- hiding a thread is not a decision about the
    // replies underneath it -- but nothing lists it any more, because its
    // thread is where a reader would have opened it from.
    const replies = await api.request<{ items: { id: string }[] }>(
      `/api/stories/${story.slug}/comments?parentId=${threadId}`,
    );
    expect(replies.body.items.map((item) => item.id)).toContain(replyId);

    // Reporting something already hidden reads exactly like reporting
    // something that never existed.
    const again = await fileReport(other, {
      targetType: "COMMENT",
      targetId: threadId,
    });
    expect(again.status).toBe(404);

    // And nobody can reply to it.
    const reply = await api.request(`/api/stories/${story.slug}/comments`, {
      method: "POST",
      as: other,
      body: { content: "Answering a ghost.", parentId: threadId },
    });
    expect(reply.status).toBe(404);
  });

  it("drops out of a club's thread list and its count", async () => {
    const threadId = await api.createDiscussion({
      clubId: club.id,
      userId: offender,
      body: "A thread worth hiding.",
    });

    const filed = await fileReport(reporter, {
      targetType: "CLUB_DISCUSSION",
      targetId: threadId,
    });
    expect(filed.status).toBe(201);

    const before = await api.request<{ club: { discussionCount: number } }>(
      `/api/clubs/${club.slug}`,
    );
    const countBefore = before.body.club.discussionCount;

    expect((await resolve(moderator, filed.body.report.id, "HIDE")).status).toBe(
      200,
    );

    const threads = await api.request<{ items: { id: string }[] }>(
      `/api/clubs/${club.slug}/discussions`,
    );
    expect(threads.body.items.map((item) => item.id)).not.toContain(threadId);

    const after = await api.request<{ club: { discussionCount: number } }>(
      `/api/clubs/${club.slug}`,
    );
    expect(after.body.club.discussionCount).toBe(countBefore - 1);
  });

  it("drops out of a channel feed and its count", async () => {
    const postId = await api.createChannelPost({
      channelId: channel.id,
      title: "A post worth hiding",
    });

    const filed = await fileReport(reporter, {
      targetType: "CHANNEL_POST",
      targetId: postId,
    });
    expect(filed.status).toBe(201);

    expect((await resolve(moderator, filed.body.report.id, "HIDE")).status).toBe(
      200,
    );

    const feed = await api.request<{ items: { id: string }[] }>(
      `/api/channels/${channel.slug}/posts`,
    );
    expect(feed.body.items.map((item) => item.id)).not.toContain(postId);

    const detail = await api.request<{ channel: { postCount: number } }>(
      `/api/channels/${channel.slug}`,
    );
    expect(
      feed.body.items.length,
      "the card's count has to agree with the feed beside it",
    ).toBe(detail.body.channel.postCount);
  });

  it("takes the notifications that quoted it with it", async () => {
    // A reply, because that is the fan-out that puts a copy of somebody's
    // words into the bell of the person they were aimed at.
    const threadId = await api.createComment({
      storyId: story.id,
      userId: other,
      content: "Something to answer.",
    });

    const reply = await api.request<{ comment: { id: string } }>(
      `/api/stories/${story.slug}/comments`,
      {
        method: "POST",
        as: offender,
        body: { content: "An abusive reply.", parentId: threadId },
      },
    );
    expect(reply.status).toBe(201);
    await settle();

    const replyId = reply.body.comment.id;
    expect(await api.countNotificationsFor("COMMENT", replyId)).toBe(1);

    const filed = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: replyId,
      reason: "HARASSMENT",
    });
    expect(filed.status).toBe(201);

    expect((await resolve(moderator, filed.body.report.id, "HIDE")).status).toBe(
      200,
    );

    // The copy in somebody else's bell is gone, which is the whole point:
    // hiding the row it came from could never have reached it.
    expect(await api.countNotificationsFor("COMMENT", replyId)).toBe(0);
  });
});

describe.skipIf(!available)("resolving", () => {
  it("closes every open report on the same target at once", async () => {
    const commentId = await api.createComment({
      storyId: story.id,
      userId: offender,
      content: "Reported by two people.",
    });

    const one = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: commentId,
    });
    const two = await fileReport(other, {
      targetType: "COMMENT",
      targetId: commentId,
      reason: "HATE",
    });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);

    expect((await resolve(moderator, one.body.report.id, "HIDE")).status).toBe(
      200,
    );

    const still = await queue(moderator, "?status=OPEN&limit=100");
    const openIds = still.items.map((item) => item.id);
    expect(openIds).not.toContain(one.body.report.id);
    expect(openIds).not.toContain(two.body.report.id);
  });

  it("restores hidden content when the call is dismissed", async () => {
    const commentId = await api.createComment({
      storyId: story.id,
      userId: offender,
      content: "Hidden then restored.",
    });

    const filed = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: commentId,
    });
    expect(filed.status).toBe(201);

    expect((await resolve(moderator, filed.body.report.id, "HIDE")).status).toBe(
      200,
    );
    expect(await visibleComments(story.slug)).not.toContain(commentId);

    const undone = await resolve(
      moderator,
      filed.body.report.id,
      "DISMISS",
      "Read it again; it is fine.",
    );

    expect(undone.status).toBe(200);
    expect(undone.body.report.action).toBe("DISMISS");
    expect(undone.body.report.note).toBe("Read it again; it is fine.");
    expect(undone.body.report.target?.hidden).toBe(false);
    expect(await visibleComments(story.slug)).toContain(commentId);
  });

  it("suspends the author, and stops them posting anywhere", async () => {
    const commentId = await api.createComment({
      storyId: story.id,
      userId: offender,
      content: "The one that costs the account.",
    });

    const filed = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: commentId,
      reason: "HATE",
    });
    expect(filed.status).toBe(201);

    const acted = await resolve(moderator, filed.body.report.id, "SUSPEND");
    expect(acted.status).toBe(200);
    expect(await api.readSuspended(offender)).toBe(true);

    // Suspension hides the post it was imposed over: never one without the
    // other.
    expect(await visibleComments(story.slug)).not.toContain(commentId);

    const comment = await api.request(`/api/stories/${story.slug}/comments`, {
      method: "POST",
      as: offender,
      body: { content: "Still here." },
    });
    expect(comment.status).toBe(403);

    const discussion = await api.request(`/api/clubs/${club.slug}/discussions`, {
      method: "POST",
      as: offender,
      body: { body: "Still here too." },
    });
    expect(discussion.status).toBe(403);

    const report = await fileReport(offender, {
      targetType: "COMMENT",
      targetId: await api.createComment({
        storyId: story.id,
        userId: other,
      }),
    });
    expect(report.status).toBe(403);

    // Reading is untouched, which is what makes this a suspension rather than
    // a ban.
    const reading = await api.request(`/api/stories/${story.slug}/comments`, {
      as: offender,
    });
    expect(reading.status).toBe(200);

    // And dismissing the report that imposed it lifts it again.
    expect(
      (await resolve(moderator, filed.body.report.id, "DISMISS")).status,
    ).toBe(200);
    expect(await api.readSuspended(offender)).toBe(false);
  });

  it("refuses to suspend an administrator", async () => {
    const commentId = await api.createComment({
      storyId: story.id,
      userId: moderator,
      content: "Written by staff.",
    });

    const filed = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: commentId,
    });
    expect(filed.status).toBe(201);

    const acted = await resolve(moderator, filed.body.report.id, "SUSPEND");
    expect(acted.status).toBe(409);
    expect(await api.readSuspended(moderator)).toBe(false);
    // Nothing was hidden either: the guard runs before any write.
    expect(await visibleComments(story.slug)).toContain(commentId);
  });
});

describe.skipIf(!available)("telling people what happened", () => {
  /** The notification types sitting in an account's bell. */
  async function inboxTypes(as: string): Promise<string[]> {
    const response = await api.request<{ items: { type: string }[] }>(
      "/api/notifications",
      { as },
    );

    expect(response.status).toBe(200);
    return response.body.items.map((item) => item.type);
  }

  async function inboxOf(as: string, type: string) {
    const response = await api.request<{
      items: { type: string; title: string; excerpt: string | null }[];
    }>("/api/notifications", { as });

    expect(response.status).toBe(200);
    return response.body.items.filter((item) => item.type === type);
  }

  it("tells an author their comment was hidden, and why", async () => {
    const author = await api.createUser("mhidden");
    const commentId = await api.createComment({
      storyId: story.id,
      userId: author,
      content: "Buy my thing.",
    });

    const filed = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: commentId,
      reason: "SPAM",
      details: "This person is a menace and here is my opinion of them.",
    });
    expect(filed.status).toBe(201);

    expect((await resolve(moderator, filed.body.report.id, "HIDE")).status).toBe(
      200,
    );
    await settle();

    const told = await inboxOf(author, "CONTENT_HIDDEN");
    expect(told).toHaveLength(1);
    expect(told[0]?.title).toBe("Your comment was hidden");
    // The category, not the reporter's words about them.
    expect(told[0]?.excerpt).toBe("A moderator hid it for spam or advertising.");
    expect(told[0]?.excerpt).not.toContain("menace");
  });

  it("tells the reporter the outcome, without naming the author", async () => {
    const author = await api.createUser("mreported");
    // Its own reporter: the shared fixture has filed reports all over this
    // file, and "exactly one" is the assertion that matters here.
    const asker = await api.createUser("masker");
    const commentId = await api.createComment({
      storyId: story.id,
      userId: author,
      content: "Something reportable.",
    });

    const filed = await fileReport(asker, {
      targetType: "COMMENT",
      targetId: commentId,
    });
    expect(filed.status).toBe(201);

    expect((await resolve(moderator, filed.body.report.id, "HIDE")).status).toBe(
      200,
    );
    await settle();

    const told = await inboxOf(asker, "REPORT_RESOLVED");
    expect(told).toHaveLength(1);
    expect(told[0]?.title).toBe("Your report on a comment was reviewed");
    expect(told[0]?.excerpt).toBe("The content was hidden.");
    expect(told[0]?.title).not.toContain(author);
  });

  it("says nothing to an author whose report was dismissed", async () => {
    const author = await api.createUser("mkept");
    const commentId = await api.createComment({
      storyId: story.id,
      userId: author,
      content: "Perfectly fine, actually.",
    });

    const asker = await api.createUser("mdismissed");
    const filed = await fileReport(asker, {
      targetType: "COMMENT",
      targetId: commentId,
    });
    expect(filed.status).toBe(201);

    expect(
      (await resolve(moderator, filed.body.report.id, "DISMISS")).status,
    ).toBe(200);
    await settle();

    // Nothing was done to them, so there is nothing to tell them -- and a
    // grievance they did not have is not worth handing over.
    expect(await inboxTypes(author)).not.toContain("CONTENT_HIDDEN");
    // The reporter still hears, because they asked.
    const told = await inboxOf(asker, "REPORT_RESOLVED");
    expect(told).toHaveLength(1);
    expect(told[0]?.excerpt).toBe("We looked at it and took no action.");
  });
});

describe.skipIf(!available)("reinstating an account", () => {
  async function reinstate(as: string, userId: string) {
    return api.request<{ user: { id: string } }>(
      `/api/moderation/users/${userId}/reinstate`,
      { method: "POST", as },
    );
  }

  it("lifts a suspension without the report that imposed it", async () => {
    const offender = await api.createUser("mstranded");
    const commentId = await api.createComment({
      storyId: story.id,
      userId: offender,
      content: "Worth a suspension.",
    });

    const filed = await fileReport(reporter, {
      targetType: "COMMENT",
      targetId: commentId,
    });
    expect(
      (await resolve(moderator, filed.body.report.id, "SUSPEND")).status,
    ).toBe(200);
    expect(await api.readSuspended(offender)).toBe(true);

    const lifted = await reinstate(moderator, offender);
    expect(lifted.status).toBe(200);
    expect(lifted.body.user.id).toBe(offender);
    expect(await api.readSuspended(offender)).toBe(false);
  });

  it("409s for an account in good standing", async () => {
    const fine = await api.createUser("mfine");

    const { status } = await reinstate(moderator, fine);

    expect(status).toBe(409);
  });

  it("404s for an account that does not exist", async () => {
    const { status } = await reinstate(
      moderator,
      "00000000-0000-4000-8000-0000000000ff",
    );

    expect(status).toBe(404);
  });

  it("is administrators only", async () => {
    const offender = await api.createUser("mstill");

    const { status } = await reinstate(reporter, offender);

    expect(status).toBe(403);
  });
});
