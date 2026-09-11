import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

/** An author with a filled-in profile, so the public shape has real values. */
let author: string;
let authorName: string;

/** Two more readers, so "somebody else follows them too" is expressible. */
let reader: string;
let readerName: string;
let other: string;

beforeAll(async () => {
  if (!available) return;
  await api.start();

  author = await api.createUser("ua", {
    displayName: "Ilse van der Meer",
    bio: "Writes cold northern fantasy.",
    isAuthor: true,
  });
  authorName = api.usernameOf(author);

  reader = await api.createUser("ur");
  readerName = api.usernameOf(reader);

  other = await api.createUser("uo");
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

/* Profile ---------------------------------------------------------------- */

describe.skipIf(!available)("reading a public profile", () => {
  it("serves a profile anonymously with the public fields", async () => {
    const { status, body } = await api.request(`/api/users/${authorName}`);

    expect(status).toBe(200);
    expect(body.profile).toMatchObject({
      id: author,
      username: authorName,
      displayName: "Ilse van der Meer",
      bio: "Writes cold northern fantasy.",
      isAuthor: true,
      readerLevel: 1,
      authorLevel: 1,
      readingStreak: 0,
      followerCount: 0,
      followingCount: 0,
      isFollowing: false,
      isMe: false,
    });
    expect(typeof body.profile.joinedAt).toBe("string");
  });

  /**
   * The point of the whole module: a public profile is written out field by
   * field, so a column added to `auth.User` cannot start leaking through it.
   * Pinning the exact key set is what makes that a test rather than a hope.
   */
  it("never leaks email, password hash or any other private column", async () => {
    const { body } = await api.request(`/api/users/${authorName}`);

    expect(Object.keys(body.profile).sort()).toEqual([
      "authorLevel",
      "avatarUrl",
      "bio",
      "displayName",
      "followerCount",
      "followingCount",
      "id",
      "isAuthor",
      "isFollowing",
      "isMe",
      "joinedAt",
      "readerLevel",
      "readingStreak",
      "storyCount",
      "username",
    ]);

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("fixtures.invalid");
    expect(serialised).not.toContain("passwordHash");
    expect(serialised).not.toContain("emailVerified");
    expect(serialised).not.toContain("googleId");
    expect(serialised).not.toContain("streakLastReadAt");
  });

  it("finds a profile whatever case the handle is typed in", async () => {
    const { status, body } = await api.request(
      `/api/users/${authorName.toUpperCase()}`,
    );

    expect(status).toBe(200);
    expect(body.profile.username).toBe(authorName);
  });

  it("marks the caller's own profile rather than offering a follow button", async () => {
    const { body } = await api.request(`/api/users/${authorName}`, {
      as: author,
    });

    expect(body.profile.isMe).toBe(true);
    expect(body.profile.isFollowing).toBe(false);
  });

  it("404s for a handle nobody holds", async () => {
    const { status } = await api.request(
      `/api/users/${api.runId}-nobody-at-all`,
    );

    expect(status).toBe(404);
  });
});

/* Story count and story list --------------------------------------------- */

describe.skipIf(!available)("an author's stories", () => {
  it("counts and lists only published stories for a stranger", async () => {
    const writer = await api.createUser("us1", { isAuthor: true });
    const handle = api.usernameOf(writer);

    await api.createStory({ title: "Published One", authorId: writer });
    await api.createStory({ title: "Published Two", authorId: writer });
    await api.createStory({
      title: "Still A Draft",
      authorId: writer,
      listed: false,
    });

    const profile = await api.request(`/api/users/${handle}`);
    const stories = await api.request(`/api/users/${handle}/stories`);

    expect(profile.body.profile.storyCount).toBe(2);
    expect(stories.status).toBe(200);
    expect(stories.body.total).toBe(2);
    expect(
      stories.body.items.map((item: { title: string }) => item.title).sort(),
    ).toEqual(["Published One", "Published Two"]);
  });

  /**
   * The header count and the Stories tab go through the same visibility rule,
   * so they cannot show different numbers -- which is the whole reason
   * `countVisibleStoriesBy` exists rather than a `listedAt is not null` count
   * written a second time here.
   */
  it("counts and lists an author's own drafts back to them", async () => {
    const writer = await api.createUser("us2", { isAuthor: true });
    const handle = api.usernameOf(writer);

    await api.createStory({ title: "Out In The World", authorId: writer });
    await api.createStory({
      title: "Not Ready Yet",
      authorId: writer,
      listed: false,
    });

    const profile = await api.request(`/api/users/${handle}`, { as: writer });
    const stories = await api.request(`/api/users/${handle}/stories`, {
      as: writer,
    });

    expect(profile.body.profile.storyCount).toBe(2);
    expect(stories.body.total).toBe(2);
    expect(profile.body.profile.storyCount).toBe(stories.body.total);
  });

  /**
   * A catalogue edition is a `content.Story` row like any other, and seeded
   * imports carry a real author. `listStories` has always excluded them --
   * they are browsed through `/api/books` -- so a header count that did not
   * would say "4 stories" over a tab listing one.
   */
  it("counts only what the story list pages through, not catalogue editions", async () => {
    const writer = await api.createUser("us3", { isAuthor: true });
    const handle = api.usernameOf(writer);

    await api.createStory({ title: "Serialised Here", authorId: writer });
    await api.createBook({ title: "An Imported Edition", authorId: writer });

    const profile = await api.request(`/api/users/${handle}`);
    const stories = await api.request(`/api/users/${handle}/stories`);

    expect(profile.body.profile.storyCount).toBe(1);
    expect(stories.body.total).toBe(1);
    expect(stories.body.items[0].title).toBe("Serialised Here");
  });

  it("returns an empty page rather than erroring for someone who writes nothing", async () => {
    const { status, body } = await api.request(
      `/api/users/${readerName}/stories`,
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({ items: [], total: 0, hasMore: false });
  });
});

/* Following -------------------------------------------------------------- */

describe.skipIf(!available)("following", () => {
  it("requires a signed-in caller", async () => {
    const { status } = await api.request(`/api/users/${authorName}/follow`, {
      method: "POST",
    });

    expect(status).toBe(401);
  });

  it("refuses a self-follow", async () => {
    const { status, body } = await api.request(
      `/api/users/${readerName}/follow`,
      { method: "POST", as: reader },
    );

    expect(status).toBe(400);
    expect(body.error.message).toBe("You cannot follow yourself.");
    expect(await api.countFollowers(reader)).toBe(0);
  });

  it("404s when following a handle nobody holds", async () => {
    const { status } = await api.request(
      `/api/users/${api.runId}-ghost/follow`,
      { method: "POST", as: reader },
    );

    expect(status).toBe(404);
  });

  it("is idempotent: following twice leaves one row and one follower", async () => {
    const target = await api.createUser("uf1");
    const handle = api.usernameOf(target);

    const first = await api.request(`/api/users/${handle}/follow`, {
      method: "POST",
      as: reader,
    });
    const second = await api.request(`/api/users/${handle}/follow`, {
      method: "POST",
      as: reader,
    });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ following: true, followerCount: 1 });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ following: true, followerCount: 1 });
    expect(await api.countFollowers(target)).toBe(1);
  });

  it("is idempotent the other way: unfollowing a stranger is a no-op, not a 404", async () => {
    const target = await api.createUser("uf2");
    const handle = api.usernameOf(target);

    const { status, body } = await api.request(`/api/users/${handle}/follow`, {
      method: "DELETE",
      as: reader,
    });

    expect(status).toBe(200);
    expect(body).toEqual({ following: false, followerCount: 0 });
  });

  it("keeps both counts correct through follow/unfollow churn", async () => {
    const target = await api.createUser("uf3");
    const handle = api.usernameOf(target);

    await api.request(`/api/users/${handle}/follow`, {
      method: "POST",
      as: reader,
    });
    await api.request(`/api/users/${handle}/follow`, {
      method: "POST",
      as: other,
    });

    let profile = await api.request(`/api/users/${handle}`);
    expect(profile.body.profile.followerCount).toBe(2);

    // The follower's own profile has to move in step: one row, two readings.
    const readerProfile = await api.request(`/api/users/${readerName}`);
    expect(readerProfile.body.profile.followingCount).toBeGreaterThanOrEqual(1);

    await api.request(`/api/users/${handle}/follow`, {
      method: "DELETE",
      as: reader,
    });
    await api.request(`/api/users/${handle}/follow`, {
      method: "DELETE",
      as: reader,
    });

    profile = await api.request(`/api/users/${handle}`);
    expect(profile.body.profile.followerCount).toBe(1);

    await api.request(`/api/users/${handle}/follow`, {
      method: "DELETE",
      as: other,
    });

    profile = await api.request(`/api/users/${handle}`);
    expect(profile.body.profile.followerCount).toBe(0);
    expect(await api.countFollowers(target)).toBe(0);
  });

  it("reflects the caller's own relationship on the profile", async () => {
    const target = await api.createUser("uf4");
    const handle = api.usernameOf(target);

    const before = await api.request(`/api/users/${handle}`, { as: reader });
    expect(before.body.profile.isFollowing).toBe(false);

    await api.request(`/api/users/${handle}/follow`, {
      method: "POST",
      as: reader,
    });

    const after = await api.request(`/api/users/${handle}`, { as: reader });
    expect(after.body.profile.isFollowing).toBe(true);

    // Somebody else's view of the same profile is unaffected.
    const stranger = await api.request(`/api/users/${handle}`, { as: other });
    expect(stranger.body.profile.isFollowing).toBe(false);

    // And an anonymous reader is told false rather than nothing.
    const anonymous = await api.request(`/api/users/${handle}`);
    expect(anonymous.body.profile.isFollowing).toBe(false);
  });
});

