/**
 * Catalogue routes: browsing, searching and reading a single book.
 *
 * All of these are open — browsing does not require a session. When a caller
 * *is* signed in, responses carry that reader's shelf status so a card can
 * render its "in your library" state without a second request.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { parseOrThrow } from "../lib/validate.js";
import { getUserId } from "../middleware/current-user.js";
import {
  BOOK_SORTS,
  MAX_PAGE_SIZE,
  getBook,
  getDiscover,
  getRelatedBooks,
  listBooks,
  listGenres,
  type Book,
} from "../services/books.js";
import { statusesForBooks, type ReadingStatus } from "../services/library.js";

const router = Router();

/** Books as sent to the client, plus the caller's shelf status when known. */
interface BookResponse extends Book {
  libraryStatus: ReadingStatus | null;
}

/**
 * `req.query` values arrive as strings. Coercion lives in the schema so a bad
 * `page=abc` is a 400 with a field message rather than a silent `NaN`.
 */
const listQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  genreId: z.uuid("Not a known genre.").optional(),
  status: z.enum(["all", "completed", "ongoing"]).default("all"),
  sort: z.enum(BOOK_SORTS).default("recent"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(12),
});

const idParamSchema = z.object({ id: z.uuid("That book could not be found.") });

/**
 * Annotates a batch of books with the caller's shelf status. Anonymous callers
 * get `null` throughout rather than a missing key, so the client has one shape
 * to render either way.
 */
async function withLibraryStatus(
  req: Request,
  books: Book[],
): Promise<BookResponse[]> {
  const userId = getUserId(req);
  if (userId === null || books.length === 0) {
    return books.map((book) => ({ ...book, libraryStatus: null }));
  }

  const statuses = await statusesForBooks(
    userId,
    books.map((book) => book.id),
  );

  return books.map((book) => ({
    ...book,
    libraryStatus: statuses[book.id] ?? null,
  }));
}

/* Reference data --------------------------------------------------------- */

router.get("/genres", async (_req, res, next) => {
  try {
    res.json({ genres: await listGenres() });
  } catch (error) {
    next(error);
  }
});

/** Everything the Discover page opens with, in one round trip. */
router.get("/discover", async (req, res, next) => {
  try {
    const discover = await getDiscover();

    // One annotation pass over every book on the page, deduplicated by id.
    const everyBook = [
      ...(discover.featured ? [discover.featured] : []),
      ...discover.trending,
      ...discover.recommended,
      ...discover.sections.flatMap((section) => section.books),
    ];
    const annotated = await withLibraryStatus(req, everyBook);
    const byId = new Map(annotated.map((book) => [book.id, book]));
    const decorate = (book: Book): BookResponse =>
      byId.get(book.id) ?? { ...book, libraryStatus: null };

    res.json({
      featured: discover.featured ? decorate(discover.featured) : null,
      trending: discover.trending.map(decorate),
      recommended: discover.recommended.map(decorate),
      sections: discover.sections.map((section) => ({
        genre: section.genre,
        books: section.books.map(decorate),
      })),
    });
  } catch (error) {
    next(error);
  }
});

/* Catalogue -------------------------------------------------------------- */

router.get("/", async (req, res, next) => {
  try {
    const query = parseOrThrow(listQuerySchema, req.query);

    const page = await listBooks({
      search: query.search,
      genreId: query.genreId,
      completed:
        query.status === "all" ? undefined : query.status === "completed",
      sort: query.sort,
      page: query.page,
      limit: query.limit,
    });

    res.json({ ...page, items: await withLibraryStatus(req, page.items) });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const [book] = await withLibraryStatus(req, [await getBook(id)]);
    res.json({ book });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/related", async (req, res, next) => {
  try {
    const { id } = parseOrThrow(idParamSchema, req.params);
    const related = await getRelatedBooks(id);
    res.json({ books: await withLibraryStatus(req, related) });
  } catch (error) {
    next(error);
  }
});

export default router;
