import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

/** The channel's author -- the only privileged user a channel has. */
let author: string;
/** Another author, so "not yours" is a real account and not just absence. */
let rival: string;
let reader: string;

let channelId: string;
let channelSlug: string;

/** Four posts on `channelId`, written a day apart, newest last. */
let postIds: string[] = [];

beforeAll(async () => {
  if (!available) return;
  await api.start();

  author = await api.createUser("aut");
  rival = await api.createUser("riv");
  reader = await api.createUser("rea");

  const channel = await api.createChannel({
    name: "Notes from the Coast",
    authorId: author,
  });
  channelId = channel.id;
  channelSlug = channel.slug;

  // Written a day apart so the feed's ordering is not a coin flip between
  // rows sharing a millisecond.
  const base = Date.UTC(2026, 7, 1);
  postIds = [];
  for (let index = 0; index < 4; index += 1) {
    postIds.push(
      await api.createChannelPost({
        channelId,
        title: `Chapter ${index + 1} is live`,
        content: `Body of post ${index + 1}.`,
        postedAt: new Date(base + index * 86_400_000),
      }),
    );
  }
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

describe.skipIf(!available)("reading channels", () => {
  it("lists channels publicly, with both counts", async () => {
    const { status, body } = await api.request("/api/channels");

    expect(status).toBe(200);

    const found = body.items.find(
      (channel: { id: string }) => channel.id === channelId,
    );
    expect(found.postCount).toBe(4);
    expect(found.subscriberCount).toBe(0);
    expect(found.subscribed).toBe(false);
    expect(found.author.id).toBe(author);
  });

  it("addresses a channel by slug or by id alike", async () => {
    const bySlug = await api.request(`/api/channels/${channelSlug}`);
    const byId = await api.request(`/api/channels/${channelId}`);

    expect(bySlug.body.channel.id).toBe(byId.body.channel.id);
  });

  it("reports the caller's subscription state when signed in", async () => {
    await api.subscribeToChannel({ channelId, userId: reader });

    const theirs = await api.request(`/api/channels/${channelSlug}`, {
      as: reader,
    });
    const anonymous = await api.request(`/api/channels/${channelSlug}`);

    expect(theirs.body.channel.subscribed).toBe(true);
    expect(theirs.body.channel.subscriberCount).toBe(1);

    // An anonymous caller has no subscription to report, and the count is
    // still the truth.
    expect(anonymous.body.channel.subscribed).toBe(false);
    expect(anonymous.body.channel.subscriberCount).toBe(1);
  });

  it("filters to the channels the caller owns", async () => {
    const mine = await api.request("/api/channels?mine=true", { as: author });
    const theirs = await api.request("/api/channels?mine=true", { as: rival });

    expect(mine.body.items.map((item: { id: string }) => item.id)).toContain(
      channelId,
    );
    expect(
      theirs.body.items.map((item: { id: string }) => item.id),
    ).not.toContain(channelId);
  });

  it("filters to the channels the caller subscribes to", async () => {
    const subscribed = await api.request("/api/channels?subscribed=true", {
      as: reader,
    });
    const none = await api.request("/api/channels?subscribed=true", {
      as: rival,
    });

    expect(
      subscribed.body.items.map((item: { id: string }) => item.id),
    ).toContain(channelId);
    expect(none.body.items).toHaveLength(0);
  });

  it("404s on a channel that does not exist", async () => {
    const { status, body } = await api.request("/api/channels/no-such-channel");

    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});

describe.skipIf(!available)("owner-only enforcement", () => {
  it("401s on every privileged route without a caller", async () => {
    const responses = await Promise.all([
      api.request("/api/channels", {
        method: "POST",
        body: { name: "Anonymous Channel" },
      }),
      api.request(`/api/channels/${channelId}`, {
        method: "PATCH",
        body: { name: "Renamed" },
      }),
      api.request(`/api/channels/${channelId}`, { method: "DELETE" }),
      api.request(`/api/channels/${channelId}/subscribe`, { method: "POST" }),
      api.request(`/api/channels/${channelId}/subscribe`, { method: "DELETE" }),
      api.request(`/api/channels/${channelId}/posts`, {
        method: "POST",
        body: { title: "Hello", content: "Anyone there?" },
      }),
      api.request(`/api/channels/posts/${postIds[0]}`, {
        method: "PATCH",
        body: { title: "Rewritten" },
      }),
      api.request(`/api/channels/posts/${postIds[0]}`, { method: "DELETE" }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("unauthorized");
    }
  });

  it("403s anybody but the author on every channel write", async () => {
    const responses = await Promise.all([
      api.request(`/api/channels/${channelId}`, {
        method: "PATCH",
        as: rival,
        body: { name: "Hijacked" },
      }),
      api.request(`/api/channels/${channelId}`, {
        method: "DELETE",
        as: rival,
      }),
      api.request(`/api/channels/${channelId}/posts`, {
        method: "POST",
        as: rival,
        body: { title: "Not mine", content: "But I posted it." },
      }),
      // A subscriber is no more privileged than a stranger.
      api.request(`/api/channels/${channelId}/posts`, {
        method: "POST",
        as: reader,
        body: { title: "Subscriber post", content: "Should be refused." },
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("forbidden");
    }
  });

  it("403s anybody but the author on a post write", async () => {
    const responses = await Promise.all([
      api.request(`/api/channels/posts/${postIds[0]}`, {
        method: "PATCH",
        as: rival,
        body: { title: "Rewritten by a stranger" },
      }),
      api.request(`/api/channels/posts/${postIds[0]}`, {
        method: "DELETE",
        as: reader,
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("forbidden");
    }

    // And the post is untouched.
    const feed = await api.request(`/api/channels/${channelSlug}/posts`);
    expect(feed.body.items.map((post: { id: string }) => post.id)).toContain(
      postIds[0],
    );
  });

  it("404s a post that does not exist, before asking who owns it", async () => {
    const missing = "00000000-0000-4000-8000-0000000000ff";

    const { status, body } = await api.request(
      `/api/channels/posts/${missing}`,
      { method: "DELETE", as: author },
    );

    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("lets the author rename the channel without moving its slug", async () => {
    const { status, body } = await api.request(`/api/channels/${channelId}`, {
      method: "PATCH",
      as: author,
      body: { name: "Notes from the Coast (Revived)" },
    });

    expect(status).toBe(200);
    expect(body.channel.name).toBe("Notes from the Coast (Revived)");
    expect(body.channel.slug).toBe(channelSlug);
  });

  it("rejects a PATCH that changes nothing", async () => {
    const { status } = await api.request(`/api/channels/${channelId}`, {
      method: "PATCH",
      as: author,
      body: {},
    });

    expect(status).toBe(400);
  });
});

describe.skipIf(!available)("creating a channel", () => {
  it("makes the caller its author and marks them an author", async () => {
    const { status, body } = await api.request("/api/channels", {
      method: "POST",
      as: rival,
      body: { name: "Maintenance Log", description: "Process notes." },
    });

    expect(status).toBe(201);
    api.trackChannel(body.channel.id);

    expect(body.channel.author.id).toBe(rival);
    expect(body.channel.slug).toBe("maintenance-log");
    expect(body.channel.subscriberCount).toBe(0);
    expect(body.channel.postCount).toBe(0);
    // Opening a channel is an authoring act, the same as starting a story.
    expect(body.channel.subscribed).toBe(false);
  });

  it("suffixes a slug that is already taken", async () => {
    const { body } = await api.request("/api/channels", {
      method: "POST",
      as: rival,
      body: { name: "Maintenance Log" },
    });

    api.trackChannel(body.channel.id);
    expect(body.channel.slug).toBe("maintenance-log-2");
  });

  it("rejects a name that is too short", async () => {
    const { status, body } = await api.request("/api/channels", {
      method: "POST",
      as: rival,
      body: { name: "x" },
    });

    expect(status).toBe(400);
    expect(body.error.details.name).toBeDefined();
  });

  it("deletes a channel with its posts and subscribers", async () => {
    const created = await api.request("/api/channels", {
      method: "POST",
      as: rival,
      body: { name: "Short Lived Channel" },
    });
    const doomed = created.body.channel.id;
    api.trackChannel(doomed);

    await api.request(`/api/channels/${doomed}/posts`, {
      method: "POST",
      as: rival,
      body: { title: "First and last", content: "Goodbye." },
    });
    await api.request(`/api/channels/${doomed}/subscribe`, {
      method: "POST",
      as: reader,
    });

    const deleted = await api.request(`/api/channels/${doomed}`, {
      method: "DELETE",
      as: rival,
    });

    expect(deleted.status).toBe(204);
    expect((await api.request(`/api/channels/${doomed}`)).status).toBe(404);
  });
});

describe.skipIf(!available)("subscribing", () => {
  it("is idempotent: subscribing twice succeeds and counts once", async () => {
    const fresh = await api.createChannel({
      name: "Idempotent Channel",
      authorId: author,
    });

    const first = await api.request(`/api/channels/${fresh.id}/subscribe`, {
      method: "POST",
      as: reader,
    });
    const second = await api.request(`/api/channels/${fresh.id}/subscribe`, {
      method: "POST",
      as: reader,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.subscribed).toBe(true);
    // The second call does not reset the subscription date.
    expect(second.body.subscribedAt).toBe(first.body.subscribedAt);

    const { body } = await api.request(`/api/channels/${fresh.slug}`, {
      as: reader,
    });
    expect(body.channel.subscriberCount).toBe(1);
    expect(body.channel.subscribed).toBe(true);
  });

  it("is idempotent the other way: unsubscribing twice succeeds", async () => {
    const fresh = await api.createChannel({
      name: "Unsubscribe Twice",
      authorId: author,
    });

    await api.request(`/api/channels/${fresh.id}/subscribe`, {
      method: "POST",
      as: reader,
    });

    const first = await api.request(`/api/channels/${fresh.id}/subscribe`, {
      method: "DELETE",
      as: reader,
    });
    const second = await api.request(`/api/channels/${fresh.id}/subscribe`, {
      method: "DELETE",
      as: reader,
    });

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);

    const { body } = await api.request(`/api/channels/${fresh.slug}`, {
      as: reader,
    });
    expect(body.channel.subscriberCount).toBe(0);
    expect(body.channel.subscribed).toBe(false);
  });

  it("unsubscribing from something you never followed is not an error", async () => {
    const { status } = await api.request(
      `/api/channels/${channelId}/subscribe`,
      { method: "DELETE", as: rival },
    );

    expect(status).toBe(204);
  });

  it("404s on subscribing to a channel that does not exist", async () => {
    const { status } = await api.request("/api/channels/nope/subscribe", {
      method: "POST",
      as: reader,
    });

    expect(status).toBe(404);
  });

  it("keeps one reader's subscription out of another's view", async () => {
    const mine = await api.request(`/api/channels/${channelSlug}`, {
      as: reader,
    });
    const theirs = await api.request(`/api/channels/${channelSlug}`, {
      as: rival,
    });

    expect(mine.body.channel.subscribed).toBe(true);
    expect(theirs.body.channel.subscribed).toBe(false);
  });
});

describe.skipIf(!available)("the post feed", () => {
  it("is public and ordered newest first", async () => {
    const { status, body } = await api.request(
      `/api/channels/${channelSlug}/posts`,
    );

    expect(status).toBe(200);
    expect(body.total).toBe(4);
    expect(body.items.map((post: { id: string }) => post.id)).toEqual(
      [...postIds].reverse(),
    );
  });

  it("paginates without repeating or dropping a post", async () => {
    const first = await api.request(
      `/api/channels/${channelSlug}/posts?page=1&limit=2`,
    );
    const second = await api.request(
      `/api/channels/${channelSlug}/posts?page=2&limit=2`,
    );
    const third = await api.request(
      `/api/channels/${channelSlug}/posts?page=3&limit=2`,
    );

    expect(first.body.total).toBe(4);
    expect(first.body.totalPages).toBe(2);
    expect(first.body.hasMore).toBe(true);
    expect(second.body.hasMore).toBe(false);
    expect(third.body.items).toHaveLength(0);

    const paged = [
      ...first.body.items.map((post: { id: string }) => post.id),
      ...second.body.items.map((post: { id: string }) => post.id),
    ];

    // Every post exactly once, still newest first across the page boundary.
    expect(paged).toEqual([...postIds].reverse());
  });

  it("lets the author post, and the post lands at the top", async () => {
    const created = await api.request(`/api/channels/${channelId}/posts`, {
      method: "POST",
      as: author,
      body: {
        title: "Update schedule for autumn",
        content: "Thursdays, as usual.",
      },
    });

    expect(created.status).toBe(201);
    expect(created.body.post.title).toBe("Update schedule for autumn");
    expect(created.body.post.channelId).toBe(channelId);

    const feed = await api.request(`/api/channels/${channelSlug}/posts`);
    expect(feed.body.items[0].id).toBe(created.body.post.id);
    expect(feed.body.total).toBe(5);

    await api.request(`/api/channels/posts/${created.body.post.id}`, {
      method: "DELETE",
      as: author,
    });
  });

  it("rejects an empty title or body", async () => {
    const responses = await Promise.all([
      api.request(`/api/channels/${channelId}/posts`, {
        method: "POST",
        as: author,
        body: { title: "  ", content: "Body is fine." },
      }),
      api.request(`/api/channels/${channelId}/posts`, {
        method: "POST",
        as: author,
        body: { title: "Title is fine", content: "   \n " },
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("validation_error");
    }
  });

  it("edits a post in place", async () => {
    const { status, body } = await api.request(
      `/api/channels/posts/${postIds[1]}`,
      { method: "PATCH", as: author, body: { content: "Rewritten body." } },
    );

    expect(status).toBe(200);
    expect(body.post.content).toBe("Rewritten body.");
    // The title was not in the patch, so it is untouched.
    expect(body.post.title).toBe("Chapter 2 is live");
    expect(body.post.updatedAt).not.toBe(body.post.postedAt);
  });

  it("editing does not move the post in the feed", async () => {
    const before = await api.request(`/api/channels/${channelSlug}/posts`);

    await api.request(`/api/channels/posts/${postIds[0]}`, {
      method: "PATCH",
      as: author,
      body: { title: "Chapter 1 is live (revised)" },
    });

    const after = await api.request(`/api/channels/${channelSlug}/posts`);

    // Ordering is by `postedAt`, not `updatedAt`, so an edit is not a bump.
    expect(after.body.items.map((post: { id: string }) => post.id)).toEqual(
      before.body.items.map((post: { id: string }) => post.id),
    );
  });

  it("deletes a post and nothing else", async () => {
    const deleted = await api.request(`/api/channels/posts/${postIds[3]}`, {
      method: "DELETE",
      as: author,
    });

    expect(deleted.status).toBe(204);

    const feed = await api.request(`/api/channels/${channelSlug}/posts`);
    expect(feed.body.total).toBe(3);
    expect(feed.body.items.map((post: { id: string }) => post.id)).not.toContain(
      postIds[3],
    );
  });

  it("404s the feed of a channel that does not exist", async () => {
    const { status } = await api.request("/api/channels/nope/posts");

    expect(status).toBe(404);
  });
});
