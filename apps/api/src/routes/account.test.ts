import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { db } from "../prisma/db.js";
import { UPLOAD_ROOT } from "../lib/storage.js";

const api = new TestApi();
const available = await databaseAvailable();

let reader: string;
let neighbour: string;

/** A one-pixel PNG: the smallest input that passes signature sniffing. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** Files written by the suite, removed afterwards so runs leave no residue. */
const writtenUrls: string[] = [];

function uploadAvatar(data: Buffer, as = reader, contentType = "image/png") {
  return api.request("/api/account/avatar", {
    method: "POST",
    as,
    raw: { data, contentType },
  });
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  reader = await api.createUser("account");
  neighbour = await api.createUser("neighbour");
});

afterAll(async () => {
  if (!available) return;

  for (const url of writtenUrls.filter(Boolean)) {
    const key = url.slice(url.indexOf("/uploads/") + "/uploads/".length);
    await rm(path.join(UPLOAD_ROOT, key), { force: true });
  }

  await api.stop();
});

describe.skipIf(!available)("GET /api/account/me", () => {
  it("requires a signed-in caller", async () => {
    const response = await api.request("/api/account/me");

    expect(response.status).toBe(401);
  });

  it("returns the caller's own profile and never their password hash", async () => {
    const response = await api.request("/api/account/me", { as: reader });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(reader);
    expect(response.body).toHaveProperty("bio");
    expect(response.body).not.toHaveProperty("passwordHash");
  });
});

describe.skipIf(!available)("PATCH /api/account/me", () => {
  it("updates only the fields sent", async () => {
    const named = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { displayName: "Jayshree U.", bio: "Reader first." },
    });

    expect(named.status).toBe(200);
    expect(named.body.displayName).toBe("Jayshree U.");

    const bioOnly = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { bio: "Writer on Sundays." },
    });

    // The display name survives a request that did not mention it.
    expect(bioOnly.body.displayName).toBe("Jayshree U.");
    expect(bioOnly.body.bio).toBe("Writer on Sundays.");
  });

  it("stores a cleared bio or display name as null", async () => {
    const response = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { bio: "   ", displayName: "" },
    });

    expect(response.body.bio).toBeNull();
    expect(response.body.displayName).toBeNull();
  });

  it("rejects a username another account already has", async () => {
    // Fixture usernames carry the run id and are too long to be re-sent
    // through the API's own rule, so the neighbour claims a legal one first.
    const taken = `n${Date.now().toString(36)}`.slice(0, 24);

    const claimed = await api.request("/api/account/me", {
      method: "PATCH",
      as: neighbour,
      body: { username: taken },
    });

    expect(claimed.status).toBe(200);

    const response = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { username: taken },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.username).toMatch(/already taken/i);
  });

  it("accepts the caller's own username unchanged", async () => {
    const name = `r${Date.now().toString(36)}`.slice(0, 24);
    await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { username: name },
    });

    const before = await api.request("/api/account/me", { as: reader });

    const response = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { username: before.body.username },
    });

    expect(response.status).toBe(200);
    expect(response.body.username).toBe(before.body.username);
  });

  it("reports an invalid username per field rather than generically", async () => {
    const response = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { username: "no spaces here" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.username).toBeTruthy();
  });

  it("resets email verification when the address changes", async () => {
    const address = `${api.runId}-moved@fixtures.invalid`;

    const response = await api.request("/api/account/me", {
      method: "PATCH",
      as: reader,
      body: { email: address },
    });

    expect(response.status).toBe(200);
    expect(response.body.email).toBe(address);
    expect(response.body.emailVerified).toBe(false);
  });
});