/* Follower and following lists ------------------------------------------- */

describe.skipIf(!available)("the follow graph", () => {
  it("lists followers newest first, with the four-field author summary", async () => {
    const target = await api.createUser("ug1");
    const handle = api.usernameOf(target);

    const first = await api.createUser("ug2");
    const second = await api.createUser("ug3");

    // Sequential, not concurrent: the order under test is the order they
    // happened in, and two rows written at once cannot establish it.
    await api.request(`/api/users/${handle}/follow`, {
      method: "POST",
      as: first,
    });
    await api.request(`/api/users/${handle}/follow`, {
      method: "POST",
      as: second,
    });

    const { status, body } = await api.request(
      `/api/users/${handle}/followers`,
    );

    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.items.map((item: { user: { id: string } }) => item.user.id)).toEqual([
      second,
      first,
    ]);

    expect(Object.keys(body.items[0].user).sort()).toEqual([
      "avatarUrl",
      "displayName",
      "id",
      "username",
    ]);
    expect(typeof body.items[0].followedAt).toBe("string");
  });

  it("lists who somebody follows, and answers the follow-back question", async () => {
    const subject = await api.createUser("ug4");
    const handle = api.usernameOf(subject);

    const followed = await api.createUser("ug5");
    const followedHandle = api.usernameOf(followed);

    await api.request(`/api/users/${followedHandle}/follow`, {
      method: "POST",
      as: subject,
    });

    // `other` follows the same person, so their view of the list says so
    // while an anonymous reader's does not.
    await api.request(`/api/users/${followedHandle}/follow`, {
      method: "POST",
      as: other,
    });

    const mine = await api.request(`/api/users/${handle}/following`, {
      as: other,
    });
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0].user.id).toBe(followed);
    expect(mine.body.items[0].isFollowing).toBe(true);

    const anonymous = await api.request(`/api/users/${handle}/following`);
    expect(anonymous.body.items[0].isFollowing).toBe(false);
  });

  it("paginates without repeating a row", async () => {
    const target = await api.createUser("ug6");
    const handle = api.usernameOf(target);

    const followers: string[] = [];
    for (const label of ["uh1", "uh2", "uh3"]) {
      const follower = await api.createUser(label);
      followers.push(follower);
      await api.request(`/api/users/${handle}/follow`, {
        method: "POST",
        as: follower,
      });
    }

    const first = await api.request(
      `/api/users/${handle}/followers?page=1&limit=2`,
    );
    const second = await api.request(
      `/api/users/${handle}/followers?page=2&limit=2`,
    );

    expect(first.body).toMatchObject({ total: 3, totalPages: 2, hasMore: true });
    expect(second.body).toMatchObject({ total: 3, hasMore: false });

    const seen = [...first.body.items, ...second.body.items].map(
      (item: { user: { id: string } }) => item.user.id,
    );
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual([...followers].sort());
  });

  it("returns an empty page for somebody nobody follows", async () => {
    const lonely = await api.createUser("ug7");

    const { status, body } = await api.request(
      `/api/users/${api.usernameOf(lonely)}/followers`,
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      items: [],
      total: 0,
      totalPages: 0,
      hasMore: false,
    });
  });

  it("404s both lists for a handle nobody holds", async () => {
    const missing = `${api.runId}-nobody`;

    expect((await api.request(`/api/users/${missing}/followers`)).status).toBe(
      404,
    );
    expect((await api.request(`/api/users/${missing}/following`)).status).toBe(
      404,
    );
  });
});
