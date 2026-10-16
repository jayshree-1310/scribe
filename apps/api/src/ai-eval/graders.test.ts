/**
 * The code graders. They decide most of what the eval reports, so a grader
 * that marks wrongly is a metric that lies -- each is pinned here on the cases
 * that tempt it to.
 */

import { describe, expect, it } from "vitest";
import {
  changed,
  citesSource,
  continuesWithoutRepeating,
  groundedShare,
  hasPreamble,
  isDecline,
  keepsAll,
  mentionsAny,
  percentile,
  rate,
  scoreRetrieval,
  subjectRecall,
} from "./graders.js";

describe("scoreRetrieval", () => {
  it("ranks by chapter, not by passage", () => {
    // Three windows of chapter 4 before the right chapter is still rank two.
    expect(scoreRetrieval([4, 4, 4, 2], [2], 6)).toMatchObject({ rank: 2, hitAt1: false, hitAt3: true, reciprocalRank: 0.5 });
  });

  it("misses when the right chapter is beyond k", () => {
    expect(scoreRetrieval([1, 3, 5, 2], [2], 3)).toMatchObject({ rank: null, hitAtK: false, reciprocalRank: 0 });
  });

  it("accepts any of several right chapters", () => {
    expect(scoreRetrieval([3, 1], [1, 2], 6).rank).toBe(2);
  });
});

describe("isDecline", () => {
  it.each([
    "The story doesn't say what his name is.",
    "The passages do not mention a supervisor's name.",
    "That isn't stated in the chapters you have read.",
    "There is no mention of France in this story.",
    "I can't find anything about that.",
    "The story does not yet say.",
    // From a real run: a correct decline the first pattern missed.
    "The story does not give the supervisor’s name. [2]",
  ])("recognises %j", (answer) => {
    expect(isDecline(answer)).toBe(true);
  });

  it.each([
    "Mira climbed ninety-two steps [1].",
    "She did not sleep, and the supervisor asked whether she was sleeping [2].",
    "They laughed at the same moment [1].",
  ])("does not mistake an answer for a refusal: %j", (answer) => {
    expect(isDecline(answer)).toBe(false);
  });
});

describe("mentionsAny", () => {
  it("matches whole words, so 'no' is not found in 'know'", () => {
    expect(mentionsAny("I know the answer.", ["no"])).toBe(false);
    expect(mentionsAny("No, she did not win.", ["no"])).toBe(true);
    expect(mentionsAny("It was 2019.", ["2"])).toBe(false);
  });

  it("ignores case and typography", () => {
    expect(mentionsAny("She didn’t win.", ["didn't win"])).toBe(true);
    expect(mentionsAny("NINETY-TWO steps", ["ninety-two"])).toBe(true);
    // gpt-oss's non-breaking hyphen, from a real run.
    expect(mentionsAny("Mira climbed ninety\u2011two steps [1].", ["ninety-two"])).toBe(true);
    expect(keepsAll("Ninety\u2011two", ["ninety-two"])).toBe(true);
  });
});

describe("citesSource", () => {
  it("needs one right chapter among the cited", () => {
    expect(citesSource([3, 1], [1])).toBe(true);
    expect(citesSource([3], [1])).toBe(false);
    expect(citesSource([], [1])).toBe(false);
  });
});

describe("assistant graders", () => {
  it("catches the preambles the prompt forbids", () => {
    expect(hasPreamble("Here is the revised passage: Mira climbed.")).toBe(true);
    expect(hasPreamble("Sure! Mira climbed.")).toBe(true);
    expect(hasPreamble("Mira climbed the stairs.")).toBe(false);
    // "Here" inside prose is not a preamble.
    expect(hasPreamble("Hereafter she counted every step.")).toBe(false);
  });

  it("requires every kept word, and a real change", () => {
    expect(keepsAll("Mira climbed ninety-two steps.", ["mira", "Ninety-two"])).toBe(true);
    expect(keepsAll("She climbed.", ["Mira"])).toBe(false);
    expect(changed("Mira climbs.", "Mira climbs!")).toBe(false);
    expect(changed("Mira climbed.", "Mira climbs.")).toBe(true);
  });

  it("refuses a continuation that restarts with the handed-off text", () => {
    const original = "The bell rang at dawn. Cass went to the tower.";
    expect(continuesWithoutRepeating("The door at the top was open.", original)).toBe(true);
    expect(continuesWithoutRepeating("The bell rang at dawn. Cass went to the tower. Then…", original)).toBe(false);
    expect(continuesWithoutRepeating("   ", original)).toBe(false);
  });
});

describe("extraction graders", () => {
  const chapter = "She climbed the ninety-two steps in the dark, counting them.";

  it("measures how many quotes are really in the chapter", () => {
    expect(groundedShare(["climbed the ninety-two steps", "she flew up the tower"], chapter)).toBe(0.5);
    expect(groundedShare([], chapter)).toBe(0);
  });

  it("matches subjects loosely", () => {
    expect(subjectRecall(["Old Mira", "the lamp"], ["Mira"])).toBe(1);
    expect(subjectRecall(["Tolu"], ["Tolu", "Bisi"])).toBe(0.5);
  });
});

describe("aggregates", () => {
  it("rates only applicable entries", () => {
    expect(rate([true, false, null, undefined, true])).toBeCloseTo(2 / 3);
    expect(rate([null])).toBeNull();
  });

  it("takes a nearest-rank percentile", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });
});
