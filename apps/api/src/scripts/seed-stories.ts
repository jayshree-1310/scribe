/**
 * Loads a handful of authored stories with real chapters.
 *
 * The book catalogue (`seed:books`) is imported editions: no chapters, nothing
 * to read. The reader, the chapter list and the story detail page all need
 * stories written *on* Scribe, and this is the only source of those in
 * development. Run with:
 *
 *   pnpm --filter api seed:stories
 *
 * Idempotent: authors match on username and stories on slug, so re-running
 * updates in place instead of duplicating.
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { slugify } from "../lib/slug.js";
import { SEED_STORIES, type RawStory } from "../data/seed-stories.js";

/** Nothing signs in as a seeded author. */
const UNUSABLE_PASSWORD_HASH = "!seeded-story-author-no-login";

/** Words, counted the way a reader would: runs of non-space characters. */
function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

async function upsertAuthor(handle: string, displayName: string): Promise<string> {
  const existing = await db.orm.auth.User.select("id")
    .where((user) => user.username.eq(handle))
    .first();

  if (existing) {
    // A catalogue author seeded earlier has no display name; give them one,
    // and mark them as an author now that they have written something.
    await db.orm.auth.User.where((user) => user.id.eq(existing.id)).update({
      displayName,
      isAuthor: true,
    });
    return existing.id;
  }

  const created = await db.orm.auth.User.create({
    username: handle,
    email: `${handle}@authors.scribe.invalid`,
    passwordHash: UNUSABLE_PASSWORD_HASH,
    displayName,
    isAuthor: true,
    bio: `${displayName} writes on Scribe.`,
  });

  return created.id;
}

/**
 * Hues for genres this seed introduces that the book catalogue does not carry.
 * The catalogue owns the palette for the ones it defines; these fill the gaps
 * so a story is never left without a genre (and so its generated cover art has
 * a colour to work from).
 */
const EXTRA_GENRE_HUES: Record<string, number> = {
  "Literary Fiction": 210,
};

async function findOrCreateGenre(name: string): Promise<string> {
  const genre = await db.orm.content.Genre.select("id")
    .where((item) => item.name.eq(name))
    .first();

  if (genre) return genre.id;

  const created = await db.orm.content.Genre.create({
    name,
    hue: EXTRA_GENRE_HUES[name] ?? 268,
  });

  return created.id;
}

async function upsertStory(story: RawStory): Promise<"created" | "updated"> {
  const authorId = await upsertAuthor(story.authorHandle, story.authorName);
  const slug = slugify(story.title);

  const fields = {
    authorId,
    title: story.title,
    description: story.description,
    source: "SCRIBE" as const,
    isCompleted: story.isCompleted,
    kidsAppropriate: story.kidsAppropriate,
    viewCount: story.viewCount,
    likeCount: story.likeCount,
    listedAt: story.listed === false ? null : Temporal.Now.instant(),
    updatedAt: Temporal.Now.instant(),
  };

  const existing = await db.orm.content.Story.select("id")
    .where((item) => item.slug.eq(slug))
    .first();

  const storyId = existing
    ? (await db.orm.content.Story.where((item) => item.id.eq(existing.id)).update(
        fields,
      ),
      existing.id)
    : (
        await db.orm.content.Story.create({
          ...fields,
          slug,
          // Covers are generated from the story's own data by the web app.
          coverUrl: null,
        })
      ).id;

  /* Genres ------------------------------------------------------------- */

  for (const name of story.genreNames) {
    const genreId = await findOrCreateGenre(name);

    const linked = await db.orm.content.StoryGenre.where((link) =>
      link.storyId.eq(storyId),
    )
      .where((link) => link.genreId.eq(genreId))
      .first();

    if (!linked) await db.orm.content.StoryGenre.create({ storyId, genreId });
  }

  /* Chapters ----------------------------------------------------------- */

  for (const [index, chapter] of story.chapters.entries()) {
    const content = chapter.paragraphs.join("\n\n");
    const chapterNumber = index + 1;

    const chapterFields = {
      title: chapter.title,
      content,
      wordCount: countWords(content),
      publishedAt:
        chapter.published === false ? null : Temporal.Now.instant(),
      updatedAt: Temporal.Now.instant(),
    };

    const existingChapter = await db.orm.content.Chapter.select("id")
      .where((item) => item.storyId.eq(storyId))
      .where((item) => item.chapterNumber.eq(chapterNumber))
      .first();

    if (existingChapter) {
      await db.orm.content.Chapter.where((item) =>
        item.id.eq(existingChapter.id),
      ).update(chapterFields);
    } else {
      await db.orm.content.Chapter.create({
        ...chapterFields,
        storyId,
        chapterNumber,
      });
    }
  }

  return existing ? "updated" : "created";
}

async function main(): Promise<void> {
  let created = 0;
  let updated = 0;

  for (const story of SEED_STORIES) {
    const outcome = await upsertStory(story);
    if (outcome === "created") created += 1;
    else updated += 1;
    console.log(`  ${outcome === "created" ? "+" : "~"} ${story.title}`);
  }

  console.log(
    `\nStories: ${created} created, ${updated} updated ` +
      `(${SEED_STORIES.reduce((total, story) => total + story.chapters.length, 0)} chapters).`,
  );
}

await main();
await db.close();
