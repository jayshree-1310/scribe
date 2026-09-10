/**
 * URL slugs for stories.
 *
 * `content.Story.slug` is unique and NOT NULL, so every writer needs the same
 * derivation: the seed script here, and the authoring endpoints later. Keeping
 * it in one place also keeps it consistent with the migration that backfilled
 * existing rows (`migrations/app/20260910T0557_*`), which applies the same
 * rules in SQL.
 */

/** Longest slug we generate, before any uniqueness suffix. */
const MAX_LENGTH = 80;

/**
 * Lower-cases, strips anything that is not a letter or digit, and collapses
 * the gaps to single hyphens.
 *
 * A title made only of punctuation reduces to nothing, which cannot be a slug,
 * so it falls back to `story` and relies on the caller's uniqueness pass for a
 * suffix.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, "");

  return slug.length > 0 ? slug : "story";
}

/**
 * The first slug derived from `title` that `isTaken` does not reject.
 *
 * Suffixes count from 2 so the first story of a given title keeps the bare
 * slug -- `-1` would imply a sibling that does not exist. The caller supplies
 * the collision test, because who counts as a collision differs: the seed
 * script excludes the row it is updating, an author's rename excludes their own
 * story.
 */
export async function uniqueSlug(
  title: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const base = slugify(title);

  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }
}
