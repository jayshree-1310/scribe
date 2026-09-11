import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

/** The owner of every fixture club below, unless a test says otherwise. */
let owner: string;
let admin: string;
let member: string;
/** Signed in, belongs to nothing. */
let outsider: string;

let clubId: string;
let clubSlug: string;

/** A story the owner may set as the current read. */
let storyId: string;
/** A draft only its author can see, for the visibility rule. */
let draftId: string;

beforeAll(async () => {
  if (!available) return;
  await api.start();

  owner = await api.createUser("own");
  admin = await api.createUser("adm");
  member = await api.createUser("mem");
  outsider = await api.createUser("out");

  const club = await api.createClub({
    name: "Northern Lights Readers",
    creatorId: owner,
  });
  clubId = club.id;
  clubSlug = club.slug;

  await api.addClubMember({ clubId, userId: admin, role: "ADMIN" });
  await api.addClubMember({ clubId, userId: member, role: "MEMBER" });

  const story = await api.createStory({
    title: "The Salt-Glass Coast",
    authorId: owner,
  });
  storyId = story.id;
  await api.createChapter({ storyId, number: 1 });

  const draft = await api.createStory({
    title: "Unfinished Business",
    authorId: owner,
    listed: false,
  });
  draftId = draft.id;
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

describe.skipIf(!available)("reading clubs", () => {
  it("lists clubs publicly, with a member count", async () => {
    const { status, body } = await api.request("/api/clubs");

    expect(status).toBe(200);

    const found = body.items.find((club: { id: string }) => club.id === clubId);
    expect(found.memberCount).toBe(3);
    expect(found.membership).toBeNull();
  });

  it("reports the caller's own membership when signed in", async () => {
    const { body } = await api.request(`/api/clubs/${clubSlug}`, { as: admin });

    expect(body.club.membership.role).toBe("ADMIN");
    expect(body.club.owner.id).toBe(owner);
  });

  it("addresses a club by slug or by id alike", async () => {
    const bySlug = await api.request(`/api/clubs/${clubSlug}`);
    const byId = await api.request(`/api/clubs/${clubId}`);

    expect(bySlug.body.club.id).toBe(byId.body.club.id);
  });

  it("lists the owner and admins as moderators", async () => {
    const { body } = await api.request(`/api/clubs/${clubSlug}`);

    const roles = body.club.moderators.map(
      (entry: { user: { id: string }; role: string }) => [entry.user.id, entry.role],
    );

    expect(roles).toEqual(
      expect.arrayContaining([
        [owner, "OWNER"],
        [admin, "ADMIN"],
      ]),
    );
    // A plain member is not a moderator.
    expect(roles).not.toEqual(
      expect.arrayContaining([[member, "MEMBER"]]),
    );
  });

  it("404s on a club that does not exist", async () => {
    const { status, body } = await api.request("/api/clubs/no-such-club");

    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("filters to the caller's own clubs", async () => {
    const mine = await api.request("/api/clubs?mine=true", { as: member });
    const theirs = await api.request("/api/clubs?mine=true", { as: outsider });

    expect(mine.body.items.map((club: { id: string }) => club.id)).toContain(
      clubId,
    );
    expect(theirs.body.items).toHaveLength(0);
  });
});

describe.skipIf(!available)("role enforcement", () => {
  it("401s on every privileged route without a caller", async () => {
    const responses = await Promise.all([
      api.request("/api/clubs", { method: "POST", body: { name: "Anonymous" } }),
      api.request(`/api/clubs/${clubId}`, {
        method: "PATCH",
        body: { name: "Renamed" },
      }),
      api.request(`/api/clubs/${clubId}`, { method: "DELETE" }),
      api.request(`/api/clubs/${clubId}/join`, { method: "POST" }),
      api.request(`/api/clubs/${clubId}/leave`, { method: "DELETE" }),
      api.request(`/api/clubs/${clubId}/members/${member}`, {
        method: "PATCH",
        body: { role: "ADMIN" },
      }),
      api.request(`/api/clubs/${clubId}/current-read`, {
        method: "PUT",
        body: { storyId: null },
      }),
      api.request(`/api/clubs/${clubId}/discussions`, {
        method: "POST",
        body: { body: "Hello" },
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("unauthorized");
    }
  });

  it("403s a non-member on every privileged action", async () => {
    const responses = await Promise.all([
      api.request(`/api/clubs/${clubId}`, {
        method: "PATCH",
        as: outsider,
        body: { name: "Hijacked" },
      }),
      api.request(`/api/clubs/${clubId}`, { method: "DELETE", as: outsider }),
      api.request(`/api/clubs/${clubId}/members/${member}`, {
        method: "PATCH",
        as: outsider,
        body: { role: "ADMIN" },
      }),
      api.request(`/api/clubs/${clubId}/members/${member}`, {
        method: "DELETE",
        as: outsider,
      }),
      api.request(`/api/clubs/${clubId}/current-read`, {
        method: "PUT",
        as: outsider,
        body: { storyId },
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("forbidden");
    }
  });

  it("403s a plain member on the same actions", async () => {
    const responses = await Promise.all([
      api.request(`/api/clubs/${clubId}`, {
        method: "PATCH",
        as: member,
        body: { name: "Members cannot rename" },
      }),
      api.request(`/api/clubs/${clubId}`, { method: "DELETE", as: member }),
      api.request(`/api/clubs/${clubId}/current-read`, {
        method: "PUT",
        as: member,
        body: { storyId },
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
    }
  });

  it("lets an admin rename the club but not change roles", async () => {
    const renamed = await api.request(`/api/clubs/${clubId}`, {
      method: "PATCH",
      as: admin,
      body: { description: "Cold-climate fantasy, and maps." },
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body.club.description).toBe(
      "Cold-climate fantasy, and maps.",
    );

    // Role changes are the owner's alone: an admin who could grant OWNER
    // could promote themselves.
    const promotion = await api.request(
      `/api/clubs/${clubId}/members/${member}`,
      { method: "PATCH", as: admin, body: { role: "ADMIN" } },
    );

    expect(promotion.status).toBe(403);
  });

  it("does not let an admin remove another admin", async () => {
    const peer = await api.createUser("pr2");
    await api.addClubMember({ clubId, userId: peer, role: "ADMIN" });

    const blocked = await api.request(`/api/clubs/${clubId}/members/${peer}`, {
      method: "DELETE",
      as: admin,
    });

    expect(blocked.status).toBe(403);

    // The owner may.
    const allowed = await api.request(`/api/clubs/${clubId}/members/${peer}`, {
      method: "DELETE",
      as: owner,
    });

    expect(allowed.status).toBe(204);
  });

  it("does not let the club's slug change under a rename", async () => {
    const { body } = await api.request(`/api/clubs/${clubId}`, {
      method: "PATCH",
      as: owner,
      body: { name: "Northern Lights Readers (Revived)" },
    });

    expect(body.club.slug).toBe(clubSlug);
  });
});

describe.skipIf(!available)("joining and leaving", () => {
  it("is idempotent: joining twice succeeds and adds one member", async () => {
    const before = await api.request(`/api/clubs/${clubSlug}`);

    const first = await api.request(`/api/clubs/${clubId}/join`, {
      method: "POST",
      as: outsider,
    });
    const second = await api.request(`/api/clubs/${clubId}/join`, {
      method: "POST",
      as: outsider,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.membership.role).toBe("MEMBER");
    // The second call does not reset the join date.
    expect(second.body.membership.joinedAt).toBe(first.body.membership.joinedAt);

    const after = await api.request(`/api/clubs/${clubSlug}`);
    expect(after.body.club.memberCount).toBe(before.body.club.memberCount + 1);
  });

  it("leaving twice succeeds and removes one member", async () => {
    const first = await api.request(`/api/clubs/${clubId}/leave`, {
      method: "DELETE",
      as: outsider,
    });
    const second = await api.request(`/api/clubs/${clubId}/leave`, {
      method: "DELETE",
      as: outsider,
    });

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);

    const { body } = await api.request(`/api/clubs/${clubSlug}`, {
      as: outsider,
    });
    expect(body.club.membership).toBeNull();
    expect(body.club.memberCount).toBe(3);
  });

  it("refuses to let the last owner leave", async () => {
    const { status, body } = await api.request(`/api/clubs/${clubId}/leave`, {
      method: "DELETE",
      as: owner,
    });

    expect(status).toBe(409);
    expect(body.error.code).toBe("conflict");

    // Still the owner, and still in the club.
    const club = await api.request(`/api/clubs/${clubSlug}`, { as: owner });
    expect(club.body.club.owner.id).toBe(owner);
    expect(club.body.club.membership.role).toBe("OWNER");
  });

  it("refuses to demote the last owner", async () => {
    const { status, body } = await api.request(
      `/api/clubs/${clubId}/members/${owner}`,
      { method: "PATCH", as: owner, body: { role: "MEMBER" } },
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe("conflict");
  });

  it("lets the owner leave once ownership is transferred", async () => {
    // A club of its own, so the hand-over does not disturb the shared one.
    const handover = await api.createClub({
      name: "Ownership Handover",
      creatorId: owner,
    });
    await api.addClubMember({ clubId: handover.id, userId: member });

    const blocked = await api.request(`/api/clubs/${handover.id}/leave`, {
      method: "DELETE",
      as: owner,
    });
    expect(blocked.status).toBe(409);

    const promoted = await api.request(
      `/api/clubs/${handover.id}/members/${member}`,
      { method: "PATCH", as: owner, body: { role: "OWNER" } },
    );
    expect(promoted.status).toBe(200);
    expect(promoted.body.member.role).toBe("OWNER");

    const left = await api.request(`/api/clubs/${handover.id}/leave`, {
      method: "DELETE",
      as: owner,
    });
    expect(left.status).toBe(204);

    const { body } = await api.request(`/api/clubs/${handover.slug}`);
    expect(body.club.owner.id).toBe(member);
    expect(body.club.memberCount).toBe(1);
  });

  it("404s when joining a club that does not exist", async () => {
    const { status } = await api.request("/api/clubs/no-such-club/join", {
      method: "POST",
      as: outsider,
    });

    expect(status).toBe(404);
  });
});

describe.skipIf(!available)("creating a club", () => {
  it("makes the creator its owner", async () => {
    const { status, body } = await api.request("/api/clubs", {
      method: "POST",
      as: outsider,
      body: { name: "Quiet Futures", description: "Science fiction, no explosions." },
    });

    expect(status).toBe(201);
    api.trackClub(body.club.id);

    expect(body.club.owner.id).toBe(outsider);
    expect(body.club.membership.role).toBe("OWNER");
    expect(body.club.memberCount).toBe(1);
    expect(body.club.slug).toBe("quiet-futures");
    expect(body.club.currentStory).toBeNull();
  });

  it("suffixes a slug that is already taken", async () => {
    const { body } = await api.request("/api/clubs", {
      method: "POST",
      as: outsider,
      body: { name: "Quiet Futures" },
    });

    api.trackClub(body.club.id);
    expect(body.club.slug).toBe("quiet-futures-2");
  });

  it("rejects a name that is too short", async () => {
    const { status, body } = await api.request("/api/clubs", {
      method: "POST",
      as: outsider,
      body: { name: "x" },
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details.name).toBeDefined();
  });

  it("rejects a PATCH that changes nothing", async () => {
    const { status } = await api.request(`/api/clubs/${clubId}`, {
      method: "PATCH",
      as: owner,
      body: {},
    });

    expect(status).toBe(400);
  });

  it("deletes a club and its threads together", async () => {
    const created = await api.request("/api/clubs", {
      method: "POST",
      as: outsider,
      body: { name: "Short Lived Club" },
    });
    const doomed = created.body.club.id;
    api.trackClub(doomed);

    const thread = await api.request(`/api/clubs/${doomed}/discussions`, {
      method: "POST",
      as: outsider,
      body: { body: "First and last thread." },
    });
    await api.request(`/api/clubs/${doomed}/discussions`, {
      method: "POST",
      as: outsider,
      body: { body: "A reply.", parentId: thread.body.discussion.id },
    });

    const deleted = await api.request(`/api/clubs/${doomed}`, {
      method: "DELETE",
      as: outsider,
    });

    expect(deleted.status).toBe(204);
    expect((await api.request(`/api/clubs/${doomed}`)).status).toBe(404);
  });
});

describe.skipIf(!available)("the club's current read", () => {
  it("sets and clears the current story", async () => {
    const set = await api.request(`/api/clubs/${clubId}/current-read`, {
      method: "PUT",
      as: owner,
      body: { storyId },
    });

    expect(set.status).toBe(200);
    expect(set.body.club.currentStory.id).toBe(storyId);

    const cleared = await api.request(`/api/clubs/${clubId}/current-read`, {
      method: "PUT",
      as: owner,
      body: { storyId: null },
    });

    expect(cleared.body.club.currentStory).toBeNull();
  });

  it("404s on a story the caller cannot see", async () => {
    const { status } = await api.request(`/api/clubs/${clubId}/current-read`, {
      method: "PUT",
      as: admin,
      body: { storyId: draftId },
    });

    expect(status).toBe(404);
  });

  it("does not leak an unlisted current read to other people", async () => {
    // The author may point their own club at their own draft...
    const set = await api.request(`/api/clubs/${clubId}/current-read`, {
      method: "PUT",
      as: owner,
      body: { storyId: draftId },
    });
    expect(set.body.club.currentStory.id).toBe(draftId);

    // ...and everybody else sees nothing rather than the title.
    const theirs = await api.request(`/api/clubs/${clubSlug}`, { as: member });
    expect(theirs.body.club.currentStory).toBeNull();

    await api.request(`/api/clubs/${clubId}/current-read`, {
      method: "PUT",
      as: owner,
      body: { storyId: null },
    });
  });
});

describe.skipIf(!available)("discussions", () => {
  it("blocks a non-member from posting", async () => {
    const { status, body } = await api.request(
      `/api/clubs/${clubId}/discussions`,
      { method: "POST", as: outsider, body: { body: "Let me in." } },
    );

    expect(status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });

  it("lets any member post, and lists threads newest first", async () => {
    const first = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: member,
      body: { body: "Reading pace for this month?" },
    });
    const second = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: admin,
      body: { body: "Chapter 14 — the keeper's ledger." },
    });

    expect(first.status).toBe(201);
    expect(first.body.discussion.user.id).toBe(member);
    expect(first.body.discussion.parentId).toBeNull();

    const { body } = await api.request(`/api/clubs/${clubSlug}/discussions`);
    const ids = body.items.map((item: { id: string }) => item.id);

    expect(ids.indexOf(second.body.discussion.id)).toBeLessThan(
      ids.indexOf(first.body.discussion.id),
    );
  });

  it("counts replies against the thread and lists them oldest first", async () => {
    const thread = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: owner,
      body: { body: "Map thread (spoilers through ch. 9)." },
    });
    const threadId = thread.body.discussion.id;

    const replyOne = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: member,
      body: { body: "The coastline does not close.", parentId: threadId },
    });
    const replyTwo = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: admin,
      body: { body: "Deliberate, I think.", parentId: threadId },
    });

    const threads = await api.request(`/api/clubs/${clubSlug}/discussions`);
    const found = threads.body.items.find(
      (item: { id: string }) => item.id === threadId,
    );
    expect(found.replyCount).toBe(2);

    // A reply is not itself a thread.
    const ids = threads.body.items.map((item: { id: string }) => item.id);
    expect(ids).not.toContain(replyOne.body.discussion.id);

    const replies = await api.request(
      `/api/clubs/${clubSlug}/discussions?parentId=${threadId}`,
    );
    expect(replies.body.items.map((item: { id: string }) => item.id)).toEqual([
      replyOne.body.discussion.id,
      replyTwo.body.discussion.id,
    ]);
  });

  it("flattens a reply to a reply onto its thread", async () => {
    const thread = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: owner,
      body: { body: "One level deep, please." },
    });
    const threadId = thread.body.discussion.id;

    const reply = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: member,
      body: { body: "A reply.", parentId: threadId },
    });

    const nested = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: admin,
      body: { body: "A reply to the reply.", parentId: reply.body.discussion.id },
    });

    expect(nested.body.discussion.parentId).toBe(threadId);
  });

  it("rejects an empty or whitespace-only body", async () => {
    const responses = await Promise.all([
      api.request(`/api/clubs/${clubId}/discussions`, {
        method: "POST",
        as: member,
        body: { body: "" },
      }),
      api.request(`/api/clubs/${clubId}/discussions`, {
        method: "POST",
        as: member,
        body: { body: "   \n  " },
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(response.body.error.details.body).toBeDefined();
    }
  });

  it("trims the body it stores", async () => {
    const { body } = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: member,
      body: { body: "  Padded on both sides.  " },
    });

    expect(body.discussion.body).toBe("Padded on both sides.");
  });

  it("refuses a parent thread from another club", async () => {
    const other = await api.createClub({
      name: "Somebody Else's Club",
      creatorId: outsider,
    });
    const foreign = await api.createDiscussion({
      clubId: other.id,
      userId: outsider,
    });

    const { status } = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: member,
      body: { body: "Wrong club.", parentId: foreign },
    });

    expect(status).toBe(404);
  });

  it("lets the author delete their own post", async () => {
    const thread = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: member,
      body: { body: "I will retract this." },
    });
    const id = thread.body.discussion.id;

    const deleted = await api.request(`/api/clubs/discussions/${id}`, {
      method: "DELETE",
      as: member,
    });

    expect(deleted.status).toBe(204);

    const threads = await api.request(`/api/clubs/${clubSlug}/discussions`);
    expect(threads.body.items.map((item: { id: string }) => item.id)).not.toContain(
      id,
    );
  });

  it("lets a club admin delete somebody else's post", async () => {
    const thread = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: member,
      body: { body: "Moderated away." },
    });

    const { status } = await api.request(
      `/api/clubs/discussions/${thread.body.discussion.id}`,
      { method: "DELETE", as: admin },
    );

    expect(status).toBe(204);
  });

  it("403s anybody else deleting a post", async () => {
    const thread = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: member,
      body: { body: "Not yours to delete." },
    });
    const id = thread.body.discussion.id;

    const responses = await Promise.all([
      api.request(`/api/clubs/discussions/${id}`, {
        method: "DELETE",
        as: outsider,
      }),
      // A fellow member with no moderator role is no different.
      api.request(`/api/clubs/discussions/${id}`, {
        method: "DELETE",
        as: await api.createUser("by3"),
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("forbidden");
    }
  });

  it("deletes a thread's replies with it", async () => {
    const thread = await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: member,
      body: { body: "Thread with replies." },
    });
    const threadId = thread.body.discussion.id;

    await api.request(`/api/clubs/${clubId}/discussions`, {
      method: "POST",
      as: admin,
      body: { body: "A reply that should go too.", parentId: threadId },
    });

    const deleted = await api.request(`/api/clubs/discussions/${threadId}`, {
      method: "DELETE",
      as: member,
    });
    expect(deleted.status).toBe(204);

    const replies = await api.request(
      `/api/clubs/${clubSlug}/discussions?parentId=${threadId}`,
    );
    expect(replies.body.items).toHaveLength(0);
  });

  it("paginates threads without repeating one", async () => {
    const fresh = await api.createClub({
      name: "Paginated Club",
      creatorId: owner,
    });

    for (let index = 0; index < 5; index += 1) {
      await api.createDiscussion({
        clubId: fresh.id,
        userId: owner,
        body: `Thread ${index}`,
      });
    }

    const first = await api.request(
      `/api/clubs/${fresh.slug}/discussions?page=1&limit=2`,
    );
    const second = await api.request(
      `/api/clubs/${fresh.slug}/discussions?page=2&limit=2`,
    );

    expect(first.body.total).toBe(5);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.items).toHaveLength(2);

    const ids = [
      ...first.body.items.map((item: { id: string }) => item.id),
      ...second.body.items.map((item: { id: string }) => item.id),
    ];
    expect(new Set(ids).size).toBe(4);
  });
});
