import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The guard that makes "a fifth write seam must call `assertNotSuspended`"
 * something other than a comment somebody has to read.
 *
 * Suspension stops an account *writing* and nothing else, and it is enforced
 * per service function rather than in `requireUser` -- deliberately, because a
 * check in the middleware would cost every request in the app a query to
 * answer a question a handful of them ask. The cost of that decision is that
 * nothing structural connects a new write route to the rule, and the header of
 * `services/moderation.ts` carried the list instead. It was already wrong:
 * it named four seams when there were six, because two like endpoints were
 * added and the prose was not.
 *
 * So the list lives here, beside a test that fails when a write route appears
 * that is not on it. This does not decide whether a route *should* refuse a
 * suspended account -- no test can -- it only refuses to let one be added
 * without somebody saying which it is and why. An honest "exempt, because..."
 * is a perfectly good answer; not having thought about it is not.
 */

const ROUTES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
);

/** Routes that must refuse a suspended account, and do. */
const GUARDED = new Set([
  "engagement.ts POST /stories/:storyId/comments",
  "engagement.ts PUT /chapters/:id/like",
  "engagement.ts PUT /comments/:id/like",
  "clubs.ts POST /:id/discussions",
  "channels.ts POST /:id/posts",
  "moderation.ts POST /reports",
]);

/**
 * Everything else, with the reason it is not guarded. Grouped by the argument
 * rather than by file, because the argument is the part worth reviewing.
 */
const EXEMPT: Record<string, string> = Object.fromEntries(
  [
    // Getting in, and getting back in. A suspended reader still reads, so
    // every one of these has to work while suspended -- and locking somebody
    // out of their own password reset would make a suspension a deletion.
    ...[
      "auth.ts POST /signup",
      "auth.ts POST /login",
      "auth.ts POST /refresh",
      "auth.ts POST /logout",
      "auth.ts POST /logout-all",
      "auth.ts POST /google",
      "auth-security.ts POST /forgot-password",
      "auth-security.ts POST /reset-password",
      "auth-security.ts POST /change-password",
      "auth-security.ts POST /set-password",
      "auth-security.ts POST /send-verification",
      "auth-security.ts POST /verify-email",
    ].map((route) => [route, "sign-in and recovery; a suspension is not a lockout"]),

    // The account itself. Nothing here reaches another reader, and leaving is
    // a right rather than a privilege.
    ...[
      "account.ts PATCH /me",
      "account.ts POST /avatar",
      "account.ts DELETE /me",
      "account.ts DELETE /avatar",
      "preferences.ts PUT /preferences",
      "uploads.ts POST /",
    ].map((route) => [route, "the caller's own account; reaches nobody else"]),

    // Private state about what the caller has read or wants to read.
    ...[
      "library.ts POST /",
      "library.ts PATCH /:bookId",
      "library.ts DELETE /:bookId",
      "reading.ts PUT /progress",
      "reading.ts DELETE /progress/:storyId",
      "notifications.ts POST /:id/read",
      "notifications.ts POST /read-all",
      "notifications.ts DELETE /read",
    ].map((route) => [route, "reading state; a suspended account still reads"]),

    // Authoring. A draft is the author's own work and reaches nobody until it
    // is listed. **Publishing is the arguable one**: it does put work in front
    // of other people, and suspension does not stop it today. Recorded rather
    // than quietly changed -- widening what a suspension means is a product
    // decision, not a missing line.
    ...[
      "authoring.ts POST /stories",
      "authoring.ts PATCH /stories/:id",
      "authoring.ts DELETE /stories/:id",
      "authoring.ts POST /stories/:id/publish",
      "authoring.ts POST /stories/:id/unpublish",
      "authoring.ts POST /stories/:id/chapters",
      "authoring.ts POST /stories/:id/chapters/reorder",
      "authoring.ts PATCH /chapters/:id",
      "authoring.ts DELETE /chapters/:id",
      "authoring.ts POST /chapters/:id/publish",
      "authoring.ts POST /chapters/:id/unpublish",
      "authoring.ts POST /chapters/:id/multimedia",
      "authoring.ts DELETE /multimedia/:id",
      "channels.ts POST /",
      "channels.ts PATCH /:id",
      "channels.ts DELETE /:id",
      "channels.ts PATCH /posts/:id",
      "channels.ts DELETE /posts/:id",
      "clubs.ts POST /",
      "clubs.ts PATCH /:id",
      "clubs.ts DELETE /:id",
      "clubs.ts PUT /:id/current-read",
      "clubs.ts DELETE /discussions/:id",
    ].map((route) => [route, "the author's own work, or removing it"]),

    // Joining, leaving, following: membership rather than speech.
    ...[
      "clubs.ts POST /:id/join",
      "clubs.ts DELETE /:id/leave",
      "clubs.ts PATCH /:id/members/:userId",
      "clubs.ts DELETE /:id/members/:userId",
      "channels.ts POST /:id/subscribe",
      "channels.ts DELETE /:id/subscribe",
      "users.ts POST /:username/follow",
      "users.ts DELETE /:username/follow",
    ].map((route) => [route, "membership and follows, which carry no text"]),

    // Ratings and entries: a number and a pointer, neither of them prose.
    ...[
      "engagement.ts PUT /stories/:storyId/rating",
      "engagement.ts DELETE /stories/:storyId/rating",
      "engagement.ts DELETE /comments/:id",
      "engagement.ts DELETE /chapters/:id/like",
      "engagement.ts DELETE /comments/:id/like",
      "challenges.ts POST /:id/enter",
      "challenges.ts PUT /entries/:id",
      "challenges.ts DELETE /entries/:id",
    ].map((route) => [route, "a score, a withdrawal or an undo; no new text"]),

    // Administrator-only, and an administrator cannot be suspended.
    ...[
      "challenges.ts POST /",
      "challenges.ts PATCH /:id",
      "moderation.ts POST /moderation/reports/:id/resolve",
      "moderation.ts POST /moderation/users/:id/reinstate",
      "ai.ts POST /admin/jobs/:id/retry",
      "ai.ts PUT /admin/switches",
    ].map((route) => [route, "administrators only; `assertSuspendable` refuses to suspend one"]),

    // Generation for the caller alone; nothing it returns is published by it.
    ...[
      "ai.ts POST /chat",
      "ai.ts POST /chat/stream",
      "ai.ts POST /scribble",
      "ai.ts POST /scribble/stream",
      "ai.ts POST /assist",
      "ai.ts POST /assist/stream",
      "ai.ts POST /generate/${kind}",
      "ai.ts POST /generate/refine",
      "ai.ts POST /explain",
      "ai.ts POST /explain/stream",
      "ai.ts POST /ask",
      "ai.ts POST /ask/stream",
      "ai.ts POST /conversations",
      "ai.ts POST /conversations/:id/messages",
      "ai.ts DELETE /conversations/:id",
      "ai.ts POST /agent",
      "ai.ts POST /agent/stream",
    ].map((route) => [route, "answers the caller and writes nothing public"]),

    /**
     * The one AI route that does write a row, and still exempt.
     *
     * What it stores is a model's recap of a chapter that was already
     * published by somebody else -- none of the caller's own words reach it,
     * so a suspended account cannot use it to put text in front of readers.
     * Suspension exists to stop someone publishing; this publishes nothing of
     * theirs. It is also idempotent per chapter, so the row a suspended caller
     * triggers is the row the next reader would have triggered anyway.
     */
    ["ai.ts POST /recap/:slugOrId/:chapterNumber", "stores a model's recap of somebody else's published chapter; none of the caller's text reaches it"],

    /**
     * The story bible and the continuity checker. Notes an author keeps about
     * their own story, readable by nobody else: every one of these asserts
     * ownership, and nothing they write is ever shown to a reader. Suspension
     * stops publishing, and none of this publishes.
     */
    ...[
      "ai.ts POST /bible/:storyId/refresh",
      "ai.ts POST /bible/:storyId/read",
      "ai.ts POST /summaries/story/:storyId/regenerate",
      "ai.ts POST /summaries/chapter/:chapterId/regenerate",
      "ai.ts POST /bible/:storyId/facts",
      "ai.ts PATCH /bible/facts/:factId",
      "ai.ts DELETE /bible/facts/:factId",
      "ai.ts POST /continuity/chapters/:chapterId/check",
      "ai.ts POST /continuity/findings/:findingId/dismiss",
    ].map((route): [string, string] => [route, "private to the story's author; writes nothing a reader can see"]),
  ] as [string, string][],
);

