/**
 * The signed-in reader's own account.
 *
 * Every function takes the caller's id explicitly — the route resolves it once
 * through `middleware/current-user.ts` — so no id from a request body can ever
 * decide whose profile is read or written.
 */

import argon2 from "argon2";
import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { deleteAll } from "../prisma/delete-all.js";
import { HttpError } from "../lib/http-error.js";
import { sniffImage } from "../lib/image.js";
import { revokeAllSessions } from "../lib/sessions.js";
import { storage } from "../lib/storage.js";

/** The profile shape the account endpoints return. Written out field by field
 * rather than spread from the row, so adding a column — `passwordHash` being
 * the one that matters — can never start leaking it. */
export interface AccountProfile {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  isAuthor: boolean;
  readingStreak: number;
  readerLevel: number;
  authorLevel: number;
  joinedAt: string;
  /**
   * Whether this account can be signed into with a password at all. A
   * Google-only account has none (`contract.prisma`), so the settings form
   * has to offer "set a password" rather than "change your password" — and
   * the *hash itself* obviously never leaves the server, only this boolean.
   */
  hasPassword: boolean;
}

export interface ProfileUpdate {
  username?: string | undefined;
  email?: string | undefined;
  displayName?: string | undefined;
  bio?: string | undefined;
}

/** Largest avatar we accept, before any re-encoding. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Timestamp columns decode to `Temporal.Instant`; the API speaks ISO strings. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime())
    ? new Date(0).toISOString()
    : parsed.toISOString();
}

const PROFILE_COLUMNS = [
  "id",
  "username",
  "email",
  "emailVerified",
  "displayName",
  "avatarUrl",
  "bio",
  "isAuthor",
  "readingStreak",
  "readerLevel",
  "authorLevel",
  "createdAt",
  // Read only to answer `hasPassword` below. `toProfile` is the reason that
  // is safe: it names every field it returns, so the hash has no path out.
  "passwordHash",
] as const;

function toProfile(row: {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  isAuthor: boolean;
  readingStreak: number;
  readerLevel: number;
  authorLevel: number;
  createdAt: unknown;
  passwordHash: string | null;
}): AccountProfile {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    emailVerified: row.emailVerified,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    bio: row.bio,
    isAuthor: row.isAuthor,
    readingStreak: row.readingStreak,
    readerLevel: row.readerLevel,
    authorLevel: row.authorLevel,
    joinedAt: toIso(row.createdAt),
    hasPassword: row.passwordHash !== null,
  };
}

async function loadProfile(userId: string): Promise<AccountProfile> {
  const row = await db.orm.auth.User.select(...PROFILE_COLUMNS)
    .where((u) => u.id.eq(userId))
    .first();

  /**
   * A live access token for a deleted account: the token is valid, the account
   * is not. 401 rather than 404 so the client signs the caller out instead of
   * showing an empty profile.
   */
  if (!row) throw HttpError.unauthorized("Your account no longer exists.");

  return toProfile(row);
}

export function getProfile(userId: string): Promise<AccountProfile> {
  return loadProfile(userId);
}

/**
 * Applies a partial profile update.
 *
 * Only the keys present in `update` are written, so a form that sends just the
 * bio cannot blank the display name. Errors come back as a field map, which is
 * what the settings form displays inline.
 */
export async function updateProfile(
  userId: string,
  update: ProfileUpdate,
): Promise<AccountProfile> {
  const current = await loadProfile(userId);

  const changes: Record<string, unknown> = {};

  if (update.username !== undefined && update.username !== current.username) {
    const taken = await db.orm.auth.User.select("id")
      .where((u) => u.username.eq(update.username!))
      .first();

    if (taken) {
      throw HttpError.badRequest("Some of the details need fixing.", {
        username: "That username is already taken.",
      });
    }

    changes["username"] = update.username;
  }

  if (update.email !== undefined && update.email !== current.email) {
    const taken = await db.orm.auth.User.select("id")
      .where((u) => u.email.eq(update.email!))
      .first();

    if (taken) {
      throw HttpError.badRequest("Some of the details need fixing.", {
        email: "That email address is already in use.",
      });
    }

    changes["email"] = update.email;
    // The new address has not been proven to belong to this person, and
    // Google sign-in matches accounts by *verified* email — leaving the flag
    // set would let anyone claim a stranger's address and inherit their
    // Google login.
    changes["emailVerified"] = false;
  }

  if (update.displayName !== undefined) {
    // Empty means "no display name": the UI falls back to the username, which
    // reads better than a blank heading.
    changes["displayName"] = update.displayName.length > 0
      ? update.displayName
      : null;
  }

  if (update.bio !== undefined) {
    changes["bio"] = update.bio.length > 0 ? update.bio : null;
  }

  if (Object.keys(changes).length === 0) return current;

  // `updatedAt` has no `@updatedAt` behaviour in the contract, so every write
  // path sets it. The column's codec encodes a `Temporal.Instant`; a string
  // is rejected outright.
  changes["updatedAt"] = Temporal.Now.instant();

  try {
    await db.orm.auth.User.where((u) => u.id.eq(userId)).update(changes);
  } catch (error) {
    // The checks above race concurrent updates; the unique indexes are the
    // real arbiter and 23505 is how they say someone got there first.
    if (
      error instanceof Error &&
      "sqlState" in error &&
      (error as { sqlState?: string }).sqlState === "23505"
    ) {
      throw HttpError.conflict("That username or email is already taken.");
    }

    throw error;
  }

  return loadProfile(userId);
}

