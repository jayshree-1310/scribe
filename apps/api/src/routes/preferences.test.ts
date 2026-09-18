import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";
import { flushBadges } from "../services/gamification.js";
import { flushNotifications } from "../services/notifications.js";
import type { Preferences } from "../services/preferences.js";
import type { AccountProfile } from "../services/account.js";
import type { NotificationPage } from "../services/notifications.js";

const api = new TestApi();
const available = await databaseAvailable();

let reader: string;
let muter: string;
let poster: string;

let fantasy: string;
let romance: string;
let horror: string;

let channel: { id: string; slug: string };

/**
 * Fan-out is fire-and-forget, so the mute assertions have to wait for the
 * write the request did not. Badges first, never alongside; see
 * `routes/notifications.test.ts`, which explains the order once.
 */
async function settle(): Promise<void> {
  await flushBadges();
  await flushNotifications();
}

async function read(userId: string): Promise<Preferences> {
  const response = await api.request<{ preferences: Preferences }>(
    "/api/account/preferences",
    { as: userId },
  );

  expect(response.status).toBe(200);
  return response.body.preferences;
}

async function write(
  userId: string,
  body: unknown,
): Promise<{ status: number; preferences: Preferences }> {
  const response = await api.request<{ preferences: Preferences }>(
    "/api/account/preferences",
    { method: "PUT", as: userId, body },
  );

  return { status: response.status, preferences: response.body?.preferences };
}

beforeAll(async () => {
  if (!available) return;
  await api.start();

  // Short labels: `createUser` truncates the username to 30 characters, and
  // the run id already eats 25 of them.
  reader = await api.createUser("pr");
  muter = await api.createUser("pm");
  poster = await api.createUser("pp", { isAuthor: true });

  // Named so the catalogue order the service sorts into is not the order they
  // were created in -- otherwise the sort would pass by accident.
  fantasy = await api.createGenre("zz-fantasy");
  romance = await api.createGenre("mm-romance");
  horror = await api.createGenre("aa-horror");

  channel = await api.createChannel({ name: "Pref Channel", authorId: poster });
  await api.subscribeToChannel({ channelId: channel.id, userId: muter });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

describe.skipIf(!available)("reading preferences", () => {
  it("answers defaults for a reader who has never been asked", async () => {
    const preferences = await read(reader);

    expect(preferences).toMatchObject({
      genreIds: [],
      contentLength: "ANY",
      mutedNotificationTypes: [],
      onboardingComplete: false,
      onboardingCompletedAt: null,
      updatedAt: null,
    });
  });

  it("needs a session", async () => {
    const response = await api.request("/api/account/preferences");

    expect(response.status).toBe(401);
  });
});

describe.skipIf(!available)("writing preferences", () => {
  it("saves genres, a length and the onboarding flag together", async () => {
    const { status, preferences } = await write(reader, {
      genreIds: [fantasy, romance],
      contentLength: "SHORT",
      onboardingComplete: true,
    });

    expect(status).toBe(200);
    expect(preferences.genreIds).toHaveLength(2);
    expect(preferences.genreIds).toContain(fantasy);
    expect(preferences.contentLength).toBe("SHORT");
    expect(preferences.onboardingComplete).toBe(true);
    expect(preferences.onboardingCompletedAt).not.toBeNull();
  });

  it("returns the genres in catalogue order, not insertion order", async () => {
    const { preferences } = await write(reader, {
      genreIds: [fantasy, horror, romance],
    });

    // aa-horror, mm-romance, zz-fantasy -- the names, not the argument order.
    expect(preferences.genreIds).toEqual([horror, romance, fantasy]);
  });

  it("leaves out what the body left out", async () => {
    const { preferences } = await write(reader, { contentLength: "LONG" });

    expect(preferences.contentLength).toBe("LONG");
    // The three genres from the test above are still there: an absent key is
    // not an empty one.
    expect(preferences.genreIds).toHaveLength(3);
    expect(preferences.onboardingComplete).toBe(true);
  });

  it("replaces the set rather than merging it", async () => {
    const { preferences } = await write(reader, { genreIds: [horror] });

    expect(preferences.genreIds).toEqual([horror]);
  });

  it("takes an empty list as an answer", async () => {
    const { preferences } = await write(reader, { genreIds: [] });

    expect(preferences.genreIds).toEqual([]);
  });

  it("keeps the first completion timestamp when asked again", async () => {
    const first = await read(reader);
    const { preferences } = await write(reader, { onboardingComplete: true });

    expect(preferences.onboardingCompletedAt).toBe(first.onboardingCompletedAt);
  });

  it("reopens onboarding when told to", async () => {
    const { preferences } = await write(reader, { onboardingComplete: false });

    expect(preferences.onboardingComplete).toBe(false);
    expect(preferences.onboardingCompletedAt).toBeNull();

    await write(reader, { onboardingComplete: true });
  });

  it("refuses a genre that does not exist", async () => {
    const { status } = await write(reader, {
      genreIds: ["00000000-0000-4000-8000-0000000000ff"],
    });

    expect(status).toBe(400);
  });

  it("refuses a length it has never heard of", async () => {
    const { status } = await write(reader, { contentLength: "EPIC" });

    expect(status).toBe(400);
  });

  it("refuses an empty body", async () => {
    const { status } = await write(reader, {});

    expect(status).toBe(400);
  });
});

describe.skipIf(!available)("the onboarding flag on the profile", () => {
  /**
   * The web app gates its routing on this rather than on the preferences
   * endpoint, so the two have to agree. A profile that said `false` while
   * preferences said `true` would put a finished reader back into onboarding
   * on every reload.
   */
  it("follows what the preferences endpoint wrote", async () => {
    const before = await api.request<AccountProfile>("/api/account/me", {
      as: muter,
    });
    expect(before.body.onboardingComplete).toBe(false);

    await write(muter, { onboardingComplete: true });

    const after = await api.request<AccountProfile>("/api/account/me", {
      as: muter,
    });
    expect(after.body.onboardingComplete).toBe(true);
  });
});

describe.skipIf(!available)("muting a notification type", () => {
  it("stops the fan-out writing the row at all", async () => {
    const { preferences } = await write(muter, {
      mutedNotificationTypes: ["CHANNEL_POST"],
    });
    expect(preferences.mutedNotificationTypes).toEqual(["CHANNEL_POST"]);

    const posted = await api.request(`/api/channels/${channel.slug}/posts`, {
      method: "POST",
      as: poster,
      body: { title: "Muted announcement", content: "Nobody hears this." },
    });
    expect(posted.status).toBe(201);
    await settle();

    const inbox = await api.request<NotificationPage>("/api/notifications", {
      as: muter,
    });

    expect(inbox.body.items).toHaveLength(0);
  });

  it("lets the same post through once the mute is lifted", async () => {
    await write(muter, { mutedNotificationTypes: [] });

    const posted = await api.request(`/api/channels/${channel.slug}/posts`, {
      method: "POST",
      as: poster,
      body: { title: "Audible announcement", content: "This one lands." },
    });
    expect(posted.status).toBe(201);
    await settle();

    const inbox = await api.request<NotificationPage>("/api/notifications", {
      as: muter,
    });

    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0]?.title).toBe("Pref Channel");
  });

  it("refuses a type that is not in the enum", async () => {
    const { status } = await write(muter, {
      mutedNotificationTypes: ["EVERYTHING"],
    });

    expect(status).toBe(400);
  });
});
