import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApi, databaseAvailable } from "../test/harness.js";
import {
  BADGES,
  awardBadges,
  flushBadges,
  metricsFor,
} from "../services/gamification.js";

const api = new TestApi();
const available = await databaseAvailable();

/**
 * One account per concern.
 *
 * Every metric is computed over a whole account, so two suites sharing a
 * fixture reader would award each other's badges. Splitting them is cheaper
 * than reasoning about which of the two earned the row.
 */
let boundary: string;
let collector: string;
let author: string;
let commenter: string;
let rater: string;
let stranger: string;

let read: { id: string; slug: string };
let chapters: string[] = [];
let commented: { id: string; slug: string };

beforeAll(async () => {
  if (!available) return;
  await api.start();

  boundary = await api.createUser("gb");
  collector = await api.createUser("gc");
  author = await api.createUser("ga", { isAuthor: true });
  commenter = await api.createUser("gm");
  rater = await api.createUser("gr");
  stranger = await api.createUser("gs", { isAuthor: true });

  // Twelve chapters, so the ten-chapter threshold has room either side of it.
  read = await api.createStory({ title: "Twelve Parts", authorId: stranger });
  for (let number = 1; number <= 12; number += 1) {
    chapters.push(await api.createChapter({ storyId: read.id, number }));
  }

  commented = await api.createStory({ title: "Talked About", authorId: stranger });
  await api.createChapter({ storyId: commented.id, number: 1 });
}, 30_000);

afterAll(async () => {
  if (available) await api.stop();
});

/** Records `count` distinct chapter reads for one reader, from chapter 1 up. */
async function readChapters(userId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await api.recordEvent({
      storyId: read.id,
      chapterId: chapters[index] as string,
      userId,
    });
  }
}

