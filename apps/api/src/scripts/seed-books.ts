/**
 * Loads the development book catalogue.
 *
 * Idempotent: authors match on username, genres on name, books on ISBN, so
 * re-running updates in place instead of duplicating. Run with:
 *
 *   pnpm --filter api seed:books
 */

import { Temporal } from "temporal-polyfill";
import { db } from "../prisma/db.js";
import { deleteAll } from "../prisma/delete-all.js";
import {
  DEMO_READER_ID,
  DEMO_READER_USERNAME,
  fetchCatalogue,
  type RawBook,
} from "../data/catalogue-source.js";

/**
 * Catalogue authors are records, not accounts: nobody signs in as them. The
 * hash below is not a hash of anything, so it can never match a password.
 */
const UNUSABLE_PASSWORD_HASH = "!seeded-catalogue-author-no-login";

async function upsertAuthor(handle: string): Promise<string> {
  const existing = await db.orm.auth.User.select("id")
    .where((user) => user.username.eq(handle))
    .first();

  if (existing) return existing.id;

  const created = await db.orm.auth.User.create({
    username: handle,
    email: `${handle}@authors.scribe.invalid`,
    passwordHash: UNUSABLE_PASSWORD_HASH,
    isAuthor: true,
  });

  return created.id;
}

async function upsertGenre(name: string, hue: number): Promise<string> {
  const existing = await db.orm.content.Genre.select("id")
    .where((genre) => genre.name.eq(name))
    .first();

  if (existing) {
    await db.orm.content.Genre.where((genre) => genre.id.eq(existing.id)).update({
      hue,
    });
    return existing.id;
  }

  const created = await db.orm.content.Genre.create({ name, hue });
  return created.id;
}

async function upsertBook(
  book: RawBook,
  authorId: string,
  genreIds: string[],
): Promise<"created" | "updated"> {
  const fields = {
    authorId,
    title: book.title,
    description: book.description,
    publisher: book.publisher,
    publishedAt: Temporal.Instant.from(`${book.publishedAt}T00:00:00Z`),
    pageCount: book.pageCount,
    isCompleted: book.isCompleted,
    kidsAppropriate: book.kidsAppropriate,
    viewCount: book.viewCount,
    likeCount: book.likeCount,
    ratingAverage: String(book.ratingAverage),
    updatedAt: Temporal.Now.instant(),
  };

  const existing = await db.orm.content.Story.select("id")
    .where((story) => story.isbn.eq(book.isbn))
    .first();

  const storyId = existing
    ? (await db.orm.content.Story.where((story) => story.id.eq(existing.id)).update(
        fields,
      ),
      existing.id)
    : (
        await db.orm.content.Story.create({
          ...fields,
          isbn: book.isbn,
          // Covers are generated from the book's own data by the web app.
          coverUrl: null,
        })
      ).id;

  // Rewrite the genre links so a changed genre list in the source converges.
  await deleteAll(() =>
    db.orm.content.StoryGenre.where((link) => link.storyId.eq(storyId)),
  );
  for (const genreId of genreIds) {
    await db.orm.content.StoryGenre.create({ storyId, genreId });
  }

  return existing ? "updated" : "created";
}

/** A real row for the web app to act as before authentication is wired up. */
async function upsertDemoReader(): Promise<void> {
  const existing = await db.orm.auth.User.select("id")
    .where((user) => user.id.eq(DEMO_READER_ID))
    .first();

  if (existing) return;

  await db.orm.auth.User.create({
    id: DEMO_READER_ID,
    username: DEMO_READER_USERNAME,
    email: "demo.reader@readers.scribe.invalid",
    passwordHash: UNUSABLE_PASSWORD_HASH,
  });
}

async function main(): Promise<void> {
  const catalogue = await fetchCatalogue();

  const authorIds = new Map<string, string>();
  for (const author of catalogue.authors) {
    authorIds.set(author.handle, await upsertAuthor(author.handle));
  }

  const genreIds = new Map<string, string>();
  for (const genre of catalogue.genres) {
    genreIds.set(genre.name, await upsertGenre(genre.name, genre.hue));
  }

  await upsertDemoReader();

  let created = 0;
  let updated = 0;

  for (const book of catalogue.books) {
    const authorId = authorIds.get(book.authorHandle);
    if (!authorId) {
      throw new Error(`${book.title}: unknown author "${book.authorHandle}"`);
    }

    const ids = book.genreNames.map((name) => {
      const id = genreIds.get(name);
      if (!id) throw new Error(`${book.title}: unknown genre "${name}"`);
      return id;
    });

    const outcome = await upsertBook(book, authorId, ids);
    if (outcome === "created") created += 1;
    else updated += 1;
  }

  console.log(
    `Catalogue seeded: ${created} book(s) created, ${updated} updated, ` +
      `${catalogue.authors.length} author(s), ${catalogue.genres.length} genre(s).`,
  );
  console.log(`Demo reader id: ${DEMO_READER_ID}`);
}

await main();
await db.close();
