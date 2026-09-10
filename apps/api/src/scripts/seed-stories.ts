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

/** Nothing signs in as a seeded author. */
const UNUSABLE_PASSWORD_HASH = "!seeded-story-author-no-login";

interface RawChapter {
  title: string;
  paragraphs: string[];
  /** Draft chapters are visible only to their author. */
  published?: boolean;
}

interface RawStory {
  title: string;
  description: string;
  authorHandle: string;
  authorName: string;
  genreNames: string[];
  isCompleted: boolean;
  kidsAppropriate: boolean;
  viewCount: number;
  likeCount: number;
  /** A story with no `listedAt` is a draft: only its author can see it. */
  listed?: boolean;
  chapters: RawChapter[];
}

const STORIES: RawStory[] = [
  {
    title: "The Lantern Keepers",
    description:
      "Every lighthouse on the coast went dark on the same night, and only the keepers remember why.",
    authorHandle: "nell_advani",
    authorName: "Nell Advani",
    genreNames: ["Fantasy", "Mystery"],
    isCompleted: false,
    kidsAppropriate: true,
    viewCount: 18420,
    likeCount: 2310,
    chapters: [
      {
        title: "The night the lights went out",
        paragraphs: [
          "The first thing Mira noticed was not the darkness. It was the silence — the absence of the low hum the lamp made as it turned, a sound she had slept through every night for eleven years.",
          "She climbed the ninety-two steps in the dark, counting them the way her mother had taught her, and found the lamp room exactly as it should be. Glass clean. Wick trimmed. Oil full to the line.",
          "The flame was simply gone, and it had taken the warmth with it.",
        ],
      },
      {
        title: "What the harbourmaster knew",
        paragraphs: [
          "By morning there were fourteen keepers standing on the harbour wall, all of them with the same story, all of them waiting for someone to say it first.",
          "The harbourmaster said it: every light from Cape Dolan to the Narrows had failed between two and three in the morning. Not dimmed. Not guttered. Failed, together, as though something had drawn a breath.",
          "Nobody mentioned the ships still out there. That was the courtesy they paid each other, and it lasted until the tide turned.",
        ],
      },
      {
        title: "The keeper who stayed awake",
        paragraphs: [
          "Old Ansel had not slept in forty years, which was either a joke he refused to explain or the plain truth, and he was the only one who had been watching when it happened.",
          "He described it carefully, the way a man describes something he has rehearsed: the flame leaning, all at once, toward the open sea.",
        ],
        published: false,
      },
    ],
  },
  {
    title: "Small Hours at the Observatory",
    description:
      "A night-shift astronomer starts receiving replies to signals she has not sent yet.",
    authorHandle: "june_okafor",
    authorName: "June Okafor",
    genreNames: ["Science Fiction", "Mystery"],
    isCompleted: true,
    kidsAppropriate: false,
    viewCount: 42980,
    likeCount: 5104,
    chapters: [
      {
        title: "03:14",
        paragraphs: [
          "The reply arrived fourteen minutes past three, which was unremarkable, except that Ada had not transmitted anything and would not do so for another six hours.",
          "She read it twice, printed it, and then sat very still, because the message was in her own formatting — her spacing, her habit of writing frequencies without units.",
        ],
      },
      {
        title: "The problem with proof",
        paragraphs: [
          "There is a particular loneliness in holding evidence nobody will look at. Ada had three pages of it and a supervisor who had asked her, kindly, whether she was sleeping.",
          "So she did what any careful person does with an impossible result. She tried to break it.",
          "It would not break. It answered every test she put to it, politely, in her own handwriting.",
        ],
      },
      {
        title: "Sending it anyway",
        paragraphs: [
          "At 09:02 she transmitted the message she had received, word for word, into the empty part of the sky it had come from.",
          "The reply was already in the printer. It said: good, now we can begin.",
        ],
      },
    ],
  },
  {
    title: "Notes Toward a Longer Winter",
    description:
      "An unfinished draft: the first chapters of a novel about the year the snow did not stop.",
    authorHandle: "nell_advani",
    authorName: "Nell Advani",
    genreNames: ["Historical Fiction"],
    isCompleted: false,
    kidsAppropriate: true,
    viewCount: 0,
    likeCount: 0,
    listed: false,
    chapters: [
      {
        title: "November, again",
        paragraphs: [
          "It began as weather and became a fact of life, the way most disasters do — slowly enough that nobody had to decide anything.",
        ],
        published: false,
      },
    ],
  },
  {
    title: "The Inventory of Small Losses",
    description:
      "A city clerk is tasked with cataloguing everything the flood took, and finds her own name in the ledger.",
    authorHandle: "ilse_van_der_meer",
    authorName: "Ilse van der Meer",
    genreNames: ["Literary Fiction", "Mystery"],
    isCompleted: false,
    kidsAppropriate: true,
    viewCount: 9310,
    likeCount: 1180,
    chapters: [
      {
        title: "Column three",
        paragraphs: [
          "The form had four columns: what was lost, where it was lost, what it had been worth, and who was asking. Column three was the one that made people cry, and column four was the one that made them lie.",
          "Hanne had filled in eleven hundred of them since the water went down. She had a system, and the system was the only reason she could still do it.",
          "On the eleven hundred and first, under who was asking, someone had written her own name in her own hand.",
        ],
      },
      {
        title: "The archive is not the city",
        paragraphs: [
          "Her supervisor explained, patiently, that the archive was not the city; it was a record of the city, and a record could contain an error without the world having to rearrange itself around it.",
          "Hanne agreed with him completely. Then she went back after hours and pulled every form filed on the day the levee failed.",
        ],
      },
    ],
  },
  {
    title: "Nine Hundred Miles of Nothing to Say",
    description:
      "Two estranged sisters drive their mother's ashes across the country and refuse, for six days, to discuss it.",
    authorHandle: "kemi_adeyemi",
    authorName: "Kemi Adeyemi",
    genreNames: ["Literary Fiction", "Romance"],
    isCompleted: true,
    kidsAppropriate: false,
    viewCount: 26740,
    likeCount: 4092,
    chapters: [
      {
        title: "Day one: the radio",
        paragraphs: [
          "They agreed on the radio station within four minutes, which Tolu took as a sign that the week might be survivable, and which Bisi took as proof that her sister still could not bear a silence.",
          "The urn rode in the back seat with a seatbelt across it. Neither of them had suggested this. Neither of them undid it.",
        ],
      },
      {
        title: "Day three: the diner",
        paragraphs: [
          "The waitress asked if they were on holiday. Bisi said yes. Tolu said no. The waitress, who had clearly done this before, brought two coffees and left them to it.",
          "It was the first time in eleven years that they had laughed at the same moment, and they both pretended not to notice.",
        ],
      },
      {
        title: "Day six: the water",
        paragraphs: [
          "Their mother had asked for the sea, and had not specified which one, which was either carelessness or the last and best joke of a woman who wanted her daughters to have to decide something together.",
          "They stood on the shingle for a long time, holding an urn and a road atlas, and finally Tolu said: this one. And Bisi said: yes. All right. This one.",
        ],
      },
    ],
  },
  {
    title: "The Sommelier of Brackish Water",
    description:
      "In a drowned city, the woman who can taste which street a flood came from is worth more than gold.",
    authorHandle: "yusuf_abadi",
    authorName: "Yusuf Abadi",
    genreNames: ["Fantasy", "Adventure"],
    isCompleted: false,
    kidsAppropriate: false,
    viewCount: 61230,
    likeCount: 8840,
    chapters: [
      {
        title: "A glass from the Weavers' Quarter",
        paragraphs: [
          "They brought her the water in a corked bottle, the way you bring a body to a coroner, and waited to be told what had happened to it.",
          "Sabeen swirled it, warmed it against her palm, and touched it to her tongue. Rust, first. Then lime plaster. Then, faintly and unmistakably, the green rot of the loom pits.",
          "\"Weavers' Quarter,\" she said. \"Four days ago. And someone opened a sluice that should have stayed shut.\"",
        ],
      },
      {
        title: "The price of a true answer",
        paragraphs: [
          "The man who had brought the bottle paid her without arguing, which told her more than the water had. People who argue about a price intend to keep living in the city.",
          "She followed him at a distance, because she had made her living for nineteen years on the principle that water tells you where it has been, and so do men.",
        ],
      },
    ],
  },
  {
    title: "Emergency Exit Row",
    description:
      "A flight attendant realises the passenger in 14C has been on every one of her flights for a month.",
    authorHandle: "priya_mehta",
    authorName: "Priya Mehta",
    genreNames: ["Thriller", "Mystery"],
    isCompleted: true,
    kidsAppropriate: false,
    viewCount: 88410,
    likeCount: 12980,
    chapters: [
      {
        title: "Doors to manual",
        paragraphs: [
          "Nadia noticed him the way you notice a word you have read four times on the same page: not as a shock, but as a slow accumulation of wrongness.",
          "Rome. Then Lisbon. Then the awful red-eye to Halifax that nobody chooses. Same seat. Same grey jacket. Same untouched glass of water.",
        ],
      },
      {
        title: "The manifest",
        paragraphs: [
          "She pulled the manifests on her own time, which was against three separate policies, and found that the name in 14C changed every flight while the frequent-flyer number did not.",
          "That number belonged to a man who had died in 2019. She knew, because she had worked the flight it happened on.",
        ],
      },
      {
        title: "Cabin secure",
        paragraphs: [
          "On the descent into Reykjavík he finally spoke to her, and what he said was: you're the only one who ever looks at the water.",
        ],
      },
    ],
  },
  {
    title: "Hollowmere",
    description:
      "The village has a bell that rings when someone is lying, and this week it will not stop.",
    authorHandle: "jo_fairweather",
    authorName: "Jo Fairweather",
    genreNames: ["Horror", "Mystery"],
    isCompleted: false,
    kidsAppropriate: false,
    viewCount: 33150,
    likeCount: 5620,
    chapters: [
      {
        title: "Monday, and it starts",
        paragraphs: [
          "The bell had rung eleven times in Cass's lifetime, and each time the village had known within the hour who it meant. That was the comfort of it. The bell was a small, cruel, reliable thing.",
          "On Monday it rang at dawn and did not stop, and by noon everyone had stopped meeting each other's eyes.",
        ],
      },
      {
        title: "What the vicar would not say",
        paragraphs: [
          "The vicar climbed the tower alone and came down grey, and told them the mechanism was sound and the rope was still, and then he said nothing else for two days.",
          "Cass, who was fifteen and had never been trusted with anything, went up after him and found the bell hanging perfectly motionless in the loud dark.",
        ],
      },
    ],
  },
  {
    title: "The Understudy Always Knows",
    description:
      "Six weeks before opening night, the lead vanishes — and her understudy has been rehearsing the disappearance.",
    authorHandle: "lucia_castellanos",
    authorName: "Lucía Castellanos",
    genreNames: ["Thriller", "Romance"],
    isCompleted: false,
    kidsAppropriate: false,
    viewCount: 15870,
    likeCount: 2440,
    chapters: [
      {
        title: "Blocking",
        paragraphs: [
          "An understudy learns a role the way a burglar learns a house: not the front rooms everyone sees, but the hinges, the loose board, the window that never quite locks.",
          "Frankie knew where Isolde breathed in the second act. She knew which line she always dropped when she was tired, and which one she had never once got wrong.",
        ],
      },
      {
        title: "Notes from the director",
        paragraphs: [
          "The police asked whether Isolde had seemed frightened. The director said no, brilliant, difficult, never frightened, and then he looked at Frankie for slightly too long.",
          "Frankie said nothing, which is the first thing they teach you: hold the pause until it belongs to you.",
        ],
      },
    ],
  },
  {
    title: "A Field Guide to Local Ghosts",
    description:
      "A teenager documents every haunting in her town for the school science fair, and the ghosts start correcting her notes.",
    authorHandle: "elin_lindqvist",
    authorName: "Elin Lindqvist",
    genreNames: ["Young Adult", "Fantasy"],
    isCompleted: false,
    kidsAppropriate: true,
    viewCount: 47620,
    likeCount: 9310,
    chapters: [
      {
        title: "Specimen one: the bus stop",
        paragraphs: [
          "My hypothesis was that ghosts are a local phenomenon, like accents or bad drainage, and that a properly kept field guide would show patterns nobody had noticed because nobody had bothered to write them down.",
          "Specimen one waits at the bus stop on Tanner Road every evening between six and seven. She is roughly my height. She has never once got on a bus.",
        ],
      },
      {
        title: "Specimen one has opinions",
        paragraphs: [
          "This morning my notebook said HEIGHT: TALLER THAN YOU in handwriting that is not mine, which is not how peer review is supposed to work.",
          "I have amended the entry. I have also started a second notebook, which I keep at my grandmother's, because I would like at least one set of observations that observes back less.",
        ],
      },
      {
        title: "The science fair, and after",
        paragraphs: [
          "I did not win the science fair. The judges said my methodology was sound but my sample was unverifiable, which is the politest anyone has ever been about the dead.",
          "Specimen one was at the back of the hall the whole time. She clapped. Nobody else heard it.",
        ],
      },
    ],
  },
];

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

  for (const story of STORIES) {
    const outcome = await upsertStory(story);
    if (outcome === "created") created += 1;
    else updated += 1;
    console.log(`  ${outcome === "created" ? "+" : "~"} ${story.title}`);
  }

  console.log(
    `\nStories: ${created} created, ${updated} updated ` +
      `(${STORIES.reduce((total, story) => total + story.chapters.length, 0)} chapters).`,
  );
}

await main();
await db.close();