describe.skipIf(!available)("the catalogue", () => {
  it("has a unique code for every badge", () => {
    const codes = BADGES.map((badge) => badge.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it("asks only for metrics the engine computes", async () => {
    const metrics = await metricsFor(boundary);

    for (const badge of BADGES) {
      expect(metrics[badge.metric]).toBeTypeOf("number");
    }
  });
});

describe.skipIf(!available)("awarding", () => {
  it("does not award at one below the threshold", async () => {
    await readChapters(boundary, 9);

    const awarded = await awardBadges(boundary);

    expect(awarded.map((badge) => badge.code)).not.toContain("chapters-10");
    expect(await api.readBadges(boundary)).not.toContain("chapters-10");
  });

  it("awards at exactly the threshold", async () => {
    await readChapters(boundary, 10);

    const awarded = await awardBadges(boundary);

    expect(awarded.map((badge) => badge.code)).toContain("chapters-10");
    expect(await api.readBadges(boundary)).toContain("chapters-10");
  });

  it("is idempotent: re-evaluating past the threshold awards nothing new", async () => {
    await readChapters(boundary, 11);

    const again = await awardBadges(boundary);
    const third = await awardBadges(boundary);

    expect(again.map((badge) => badge.code)).not.toContain("chapters-10");
    expect(third).toEqual([]);

    // One row, not three: the unique key is what makes the insert idempotent.
    const held = await api.readBadges(boundary);
    expect(held.filter((code) => code === "chapters-10")).toHaveLength(1);
  });

  it("awards exactly the set the seeded metrics earn", async () => {
    // Reading: 12 chapters of one story, and a week's streak.
    await readChapters(collector, 12);
    await api.setStreak(collector, { streak: 7, lastReadAt: new Date() });

    // Community: one rating, one comment.
    await api.createRating({ userId: collector, storyId: read.id, rating: 4 });
    await api.createComment({ storyId: read.id, userId: collector });

    await awardBadges(collector);

    expect(await api.readBadges(collector)).toEqual([
      "chapters-10",
      "first-comment",
      "first-review",
      "streak-7",
    ]);
  });

  it("counts an author's own work, and only stories written on Scribe", async () => {
    const own = await api.createStory({ title: "Mine", authorId: author });
    await api.createChapter({ storyId: own.id, number: 1, wordCount: 12_000 });

    // A catalogue import carries a real author column and nobody here wrote
    // it, so it must not earn a writing badge.
    await api.createBook({
      title: "Imported",
      authorId: author,
      viewCount: 90_000,
    });

    await awardBadges(author);

    expect(await api.readBadges(author)).toEqual([
      "first-chapter",
      "first-story",
      "words-10k",
    ]);
  });
});

describe.skipIf(!available)("levels", () => {
  it("derives both levels from the ladders", async () => {
    // The collector read 12 chapters and wrote nothing: reader level 2 (the
    // ladder steps at 10), author level 1.
    expect(await api.readLevels(collector)).toEqual({ reader: 2, author: 1 });

    // The author wrote 12,000 words and read nothing: author level 3 (the
    // ladder steps at 1,000 and 5,000), reader level 1.
    expect(await api.readLevels(author)).toEqual({ reader: 1, author: 3 });
  });
});

describe.skipIf(!available)("evaluation from the events that move a metric", () => {
  it("awards after a comment, without the caller waiting for it", async () => {
    const response = await api.request(
      `/api/stories/${commented.slug}/comments`,
      { method: "POST", as: commenter, body: { content: "Lovely opening." } },
    );

    expect(response.status).toBe(201);
    // The response arrived before the award did: that is the point of the
    // fire-and-forget shape, and `flushBadges` is the seam that settles it.
    await flushBadges();

    expect(await api.readBadges(commenter)).toContain("first-comment");
  });

  it("awards after a rating", async () => {
    const response = await api.request(
      `/api/stories/${commented.slug}/rating`,
      { method: "PUT", as: rater, body: { rating: 5 } },
    );

    expect(response.status).toBe(200);
    await flushBadges();

    expect(await api.readBadges(rater)).toContain("first-review");
  });
});

describe.skipIf(!available)("GET /api/badges", () => {
  it("needs a signed-in caller", async () => {
    const response = await api.request("/api/badges");

    expect(response.status).toBe(401);
  });

  it("returns the whole catalogue with the caller's progress", async () => {
    const response = await api.request("/api/badges", { as: collector });

    expect(response.status).toBe(200);
    expect(response.body.badges).toHaveLength(BADGES.length);

    const byCode = new Map<string, any>(
      response.body.badges.map((entry: any) => [entry.badge.code, entry]),
    );

    const earned = byCode.get("chapters-10");
    expect(earned.earned).toBe(true);
    expect(earned.earnedAt).toEqual(expect.any(String));
    expect(earned.progress).toBe(1);

    // 12 of the 100 chapters that badge wants, and not yet earned.
    const locked = byCode.get("chapters-100");
    expect(locked.earned).toBe(false);
    expect(locked.earnedAt).toBeNull();
    expect(locked.progress).toBeCloseTo(0.12, 5);

    expect(response.body.levels.reader.level).toBe(2);
  });

  it("never reports progress above one", async () => {
    const response = await api.request("/api/badges", { as: author });

    for (const entry of response.body.badges) {
      expect(entry.progress).toBeGreaterThanOrEqual(0);
      expect(entry.progress).toBeLessThanOrEqual(1);
    }
  });

  it("evaluates before it answers, so a missed event cannot leave it stale", async () => {
    const fresh = await api.createUser("gf");

    // Written straight to the event log, so nothing has evaluated for them.
    await readChapters(fresh, 10);
    expect(await api.readBadges(fresh)).toEqual([]);

    const response = await api.request("/api/badges", { as: fresh });

    expect(response.status).toBe(200);
    expect(response.body.newlyEarned.map((badge: any) => badge.code)).toEqual([
      "chapters-10",
    ]);
    expect(await api.readBadges(fresh)).toEqual(["chapters-10"]);
  });
});

describe.skipIf(!available)("GET /api/users/:username/badges", () => {
  it("returns what somebody has earned, and nothing they have not", async () => {
    const response = await api.request(
      `/api/users/${api.usernameOf(collector)}/badges`,
    );

    expect(response.status).toBe(200);
    expect(response.body.badges.map((entry: any) => entry.badge.code)).toEqual([
      "chapters-10",
      "streak-7",
      "first-review",
      "first-comment",
    ]);
    for (const entry of response.body.badges) expect(entry.earned).toBe(true);
  });

  it("does not leak a stranger's progress toward a locked badge", async () => {
    const response = await api.request(
      `/api/users/${api.usernameOf(collector)}/badges`,
    );

    const codes = response.body.badges.map((entry: any) => entry.badge.code);
    expect(codes).not.toContain("chapters-100");
  });

  it("404s an unknown handle", async () => {
    const response = await api.request("/api/users/nobody-at-all/badges");

    expect(response.status).toBe(404);
  });
});
