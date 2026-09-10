/**
 * Integration-test harness for the Books + Library routes.
 *
 * The suites run against the development Postgres (`docker compose up
 * postgres`). Everything a suite creates is namespaced by a per-run prefix and
 * torn down afterwards, so a run leaves no residue and cannot disturb seeded
 * catalogue data.
 */

import { Temporal } from "temporal-polyfill";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import app from "../app.js";
import { db } from "../prisma/db.js";
import { deleteAll } from "../prisma/delete-all.js";
import { DEV_USER_HEADER } from "../middleware/current-user.js";

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

/** Nothing may sign in as a fixture user. */
const UNUSABLE_PASSWORD_HASH = "!test-fixture-no-login";

export class TestApi {
  private server: Server | undefined;
  private baseUrl = "";

  /** Every id this run created, so teardown removes exactly its own rows. */
  private readonly created = {
    entries: [] as string[],
    links: [] as { storyId: string; genreId: string }[],
    stories: [] as string[],
    genres: [] as string[],
    users: [] as string[],
  };

  readonly runId = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  async start(): Promise<void> {
    this.server = app.listen(0);
    await new Promise<void>((resolve) => this.server?.once("listening", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await this.cleanup();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /* Requests ------------------------------------------------------------ */

  async request<T = any>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      /** Omit to make the request anonymously. */
      as?: string;
      /** Sends bytes verbatim instead of JSON, for the avatar upload route. */
      raw?: { data: Buffer; contentType: string };
    } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.raw) headers["Content-Type"] = options.raw.contentType;
    if (options.as) headers[DEV_USER_HEADER] = options.as;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.raw
        ? new Uint8Array(options.raw.data)
        : options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
    });

    return {
      status: response.status,
      body: response.status === 204 ? (null as T) : ((await response.json()) as T),
    };
  }

  /* Fixtures ------------------------------------------------------------- */

  async createUser(label: string): Promise<string> {
    const username = `${this.runId}-${label}`.slice(0, 30);
    const user = await db.orm.auth.User.select("id").create({
      username,
      email: `${username}@fixtures.invalid`,
      passwordHash: UNUSABLE_PASSWORD_HASH,
    });

    this.created.users.push(user.id);
    return user.id;
  }

  async createGenre(name: string, hue = 200): Promise<string> {
    const genre = await db.orm.content.Genre.select("id").create({
      name: `${this.runId}-${name}`,
      hue,
    });

    this.created.genres.push(genre.id);
    return genre.id;
  }

  async createBook(input: {
    title: string;
    authorId: string;
    genreIds?: string[];
    isbn?: string;
    publisher?: string;
    publishedAt?: string;
    pageCount?: number;
    ratingAverage?: number | null;
    viewCount?: number;
    likeCount?: number;
    isCompleted?: boolean;
  }): Promise<string> {
    const story = await db.orm.content.Story.select("id").create({
      authorId: input.authorId,
      title: input.title,
      description: `${input.title} — fixture`,
      isbn: input.isbn ?? `${this.runId}-${input.title}`.slice(0, 40),
      publisher: input.publisher ?? "Fixture Press",
      publishedAt: Temporal.Instant.from(
        `${input.publishedAt ?? "2024-01-01"}T00:00:00Z`,
      ),
      pageCount: input.pageCount ?? 200,
      ratingAverage:
        input.ratingAverage === null ? null : String(input.ratingAverage ?? 4),
      viewCount: input.viewCount ?? 0,
      likeCount: input.likeCount ?? 0,
      isCompleted: input.isCompleted ?? true,
    });

    this.created.stories.push(story.id);

    for (const genreId of input.genreIds ?? []) {
      await db.orm.content.StoryGenre.create({ storyId: story.id, genreId });
      this.created.links.push({ storyId: story.id, genreId });
    }

    return story.id;
  }

  /** Records a shelf row this run caused, so teardown can remove it. */
  track(entryId: string): void {
    this.created.entries.push(entryId);
  }

  /* Teardown -------------------------------------------------------------- */

  private async cleanup(): Promise<void> {
    // Shelf rows first: they reference both users and stories.
    for (const userId of this.created.users) {
      await deleteAll(() =>
        db.orm.library.LibraryEntry.where((entry) => entry.userId.eq(userId)),
      );
    }
    for (const storyId of this.created.stories) {
      await deleteAll(() =>
        db.orm.library.LibraryEntry.where((entry) => entry.storyId.eq(storyId)),
      );
      await deleteAll(() =>
        db.orm.content.StoryGenre.where((link) => link.storyId.eq(storyId)),
      );
      await db.orm.content.Story.where((story) => story.id.eq(storyId)).delete();
    }
    for (const genreId of this.created.genres) {
      await db.orm.content.Genre.where((genre) => genre.id.eq(genreId)).delete();
    }
    for (const userId of this.created.users) {
      await db.orm.auth.User.where((user) => user.id.eq(userId)).delete();
    }
  }
}

/**
 * True when the development database is reachable. The suites skip rather than
 * fail without it, so `pnpm test` stays runnable with the Docker stack down —
 * but they run for real wherever it is up.
 */
export async function databaseAvailable(): Promise<boolean> {
  try {
    await db.orm.content.Genre.select("id").limit(1).all();
    return true;
  } catch (error) {
    console.warn(
      "\n[books/library tests] Skipped: no database reachable at DATABASE_URL.\n" +
        "Start it with `docker compose up -d postgres` and re-run.\n" +
        `Reason: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}