/**
 * Stores a new avatar and points the account at it.
 *
 * The bytes decide the type — see `lib/image.ts` for why the declared one is
 * not trusted — and the previous file is removed only after the row is
 * updated, so a failed write never leaves the profile pointing at a file that
 * is gone.
 */
export async function setAvatar(
  userId: string,
  bytes: Buffer,
): Promise<AccountProfile> {
  if (bytes.length === 0) {
    throw HttpError.badRequest("That upload was empty.", {
      avatar: "Choose an image to upload.",
    });
  }

  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new HttpError(
      413,
      "payload_too_large",
      "That image is too large. Pick one under 2 MB.",
      { avatar: "That image is too large. Pick one under 2 MB." },
    );
  }

  const kind = sniffImage(bytes);

  if (!kind) {
    throw HttpError.badRequest("That file is not an image we can read.", {
      avatar: "Use a PNG, JPEG, WebP or GIF image.",
    });
  }

  const previous = (await loadProfile(userId)).avatarUrl;

  const stored = await storage.put({
    prefix: "avatars",
    data: bytes,
    extension: kind.extension,
    contentType: kind.contentType,
  });

  try {
    await db.orm.auth.User.where((u) => u.id.eq(userId)).update({
      avatarUrl: stored.url,
      updatedAt: Temporal.Now.instant(),
    });
  } catch (error) {
    // Nothing references the file we just wrote, so it would leak.
    await storage.remove(stored.url);
    throw error;
  }

  if (previous) await storage.remove(previous);

  return loadProfile(userId);
}

/** Clears the avatar, falling the UI back to the generated monogram. */
export async function removeAvatar(userId: string): Promise<AccountProfile> {
  const previous = (await loadProfile(userId)).avatarUrl;

  if (previous) {
    await db.orm.auth.User.where((u) => u.id.eq(userId)).update({
      avatarUrl: null,
      updatedAt: Temporal.Now.instant(),
    });

    await storage.remove(previous);
  }

  return loadProfile(userId);
}

/* Deletion --------------------------------------------------------------- */

/**
 * What a caller must send to close their account.
 *
 * `confirmUsername` is not security — anyone holding the session already
 * knows it — it is the friction that separates "I meant this" from a
 * mis-click on an irreversible button. The password is the security part,
 * and only accounts that have one can be asked for it.
 */
export interface AccountDeletion {
  confirmUsername: string;
  password?: string | undefined;
}

/**
 * Closes an account and removes what it left behind.
 *
 * **The policy is hard deletion, and it includes the person's stories.** That
 * is the promise the settings page has always made ("This removes your
 * profile, stories, comments and reading history"), and quietly keeping
 * published work under an "[deleted]" byline would make that a lie. It is the
 * harsher of the two reasonable choices: the alternative — anonymising
 * authorship so readers keep the story — is defensible, but it takes the
 * author's decision away from them and cannot be undone either.
 *
 * Two consequences worth stating plainly:
 *
 * - Other readers' shelves, ratings, comments and reading progress against
 *   those stories go with them. There is no story left for those rows to
 *   point at, so this is deletion, not a cascade we chose.
 * - Clubs and channels this person created are deleted along with their
 *   memberships and posts. Transfer of ownership is a feature those tasks
 *   can add; inventing one here would be guessing at it.
 *
 * The row removal runs in one transaction, so a failure part-way through
 * cannot leave an account half gone. The avatar file and the sessions are
 * cleaned up *after* it commits, because neither can be rolled back.
 */
