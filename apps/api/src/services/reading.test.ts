/**
 * Unit tests for the streak rule.
 *
 * `advanceStreak` is pure and is the only place that decides where a reading
 * day starts, so it is tested directly rather than through the API — the
 * boundary cases need a clock the test controls, and waiting a day is not a
 * test.
 */

import { describe, expect, it } from "vitest";
import { advanceStreak } from "./reading.js";

/** Midday, so a test's ± hours cannot wander across a UTC day boundary. */
function utc(day: number, hour = 12): Date {
  return new Date(Date.UTC(2026, 8, day, hour, 0, 0));
}

describe("advanceStreak", () => {
  it("starts at 1 for a reader who has never read", () => {
    expect(advanceStreak(0, null, utc(10))).toEqual({
      streak: 1,
      changed: true,
    });
  });

  it("increments across a day boundary", () => {
    expect(advanceStreak(4, utc(9), utc(10))).toEqual({
      streak: 5,
      changed: true,
    });
  });

  it("increments across the boundary even minutes apart", () => {
    // 23:50 to 00:10 is twenty minutes and two different days, which is the
    // rule working as specified rather than a bug: the count follows the
    // calendar, not elapsed time.
    expect(advanceStreak(1, utc(9, 23), utc(10, 0))).toEqual({
      streak: 2,
      changed: true,
    });
  });

  it("does nothing when the reader already read today", () => {
    expect(advanceStreak(7, utc(10, 1), utc(10, 23))).toEqual({
      streak: 7,
      changed: false,
    });
  });

  it("restarts after a missed day", () => {
    expect(advanceStreak(12, utc(8), utc(10))).toEqual({
      streak: 1,
      changed: true,
    });
  });

  it("restarts after a long gap", () => {
    expect(advanceStreak(30, utc(1), utc(28))).toEqual({
      streak: 1,
      changed: true,
    });
  });

  it("restarts rather than trusting an anchor in the future", () => {
    expect(advanceStreak(9, utc(12), utc(10))).toEqual({
      streak: 1,
      changed: true,
    });
  });

  it("counts days in UTC, not in the host's timezone", () => {
    /**
     * 2026-09-09T23:00Z and 2026-09-10T01:00Z are consecutive UTC days and
     * the *same* day in, say, UTC-05:00. The result must follow UTC until a
     * reader timezone is stored — this is the assertion that fails if someone
     * swaps the arithmetic for `Date.prototype.getDate()`, which reads local.
     */
    const previous = new Date("2026-09-09T23:00:00Z");
    const now = new Date("2026-09-10T01:00:00Z");

    expect(advanceStreak(2, previous, now)).toEqual({
      streak: 3,
      changed: true,
    });
  });
});
