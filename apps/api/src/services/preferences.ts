/**
 * What a reader told us they want.
 *
 * Three tables, one subject. `auth.UserPreference` holds the scalars,
 * `auth.GenrePreference` the genres they picked and `auth.NotificationMute`
 * the types they would rather not hear about; see the contract for why each is
 * shaped the way it is.
 *
 * Two decisions are made here and nowhere else.
 *
 * **An absent row is an answer.** Nothing creates a preference row on sign-up.
 * A reader who has never answered anything has no row, which is what
 * `onboardingComplete: false` means and why the web app can gate its onboarding
 * flow on this rather than on local state. Every read tolerates the absence and
 * returns `DEFAULTS`, so no caller has to create a row to look one up -- and
 * `deleteAccount` has one less thing that must exist.
 *
 * **A write replaces a set; it does not merge one.** `genreIds` and
 * `mutedNotificationTypes` are sent whole or not at all: sending three genres
 * means the reader now likes exactly those three. A merge would give the
 * settings form no way to express "none", which is a real answer and the one
 * the form's "clear all" produces. Keys the caller omits are left alone, which
 * is the same rule `updateProfile` follows for the profile.
 *
 * Two features read what is written here, which is the reason this module is
 * not part of `services/recommendations.ts`: the recommender ranks on the
 * genres and the length, and `services/notifications.ts` filters its fan-out on
 * the mutes. Both read the tables directly in SQL rather than calling in here,
 * because both are already one statement and a round trip for a handful of ids
 * would only be a second place the rule could drift.
 */

import { db } from "../prisma/db.js";
import { deleteAll } from "../prisma/delete-all.js";
import { HttpError } from "../lib/http-error.js";
import { NOTIFICATION_TYPES, type NotificationType } from "./notifications.js";

/**
 * Derived from `db.transaction` rather than imported, for the reason
 * `services/authoring.ts` gives: the type is not re-exported from the runtime
 * entry point, and deriving it here cannot drift from the client.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The part of a client `deletePreferencesFor` needs, so it can be handed a
 * transaction (`deleteAccount`) or the client itself (`TestApi.cleanup`). The
 * two share `orm` and differ everywhere else.
 */
type OrmOnly = { orm: Tx["orm"] };

export const CONTENT_LENGTHS = ["SHORT", "MEDIUM", "LONG", "ANY"] as const;

export type ContentLength = (typeof CONTENT_LENGTHS)[number];

/**
 * How many genres a reader may name.
 *
 * Not a rule about taste -- it is what stops one request writing a row per
 * genre in the catalogue, and it is comfortably above the ten the onboarding
 * step offers.
 */
export const MAX_PREFERRED_GENRES = 20;

export interface Preferences {
  /** The genres the reader named, in the order the catalogue lists them. */
  genreIds: string[];
  contentLength: ContentLength;
  mutedNotificationTypes: NotificationType[];
  /** Derived from the timestamp below; the two cannot disagree. */
  onboardingComplete: boolean;
  onboardingCompletedAt: string | null;
  /** Null for a reader who has never answered anything. */
  updatedAt: string | null;
}

/**
 * What a reader who has answered nothing has.
 *
 * `ANY` rather than a guess at a middle value: the recommender reads it as
 * "do not rank on length", so a default of `MEDIUM` would silently push every
 * new reader towards novellas.
 */
const DEFAULTS: Preferences = {
  genreIds: [],
  contentLength: "ANY",
  mutedNotificationTypes: [],
  onboardingComplete: false,
  onboardingCompletedAt: null,
  updatedAt: null,
};

export interface PreferenceUpdate {
  genreIds?: string[] | undefined;
  contentLength?: ContentLength | undefined;
  mutedNotificationTypes?: NotificationType[] | undefined;
  /**
   * `true` finishes onboarding, `false` reopens it. Finishing twice keeps the
   * first timestamp: the column records when the reader got through the flow,
   * and a later settings save is not a second completion.
   */
  onboardingComplete?: boolean | undefined;
}

