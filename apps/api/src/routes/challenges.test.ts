import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";

const api = new TestApi();
const available = await databaseAvailable();

/** The only account allowed to host a challenge. */
let admin: string;

/** Writers, so "you can only enter your own story" is expressible. */
let author: string;
let other: string;

/** Readers, so a story can carry more than one rating. */
let raters: string[] = [];

/** One challenge in each of the three states the clock can produce. */
let active: { id: string; slug: string };
let upcoming: { id: string; slug: string };
let past: { id: string; slug: string };

let story: { id: string; slug: string };
let otherStory: { id: string; slug: string };
let draft: { id: string; slug: string };
let catalogue: string;

beforeAll(async () => {
  if (!available) return;
  await api.start();

  admin = await api.createUser("ca");
  await api.setAdmin(admin);

  author = await api.createUser("cw", { isAuthor: true });
  other = await api.createUser("co", { isAuthor: true });

  raters = [
    await api.createUser("cr1"),
    await api.createUser("cr2"),
    await api.createUser("cr3"),
  ];

  active = await api.createChallenge({
    title: "Active Challenge",
    hostId: admin,
    opensIn: -2,
    closesIn: 5,
  });
  upcoming = await api.createChallenge({
    title: "Upcoming Challenge",
    hostId: admin,
    opensIn: 3,
    closesIn: 20,
  });
  past = await api.createChallenge({
    title: "Past Challenge",
    hostId: admin,
    opensIn: -20,
    closesIn: -2,
  });

  story = await api.createStory({ title: "Entry Story", authorId: author });
  otherStory = await api.createStory({ title: "Someone Elses", authorId: other });
  draft = await api.createStory({
    title: "Unfinished Entry",
    authorId: author,
    listed: false,
  });
  catalogue = await api.createBook({ title: "Imported Edition", authorId: author });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

/* Discovery -------------------------------------------------------------- */

describe.skipIf(!available)("listing challenges", () => {
  it("splits them by the window rather than by a stored status", async () => {
    const { status, body } = await api.request("/api/challenges");

    expect(status).toBe(200);

    const idsIn = (group: { id: string }[]) => group.map((item) => item.id);

    expect(idsIn(body.active)).toContain(active.id);
    expect(idsIn(body.upcoming)).toContain(upcoming.id);
    expect(idsIn(body.past)).toContain(past.id);

    // Each challenge appears in exactly one group.
    expect(idsIn(body.upcoming)).not.toContain(active.id);
    expect(idsIn(body.past)).not.toContain(active.id);
  });

  it("carries the fields a challenge card renders", async () => {
    const { body } = await api.request("/api/challenges");
    const found = body.active.find(
      (item: { id: string }) => item.id === active.id,
    );

    expect(found).toMatchObject({
      slug: active.slug,
      title: "Active Challenge",
      prompt: "Write something about a door.",
      state: "active",
      wordTarget: 1000,
    });
    expect(found.host).toMatchObject({ id: admin });
    expect(typeof found.startsAt).toBe("string");
    expect(typeof found.endsAt).toBe("string");
  });
});

describe.skipIf(!available)("one challenge", () => {
  it("is addressable by slug and by id", async () => {
    const bySlug = await api.request(`/api/challenges/${active.slug}`);
    const byId = await api.request(`/api/challenges/${active.id}`);

    expect(bySlug.status).toBe(200);
    expect(byId.status).toBe(200);
    expect(bySlug.body.challenge.id).toBe(byId.body.challenge.id);
  });

  it("answers 404 for a slug nobody has", async () => {
    const { status } = await api.request("/api/challenges/no-such-challenge");

    expect(status).toBe(404);
  });

  it("carries no entry for an anonymous caller", async () => {
    const { body } = await api.request(`/api/challenges/${active.slug}`);

    expect(body.challenge.entry).toBeNull();
  });
});

/* Entering --------------------------------------------------------------- */

describe.skipIf(!available)("entering a challenge", () => {
  it("refuses before the window opens", async () => {
    const { status, body } = await api.request(
      `/api/challenges/${upcoming.id}/enter`,
      { method: "POST", as: author },
    );

    expect(status).toBe(409);
    expect(body.error.message).toMatch(/not opened/i);
  });

  it("refuses after the window closes", async () => {
    const { status, body } = await api.request(
      `/api/challenges/${past.id}/enter`,
      { method: "POST", as: author },
    );

    expect(status).toBe(409);
    expect(body.error.message).toMatch(/closed/i);
  });

  it("refuses an anonymous caller", async () => {
    const { status } = await api.request(`/api/challenges/${active.id}/enter`, {
      method: "POST",
    });

    expect(status).toBe(401);
  });

  it("takes a place inside the window, with no story yet", async () => {
    const { status, body } = await api.request(
      `/api/challenges/${active.id}/enter`,
      { method: "POST", as: author },
    );

    expect(status).toBe(201);
    expect(body.entry).toMatchObject({ challengeId: active.id, story: null, note: null });
  });

  it("refuses a second place in the same challenge", async () => {
    const { status, body } = await api.request(
      `/api/challenges/${active.id}/enter`,
      { method: "POST", as: author },
    );

    expect(status).toBe(409);
    expect(body.error.message).toMatch(/already entered/i);
  });

  /**
   * Two requests that both pass the "already entered?" read before either
   * writes. `@@unique([challengeId, userId])` is what stops the second row;
   * this pins that the caller is told so rather than handed a 500.
   */
  it("answers a lost race with the same conflict, not a fault", async () => {
    const race = await api.createChallenge({
      title: "Raced Challenge",
      hostId: admin,
      opensIn: -1,
      closesIn: 5,
    });
    const racer = await api.createUser("crace");

    const [first, second] = await Promise.all([
      api.request(`/api/challenges/${race.id}/enter`, {
        method: "POST",
        as: racer,
      }),
      api.request(`/api/challenges/${race.id}/enter`, {
        method: "POST",
        as: racer,
      }),
    ]);

    expect([first!.status, second!.status].sort()).toEqual([201, 409]);

    const { body } = await api.request(`/api/challenges/${race.slug}`);
    expect(body.challenge.participantCount).toBe(1);
  });

  it("returns the caller their own entry, and nobody else's", async () => {
    const mine = await api.request(`/api/challenges/${active.slug}`, {
      as: author,
    });
    const theirs = await api.request(`/api/challenges/${active.slug}`, {
      as: other,
    });

    expect(mine.body.challenge.entry).not.toBeNull();
    expect(theirs.body.challenge.entry).toBeNull();
  });

  it("counts a place as a participant but not yet as an entry", async () => {
    const { body } = await api.request(`/api/challenges/${active.slug}`);

    expect(body.challenge.participantCount).toBe(1);
    expect(body.challenge.entryCount).toBe(0);
  });
});

/* The entry -------------------------------------------------------------- */

describe.skipIf(!available)("attaching a story to an entry", () => {
  let entryId: string;

  beforeAll(async () => {
    const { body } = await api.request(`/api/challenges/${active.slug}`, {
      as: author,
    });
    entryId = body.challenge.entry.id;
  });

  it("refuses somebody else's story", async () => {
    const { status, body } = await api.request(`/api/challenges/entries/${entryId}`, {
      method: "PUT",
      as: author,
      body: { storyId: otherStory.id },
    });

    expect(status).toBe(403);
    expect(body.error.message).toMatch(/story you wrote/i);
  });

  it("refuses a catalogue edition, which nobody wrote on Scribe", async () => {
    const { status } = await api.request(`/api/challenges/entries/${entryId}`, {
      method: "PUT",
      as: author,
      body: { storyId: catalogue },
    });

    expect(status).toBe(400);
  });

  it("refuses an entry that is not the caller's", async () => {
    const { status } = await api.request(`/api/challenges/entries/${entryId}`, {
      method: "PUT",
      as: other,
      body: { note: "not mine" },
    });

    expect(status).toBe(403);
  });

  it("attaches the caller's own story and keeps the note", async () => {
    const { status, body } = await api.request(`/api/challenges/entries/${entryId}`, {
      method: "PUT",
      as: author,
      body: { storyId: story.id, note: "Written in one sitting." },
    });

    expect(status).toBe(200);
    expect(body.entry.story.id).toBe(story.id);
    expect(body.entry.note).toBe("Written in one sitting.");
  });

  it("now counts as an entry as well as a participant", async () => {
    const { body } = await api.request(`/api/challenges/${active.slug}`);

    expect(body.challenge.participantCount).toBe(1);
    expect(body.challenge.entryCount).toBe(1);
  });

  it("swaps the story without resending the note", async () => {
    const swapped = await api.request(`/api/challenges/entries/${entryId}`, {
      method: "PUT",
      as: author,
      body: { storyId: draft.id },
    });

    expect(swapped.body.entry.story.id).toBe(draft.id);
    expect(swapped.body.entry.note).toBe("Written in one sitting.");

    // Put it back, so the leaderboard suite below reads a published entry.
    await api.request(`/api/challenges/entries/${entryId}`, {
      method: "PUT",
      as: author,
      body: { storyId: story.id },
    });
  });

  it("refuses an empty body rather than answering 200 to nothing", async () => {
    const { status } = await api.request(`/api/challenges/entries/${entryId}`, {
      method: "PUT",
      as: author,
      body: {},
    });

    expect(status).toBe(400);
  });
});

describe.skipIf(!available)("withdrawing", () => {
  it("removes the entry and the participant with it", async () => {
    const joined = await api.request(`/api/challenges/${active.id}/enter`, {
      method: "POST",
      as: other,
    });
    expect(joined.status).toBe(201);

    const removed = await api.request(
      `/api/challenges/entries/${joined.body.entry.id}`,
      { method: "DELETE", as: other },
    );
    expect(removed.status).toBe(204);

    const { body } = await api.request(`/api/challenges/${active.slug}`, {
      as: other,
    });
    expect(body.challenge.entry).toBeNull();
    expect(body.challenge.participantCount).toBe(1);
  });

  it("refuses to change an entry once the challenge has closed", async () => {
    const entryId = await api.createChallengeEntry({
      challengeId: past.id,
      userId: other,
      storyId: otherStory.id,
    });

    const edited = await api.request(`/api/challenges/entries/${entryId}`, {
      method: "PUT",
      as: other,
      body: { note: "second thoughts" },
    });
    const withdrawn = await api.request(`/api/challenges/entries/${entryId}`, {
      method: "DELETE",
      as: other,
    });

    expect(edited.status).toBe(409);
    expect(withdrawn.status).toBe(409);
  });
});

/* The leaderboard -------------------------------------------------------- */

describe.skipIf(!available)("the leaderboard", () => {
  let board: { id: string; slug: string };
  let first: { id: string; slug: string };
  let tied: { id: string; slug: string };
  let single: { id: string; slug: string };
  let unrated: { id: string; slug: string };
  let hidden: { id: string; slug: string };

  beforeAll(async () => {
    board = await api.createChallenge({
      title: "Ranked Challenge",
      hostId: admin,
      opensIn: -10,
      closesIn: -1,
    });

    const writers = [
      await api.createUser("cb1", { isAuthor: true }),
      await api.createUser("cb2", { isAuthor: true }),
      await api.createUser("cb3", { isAuthor: true }),
      await api.createUser("cb4", { isAuthor: true }),
      await api.createUser("cb5", { isAuthor: true }),
    ];

    first = await api.createStory({ title: "Nine Stars Early", authorId: writers[0]! });
    tied = await api.createStory({ title: "Nine Stars Late", authorId: writers[1]! });
    single = await api.createStory({ title: "Five Stars", authorId: writers[2]! });
    unrated = await api.createStory({ title: "No Stars", authorId: writers[3]! });
    hidden = await api.createStory({
      title: "Draft Entry",
      authorId: writers[4]!,
      listed: false,
    });

    // 5 + 4 = 9 for both of the first two, so only the tie-break separates
    // them; 5 for the third; nothing for the fourth.
    await api.createRating({ userId: raters[0]!, storyId: first.id, rating: 5 });
    await api.createRating({ userId: raters[1]!, storyId: first.id, rating: 4 });
    await api.createRating({ userId: raters[0]!, storyId: tied.id, rating: 4 });
    await api.createRating({ userId: raters[1]!, storyId: tied.id, rating: 5 });
    await api.createRating({ userId: raters[2]!, storyId: single.id, rating: 5 });

    const day = 24 * 60 * 60 * 1000;
    await api.createChallengeEntry({
      challengeId: board.id,
      userId: writers[0]!,
      storyId: first.id,
      submittedAt: new Date(Date.now() - 5 * day),
    });
    await api.createChallengeEntry({
      challengeId: board.id,
      userId: writers[1]!,
      storyId: tied.id,
      submittedAt: new Date(Date.now() - 2 * day),
    });
    await api.createChallengeEntry({
      challengeId: board.id,
      userId: writers[2]!,
      storyId: single.id,
      submittedAt: new Date(Date.now() - 4 * day),
    });
    await api.createChallengeEntry({
      challengeId: board.id,
      userId: writers[3]!,
      storyId: unrated.id,
      submittedAt: new Date(Date.now() - 3 * day),
    });
    await api.createChallengeEntry({
      challengeId: board.id,
      userId: writers[4]!,
      storyId: hidden.id,
      submittedAt: new Date(Date.now() - 6 * day),
    });
  }, 30_000);

  it("ranks by the stars an entry's story has been given, summed", async () => {
    const { status, body } = await api.request(
      `/api/challenges/${board.slug}/leaderboard`,
    );

    expect(status).toBe(200);
    expect(body.items.map((row: { story: { id: string } }) => row.story.id)).toEqual([
      first.id,
      tied.id,
      single.id,
      unrated.id,
    ]);
    expect(body.items.map((row: { rank: number }) => row.rank)).toEqual([1, 2, 3, 4]);
    expect(body.items[0]).toMatchObject({ score: 9, ratingCount: 2, ratingAverage: 4.5 });
    expect(body.items[3]).toMatchObject({ score: 0, ratingCount: 0, ratingAverage: null });
  });

  it("breaks a tie the same way every time", async () => {
    const once = await api.request(`/api/challenges/${board.slug}/leaderboard`);
    const twice = await api.request(`/api/challenges/${board.slug}/leaderboard`);

    // Equal scores and equal rating counts, so only "submitted first" can be
    // separating them -- and it has to separate them identically on a re-read.
    expect(once.body.items[0].score).toBe(twice.body.items[1].score);
    expect(once.body.items.map((row: { entryId: string }) => row.entryId)).toEqual(
      twice.body.items.map((row: { entryId: string }) => row.entryId),
    );
  });

  it("leaves an unpublished entry off the board entirely", async () => {
    const { body } = await api.request(`/api/challenges/${board.slug}/leaderboard`);

    expect(body.total).toBe(4);
    expect(
      body.items.some((row: { story: { id: string } }) => row.story.id === hidden.id),
    ).toBe(false);
  });

  it("pages without repeating or renumbering a row", async () => {
    const page1 = await api.request(
      `/api/challenges/${board.slug}/leaderboard?page=1&limit=2`,
    );
    const page2 = await api.request(
      `/api/challenges/${board.slug}/leaderboard?page=2&limit=2`,
    );

    expect(page1.body.items.map((row: { rank: number }) => row.rank)).toEqual([1, 2]);
    expect(page2.body.items.map((row: { rank: number }) => row.rank)).toEqual([3, 4]);
    expect(page1.body.hasMore).toBe(true);
    expect(page2.body.hasMore).toBe(false);
  });

  it("still knows the total on a page past the end", async () => {
    const { body } = await api.request(
      `/api/challenges/${board.slug}/leaderboard?page=5&limit=2`,
    );

    expect(body.items).toEqual([]);
    expect(body.total).toBe(4);
    expect(body.hasMore).toBe(false);
  });

  it("answers an empty board with zeroes rather than an error", async () => {
    const { status, body } = await api.request(
      `/api/challenges/${upcoming.slug}/leaderboard`,
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({ items: [], total: 0, totalPages: 0, hasMore: false });
  });
});

/* Hosting ---------------------------------------------------------------- */

describe.skipIf(!available)("hosting a challenge", () => {
  const window = () => {
    const day = 24 * 60 * 60 * 1000;
    return {
      startsAt: new Date(Date.now() + day).toISOString(),
      endsAt: new Date(Date.now() + 30 * day).toISOString(),
    };
  };

  it("refuses a caller who is not an administrator", async () => {
    const { status, body } = await api.request("/api/challenges", {
      method: "POST",
      as: author,
      body: { title: "Nobody's Challenge", prompt: "A door.", ...window() },
    });

    expect(status).toBe(403);
    expect(body.error.message).toMatch(/administrator/i);
  });

  it("creates one for an administrator, with a slug derived from the title", async () => {
    const { status, body } = await api.request("/api/challenges", {
      method: "POST",
      as: admin,
      body: {
        title: "Hosted By An Admin",
        prompt: "Two people, one shared task.",
        description: "A fixture challenge.",
        wordTarget: 2500,
        ...window(),
      },
    });

    expect(status).toBe(201);
    expect(body.challenge).toMatchObject({
      slug: "hosted-by-an-admin",
      state: "upcoming",
      wordTarget: 2500,
      participantCount: 0,
      entryCount: 0,
    });

    api.trackChallenge(body.challenge.id);
  });

  it("refuses a window that ends before it starts", async () => {
    const day = 24 * 60 * 60 * 1000;
    const { status } = await api.request("/api/challenges", {
      method: "POST",
      as: admin,
      body: {
        title: "Backwards Window",
        prompt: "A door.",
        startsAt: new Date(Date.now() + 30 * day).toISOString(),
        endsAt: new Date(Date.now() + day).toISOString(),
      },
    });

    expect(status).toBe(400);
  });

  it("renames without moving the slug every shared link depends on", async () => {
    const { body } = await api.request(`/api/challenges/${active.id}`, {
      method: "PATCH",
      as: admin,
      body: { title: "Active Challenge, Renamed" },
    });

    expect(body.challenge.title).toBe("Active Challenge, Renamed");
    expect(body.challenge.slug).toBe(active.slug);
  });

  it("refuses an edit from a caller who is not an administrator", async () => {
    const { status } = await api.request(`/api/challenges/${active.id}`, {
      method: "PATCH",
      as: author,
      body: { title: "Hijacked" },
    });

    expect(status).toBe(403);
  });
});