describe.skipIf(!available)("avatar upload", () => {
  it("stores an image and returns a URL that resolves to those bytes", async () => {
    const response = await uploadAvatar(PNG);

    expect(response.status).toBe(200);
    expect(response.body.avatarUrl).toMatch(/^\/uploads\/avatars\/.+\.png$/);
    writtenUrls.push(response.body.avatarUrl);

    const key = response.body.avatarUrl.replace("/uploads/", "");
    const onDisk = await readFile(path.join(UPLOAD_ROOT, key));
    expect(onDisk.equals(PNG)).toBe(true);
  });

  it("replaces the previous file rather than accumulating", async () => {
    const first = await uploadAvatar(PNG);
    const second = await uploadAvatar(PNG);

    writtenUrls.push(second.body.avatarUrl);
    expect(second.body.avatarUrl).not.toBe(first.body.avatarUrl);

    const staleKey = first.body.avatarUrl.replace("/uploads/", "");
    await expect(readFile(path.join(UPLOAD_ROOT, staleKey))).rejects.toThrow();
  });

  it("rejects a non-image wearing an image content type", async () => {
    const response = await uploadAvatar(
      Buffer.from("<script>alert(1)</script>", "utf8"),
      reader,
      "image/png",
    );

    expect(response.status).toBe(400);
    expect(response.body.error.details.avatar).toBeTruthy();
  });

  it("rejects a body that is not an image at all", async () => {
    const response = await api.request("/api/account/avatar", {
      method: "POST",
      as: reader,
      body: { avatar: "please" },
    });

    expect(response.status).toBe(400);
  });

  it("clears the avatar on delete", async () => {
    const uploaded = await uploadAvatar(PNG);
    const key = uploaded.body.avatarUrl.replace("/uploads/", "");

    const response = await api.request("/api/account/avatar", {
      method: "DELETE",
      as: reader,
    });

    expect(response.status).toBe(200);
    expect(response.body.avatarUrl).toBeNull();
    await expect(readFile(path.join(UPLOAD_ROOT, key))).rejects.toThrow();
  });

  it("requires a signed-in caller", async () => {
    const response = await api.request("/api/account/avatar", {
      method: "POST",
      raw: { data: PNG, contentType: "image/png" },
    });

    expect(response.status).toBe(401);
  });
});