/** Every mutating route the router files declare. */
function writeRoutes(): string[] {
  const found: string[] = [];

  for (const file of readdirSync(ROUTES_DIR).sort()) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;

    const source = readFileSync(path.join(ROUTES_DIR, file), "utf8");
    // Template literals too: the generation routes are registered in a loop
    // as `/generate/${kind}`, and a double-quote-only pattern never saw them.
    const pattern = /router\.(post|put|patch|delete)\(\s*["`]([^"`]*)["`]/g;

    for (const match of source.matchAll(pattern)) {
      found.push(`${file} ${match[1]?.toUpperCase()} ${match[2]}`);
    }
  }

  return found;
}

describe("suspension coverage", () => {
  it("has a decision recorded for every write route", () => {
    const undecided = writeRoutes().filter(
      (route) => !GUARDED.has(route) && EXEMPT[route] === undefined,
    );

    expect(
      undecided,
      "A write route was added with no suspension decision. Add it to " +
        "GUARDED in this file and call `assertNotSuspended` in its service, " +
        "or to EXEMPT with the reason it does not need to.",
    ).toEqual([]);
  });

  it("does not keep decisions for routes that no longer exist", () => {
    const live = new Set(writeRoutes());
    const stale = [...GUARDED, ...Object.keys(EXEMPT)].filter(
      (route) => !live.has(route),
    );

    // The other direction, and the one that let the old prose list go stale:
    // a route that was renamed leaves its decision behind, and a leftover
    // entry would silently excuse the next route that happened to match it.
    expect(stale).toEqual([]);
  });

  it("guards every seam that takes user-written text", () => {
    /**
     * The claim `GUARDED` is making, checked against the services rather than
     * restated: each of these functions must actually call the guard. Reading
     * the source is what the invariant is about -- there is no type that says
     * "this function checked".
     */
    const seams: [string, string][] = [
      ["engagement.ts", "createComment"],
      ["engagement.ts", "likeChapter"],
      ["engagement.ts", "likeComment"],
      ["clubs.ts", "createDiscussion"],
      ["channels.ts", "createPost"],
      ["moderation.ts", "createReport"],
    ];

    for (const [file, fn] of seams) {
      const source = readFileSync(
        path.join(ROUTES_DIR, "..", "services", file),
        "utf8",
      );
      const start = source.indexOf(`export async function ${fn}(`);
      expect(start, `${file} no longer exports ${fn}`).toBeGreaterThan(-1);

      // The guard has to be in the function's own opening, not merely in the
      // file: every one of these calls it before it does anything else.
      const opening = source.slice(start, start + 900);
      expect(
        opening.includes("assertNotSuspended"),
        `${file} ${fn} does not call assertNotSuspended`,
      ).toBe(true);
    }
  });
});