/** Timestamp columns decode to `Temporal.Instant`; the API speaks ISO strings. */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isContentLength(value: string): value is ContentLength {
  return (CONTENT_LENGTHS as readonly string[]).includes(value);
}

function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/* Reads ------------------------------------------------------------------ */

export async function getPreferences(userId: string): Promise<Preferences> {
  const [row, genres, mutes] = await Promise.all([
    db.orm.auth.UserPreference.select(
      "contentLength",
      "onboardingCompletedAt",
      "updatedAt",
    )
      .where((preference) => preference.userId.eq(userId))
      .first(),
    db.orm.auth.GenrePreference.select("genreId")
      .where((preference) => preference.userId.eq(userId))
      .all(),
    db.orm.auth.NotificationMute.select("type")
      .where((mute) => mute.userId.eq(userId))
      .all(),
  ]);

  /**
   * The junctions are read even when there is no settings row, and answered
   * even when they are non-empty without one. A reader can pick genres in the
   * onboarding flow and close the tab before the last step, and the genres
   * they chose are theirs whether or not they ever finished.
   */
  const genreIds = await orderGenres(genres.map((row) => row.genreId));

  const completedAt = row ? toIso(row.onboardingCompletedAt) : null;

  return {
    genreIds,
    contentLength:
      row && isContentLength(row.contentLength)
        ? row.contentLength
        : DEFAULTS.contentLength,
    mutedNotificationTypes: mutes
      .map((mute) => mute.type)
      .filter(isNotificationType)
      .sort(),
    onboardingComplete: completedAt !== null,
    onboardingCompletedAt: completedAt,
    updatedAt: row ? toIso(row.updatedAt) : null,
  };
}

/**
 * Whether this account has been through onboarding.
 *
 * Its own query rather than `getPreferences(...).onboardingComplete`, because
 * the only caller is `services/account.ts`, which adds this to a profile
 * fetched on every page load and has no use for the rest.
 */
export async function hasCompletedOnboarding(userId: string): Promise<boolean> {
  const row = await db.orm.auth.UserPreference.select("onboardingCompletedAt")
    .where((preference) => preference.userId.eq(userId))
    .first();

  return (
    row?.onboardingCompletedAt !== null && row?.onboardingCompletedAt !== undefined
  );
}

/**
 * Sorts a set of genre ids into catalogue order, dropping any that no longer
 * name a genre.
 *
 * The order matters only because an unordered list makes a response that
 * changes between identical requests, which is the kind of thing that turns
 * into a flickering chip row. Dropping the unknown ids is the same tolerance
 * `getStoriesByIds` shows: a reader's saved answer can outlive the row it
 * points at, and that should thin the list rather than fail the read.
 */
async function orderGenres(genreIds: string[]): Promise<string[]> {
  if (genreIds.length === 0) return [];

  const rows = await db.orm.content.Genre.select("id")
    .where((genre) => genre.id.in(genreIds))
    .orderBy((genre) => genre.name.asc())
    .all();

  return rows.map((row) => row.id);
}

/* Writes ----------------------------------------------------------------- */

/**
 * Applies a partial preference update and answers the state it left behind.
 *
 * Everything runs in one transaction: a settings save that wrote the genres
 * and then failed on the mutes would leave the reader looking at a form that
 * half-saved, with no way to tell which half.
 */