export async function deleteAccount(
  userId: string,
  input: AccountDeletion,
): Promise<void> {
  const user = await db.orm.auth.User.select("id", "username", "passwordHash")
    .where((u) => u.id.eq(userId))
    .first();

  if (!user) throw HttpError.unauthorized("Your account no longer exists.");

  if (input.confirmUsername.trim().toLowerCase() !== user.username) {
    throw HttpError.badRequest("Some of the details need fixing.", {
      confirmUsername: `Type ${user.username} to confirm.`,
    });
  }

  if (user.passwordHash !== null) {
    // An unreadable stored hash counts as a mismatch rather than a 500 — the
    // same rule `services/passwords.ts` applies, for the same reason.
    const valid =
      input.password !== undefined &&
      (await argon2
        .verify(user.passwordHash, input.password)
        .catch(() => false));

    if (!valid) {
      throw HttpError.badRequest("Some of the details need fixing.", {
        password: "That is not your password.",
      });
    }
  }

  const avatarUrl = (await loadProfile(userId)).avatarUrl;

  await db.transaction(async (tx) => {
    const stories = await tx.orm.content.Story.select("id")
      .where((story) => story.authorId.eq(userId))
      .all();

    for (const { id: storyId } of stories) {
      const chapters = await tx.orm.content.Chapter.select("id")
        .where((chapter) => chapter.storyId.eq(storyId))
        .all();

      for (const { id: chapterId } of chapters) {
        await deleteAll(() =>
          tx.orm.content.Multimedia.where((item) => item.chapterId.eq(chapterId)),
        );
      }

      // Everyone's rows against this story, not just the author's: the story
      // is going, and a rating pointing at nothing is a foreign-key error.
      await deleteAll(() =>
        tx.orm.engagement.Comment.where((row) => row.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        tx.orm.engagement.Rating.where((row) => row.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        tx.orm.engagement.ReadingHistory.where((row) => row.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        tx.orm.library.LibraryEntry.where((row) => row.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        tx.orm.challenges.ChallengeEntry.where((row) => row.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        tx.orm.content.StoryGenre.where((row) => row.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        tx.orm.content.Chapter.where((row) => row.storyId.eq(storyId)),
      );

      await tx.orm.content.Story.where((row) => row.id.eq(storyId)).delete();
    }

    // What this person left on other people's work.
    await deleteAll(() =>
      tx.orm.engagement.Comment.where((row) => row.userId.eq(userId)),
    );
    await deleteAll(() =>
      tx.orm.engagement.Rating.where((row) => row.userId.eq(userId)),
    );
    await deleteAll(() =>
      tx.orm.engagement.ReadingHistory.where((row) => row.userId.eq(userId)),
    );
    await deleteAll(() =>
      tx.orm.library.LibraryEntry.where((row) => row.userId.eq(userId)),
    );
    await deleteAll(() =>
      tx.orm.challenges.ChallengeEntry.where((row) => row.userId.eq(userId)),
    );
    await deleteAll(() =>
      tx.orm.gamification.UserBadge.where((row) => row.userId.eq(userId)),
    );
    await deleteAll(() =>
      tx.orm.clubs.ClubMembership.where((row) => row.userId.eq(userId)),
    );
    await deleteAll(() =>
      tx.orm.channels.ChannelSubscriber.where((row) => row.userId.eq(userId)),
    );

    const clubs = await tx.orm.clubs.BookClub.select("id")
      .where((club) => club.creatorId.eq(userId))
      .all();

    for (const { id: clubId } of clubs) {
      await deleteAll(() =>
        tx.orm.clubs.ClubMembership.where((row) => row.clubId.eq(clubId)),
      );
      await tx.orm.clubs.BookClub.where((row) => row.id.eq(clubId)).delete();
    }

    const channels = await tx.orm.channels.BroadcastChannel.select("id")
      .where((channel) => channel.authorId.eq(userId))
      .all();

    for (const { id: channelId } of channels) {
      await deleteAll(() =>
        tx.orm.channels.ChannelPost.where((row) => row.channelId.eq(channelId)),
      );
      await deleteAll(() =>
        tx.orm.channels.ChannelSubscriber.where((row) =>
          row.channelId.eq(channelId),
        ),
      );
      await tx.orm.channels.BroadcastChannel.where((row) =>
        row.id.eq(channelId),
      ).delete();
    }

    await tx.orm.auth.User.where((row) => row.id.eq(userId)).delete();
  });

  // Past the point of no return: neither of these can fail the deletion, and
  // both would be wrong to retry against an account that no longer exists.
  await revokeAllSessions(userId);
  if (avatarUrl) await storage.remove(avatarUrl);
}
