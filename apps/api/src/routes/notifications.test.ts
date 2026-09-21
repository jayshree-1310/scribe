import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { flushBadges } from "../services/gamification.js";
import {
  flushNotifications,
  pruneExpired,
  resetPruneThrottle,
} from "../services/notifications.js";
import type { Notification, NotificationPage } from "../services/notifications.js";

const api = new TestApi();
const available = await databaseAvailable();

/**
 * Fan-out is fire-and-forget, so every assertion about it has to wait for the
 * write the request did not wait for. These two flushes are that seam; a suite
 * that read straight after the `POST` would be racing the insert and would
 * fail about one run in ten, which is worse than failing every time.
 *
 * Badges first, and not in parallel: an award issues its own notification as
 * it lands, so draining notifications alongside badges can finish before the
 * badge has handed one over. The same order every other drain site uses.
 */
async function settle(): Promise<void> {
  await flushBadges();
  await flushNotifications();
}

/** One person's list, read the way the bell reads it. */
async function inbox(
  userId: string,
  query = "",
): Promise<NotificationPage> {
  const response = await api.request<NotificationPage>(
    `/api/notifications${query}`,
    { as: userId },
  );

  expect(response.status).toBe(200);
  return response.body;
}

/** Just the types, which is what most of these assertions are about. */
async function typesFor(userId: string): Promise<string[]> {
  return (await inbox(userId)).items.map((item) => item.type);
}

let author: string;
let follower: string;
let subscriber: string;
let member: string;
let bystander: string;
let reader: string;

let channel: { id: string; slug: string };
let club: { id: string; slug: string };
let story: { id: string; slug: string };
let chapterId: string;