export async function updatePreferences(
  userId: string,
  update: PreferenceUpdate,
): Promise<Preferences> {
  const genreIds =
    update.genreIds === undefined
      ? undefined
      : await validateGenres(update.genreIds);

  const current = await getPreferences(userId);

  const contentLength = update.contentLength ?? current.contentLength;

  /**
   * Finishing twice keeps the first timestamp, and reopening clears it. The
   * clock is this process's rather than the database's, unlike most timestamps
   * here: nothing compares this against a boundary, so a second of skew has
   * nothing to be wrong about.
   */
  const completedAt =
    update.onboardingComplete === undefined
      ? current.onboardingCompletedAt
      : update.onboardingComplete
        ? (current.onboardingCompletedAt ?? new Date().toISOString())
        : null;

  await db.transaction(async (tx) => {
    /**
     * One statement rather than a read and a branch: two tabs of the settings
     * form saving at once would otherwise race into a duplicate key on the
     * primary key. The merge above already decided every value, so the
     * conflict path writes the same columns the insert would and the later
     * save wins -- which is what a form should do.
     */
    const plan = db.raw.sql`
      INSERT INTO "auth"."userPreference"
        ("userId", "contentLength", "onboardingCompletedAt", "createdAt", "updatedAt")
      VALUES (${userId}, ${contentLength},
              NULLIF(${completedAt ?? ""}::text, '')::timestamptz, now(), now())
      ON CONFLICT ("userId") DO UPDATE SET
        "contentLength"         = EXCLUDED."contentLength",
        "onboardingCompletedAt" = EXCLUDED."onboardingCompletedAt",
        "updatedAt"             = now()
    `.affectedCount().build();

    // A transaction context runs a plan directly; `runtime()` is the client's
    // lane and using it here would put this statement outside the transaction.
    await tx.query(plan);

    if (genreIds !== undefined) {
      await deleteAll(() =>
        tx.orm.auth.GenrePreference.where((row) => row.userId.eq(userId)),
      );

      // A row at a time: the client has no bulk insert, and the set is capped
      // at `MAX_PREFERRED_GENRES` by the validation above.
      for (const genreId of genreIds) {
        await tx.orm.auth.GenrePreference.create({ userId, genreId });
      }
    }

    if (update.mutedNotificationTypes !== undefined) {
      await deleteAll(() =>
        tx.orm.auth.NotificationMute.where((row) => row.userId.eq(userId)),
      );

      for (const type of new Set(update.mutedNotificationTypes)) {
        await tx.orm.auth.NotificationMute.create({ userId, type });
      }
    }
  });

  return getPreferences(userId);
}

/**
 * Checks that every id names a genre, and refuses the whole write if one does
 * not.
 *
 * A foreign key would refuse it too, but as a 500 with a constraint name in
 * it. This is the one field of the form a stale client can get wrong -- a
 * genre chip cached from before a rename -- so it gets a message the form can
 * put under the field.
 */
async function validateGenres(genreIds: string[]): Promise<string[]> {
  const unique = [...new Set(genreIds)];

  if (unique.length > MAX_PREFERRED_GENRES) {
    throw HttpError.badRequest("That is more genres than we can use.", {
      genreIds: `Pick at most ${MAX_PREFERRED_GENRES} genres.`,
    });
  }

  if (unique.length === 0) return [];

  const known = await db.orm.content.Genre.select("id")
    .where((genre) => genre.id.in(unique))
    .all();

  if (known.length !== unique.length) {
    throw HttpError.badRequest("Some of the details you sent are not valid.", {
      genreIds: "One of those genres no longer exists.",
    });
  }

  return unique;
}

/* Deletion --------------------------------------------------------------- */

/**
 * Removes every preference row an account holds.
 *
 * Called by `deleteAccount` inside its transaction, and by `TestApi.cleanup`.
 * All three tables carry a foreign key to `auth.User`, so the user row cannot
 * go until these have.
 */
export async function deletePreferencesFor(
  tx: OrmOnly,
  userId: string,
): Promise<void> {
  await deleteAll(() =>
    tx.orm.auth.GenrePreference.where((row) => row.userId.eq(userId)),
  );
  await deleteAll(() =>
    tx.orm.auth.NotificationMute.where((row) => row.userId.eq(userId)),
  );
  await tx.orm.auth.UserPreference.where((row) => row.userId.eq(userId)).delete();
}