describe.skipIf(!available)("DELETE /api/account/me", () => {
  /**
   * A fixture user carries a placeholder hash that argon2 cannot read, and
   * the delete route asks for a password whenever the account has one — so
   * these tests give it a real hash rather than testing against a value no
   * real account would hold.
   */
  // Labels stay short: the harness truncates a fixture username to 30
  // characters, and four long ones collide into a single name.
  async function createDeletable(
    label: string,
    password: string | null,
  ): Promise<{ id: string; username: string }> {
    const id = await api.createUser(label);

    await db.orm.auth.User.where((u) => u.id.eq(id)).update({
      passwordHash: password === null ? null : await argon2.hash(password),
    });

    const row = await db.orm.auth.User.select("username")
      .where((u) => u.id.eq(id))
      .first();

    return { id, username: row!.username };
  }

  function stillExists(id: string) {
    return db.orm.auth.User.select("id")
      .where((u) => u.id.eq(id))
      .first();
  }

  it("refuses without the typed confirmation", async () => {
    const user = await createDeletable("d1", "open sesame please");

    const response = await api.request("/api/account/me", {
      method: "DELETE",
      as: user.id,
      body: { confirmUsername: "not-my-username", password: "open sesame please" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.confirmUsername).toBeTruthy();
    expect(await stillExists(user.id)).toBeTruthy();
  });

  it("refuses the wrong password", async () => {
    const user = await createDeletable("d2", "open sesame please");

    const response = await api.request("/api/account/me", {
      method: "DELETE",
      as: user.id,
      body: { confirmUsername: user.username, password: "wrong one entirely" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.password).toBeTruthy();
    expect(await stillExists(user.id)).toBeTruthy();
  });

  it("deletes the account and everything hanging off it", async () => {
    const user = await createDeletable("d3", "open sesame please");

    const genreId = await api.createGenre("dg");

    /**
     * Preferences included: all three tables carry a foreign key to
     * `auth.User`, and `genrePreference` a second one to `content.Genre`, so
     * a reader who had answered anything would fail the whole deletion on
     * `genrePreference_userId_fkey` if `deleteAccount` forgot them.
     */
    await api.setPreferences(user.id, {
      genreIds: [genreId],
      contentLength: "LONG",
      mutedNotificationTypes: ["CHANNEL_POST"],
      onboardingComplete: true,
    });

    const story = await api.createStory({
      title: "A story to be unpublished by deletion",
      authorId: user.id,
      genreIds: [genreId],
    });
    const chapterId = await api.createChapter({ storyId: story.id, number: 1 });

    // Someone else's rating against that story has to go too, or the story
    // delete would fail on a foreign key.
    const neighbourId = await api.createUser("d5");
    await api.createRating({ userId: neighbourId, storyId: story.id, rating: 4 });

    /**
     * Likes in all three directions a foreign key can refuse.
     *
     * A like this account *gave* on somebody else's chapter is a row no
     * per-story sweep visits (`chapterLike_userId_fkey`); a like somebody else
     * gave on *this* account's chapter goes with the chapter
     * (`chapterLike_chapterId_fkey`); and a like a third party left on a
     * comment this account wrote under somebody else's story blocks that
     * comment's delete (`commentLike_commentId_fkey`). Each was a separate
     * pass in `deleteAccount`, so each is asserted here rather than trusted.
     */
    const neighbourStory = await api.createStory({
      title: "Somebody else's story",
      authorId: neighbourId,
    });
    const neighbourChapter = await api.createChapter({
      storyId: neighbourStory.id,
      number: 1,
    });
    const neighbourComment = await api.createComment({
      storyId: neighbourStory.id,
      userId: user.id,
      content: "Left on somebody else's story.",
    });

    await Promise.all([
      api.request(`/api/chapters/${neighbourChapter}/like`, {
        method: "PUT",
        as: user.id,
      }),
      api.request(`/api/chapters/${chapterId}/like`, {
        method: "PUT",
        as: neighbourId,
      }),
      api.request(`/api/comments/${neighbourComment}/like`, {
        method: "PUT",
        as: neighbourId,
      }),
    ]);

    /**
     * Reads, views and follows, which is what an account that has actually
     * used Scribe has most of.
     *
     * Every one of these is a foreign key into `auth.User`, `content.Story` or
     * `content.Chapter`, and none of them was swept before: the suite's
     * fixtures had only ever been *written* through the harness, so no test
     * account had ever opened a chapter and the deletion was green while
     * failing with a 500 for every real account that had. The anonymous read
     * below is the one that has no `userId` at all, so only the per-story pass
     * can reach it.
     */
    await Promise.all([
      api.request(`/api/stories/${neighbourStory.slug}/chapters/1`, {
        as: user.id,
      }),
      api.request(`/api/stories/${story.slug}/chapters/1`, { as: neighbourId }),
      api.request(`/api/stories/${story.slug}/chapters/1`),
      api.request(`/api/users/${api.usernameOf(neighbourId)}/follow`, {
        method: "POST",
        as: user.id,
      }),
    ]);
    await api.request(`/api/users/${user.username}/follow`, {
      method: "POST",
      as: neighbourId,
    });

    // The view and read events are written fire-and-forget, so they have to be
    // on disk before the deletion opens its transaction. `deleteAccount`
    // drains them itself; this is what makes the assertion deterministic.
    await api.settleBackgroundWrites();

    const response = await api.request("/api/account/me", {
      method: "DELETE",
      as: user.id,
      body: { confirmUsername: user.username, password: "open sesame please" },
    });

    expect(response.status).toBe(200);
    expect(await stillExists(user.id)).toBeFalsy();

    const remaining = await db.orm.content.Story.select("id")
      .where((row) => row.id.eq(story.id))
      .first();

    expect(remaining).toBeFalsy();

    // The like they gave on the neighbour's chapter came off its story's count.
    const liked = await db.orm.content.Story.select("likeCount")
      .where((row) => row.id.eq(neighbourStory.id))
      .first();
    expect(liked?.likeCount).toBe(0);
  });

  /**
   * An account that has used the social side: club threads with other
   * people's replies under them, a club of its own with discussions, comment
   * threads in both directions, a story somebody else's club is reading, and
   * a hosted challenge. Each of these failed the deletion with a 500 on its
   * own foreign key; the case above touched none of them.
   */
  it("deletes an account that has used clubs, threads and challenges", async () => {
    const user = await createDeletable("d6", "open sesame please");
    const neighbourId = await api.createUser("d7");
    const thirdId = await api.createUser("d8");

    // Their story, with a reply thread, picked as another club's current read.
    const story = await api.createStory({ title: "Being Read", authorId: user.id });
    await api.createChapter({ storyId: story.id, number: 1 });
    const onTheirs = await api.createComment({ storyId: story.id, userId: neighbourId });
    await api.createComment({ storyId: story.id, userId: user.id, parentId: onTheirs });
    await api.createComment({ storyId: story.id, userId: thirdId, parentId: onTheirs });

    const neighbourClub = await api.createClub({
      name: "Neighbour's Club",
      creatorId: neighbourId,
      currentStoryId: story.id,
    });
    await api.addClubMember({ clubId: neighbourClub.id, userId: user.id });
    await api.addClubMember({ clubId: neighbourClub.id, userId: thirdId });

    // A thread of theirs with two replies from others, and a reply of theirs
    // under a thread that stays.
    const theirThread = await api.createDiscussion({
      clubId: neighbourClub.id,
      userId: user.id,
    });
    await api.createDiscussion({ clubId: neighbourClub.id, userId: neighbourId, parentId: theirThread });
    await api.createDiscussion({ clubId: neighbourClub.id, userId: thirdId, parentId: theirThread });
    const keptThread = await api.createDiscussion({
      clubId: neighbourClub.id,
      userId: neighbourId,
    });
    await api.createDiscussion({ clubId: neighbourClub.id, userId: user.id, parentId: keptThread });

    // A club of their own, with discussions by somebody else.
    const ownClub = await api.createClub({ name: "Own Club", creatorId: user.id });
    await api.addClubMember({ clubId: ownClub.id, userId: neighbourId });
    const inOwn = await api.createDiscussion({ clubId: ownClub.id, userId: neighbourId });
    await api.createDiscussion({ clubId: ownClub.id, userId: neighbourId, parentId: inOwn });
    await api.createDiscussion({ clubId: ownClub.id, userId: thirdId, parentId: inOwn });

    // A comment on somebody else's story with two third-party replies.
    const neighbourStory = await api.createStory({
      title: "Neighbour's Story",
      authorId: neighbourId,
    });
    const theirComment = await api.createComment({
      storyId: neighbourStory.id,
      userId: user.id,
    });
    await api.createComment({ storyId: neighbourStory.id, userId: neighbourId, parentId: theirComment });
    await api.createComment({ storyId: neighbourStory.id, userId: thirdId, parentId: theirComment });

    // A challenge they host, with somebody else's entry.
    const challenge = await api.createChallenge({ title: "Hosted", hostId: user.id });
    await api.createChallengeEntry({
      challengeId: challenge.id,
      userId: neighbourId,
      storyId: neighbourStory.id,
    });

    const response = await api.request("/api/account/me", {
      method: "DELETE",
      as: user.id,
      body: { confirmUsername: user.username, password: "open sesame please" },
    });

    expect(response.status).toBe(200);
    expect(await stillExists(user.id)).toBeFalsy();

    // The neighbour's club stays, reading nothing; their kept thread stays
    // without the deleted account's reply; the neighbour's story stays
    // without the deleted account's comment thread.
    const club = await db.orm.clubs.BookClub.select("currentStoryId")
      .where((row) => row.id.eq(neighbourClub.id))
      .first();
    expect(club).toEqual({ currentStoryId: null });

    const discussions = await db.orm.clubs.ClubDiscussion.select("id")
      .where((row) => row.clubId.eq(neighbourClub.id))
      .all();
    expect(discussions.map((row) => row.id)).toEqual([keptThread]);

    const comments = await db.orm.engagement.Comment.select("id")
      .where((row) => row.storyId.eq(neighbourStory.id))
      .all();
    expect(comments).toHaveLength(0);

    const challenges = await db.orm.challenges.WritingChallenge.select("id")
      .where((row) => row.id.eq(challenge.id))
      .all();
    expect(challenges).toHaveLength(0);
  });

  /**
   * A tripwire, not a behaviour test. Every foreign key onto an account, a
   * story or a chapter that does not cascade has to be handled by hand in
   * `deleteAccount` (and, for stories and chapters, `removeStory` in
   * `services/removal.ts`). When this list changes, a table was added or
   * dropped: update those sweeps first, then this list.
   */
  it("knows every table that blocks deleting an account or a story", async () => {
    const rows = await db.runtime().query(
      db.raw.sql`
        SELECT n.nspname || '.' || c.relname || '.' || a.attname
               || ' -> ' || fn.nspname || '.' || f.relname AS "fk"
          FROM pg_constraint k
          JOIN pg_class c      ON c.oid = k.conrelid
          JOIN pg_namespace n  ON n.oid = c.relnamespace
          JOIN pg_class f      ON f.oid = k.confrelid
          JOIN pg_namespace fn ON fn.oid = f.relnamespace
          JOIN pg_attribute a  ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
         WHERE k.contype = 'f'
           AND k.confdeltype <> 'c'
           AND fn.nspname || '.' || f.relname IN ('auth.user', 'content.story', 'content.chapter')
      `.returnsRow({ fk: "pg/text@1" }).build(),
    );

    expect(rows.map((row) => row.fk).sort()).toEqual([
      "ai.chapterSummary.chapterId -> content.chapter",
      "auth.genrePreference.userId -> auth.user",
      "auth.notificationMute.userId -> auth.user",
      "auth.userPreference.userId -> auth.user",
      "challenges.challengeEntry.storyId -> content.story",
      "challenges.challengeEntry.userId -> auth.user",
      "challenges.writingChallenge.hostId -> auth.user",
      "channels.broadcastChannel.authorId -> auth.user",
      "channels.channelSubscriber.userId -> auth.user",
      "clubs.bookClub.creatorId -> auth.user",
      "clubs.bookClub.currentStoryId -> content.story",
      "clubs.clubDiscussion.userId -> auth.user",
      "clubs.clubMembership.userId -> auth.user",
      "content.chapter.storyId -> content.story",
      "content.multimedia.chapterId -> content.chapter",
      "content.story.authorId -> auth.user",
      "content.storyGenre.storyId -> content.story",
      "engagement.chapterLike.chapterId -> content.chapter",
      "engagement.chapterLike.userId -> auth.user",
      "engagement.chapterRead.chapterId -> content.chapter",
      "engagement.chapterRead.storyId -> content.story",
      "engagement.chapterRead.userId -> auth.user",
      "engagement.comment.chapterId -> content.chapter",
      "engagement.comment.storyId -> content.story",
      "engagement.comment.userId -> auth.user",
      "engagement.commentLike.userId -> auth.user",
      "engagement.follow.followerId -> auth.user",
      "engagement.follow.followingId -> auth.user",
      "engagement.rating.storyId -> content.story",
      "engagement.rating.userId -> auth.user",
      "engagement.readingHistory.chapterId -> content.chapter",
      "engagement.readingHistory.storyId -> content.story",
      "engagement.readingHistory.userId -> auth.user",
      "engagement.storyView.storyId -> content.story",
      "engagement.storyView.userId -> auth.user",
      "gamification.userBadge.userId -> auth.user",
      "moderation.report.reporterId -> auth.user",
      "moderation.report.resolvedById -> auth.user",
      "notifications.notification.actorId -> auth.user",
      "notifications.notification.userId -> auth.user",
    ]);
  });

  /**
   * An access token stays valid for up to fifteen minutes after the account
   * goes. Writes made with it breached a foreign key onto the deleted user and
   * answered 500; they should say "sign in again".
   */
  it("answers 401, not 500, to writes from an account that was just deleted", async () => {
    const user = await createDeletable("d9", "open sesame please");

    const deleted = await api.request("/api/account/me", {
      method: "DELETE",
      as: user.id,
      body: { confirmUsername: user.username, password: "open sesame please" },
    });
    expect(deleted.status).toBe(200);

    const story = await api.request("/api/author/stories", {
      method: "POST",
      as: user.id,
      body: { title: "Written by nobody" },
    });
    expect(story.status).toBe(401);

    const club = await api.request("/api/clubs", {
      method: "POST",
      as: user.id,
      body: { name: "Founded by nobody" },
    });
    expect(club.status).toBe(401);
  });

  it("asks a Google-only account for the username alone", async () => {
    const user = await createDeletable("d4", null);

    const response = await api.request("/api/account/me", {
      method: "DELETE",
      as: user.id,
      body: { confirmUsername: user.username },
    });

    expect(response.status).toBe(200);
    expect(await stillExists(user.id)).toBeFalsy();
  });

  it("requires a signed-in caller", async () => {
    const response = await api.request("/api/account/me", {
      method: "DELETE",
      body: { confirmUsername: "anyone" },
    });

    expect(response.status).toBe(401);
  });
});

describe.skipIf(!available)("password state on the profile", () => {
  it("reports whether the account can be signed into with a password", async () => {
    const withPassword = await api.request("/api/account/me", { as: reader });
    expect(withPassword.body.hasPassword).toBe(true);

    await db.orm.auth.User.where((u) => u.id.eq(neighbour)).update({
      passwordHash: null,
    });

    const googleOnly = await api.request("/api/account/me", { as: neighbour });
    expect(googleOnly.body.hasPassword).toBe(false);
    expect(googleOnly.body).not.toHaveProperty("passwordHash");
  });
});
