import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Temporal } from "temporal-polyfill";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { flushNotifications } from "../services/notifications.js";
import type { Notification } from "../services/notifications.js";
import type { Report } from "../services/moderation.js";
import type {
  ListEntry,
  Page,
  ReadingList,
  ReadingListDetail,
} from "../services/reading-lists.js";

const api = new TestApi();
const available = await databaseAvailable();

let curator: string;
let follower: string;
let stranger: string;
let moderator: string;

let tide: { id: string; slug: string };
let lamps: { id: string; slug: string };
let draft: { id: string; slug: string };
let catalogueBook: string;

beforeAll(async () => {
  if (!available) return;
  await api.start();

  curator = await api.createUser("lcur", { isAuthor: true });
  follower = await api.createUser("lfol");
  stranger = await api.createUser("lstr");
  moderator = await api.createUser("lmod");
  await api.setAdmin(moderator);

  tide = await api.createStory({ title: "Tide Tables", authorId: curator });
  lamps = await api.createStory({ title: "Lamps of Ure", authorId: stranger });
  draft = await api.createStory({ title: "Unlisted Draft", authorId: curator, listed: false });
  catalogueBook = await api.createBook({ title: "Catalogue Classic", authorId: stranger });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

async function createList(
  as: string,
  body: Record<string, unknown>,
): Promise<ReadingListDetail> {
  const response = await api.request<{ list: ReadingListDetail }>("/api/lists", {
    method: "POST",
    as,
    body,
  });
  expect(response.status).toBe(201);
  return response.body.list;
}

async function addEntry(as: string, listId: string, storyId: string, note?: string) {
  return api.request<{ entry: ListEntry }>(`/api/lists/${listId}/entries`, {
    method: "POST",
    as,
    body: { storyId, ...(note === undefined ? {} : { note }) },
  });
}

async function getList(key: string, as?: string) {
  return api.request<{ list: ReadingListDetail }>(`/api/lists/${key}`, as ? { as } : {});
}

async function notificationsOf(as: string): Promise<Notification[]> {
  await flushNotifications();
  const response = await api.request<{ items: Notification[] }>("/api/notifications", { as });
  expect(response.status).toBe(200);
  return response.body.items.filter((item) => item.type === "LIST_ADDITION");
}

describe.skipIf(!available)("reading lists", () => {
  let list: ReadingListDetail;

  it("creates a list with a slug from its name, owned by the caller", async () => {
    list = await createList(curator, {
      name: "Best slow-burn fantasy",
      description: "Stories that take their time.",
    });

    expect(list.slug).toMatch(/^best-slow-burn-fantasy/);
    expect(list.isPublic).toBe(true);
    expect(list.isOwner).toBe(true);
    expect(list.owner.id).toBe(curator);
    expect(list.entries).toEqual([]);
    expect(list.storyCount).toBe(0);

    // A second list of the same name gets its own address.
    const twin = await createList(curator, { name: "Best slow-burn fantasy" });
    expect(twin.slug).not.toBe(list.slug);
    expect((await api.request(`/api/lists/${twin.id}`, { method: "DELETE", as: curator })).status).toBe(204);
  });

  it("validates names and refuses an empty patch", async () => {
    const short = await api.request("/api/lists", { method: "POST", as: curator, body: { name: "x" } });
    expect(short.status).toBe(400);

    const empty = await api.request(`/api/lists/${list.id}`, { method: "PATCH", as: curator, body: {} });
    expect(empty.status).toBe(400);
  });

  it("holds Scribe stories and catalogue books, newest first, with notes", async () => {
    const first = await addEntry(curator, list.id, tide.id, "Slow, then devastating.");
    expect(first.status).toBe(201);
    expect(first.body.entry.note).toBe("Slow, then devastating.");
    expect(first.body.entry.story.id).toBe(tide.id);

    expect((await addEntry(curator, list.id, catalogueBook)).status).toBe(201);
    expect((await addEntry(curator, list.slug, lamps.id, "   ")).status).toBe(201);

    const read = await getList(list.slug);
    expect(read.status).toBe(200);
    expect(read.body.list.entries.map((entry) => entry.story.id)).toEqual([
      lamps.id,
      catalogueBook,
      tide.id,
    ]);
    // A blank note is no note.
    expect(read.body.list.entries[0]?.note).toBeNull();
    expect(read.body.list.storyCount).toBe(3);
    expect(read.body.list.previews.map((story) => story.id)).toEqual([
      lamps.id,
      catalogueBook,
      tide.id,
    ]);
    // Signed out: not the owner, not following.
    expect(read.body.list.isOwner).toBe(false);
    expect(read.body.list.following).toBe(false);
  });

  it("refuses a duplicate, a draft and somebody else's list", async () => {
    expect((await addEntry(curator, list.id, tide.id)).status).toBe(409);
    // A draft reads as absent, even to its own author.
    expect((await addEntry(curator, list.id, draft.id)).status).toBe(404);
    expect((await addEntry(stranger, list.id, draft.id)).status).toBe(403);
    expect(
      (await api.request(`/api/lists/${list.id}`, { method: "PATCH", as: stranger, body: { name: "Mine now" } })).status,
    ).toBe(403);
  });

  it("edits a note and removes an entry", async () => {
    const edited = await api.request<{ entry: ListEntry }>(
      `/api/lists/${list.id}/entries/${catalogueBook}`,
      { method: "PATCH", as: curator, body: { note: "A classic for a reason." } },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.entry.note).toBe("A classic for a reason.");

    expect(
      (await api.request(`/api/lists/${list.id}/entries/${lamps.id}`, { method: "DELETE", as: curator })).status,
    ).toBe(204);
    expect(
      (await api.request(`/api/lists/${list.id}/entries/${lamps.id}`, { method: "DELETE", as: curator })).status,
    ).toBe(404);

    const read = await getList(list.id);
    expect(read.body.list.entries.map((entry) => entry.story.id)).toEqual([catalogueBook, tide.id]);
  });

  it("leaves out a story that is unlisted, and brings it back", async () => {
    const { db } = await import("../prisma/db.js");
    await db.orm.content.Story.where((row) => row.id.eq(tide.id)).update({ listedAt: null });

    let read = await getList(list.id);
    expect(read.body.list.entries.map((entry) => entry.story.id)).toEqual([catalogueBook]);
    expect(read.body.list.storyCount).toBe(1);

    await db.orm.content.Story.where((row) => row.id.eq(tide.id)).update({
      listedAt: Temporal.Now.instant(),
    });
    read = await getList(list.id);
    expect(read.body.list.storyCount).toBe(2);
  });

  it("follows, and notifies followers once per unread addition", async () => {
    // Owners cannot follow their own list.
    expect((await api.request(`/api/lists/${list.id}/follow`, { method: "POST", as: curator })).status).toBe(400);

    const followed = await api.request<{ following: boolean; followerCount: number }>(
      `/api/lists/${list.slug}/follow`,
      { method: "POST", as: follower },
    );
    expect(followed.status).toBe(200);
    expect(followed.body).toEqual({ following: true, followerCount: 1 });
    // Idempotent.
    expect((await api.request(`/api/lists/${list.id}/follow`, { method: "POST", as: follower })).body.followerCount).toBe(1);

    expect((await addEntry(curator, list.id, lamps.id)).status).toBe(201);
    let bell = await notificationsOf(follower);
    expect(bell).toHaveLength(1);
    expect(bell[0]?.title).toBe("Best slow-burn fantasy");
    expect(bell[0]?.excerpt).toBe("Added Lamps of Ure");
    expect(bell[0]?.href).toBe(`/lists/${list.slug}`);
    expect(bell[0]?.actor?.id).toBe(curator);

    // A second addition while the first is unread rings nothing new.
    await api.request(`/api/lists/${list.id}/entries/${lamps.id}`, { method: "DELETE", as: curator });
    expect((await addEntry(curator, list.id, lamps.id)).status).toBe(201);
    expect(await notificationsOf(follower)).toHaveLength(1);

    // Once it is read, the next addition is news again.
    expect((await api.request("/api/notifications/read-all", { method: "POST", as: follower })).status).toBe(200);
    await api.request(`/api/lists/${list.id}/entries/${lamps.id}`, { method: "DELETE", as: curator });
    expect((await addEntry(curator, list.id, lamps.id)).status).toBe(201);
    bell = await notificationsOf(follower);
    expect(bell).toHaveLength(2);

    // The owner is never told about their own list.
    expect(await notificationsOf(curator)).toHaveLength(0);

    const page = await api.request<Page<ReadingList>>("/api/lists?followed=true", { as: follower });
    expect(page.body.items.map((item) => item.id)).toEqual([list.id]);
    expect(page.body.items[0]?.following).toBe(true);
  });

  it("honours a mute", async () => {
    await api.request("/api/notifications/read-all", { method: "POST", as: follower });
    const muted = await api.request("/api/account/preferences", {
      method: "PUT",
      as: follower,
      body: { mutedNotificationTypes: ["LIST_ADDITION"] },
    });
    expect(muted.status).toBe(200);

    await api.request(`/api/lists/${list.id}/entries/${lamps.id}`, { method: "DELETE", as: curator });
    await addEntry(curator, list.id, lamps.id);
    const unread = (await notificationsOf(follower)).filter((item) => item.readAt === null);
    expect(unread).toHaveLength(0);

    await api.request("/api/account/preferences", {
      method: "PUT",
      as: follower,
      body: { mutedNotificationTypes: [] },
    });
  });

  it("keeps a private list to its owner, and its followers quiet", async () => {
    const hidden = await api.request<{ list: ReadingListDetail }>(`/api/lists/${list.id}`, {
      method: "PATCH",
      as: curator,
      body: { isPublic: false },
    });
    expect(hidden.status).toBe(200);
    expect(hidden.body.list.isPublic).toBe(false);

    expect((await getList(list.slug)).status).toBe(404);
    expect((await getList(list.slug, follower)).status).toBe(404);
    expect((await getList(list.slug, curator)).status).toBe(200);
    expect((await api.request(`/api/lists/${list.id}/follow`, { method: "POST", as: stranger })).status).toBe(404);

    // Gone from the follower's list and from the curator's public profile.
    const followedPage = await api.request<Page<ReadingList>>("/api/lists?followed=true", { as: follower });
    expect(followedPage.body.items).toEqual([]);
    const owner = api.usernameOf(curator);
    const publicView = await api.request<Page<ReadingList>>(`/api/lists?owner=${owner}`);
    expect(publicView.body.items.map((item) => item.id)).not.toContain(list.id);
    const ownView = await api.request<Page<ReadingList>>(`/api/lists?owner=${owner}`, { as: curator });
    expect(ownView.body.items.map((item) => item.id)).toContain(list.id);

    await api.request("/api/notifications/read-all", { method: "POST", as: follower });
    await api.request(`/api/lists/${list.id}/entries/${lamps.id}`, { method: "DELETE", as: curator });
    await addEntry(curator, list.id, lamps.id);
    const unread = (await notificationsOf(follower)).filter((item) => item.readAt === null);
    expect(unread).toHaveLength(0);

    // Public again: the follower is still following.
    await api.request(`/api/lists/${list.id}`, { method: "PATCH", as: curator, body: { isPublic: true } });
    const back = await getList(list.id, follower);
    expect(back.body.list.following).toBe(true);
    expect(back.body.list.followerCount).toBe(1);
  });

  it("says which of the owner's lists hold a story", async () => {
    const other = await createList(curator, { name: "Comfort reads" });
    const owner = api.usernameOf(curator);

    const page = await api.request<Page<ReadingList>>(
      // As the Add to list dialog asks: every list the owner may keep, at once.
      `/api/lists?owner=${owner}&storyId=${tide.id}&limit=50`,
      { as: curator },
    );
    expect(page.status).toBe(200);
    const byId = new Map(page.body.items.map((item) => [item.id, item.hasStory]));
    expect(byId.get(list.id)).toBe(true);
    expect(byId.get(other.id)).toBe(false);

    await api.request(`/api/lists/${other.id}`, { method: "DELETE", as: curator });
  });

  it("browses public lists that hold something", async () => {
    const empty = await createList(stranger, { name: "Nothing yet" });

    const page = await api.request<Page<ReadingList>>("/api/lists?sort=popular&limit=48");
    expect(page.status).toBe(200);
    const ids = page.body.items.map((item) => item.id);
    expect(ids).toContain(list.id);
    expect(ids).not.toContain(empty.id);

    await api.request(`/api/lists/${empty.id}`, { method: "DELETE", as: stranger });
  });

  it("is reported and taken down whole, and the bells go with it", async () => {
    await api.request(`/api/lists/${list.id}/entries/${lamps.id}`, { method: "DELETE", as: curator });
    await addEntry(curator, list.id, lamps.id);
    await flushNotifications();

    // The curator cannot report their own list.
    const own = await api.request("/api/reports", {
      method: "POST",
      as: curator,
      body: { targetType: "READING_LIST", targetId: list.id, reason: "SPAM" },
    });
    expect(own.status).toBe(400);

    const filed = await api.request<{ report: Report }>("/api/reports", {
      method: "POST",
      as: stranger,
      body: { targetType: "READING_LIST", targetId: list.id, reason: "SPAM" },
    });
    expect(filed.status).toBe(201);
    expect(filed.body.report.target?.href).toBe(`/lists/${list.slug}`);
    // The notes are part of what the moderator reads.
    expect(filed.body.report.target?.excerpt).toContain("A classic for a reason.");

    const hide = await api.request(`/api/moderation/reports/${filed.body.report.id}/resolve`, {
      method: "POST",
      as: moderator,
      body: { action: "HIDE" },
    });
    expect(hide.status).toBe(200);

    expect((await getList(list.slug, follower)).status).toBe(404);
    expect((await getList(list.slug, curator)).status).toBe(404);
    expect((await addEntry(curator, list.id, draft.id)).status).toBe(404);
    expect(await notificationsOf(follower)).toHaveLength(0);

    const dismiss = await api.request(`/api/moderation/reports/${filed.body.report.id}/resolve`, {
      method: "POST",
      as: moderator,
      body: { action: "DISMISS" },
    });
    expect(dismiss.status).toBe(200);
    expect((await getList(list.slug)).status).toBe(200);
  });

  it("refuses new words while suspended, and still lets the owner tidy up", async () => {
    await api.setSuspended(curator, true);
    try {
      expect(
        (await api.request("/api/lists", { method: "POST", as: curator, body: { name: "While suspended" } })).status,
      ).toBe(403);
      expect((await addEntry(curator, list.id, draft.id)).status).toBe(403);
      expect(
        (await api.request(`/api/lists/${list.id}/entries/${lamps.id}`, { method: "DELETE", as: curator })).status,
      ).toBe(204);
    } finally {
      await api.setSuspended(curator, false);
    }
  });

  it("deletes the list, and the bells that pointed at it", async () => {
    await api.request(`/api/lists/${list.id}/entries/${tide.id}`, { method: "DELETE", as: curator });
    await addEntry(curator, list.id, tide.id);
    expect((await notificationsOf(follower)).length).toBeGreaterThan(0);

    expect((await api.request(`/api/lists/${list.id}`, { method: "DELETE", as: stranger })).status).toBe(403);
    expect((await api.request(`/api/lists/${list.id}`, { method: "DELETE", as: curator })).status).toBe(204);
    expect((await getList(list.id, curator)).status).toBe(404);
    expect(await notificationsOf(follower)).toHaveLength(0);
  });
});