beforeAll(async () => {
  if (!available) return;
  await api.start();

  author = await api.createUser("nauthor", { isAuthor: true });
  follower = await api.createUser("nfollow");
  subscriber = await api.createUser("nsub");
  member = await api.createUser("nmember");
  // In nothing: the control every fan-out assertion is measured against.
  bystander = await api.createUser("nby");
  reader = await api.createUser("nreader");

  channel = await api.createChannel({ name: "Notify Channel", authorId: author });
  await api.subscribeToChannel({ channelId: channel.id, userId: subscriber });
  // The author subscribed to their own channel, which is what makes "no
  // self-notification" a real assertion rather than an absent row.
  await api.subscribeToChannel({ channelId: channel.id, userId: author });

  club = await api.createClub({ name: "Notify Club", creatorId: author });
  await api.addClubMember({ clubId: club.id, userId: member });
  await api.addClubMember({ clubId: club.id, userId: reader });

  await api.createFollow({ followerId: follower, followingId: author });

  story = await api.createStory({ title: "Notify Story", authorId: author });
  chapterId = await api.createChapter({ storyId: story.id, number: 1 });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

describe.skipIf(!available)("channel posts", () => {
  it("reaches subscribers and nobody else", async () => {
    const response = await api.request(`/api/channels/${channel.slug}/posts`, {
      method: "POST",
      as: author,
      body: { title: "Chapter four is up", content: "It took a while." },
    });
    expect(response.status).toBe(201);
    await settle();

    const [sub, outsider] = await Promise.all([
      inbox(subscriber),
      inbox(bystander),
    ]);

    expect(sub.items).toHaveLength(1);
    expect(sub.items[0]?.type).toBe("CHANNEL_POST");
    expect(outsider.items).toHaveLength(0);
  });

  it("names the channel and quotes the post", async () => {
    const [notification] = (await inbox(subscriber)).items;

    expect(notification?.title).toBe("Notify Channel");
    expect(notification?.excerpt).toBe("Chapter four is up");
    expect(notification?.href).toBe(`/channels/${channel.slug}`);
    expect(notification?.actor?.id).toBe(author);
  });

  it("does not tell the author about their own post", async () => {
    // Subscribed to their own channel in `beforeAll`, so this is the rule and
    // not an accident of who happens to be listening.
    expect(await typesFor(author)).not.toContain("CHANNEL_POST");
  });
});

describe.skipIf(!available)("club discussions", () => {
  let threadId: string;

  it("tells every other member about a new thread", async () => {
    const response = await api.request<{ discussion: { id: string } }>(
      `/api/clubs/${club.slug}/discussions`,
      { method: "POST", as: author, body: { body: "What did everyone think?" } },
    );
    expect(response.status).toBe(201);
    threadId = response.body.discussion.id;
    await settle();

    expect(await typesFor(member)).toContain("CLUB_DISCUSSION");
    expect(await typesFor(reader)).toContain("CLUB_DISCUSSION");
    // The poster is a member too, and is still not told.
    expect(await typesFor(author)).not.toContain("CLUB_DISCUSSION");
    expect(await typesFor(bystander)).not.toContain("CLUB_DISCUSSION");
  });

  it("tells only the thread's author about a reply", async () => {
    const before = (await inbox(reader)).total;

    const response = await api.request(`/api/clubs/${club.slug}/discussions`, {
      method: "POST",
      as: member,
      body: { body: "I liked the ending.", parentId: threadId },
    });
    expect(response.status).toBe(201);
    await settle();

    // The person replied to hears about it...
    expect(await typesFor(author)).toContain("COMMENT_REPLY");
    // ...and the rest of the club does not. A thread with twenty replies is
    // otherwise twenty notifications for every member.
    expect((await inbox(reader)).total).toBe(before);
  });
});

describe.skipIf(!available)("story comments", () => {
  let commentId: string;

  it("tells the story's author about a top-level comment", async () => {
    const response = await api.request<{ comment: { id: string } }>(
      `/api/stories/${story.slug}/comments`,
      { method: "POST", as: reader, body: { content: "Lovely opening." } },
    );
    expect(response.status).toBe(201);
    commentId = response.body.comment.id;
    await settle();

    const notification = (await inbox(author)).items.find(
      (item) => item.type === "STORY_COMMENT",
    );

    expect(notification).toBeDefined();
    expect(notification?.title).toBe("Notify Story");
    expect(notification?.excerpt).toBe("Lovely opening.");
    expect(notification?.href).toBe(`/story/${story.slug}`);
    expect(notification?.actor?.id).toBe(reader);
  });

  it("says nothing about a comment on your own story", async () => {
    const countStoryComments = async (): Promise<number> =>
      (await inbox(author)).items.filter(
        (item) => item.type === "STORY_COMMENT",
      ).length;

    const before = await countStoryComments();

    const response = await api.request(`/api/stories/${story.slug}/comments`, {
      method: "POST",
      as: author,
      body: { content: "Thanks for reading." },
    });
    expect(response.status).toBe(201);
    await settle();

    /**
     * Counted by type rather than off `total`, which this comment moves for an
     * unrelated reason: commenting is a badge metric, so the author may earn
     * one and be sent a `BADGE_EARNED` in the same breath. Asserting the total
     * would make this test fail on the badge engine's behaviour rather than on
     * the rule it is about.
     */
    expect(await countStoryComments()).toBe(before);
  });

  it("tells the author of the comment a reply answers", async () => {
    // The story's author is a third party to this reply, and the point of the
    // assertion below is that they stay one: `STORY_COMMENT` fires on the
    // thread and not again on every answer to it.
    const authorBefore = (await inbox(author)).total;

    const response = await api.request(`/api/stories/${story.slug}/comments`, {
      method: "POST",
      as: member,
      body: { content: "Agreed.", parentId: commentId },
    });
    expect(response.status).toBe(201);
    await settle();

    const reply = (await inbox(reader)).items.find(
      (item) => item.type === "COMMENT_REPLY",
    );

    expect(reply).toBeDefined();
    expect(reply?.title).toBe("Notify Story");
    expect(reply?.excerpt).toBe("Agreed.");
    expect(reply?.actor?.id).toBe(member);
  });

  it("does not also tell the story's author about a reply", async () => {
    const before = (await inbox(author)).total;

    const response = await api.request(`/api/stories/${story.slug}/comments`, {
      method: "POST",
      as: member,
      body: { content: "Second that.", parentId: commentId },
    });
    expect(response.status).toBe(201);
    await settle();

    // One comment is one notification: `notifyCommentParent` matched and
    // `notifyStoryAuthor` did not, because the two conditions are exclusive.
    expect((await inbox(author)).total).toBe(before);
  });

  it("says nothing when somebody replies to themselves", async () => {
    const before = (await inbox(reader)).total;

    const response = await api.request(`/api/stories/${story.slug}/comments`, {
      method: "POST",
      as: reader,
      body: { content: "One more thought.", parentId: commentId },
    });
    expect(response.status).toBe(201);
    await settle();

    expect((await inbox(reader)).total).toBe(before);
  });

  it("links a chapter-scoped thread at the chapter", async () => {
    const thread = await api.request<{ comment: { id: string } }>(
      `/api/stories/${story.slug}/comments`,
      { method: "POST", as: reader, body: { content: "On this bit.", chapterId } },
    );
    expect(thread.status).toBe(201);

    const reply = await api.request(`/api/stories/${story.slug}/comments`, {
      method: "POST",
      as: member,
      body: { content: "Same.", parentId: thread.body.comment.id },
    });
    expect(reply.status).toBe(201);
    await settle();

    // A reader sent to the story page would have to find which of forty
    // chapters was being discussed.
    const [latest] = (await inbox(reader)).items;
    expect(latest?.href).toBe(`/read/${story.slug}/1`);
  });
});

describe.skipIf(!available)("new stories", () => {
  let draft: { id: string; slug: string };

  it("tells followers when a story is listed", async () => {
    draft = await api.createStory({
      title: "Held Back",
      authorId: author,
      listed: false,
    });
    await api.createChapter({ storyId: draft.id, number: 1 });

    const response = await api.request(
      `/api/author/stories/${draft.id}/publish`,
      { method: "POST", as: author },
    );
    expect(response.status).toBe(200);
    await settle();

    const announced = (await inbox(follower)).items.filter(
      (item) => item.type === "NEW_STORY",
    );

    expect(announced).toHaveLength(1);
    expect(announced[0]?.title).toBe("Held Back");
    expect(announced[0]?.href).toBe(`/story/${draft.slug}`);
    // Not in anybody else's list: this is the follow graph, not the platform.
    expect(await typesFor(bystander)).not.toContain("NEW_STORY");
  });

  it("does not announce the same story twice", async () => {
    const before = (await inbox(follower)).total;

    // Publishing an already-listed story is a correction, not a release --
    // the same transition `listedAt` records.
    const again = await api.request(
      `/api/author/stories/${draft.id}/publish`,
      { method: "POST", as: author },
    );
    expect(again.status).toBe(200);
    await settle();

    expect((await inbox(follower)).total).toBe(before);
  });
});

describe.skipIf(!available)("badges", () => {
  it("tells the earner, with no actor beside it", async () => {
    // A first comment earns `first-comment`, which is the cheapest badge to
    // provoke through a real endpoint.
    const earner = await api.createUser("nbadge");

    const response = await api.request(`/api/stories/${story.slug}/comments`, {
      method: "POST",
      as: earner,
      body: { content: "My first." },
    });
    expect(response.status).toBe(201);
    await settle();

    const earned = (await inbox(earner)).items.filter(
      (item) => item.type === "BADGE_EARNED",
    );

    expect(earned).toHaveLength(1);
    expect(earned[0]?.title).toBe("First Comment");
    expect(earned[0]?.href).toBe("/badges");
    // The one type nobody else caused, and so the one with no face beside it.
    expect(earned[0]?.actor).toBeNull();
  });
});

describe.skipIf(!available)("reading and counting", () => {
  let counted: string;
  let items: Notification[];

  beforeAll(async () => {
    if (!available) return;

    counted = await api.createUser("ncount");
    await api.subscribeToChannel({ channelId: channel.id, userId: counted });

    for (const title of ["First", "Second", "Third"]) {
      const response = await api.request(
        `/api/channels/${channel.slug}/posts`,
        { method: "POST", as: author, body: { title, content: "Body." } },
      );
      expect(response.status).toBe(201);
    }
    await settle();

    items = (await inbox(counted)).items;
  });

  it("starts with everything unread, newest first", () => {
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.excerpt)).toEqual([
      "Third",
      "Second",
      "First",
    ]);
    expect(items.every((item) => item.readAt === null)).toBe(true);
  });

  it("counts down one at a time, and answers with the new count", async () => {
    const first = await api.request<{ unreadCount: number }>(
      `/api/notifications/${items[0]?.id}/read`,
      { method: "POST", as: counted },
    );

    expect(first.status).toBe(200);
    expect(first.body.unreadCount).toBe(2);
    expect((await inbox(counted)).unreadCount).toBe(2);
  });

  it("does not fail when the same one is read twice", async () => {
    const again = await api.request<{ unreadCount: number }>(
      `/api/notifications/${items[0]?.id}/read`,
      { method: "POST", as: counted },
    );

    // A second click is a no-op, not a 404: the row is still theirs.
    expect(again.status).toBe(200);
    expect(again.body.unreadCount).toBe(2);
  });

  it("keeps the count whole while the list is filtered", async () => {
    const unread = await inbox(counted, "?unread=true");

    // Two of three rows, and still the account's count rather than the page's.
    expect(unread.items).toHaveLength(2);
    expect(unread.total).toBe(2);
    expect(unread.unreadCount).toBe(2);

    const all = await inbox(counted);
    expect(all.total).toBe(3);
    expect(all.unreadCount).toBe(2);
  });

  it("pages without repeating a row", async () => {
    const [first, second] = await Promise.all([
      inbox(counted, "?limit=2&page=1"),
      inbox(counted, "?limit=2&page=2"),
    ]);

    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);

    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("clears the lot", async () => {
    const response = await api.request<{ unreadCount: number }>(
      "/api/notifications/read-all",
      { method: "POST", as: counted },
    );

    expect(response.status).toBe(200);
    expect(response.body.unreadCount).toBe(0);

    const after = await inbox(counted);
    expect(after.unreadCount).toBe(0);
    // Read, not gone: the list is a history.
    expect(after.total).toBe(3);
    expect(after.items.every((item) => item.readAt !== null)).toBe(true);
  });
});

describe.skipIf(!available)("clearing", () => {
  let clearer: string;
  /** Subscribed to the same channel, and never the one doing the clearing. */
  let neighbour: string;

  beforeAll(async () => {
    if (!available) return;

    clearer = await api.createUser("nclear");
    // Distinct in its first four characters, which is all that survives the
    // harness's 30-character username: `nclearby` would collide with `nclear`.
    neighbour = await api.createUser("nkeep");
    await api.subscribeToChannel({ channelId: channel.id, userId: clearer });
    await api.subscribeToChannel({ channelId: channel.id, userId: neighbour });

    for (const title of ["Keep", "Drop A", "Drop B"]) {
      const response = await api.request(
        `/api/channels/${channel.slug}/posts`,
        { method: "POST", as: author, body: { title, content: "Body." } },
      );
      expect(response.status).toBe(201);
    }
    await settle();

    // The neighbour reads everything, so their whole list is exactly what a
    // `DELETE` that forgot its `userId` would destroy.
    const read = await api.request("/api/notifications/read-all", {
      method: "POST",
      as: neighbour,
    });
    expect(read.status).toBe(200);
  });

  it("deletes the read ones and leaves the unread alone", async () => {
    const before = await inbox(clearer);
    expect(before.total).toBe(3);

    // Newest first, so this reads "Drop B" and "Drop A" and leaves "Keep".
    for (const item of before.items.slice(0, 2)) {
      const read = await api.request(
        `/api/notifications/${item.id}/read`,
        { method: "POST", as: clearer },
      );
      expect(read.status).toBe(200);
    }

    const cleared = await api.request<{ unreadCount: number }>(
      "/api/notifications/read",
      { method: "DELETE", as: clearer },
    );

    expect(cleared.status).toBe(200);
    // Unchanged by definition: clearing touches nothing unread.
    expect(cleared.body.unreadCount).toBe(1);

    const after = await inbox(clearer);
    expect(after.total).toBe(1);
    expect(after.items.map((item) => item.excerpt)).toEqual(["Keep"]);
    expect(after.items[0]?.readAt).toBeNull();
  });

  it("is a no-op when nothing has been read", async () => {
    const response = await api.request<{ unreadCount: number }>(
      "/api/notifications/read",
      { method: "DELETE", as: clearer },
    );

    expect(response.status).toBe(200);
    expect(response.body.unreadCount).toBe(1);
    expect(await api.countNotifications(clearer)).toBe(1);
  });

  it("clears only the caller's", async () => {
    // Every one of the neighbour's is read, and the `DELETE`s above ran as
    // `clearer`. A statement that forgot its `userId` would have emptied this.
    const theirs = await inbox(neighbour);

    expect(theirs.total).toBe(3);
    expect(theirs.items.every((item) => item.readAt !== null)).toBe(true);
  });

  it("turns away a caller with no session", async () => {
    const response = await api.request("/api/notifications/read", {
      method: "DELETE",
    });

    expect(response.status).toBe(401);
  });
});

describe.skipIf(!available)("retention", () => {
  let aged: string;

  beforeAll(async () => {
    if (!available) return;

    aged = await api.createUser("naged");
    await api.subscribeToChannel({ channelId: channel.id, userId: aged });

    for (const title of ["Old read", "Old unread", "Recent"]) {
      const response = await api.request(
        `/api/channels/${channel.slug}/posts`,
        { method: "POST", as: author, body: { title, content: "Body." } },
      );
      expect(response.status).toBe(201);
    }
    await settle();
  });

  it("drops a read notification a week after it was read", async () => {
    const before = await inbox(aged);
    expect(before.total).toBe(3);

    const [recent, unread, read] = before.items;
    expect(read?.excerpt).toBe("Old read");

    const marked = await api.request(`/api/notifications/${read?.id}/read`, {
      method: "POST",
      as: aged,
    });
    expect(marked.status).toBe(200);

    // Everything eight days back: past the read ceiling, nowhere near the
    // thirty-day one, so only the row that was read should go.
    await api.backdateNotifications(aged, 8);
    await pruneExpired(aged);

    const after = await inbox(aged);
    expect(after.total).toBe(2);
    expect(after.items.map((item) => item.id).sort()).toEqual(
      [recent?.id, unread?.id].sort(),
    );
    // Untouched, so the bell still says there are two things to look at.
    expect(after.unreadCount).toBe(2);
  });

  it("keeps a read notification that is only a day old", async () => {
    const [newest] = (await inbox(aged)).items;

    const marked = await api.request(`/api/notifications/${newest?.id}/read`, {
      method: "POST",
      as: aged,
    });
    expect(marked.status).toBe(200);

    await api.backdateNotifications(aged, 1);
    await pruneExpired(aged);

    expect(await api.countNotifications(aged)).toBe(2);
  });

  it("drops an unread notification after a month", async () => {
    // Both remaining rows are now nine and thirty-one days old respectively
    // once this lands; the ceiling is on `createdAt` and ignores `readAt`.
    await api.backdateNotifications(aged, 31);
    await pruneExpired(aged);

    expect(await api.countNotifications(aged)).toBe(0);
  });

  it("sweeps on a list read, without being asked", async () => {
    const swept = await api.createUser("nswept");
    await api.subscribeToChannel({ channelId: channel.id, userId: swept });

    const response = await api.request(
      `/api/channels/${channel.slug}/posts`,
      { method: "POST", as: author, body: { title: "Stale", content: "Body." } },
    );
    expect(response.status).toBe(201);
    await settle();

    await api.backdateNotifications(swept, 40);

    // The throttle is per account and stamped on the first read, so a fixture
    // that has never listed is swept by its first request either way; clearing
    // it keeps this test honest if that setup ever changes.
    resetPruneThrottle();

    expect((await inbox(swept)).total).toBe(0);
    expect(await api.countNotifications(swept)).toBe(0);
  });

  it("sweeps at most once an hour for one account", async () => {
    const throttled = await api.createUser("nthrottle");
    await api.subscribeToChannel({ channelId: channel.id, userId: throttled });

    const response = await api.request(
      `/api/channels/${channel.slug}/posts`,
      { method: "POST", as: author, body: { title: "Fresh", content: "Body." } },
    );
    expect(response.status).toBe(201);
    await settle();

    resetPruneThrottle();
    // First read stamps the throttle and sweeps nothing: the row is new.
    expect((await inbox(throttled)).total).toBe(1);

    // Now age it past both ceilings. The next read is inside the hour, so the
    // row survives -- which is what proves the throttle is doing something.
    await api.backdateNotifications(throttled, 40);
    expect(await api.countNotifications(throttled)).toBe(1);

    const second = await inbox(throttled);
    expect(second.total).toBe(1);
    expect(await api.countNotifications(throttled)).toBe(1);

    // And it goes the moment the throttle is out of the way.
    resetPruneThrottle();
    expect((await inbox(throttled)).total).toBe(0);
  });
});

describe.skipIf(!available)("access", () => {
  it("turns away a caller with no session", async () => {
    const response = await api.request("/api/notifications");

    expect(response.status).toBe(401);
  });

  it("will not let one reader read another's", async () => {
    const [mine] = (await inbox(subscriber)).items;
    expect(mine).toBeDefined();

    const response = await api.request(
      `/api/notifications/${mine?.id}/read`,
      { method: "POST", as: bystander },
    );

    // 404 rather than 403: the id of a row that is not yours is not something
    // the API should confirm exists.
    expect(response.status).toBe(404);
    expect((await inbox(subscriber)).items[0]?.readAt).toBeNull();
  });
});
