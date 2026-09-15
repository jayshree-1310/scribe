/**
 * Loads a handful of writing challenges across the three states the clock can
 * produce. Run with:
 *
 *   pnpm --filter api seed:challenges
 *
 * Challenges can only be created by an administrator, and nothing in the web
 * app grants that flag -- so without this there is no supported way to put a
 * challenge in a development database, and the Challenges page is empty with
 * no way to fill it.
 *
 * Deliberately seeds no *entries*. A place in a challenge belongs to a writer
 * who took it, and the leaderboard ranks by the ratings readers left: both are
 * things to do through the app, not rows to invent. Enter one from
 * `/challenges` and rate the story to watch the board build.
 *
 * Idempotent: challenges match on slug, so re-running moves their windows
 * forward rather than duplicating them.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { slugify } from "../lib/slug.js";

/** Nothing signs in as the seeded host. */
const UNUSABLE_PASSWORD_HASH = "!seeded-challenge-host-no-login";

const HOST_HANDLE = "scribe_challenges";

const DAY = 24 * 60 * 60 * 1000;

interface RawChallenge {
  title: string;
  prompt: string;
  description: string;
  /** Days from now the window opens; negative is in the past. */
  opensIn: number;
  closesIn: number;
  wordTarget: number | null;
}

const CHALLENGES: RawChallenge[] = [
  {
    title: "September Flash Fiction",
    prompt: "A door that only opens for one person.",
    description:
      "One thousand words or fewer, any genre. The door can be literal, and it is more interesting when it is not.",
    opensIn: -8,
    closesIn: 6,
    wordTarget: 1000,
  },
  {
    title: "Steal This First Line",
    prompt: "“I have been dead for a week and nobody has noticed.”",
    description:
      "Start with the line exactly as written, then go anywhere. Up to five thousand words.",
    opensIn: -3,
    closesIn: 18,
    wordTarget: 5000,
  },
  {
    title: "The Slowest Burn",
    prompt: "Two people, one shared task, no confession.",
    description:
      "A romance challenge with a rule: nobody may say how they feel. Show it in the work they do together.",
    opensIn: -14,
    closesIn: 2,
    wordTarget: 3000,
  },
  {
    title: "Daylight Horror",
    prompt: "Something is wrong and it is two in the afternoon.",
    description: "No night scenes. No basements. Make noon frightening.",
    opensIn: 9,
    closesIn: 39,
    wordTarget: 4000,
  },
  {
    title: "One Map, Many Stories",
    prompt: "Everyone writes in the same invented country.",
    description:
      "A shared-setting challenge. The map is published on day one; you claim a region and write it.",
    opensIn: 21,
    closesIn: 72,
    wordTarget: null,
  },
  {
    title: "Thirty Poems, Thirty Days",
    prompt: "One poem a day for the month.",
    description: "Finished last month. The archive stays open to read.",
    opensIn: -68,
    closesIn: -38,
    wordTarget: null,
  },
];

/**
 * The account the seeded challenges are hosted by.
 *
 * An existing administrator is reused when there is one, so a real operator
 * who ran `admin:grant` on their own account hosts these rather than a robot
 * appearing beside them.
 */
async function findHost(): Promise<string> {
  const admin = await db.orm.auth.User.select("id")
    .where((user) => user.isAdmin.eq(true))
    .orderBy((user) => user.createdAt.asc())
    .first();

  if (admin) return admin.id;

  const existing = await db.orm.auth.User.select("id")
    .where((user) => user.username.eq(HOST_HANDLE))
    .first();

  if (existing) {
    await db.orm.auth.User.where((user) => user.id.eq(existing.id)).update({
      isAdmin: true,
    });
    return existing.id;
  }

  const created = await db.orm.auth.User.create({
    username: HOST_HANDLE,
    email: `${HOST_HANDLE}@scribe.invalid`,
    passwordHash: UNUSABLE_PASSWORD_HASH,
    displayName: "Scribe Challenges",
    bio: "Sets the briefs.",
    isAdmin: true,
  });

  return created.id;
}

async function upsertChallenge(
  raw: RawChallenge,
  hostId: string,
): Promise<"created" | "updated"> {
  const slug = slugify(raw.title);
  const now = Date.now();

  const fields = {
    title: raw.title,
    prompt: raw.prompt,
    description: raw.description,
    wordTarget: raw.wordTarget,
    startAt: Temporal.Instant.from(new Date(now + raw.opensIn * DAY).toISOString()),
    endAt: Temporal.Instant.from(new Date(now + raw.closesIn * DAY).toISOString()),
    updatedAt: Temporal.Now.instant(),
  };

  const existing = await db.orm.challenges.WritingChallenge.select("id")
    .where((challenge) => challenge.slug.eq(slug))
    .first();

  if (existing) {
    // The windows move with every run, so a database seeded weeks ago still
    // has something active to look at.
    await db.orm.challenges.WritingChallenge.where((challenge) =>
      challenge.id.eq(existing.id),
    ).update(fields);
    return "updated";
  }

  await db.orm.challenges.WritingChallenge.create({
    ...fields,
    slug,
    hostId,
    createdAt: Temporal.Now.instant(),
  });

  return "created";
}

async function main(): Promise<void> {
  const hostId = await findHost();

  let created = 0;
  let updated = 0;

  for (const challenge of CHALLENGES) {
    const outcome = await upsertChallenge(challenge, hostId);
    if (outcome === "created") created += 1;
    else updated += 1;
    console.log(`  ${outcome === "created" ? "+" : "~"} ${challenge.title}`);
  }

  console.log(`\nChallenges: ${created} created, ${updated} updated.`);
}

await main();
await db.close();
