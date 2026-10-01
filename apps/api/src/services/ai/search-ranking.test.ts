/**
 * The ranking rules of hybrid search, as a specification.
 *
 * No database and no model: these are the functions that decide what
 * retrieved rows mean, and every one of them is pure. `routes/ai-search.test.ts`
 * covers the same behaviour end to end; this file is where a change to a rule
 * should fail first, with a message about the rule rather than about a route.
 */

import { describe, expect, it } from "vitest";
import {
  EXCERPT_CHARS,
  PASSAGES_PER_STORY,
  RRF_K,
  excerptOf,
  fuseRankings,
  rankStories,
  type PassageHit,
} from "./search-ranking.js";

function hit(
  storyId: string,
  chapterId: string,
  similarity: number,
  text = `${storyId}/${chapterId}`,
): PassageHit {
  return {
    storyId,
    chapterId,
    chapterNumber: 1,
    chapterTitle: "Chapter",
    text,
    similarity,
  };
}

describe("rankStories", () => {
  it("ranks a story by its best passage, not its average", () => {
    const ranked = rankStories(
      [
        // One devastating chapter among unrelated ones...
        hit("novel", "n1", 0.9),
        hit("novel", "n2", 0.51),
        hit("novel", "n3", 0.51),
        // ...against a story that is consistently, mildly on topic.
        hit("short", "s1", 0.7),
        hit("short", "s2", 0.7),
      ],
      0.5,
    );

    expect(ranked.map((story) => story.storyId)).toEqual(["novel", "short"]);
    expect(ranked[0]?.similarity).toBe(0.9);
  });

  it("drops everything under the similarity floor", () => {
    const ranked = rankStories(
      [hit("near", "a", 0.62), hit("far", "b", 0.44), hit("near", "c", 0.3)],
      0.5,
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.passages.map((passage) => passage.chapterId)).toEqual(["a"]);
  });

  it("returns nothing when nothing is near, rather than the nearest", () => {
    // Nearest-neighbour search always has neighbours; this is the floor's job.
    expect(rankStories([hit("x", "a", 0.45), hit("y", "b", 0.41)], 0.5)).toEqual([]);
  });

  it("quotes at most one passage per chapter, and a bounded number per story", () => {
    const ranked = rankStories(
      [
        // Overlapping windows of one scene: near-duplicates.
        hit("story", "ch1", 0.9),
        hit("story", "ch1", 0.88),
        hit("story", "ch2", 0.8),
        hit("story", "ch3", 0.79),
      ],
      0.5,
    );

    const passages = ranked[0]?.passages ?? [];
    expect(passages).toHaveLength(PASSAGES_PER_STORY);
    expect(passages.map((passage) => passage.chapterId)).toEqual(["ch1", "ch2"]);
  });

  it("does not trust the order rows arrive in", () => {
    // `relaxed_order` lets the index return rows slightly out of order.
    const ranked = rankStories(
      [hit("b", "b1", 0.6), hit("a", "a1", 0.8), hit("b", "b2", 0.7)],
      0.5,
    );

    expect(ranked.map((story) => story.storyId)).toEqual(["a", "b"]);
    expect(ranked[1]?.passages[0]?.chapterId).toBe("b2");
  });
});

describe("fuseRankings", () => {
  it("ranks an item both lists found above an item only one list found", () => {
    const fused = fuseRankings([
      ["keyword-only", "both"],
      ["meaning-only", "both"],
    ]);

    // Second in both lists beats first in one.
    expect(fused[0]?.id).toBe("both");
    expect(fused[0]?.ranks).toEqual([2, 2]);
    expect(fused[0]?.score).toBeCloseTo(2 / (RRF_K + 2));
  });

  it("scores by rank alone, with the documented constant", () => {
    const fused = fuseRankings([["a", "b", "c"]]);

    expect(fused.map((item) => item.score)).toEqual([
      1 / (RRF_K + 1),
      1 / (RRF_K + 2),
      1 / (RRF_K + 3),
    ]);
  });

  it("records where each item came from", () => {
    const fused = fuseRankings([["k"], ["s"]]);
    const byId = new Map(fused.map((item) => [item.id, item.ranks]));

    expect(byId.get("k")).toEqual([1, null]);
    expect(byId.get("s")).toEqual([null, 1]);
  });

  it("breaks ties deterministically, so a page boundary cannot shuffle", () => {
    // Equal scores: first in one list each.
    const once = fuseRankings([["zeta"], ["alpha"]]);
    const again = fuseRankings([["zeta"], ["alpha"]]);

    expect(once.map((item) => item.id)).toEqual(["alpha", "zeta"]);
    expect(again).toEqual(once);
  });

  it("handles an empty list, which is what a degraded half looks like", () => {
    expect(fuseRankings([["a", "b"], []]).map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
    expect(fuseRankings([[], []])).toEqual([]);
  });
});

describe("excerptOf", () => {
  const long =
    "The harbour was quiet that morning and the gulls had not yet come in. ".repeat(4) +
    "She found the lighthouse keeper's letter folded inside the logbook. " +
    "Nobody had written in it for eleven years, and the ink had gone brown. ".repeat(4);

  it("returns a short passage whole", () => {
    expect(excerptOf("A short passage.", "anything")).toBe("A short passage.");
  });

  it("stays within its bound, plus the ellipses", () => {
    const excerpt = excerptOf(long, "nothing that appears");
    expect(excerpt.replace(/…/g, "").length).toBeLessThanOrEqual(EXCERPT_CHARS);
  });

  it("centres on a query word when the passage contains one", () => {
    const excerpt = excerptOf(long, "keeper letter");

    expect(excerpt).toContain("letter");
    expect(excerpt.startsWith("…")).toBe(true);
  });

  it("anchors on the most distinctive word, not the earliest", () => {
    // "the" appears in the first sentence; "logbook" is what the reader typed
    // the query for.
    const excerpt = excerptOf(long, "the logbook");
    expect(excerpt).toContain("logbook");
  });

  it("opens the window when no query word appears, as semantic matches do", () => {
    const excerpt = excerptOf(long, "grief");

    expect(excerpt.startsWith("The harbour")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("never cuts a word in half", () => {
    const excerpt = excerptOf(long, "logbook");
    const words = new Set(long.replace(/\s+/g, " ").split(" "));

    for (const word of excerpt.replace(/…/g, "").split(" ")) {
      expect(words.has(word)).toBe(true);
    }
  });
});
