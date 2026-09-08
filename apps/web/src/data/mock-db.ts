/**
 * In-memory dataset backing the UI while the Scribe API is being built.
 *
 * Everything here is deterministic: a seeded PRNG derives counts and dates from
 * stable ids, so the same story always has the same numbers across reloads and
 * across light/dark screenshots. `src/data/api.ts` is the only module that
 * reads this — swap that file for real fetches and the UI is unchanged.
 */

import type {
  Badge,
  BookClub,
  BroadcastChannel,
  Chapter,
  ChannelPost,
  ChallengeEntry,
  ClubDiscussion,
  ClubMembership,
  Comment,
  Genre,
  Multimedia,
  Rating,
  ReadingHistory,
  Story,
  StoryStatus,
  User,
  UserBadge,
  WritingChallenge,
} from '../types/domain'

/* Deterministic helpers ------------------------------------------------ */

function seeded(seed: string): () => number {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return () => {
    hash ^= hash << 13
    hash ^= hash >>> 17
    hash ^= hash << 5
    return ((hash >>> 0) % 100000) / 100000
  }
}

/** Fixed "now" so relative dates stay stable in tests and screenshots. */
const NOW = new Date('2026-09-08T09:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86400000).toISOString()
}

function daysAhead(days: number): string {
  return new Date(NOW.getTime() + days * 86400000).toISOString()
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] as T
}

function between(random: () => number, min: number, max: number): number {
  return Math.floor(min + random() * (max - min))
}

/* Genres --------------------------------------------------------------- */

export const genres: Genre[] = [
  { id: 'g-fantasy', name: 'Fantasy', slug: 'fantasy', hue: 268, storyCount: 12840, description: 'Magic systems, invented worlds and impossible maps.' },
  { id: 'g-romance', name: 'Romance', slug: 'romance', hue: 342, storyCount: 18320, description: 'Slow burns, second chances and terrible timing.' },
  { id: 'g-mystery', name: 'Mystery', slug: 'mystery', hue: 202, storyCount: 7410, description: 'Clues in plain sight and narrators you should not trust.' },
  { id: 'g-thriller', name: 'Thriller', slug: 'thriller', hue: 6, storyCount: 6980, description: 'Short chapters, shorter fuses.' },
  { id: 'g-scifi', name: 'Sci-Fi', slug: 'sci-fi', hue: 190, storyCount: 8115, description: 'Near futures, deep space and the ethics of both.' },
  { id: 'g-historical', name: 'Historical Fiction', slug: 'historical-fiction', hue: 32, storyCount: 4260, description: 'Real centuries, invented lives.' },
  { id: 'g-ya', name: 'Young Adult', slug: 'young-adult', hue: 288, storyCount: 15070, description: 'First everything, at full volume.' },
  { id: 'g-horror', name: 'Horror', slug: 'horror', hue: 150, storyCount: 3890, description: 'Quiet dread and the thing behind the door.' },
  { id: 'g-poetry', name: 'Poetry', slug: 'poetry', hue: 224, storyCount: 5240, description: 'Line breaks that earn their keep.' },
  { id: 'g-adventure', name: 'Adventure', slug: 'adventure', hue: 96, storyCount: 6630, description: 'Long roads, bad weather, good company.' },
]

export const genreById = new Map(genres.map((genre) => [genre.id, genre]))

/* Users ---------------------------------------------------------------- */

interface AuthorSeed {
  id: string
  username: string
  displayName: string
  bio: string
  hue: number
}

const authorSeeds: AuthorSeed[] = [
  { id: 'u-ilse', username: 'ilsevandermeer', displayName: 'Ilse van der Meer', bio: 'Writes cold northern fantasy. Cartographer by training, which explains the maps.', hue: 268 },
  { id: 'u-adeyemi', username: 'k_adeyemi', displayName: 'Kemi Adeyemi', bio: 'Romance with sharp edges. Lagos to Lisbon. Tea over coffee, always.', hue: 342 },
  { id: 'u-solano', username: 'rsolano', displayName: 'Rafael Solano', bio: 'Detective fiction set in cities that do not sleep because the rent is due.', hue: 202 },
  { id: 'u-nakamura', username: 'haru_nakamura', displayName: 'Haru Nakamura', bio: 'Quiet science fiction about repairing things — machines, mostly people.', hue: 190 },
  { id: 'u-okonkwo', username: 'amaraokonkwo', displayName: 'Amara Okonkwo', bio: 'Historical fiction, 19th century, women who kept the ledgers.', hue: 32 },
  { id: 'u-lindqvist', username: 'e_lindqvist', displayName: 'Elin Lindqvist', bio: 'Horror that happens in daylight. Sorry in advance.', hue: 150 },
  { id: 'u-mehta', username: 'priyamehta', displayName: 'Priya Mehta', bio: 'YA about ambitious girls and the institutions that underestimate them.', hue: 288 },
  { id: 'u-abadi', username: 'yusufabadi', displayName: 'Yusuf Abadi', bio: 'Poems, mostly at night. Occasional essays when the poems refuse.', hue: 224 },
  { id: 'u-fairweather', username: 'j_fairweather', displayName: 'Jo Fairweather', bio: 'Adventure serials. I have fallen off most things worth falling off.', hue: 96 },
  { id: 'u-castellanos', username: 'lcastellanos', displayName: 'Lucía Castellanos', bio: 'Thrillers with short chapters, because you have a train to catch.', hue: 6 },
]

function makeAuthor(seed: AuthorSeed): User {
  const random = seeded(seed.id)
  return {
    id: seed.id,
    username: seed.username,
    displayName: seed.displayName,
    email: `${seed.username}@scribe.example`,
    bio: seed.bio,
    avatarHue: seed.hue,
    joinedAt: daysAgo(between(random, 420, 1600)),
    isAuthor: true,
    followerCount: between(random, 4200, 186000),
    followingCount: between(random, 40, 620),
    stats: {
      storiesRead: between(random, 60, 340),
      chaptersRead: between(random, 900, 5200),
      storiesPublished: 0,
      totalViews: 0,
      averageRating: null,
      readingStreakDays: between(random, 3, 90),
      minutesReadThisWeek: between(random, 60, 700),
    },
  }
}

export const authors: User[] = authorSeeds.map(makeAuthor)

/** The signed-in reader used across the app. */
export const currentUser: User = {
  id: 'u-me',
  username: 'jayshree',
  displayName: 'Jayshree Upadhyay',
  email: 'jayshree@scribe.example',
  bio: 'Reader first, writer on Sundays. Currently deep in northern fantasy and anything with a map in the front matter.',
  avatarHue: 24,
  joinedAt: daysAgo(268),
  isAuthor: true,
  followerCount: 1284,
  followingCount: 96,
  stats: {
    storiesRead: 74,
    chaptersRead: 1146,
    storiesPublished: 2,
    totalViews: 48210,
    averageRating: 4.31,
    readingStreakDays: 7,
    minutesReadThisWeek: 284,
  },
}

export const users: User[] = [currentUser, ...authors]
export const userById = new Map(users.map((user) => [user.id, user]))

/* Stories -------------------------------------------------------------- */

interface StorySeed {
  id: string
  title: string
  authorId: string
  genreIds: string[]
  status: StoryStatus
  tagline: string
  synopsis: string
  kids?: boolean
}

const storySeeds: StorySeed[] = [
  {
    id: 's-saltglass',
    title: 'The Salt-Glass Coast',
    authorId: 'u-ilse',
    genreIds: ['g-fantasy', 'g-adventure'],
    status: 'ongoing',
    tagline: 'The sea remembers every name it takes. Mira intends to take one back.',
    synopsis:
      'When the tide turns to glass every ninth winter, the coastal towns send one girl out to walk it. Mira Feldsen has walked it twice and come back with someone else\'s memories both times. The third walk is not for the town. It is for her brother, whose name the sea swallowed whole — and for the lighthouse keeper who has been writing down every name it has ever taken.',
  },
  {
    id: 's-lastletter',
    title: 'The Last Letter from Lisbon',
    authorId: 'u-adeyemi',
    genreIds: ['g-romance', 'g-historical'],
    status: 'completed',
    tagline: 'Two archivists, one misfiled letter, sixty years too late.',
    synopsis:
      'Adaeze catalogues other people\'s love letters for a living, which is how she finds one addressed to her grandmother from a man the family swears never existed. Tracing it takes her to a Lisbon archive, a stubborn colleague who disagrees with her filing system, and a correspondence that was interrupted mid-sentence in 1964.',
  },
  {
    id: 's-ninthfloor',
    title: 'Nobody Lives on the Ninth Floor',
    authorId: 'u-solano',
    genreIds: ['g-mystery', 'g-thriller'],
    status: 'ongoing',
    tagline: 'The building has eight floors. The elevator disagrees.',
    synopsis:
      'Detective Iván Reyes has taken the same elevator for eleven years. On a Tuesday in March it stops at a floor the building does not have, and a woman he watched be buried steps in and asks him for the time. What follows is a case with no body, no crime and forty-one witnesses who all describe a different tenant.',
  },
  {
    id: 's-quietengine',
    title: 'The Quiet Engine',
    authorId: 'u-nakamura',
    genreIds: ['g-scifi'],
    status: 'ongoing',
    tagline: 'A repair technician, a dying station, and the machine that keeps apologising.',
    synopsis:
      'Station Hoshi runs on a reactor that has begun to say sorry. Yuki is the only technician left who remembers how it used to sound, and the only one who will admit that the apologising started the week the crew count dropped. Maintenance logs as a love letter to broken things.',
  },
  {
    id: 's-ledgerkeepers',
    title: 'The Ledger Keepers',
    authorId: 'u-okonkwo',
    genreIds: ['g-historical'],
    status: 'completed',
    tagline: 'History recorded the men who signed. She recorded everything else.',
    synopsis:
      'In 1871 the Onitsha trading houses ran on ledgers kept by women whose names never made the contracts. Nkechi keeps the most accurate books on the river, which makes her indispensable, and then dangerous, and then the only person who can prove what the company did.',
  },
  {
    id: 's-noonbell',
    title: 'The Noon Bell',
    authorId: 'u-lindqvist',
    genreIds: ['g-horror', 'g-mystery'],
    status: 'ongoing',
    tagline: 'It rings at twelve. You have until the last stroke to be indoors.',
    synopsis:
      'Nothing bad has happened in Vitsand for two hundred years, provided everyone is inside by the last stroke of the noon bell. Karin has come home to bury her mother and finds the rule has quietly acquired exceptions. Daylight horror about small towns and the arithmetic of safety.',
  },
  {
    id: 's-scholarship',
    title: 'Scholarship Girl',
    authorId: 'u-mehta',
    genreIds: ['g-ya'],
    status: 'ongoing',
    tagline: 'She got in on merit. Everyone keeps saying it like a question.',
    kids: true,
    synopsis:
      'Ananya has one year at Ravenscourt, a full scholarship and a list of things she is not supposed to want. The debating society wants a mascot, the headmistress wants a success story, and Ananya wants the prize nobody has given a scholarship student in ninety-one years.',
  },
  {
    id: 's-nightshift',
    title: 'Night Shift Psalms',
    authorId: 'u-abadi',
    genreIds: ['g-poetry'],
    status: 'completed',
    tagline: 'Forty poems written between two and five in the morning.',
    synopsis:
      'A collection assembled across three years of hospital night shifts — ward lights, vending machines, the specific tenderness of handing someone a blanket at 4am. Read one at a time, preferably late.',
  },
  {
    id: 's-longportage',
    title: 'The Long Portage',
    authorId: 'u-fairweather',
    genreIds: ['g-adventure'],
    status: 'ongoing',
    tagline: 'Nine hundred kilometres of river. One canoe. Two people not speaking.',
    kids: true,
    synopsis:
      'A serialised account of a route nobody has run since 1954, undertaken by two former climbing partners who fell out badly and never said why. Weather, whitewater, and a slow thaw told in daily entries.',
  },
  {
    id: 's-sixminutes',
    title: 'Six Minutes to Vasa',
    authorId: 'u-castellanos',
    genreIds: ['g-thriller'],
    status: 'ongoing',
    tagline: 'The train arrives in six minutes. She has to decide before it does.',
    synopsis:
      'A courier, a locked case, and a platform under surveillance from four directions. Told in ninety-second chapters across a single commute that keeps not ending.',
  },
  {
    id: 's-cartographers',
    title: "The Cartographer's Apprentice",
    authorId: 'u-ilse',
    genreIds: ['g-fantasy', 'g-ya'],
    status: 'completed',
    tagline: 'Draw the coast wrong and the coast obliges.',
    kids: true,
    synopsis:
      'Tam is apprenticed to a mapmaker whose errors have a habit of becoming geography. A gentler companion piece to The Salt-Glass Coast, set two generations earlier.',
  },
  {
    id: 's-secondchance',
    title: 'Second Chance Bakery',
    authorId: 'u-adeyemi',
    genreIds: ['g-romance'],
    status: 'ongoing',
    tagline: 'He bought the building. She has the only key that works.',
    kids: true,
    synopsis:
      'Ife inherited a failing bakery and a feud. Tobi bought the freehold and a problem he did not read the fine print on. Enemies-to-lovers with a lot of bread.',
  },
  {
    id: 's-hollowmarket',
    title: 'The Hollow Market',
    authorId: 'u-lindqvist',
    genreIds: ['g-horror', 'g-fantasy'],
    status: 'hiatus',
    tagline: 'Everything is for sale. Bring something you can stand to lose.',
    synopsis:
      'A market that appears in cities the week before something terrible, selling exactly what you need at exactly the wrong price.',
  },
  {
    id: 's-orbitaldecay',
    title: 'Orbital Decay',
    authorId: 'u-nakamura',
    genreIds: ['g-scifi', 'g-thriller'],
    status: 'completed',
    tagline: 'Eleven months of orbit left, and a stowaway with a better plan.',
    synopsis:
      'A decommissioned survey ship, a crew of four who have stopped pretending to like each other, and an unlisted passenger who knows why the mission was really funded.',
  },
  {
    id: 's-riverwidow',
    title: 'The River Widow',
    authorId: 'u-okonkwo',
    genreIds: ['g-historical', 'g-mystery'],
    status: 'ongoing',
    tagline: 'She was widowed by the river three times. Only once by accident.',
    synopsis:
      'A delta trading town, a woman with a reputation, and an inquest that everyone would prefer went badly.',
  },
  {
    id: 's-glasshour',
    title: 'The Glass Hour',
    authorId: 'u-mehta',
    genreIds: ['g-ya', 'g-fantasy'],
    status: 'ongoing',
    tagline: 'One hour a day when the rules do not apply. Use it well.',
    kids: true,
    synopsis:
      'Every student at Marrowfield gets one hour of impossible ability, once, on a day nobody can predict. Devi has been keeping notes on everyone else\'s.',
  },
  {
    id: 's-deadletter',
    title: 'Dead Letter Office',
    authorId: 'u-solano',
    genreIds: ['g-mystery'],
    status: 'ongoing',
    tagline: 'Undeliverable mail, and one letter that keeps coming back.',
    synopsis:
      'A clerk in the undeliverable mail division starts answering the letters. One of the recipients writes back, which should not be possible.',
  },
  {
    id: 's-summitfever',
    title: 'Summit Fever',
    authorId: 'u-fairweather',
    genreIds: ['g-adventure', 'g-thriller'],
    status: 'completed',
    tagline: 'Everyone summits. Not everyone comes down as themselves.',
    synopsis:
      'Eight climbers, one weather window, and the decision made at 8,300 metres that the survivors describe eight different ways.',
  },
  {
    id: 's-tidepool',
    title: 'Tide Pool Elegies',
    authorId: 'u-abadi',
    genreIds: ['g-poetry', 'g-scifi'],
    status: 'ongoing',
    tagline: 'Poems from a coastline that will not exist in thirty years.',
    synopsis: 'A slow, oceanic sequence about erosion, both geological and personal.',
  },
  {
    id: 's-nineteenknives',
    title: 'Nineteen Knives',
    authorId: 'u-castellanos',
    genreIds: ['g-thriller', 'g-mystery'],
    status: 'ongoing',
    tagline: 'A locked kitchen, a missing chef, and one knife unaccounted for.',
    synopsis:
      'The staff of a three-star restaurant have four hours before service to work out which of them is lying.',
  },
]

const CHAPTER_TITLES = [
  'The Beginning', 'Into the Unknown', 'The Secret', 'Low Water', 'What the Keeper Wrote',
  'Nine Winters', 'The Ninth Stroke', 'Salt and Paper', 'A Name Returned', 'The Long Way Round',
  'Everything She Filed', 'The Wrong Address', 'Interrupted', 'The Last Letter', 'After',
  'Small Repairs', 'The Apology', 'Crew Count', 'Signal Drift', 'Homecoming',
]

function makeStory(seed: StorySeed): Story {
  const random = seeded(seed.id)
  const published = seed.status === 'draft' ? null : daysAgo(between(random, 30, 700))
  const chapterCount = seed.genreIds.includes('g-poetry')
    ? between(random, 12, 40)
    : between(random, 8, 42)
  const ratingCount = between(random, 320, 42000)

  return {
    id: seed.id,
    title: seed.title,
    slug: seed.id.replace('s-', ''),
    synopsis: seed.synopsis,
    tagline: seed.tagline,
    authorId: seed.authorId,
    status: seed.status,
    genreIds: seed.genreIds,
    kidsAppropriate: seed.kids ?? false,
    publishedAt: published,
    updatedAt: daysAgo(between(random, 0, 26)),
    chapterCount,
    wordCount: chapterCount * between(random, 1900, 3600),
    viewCount: between(random, 18000, 2400000),
    likeCount: between(random, 900, 184000),
    commentCount: between(random, 120, 21000),
    ratingAverage: Number((3.7 + random() * 1.25).toFixed(2)),
    ratingCount,
  }
}

export const stories: Story[] = storySeeds.map(makeStory)
export const storyById = new Map(stories.map((story) => [story.id, story]))

/* Chapters ------------------------------------------------------------- */

const PROSE = [
  'The tide went out further than it had any right to, and kept going, until the seabed lay open like a book nobody had asked to have read aloud.',
  'She counted the strokes without meaning to. Everyone in the town counted; it was the first arithmetic any of them learned and the last they would forget.',
  'There is a particular silence to a room where someone has just stopped speaking, and a different one where someone has decided not to start.',
  'The keeper had written the names in a hand that got smaller each year, as though the paper were the thing in short supply.',
  'Outside, the weather had made up its mind. Inside, nobody had.',
  'He had the sort of face that made strangers explain themselves, and he had never once asked them to.',
  'The machine hummed, faltered, and hummed again, and in the gap between the two she heard something that was almost a word.',
  'Nobody warned her that the hardest part would be the paperwork. Grief, it turned out, arrived in triplicate.',
  'They walked without talking for an hour, which was the most honest conversation they had managed in years.',
  'The letter was dated in a year when both of them had been someone else entirely.',
  'Later she would say the decision took a second. In truth it took eleven years and then a second.',
  'The light came in low and made the dust look deliberate, like something arranged for a photograph nobody would take.',
  'Every town has a rule it does not explain to visitors. Vitsand has two, and only ever mentions the first.',
  'She wrote it all down because writing it down was the only way she knew to make a thing stop happening to her and start being hers.',
  'The corridor smelled of rain on hot metal, which meant the seals had gone again, which meant another night awake with a torch in her teeth.',
]

function makeChapters(story: Story): Chapter[] {
  const random = seeded(`${story.id}-chapters`)
  const count = Math.min(story.chapterCount, 24)

  return Array.from({ length: count }, (_, index) => {
    const number = index + 1
    const paragraphCount = between(random, 6, 13)
    const paragraphs = Array.from({ length: paragraphCount }, () => pick(PROSE, random))
    const wordCount = paragraphs.join(' ').split(' ').length * between(random, 8, 16)

    const multimedia: Multimedia[] = []
    if (number % 5 === 0) {
      multimedia.push({
        id: `${story.id}-ch${number}-img`,
        chapterId: `${story.id}-ch${number}`,
        kind: 'image',
        caption: 'Chapter plate — the coast at low water',
      })
    }
    if (number % 7 === 0) {
      multimedia.push({
        id: `${story.id}-ch${number}-audio`,
        chapterId: `${story.id}-ch${number}`,
        kind: 'audio',
        caption: 'Author narration',
        durationSeconds: between(random, 240, 900),
      })
    }

    return {
      id: `${story.id}-ch${number}`,
      storyId: story.id,
      number,
      title: CHAPTER_TITLES[index % CHAPTER_TITLES.length] as string,
      paragraphs,
      publishedAt: daysAgo(Math.max(0, 700 - number * between(random, 6, 20))),
      wordCount,
      readingMinutes: Math.max(3, Math.round(wordCount / 220)),
      viewCount: Math.round(story.viewCount / (number * 0.7 + 1)),
      multimedia,
    }
  })
}

export const chaptersByStory = new Map(
  stories.map((story) => [story.id, makeChapters(story)]),
)

/* Engagement ----------------------------------------------------------- */

const COMMENT_BODIES = [
  'The pacing in this chapter is extraordinary. I read the last three paragraphs twice.',
  'Absolutely not okay with what you just did to that character. Continuing immediately.',
  'The detail about the handwriting getting smaller each year has been living in my head all week.',
  'I came for the premise and stayed for the sentences.',
  'Reading this on my commute was a mistake. I missed my stop.',
  'The way you write weather. Nobody else does it like this.',
  'Chapter 9 rewired something in me. Thank you for writing it.',
  'Please tell me the update schedule is weekly. I need to plan my life around this.',
]

export const comments: Comment[] = stories.flatMap((story) => {
  const random = seeded(`${story.id}-comments`)
  const commenters = users.filter((user) => user.id !== story.authorId)

  return Array.from({ length: 6 }, (_, index) => ({
    id: `${story.id}-c${index}`,
    storyId: story.id,
    chapterId: index % 2 === 0 ? `${story.id}-ch${between(random, 1, 8)}` : null,
    userId: (pick(commenters, random) as User).id,
    body: pick(COMMENT_BODIES, random) as string,
    createdAt: daysAgo(between(random, 0, 40)),
    likeCount: between(random, 2, 940),
    replyCount: between(random, 0, 24),
  }))
})

const REVIEWS = [
  'One of the best things being written on Scribe right now. The restraint is the whole trick.',
  'Gorgeous prose, genuinely surprising plotting, and an ending that earns itself.',
  'Started it on a Sunday and finished it on the same Sunday. Cancel your plans.',
  null,
  'Slow in the middle third, but the payoff is worth the patience.',
]

export const ratings: Rating[] = stories.flatMap((story) => {
  const random = seeded(`${story.id}-ratings`)
  const raters = users.filter((user) => user.id !== story.authorId)

  return Array.from({ length: 4 }, (_, index) => ({
    id: `${story.id}-r${index}`,
    storyId: story.id,
    userId: (pick(raters, random) as User).id,
    score: between(random, 3, 6),
    review: pick(REVIEWS, random) as string | null,
    createdAt: daysAgo(between(random, 1, 120)),
  }))
})

/* Reading history ------------------------------------------------------ */

interface HistorySeed {
  storyId: string
  chapterNumber: number
  storyProgress: number
  chapterProgress: number
  shelf: ReadingHistory['shelf']
  daysSince: number
  bookmarked?: boolean
}

const historySeeds: HistorySeed[] = [
  { storyId: 's-saltglass', chapterNumber: 14, storyProgress: 0.62, chapterProgress: 0.38, shelf: 'reading', daysSince: 0, bookmarked: true },
  { storyId: 's-ninthfloor', chapterNumber: 7, storyProgress: 0.34, chapterProgress: 0.71, shelf: 'reading', daysSince: 1 },
  { storyId: 's-quietengine', chapterNumber: 3, storyProgress: 0.12, chapterProgress: 0.2, shelf: 'reading', daysSince: 2, bookmarked: true },
  { storyId: 's-scholarship', chapterNumber: 11, storyProgress: 0.48, chapterProgress: 0.05, shelf: 'reading', daysSince: 4 },
  { storyId: 's-lastletter', chapterNumber: 22, storyProgress: 1, chapterProgress: 1, shelf: 'completed', daysSince: 12 },
  { storyId: 's-ledgerkeepers', chapterNumber: 18, storyProgress: 1, chapterProgress: 1, shelf: 'completed', daysSince: 34 },
  { storyId: 's-orbitaldecay', chapterNumber: 20, storyProgress: 1, chapterProgress: 1, shelf: 'completed', daysSince: 61 },
  { storyId: 's-noonbell', chapterNumber: 1, storyProgress: 0.02, chapterProgress: 0, shelf: 'saved', daysSince: 6 },
  { storyId: 's-glasshour', chapterNumber: 1, storyProgress: 0, chapterProgress: 0, shelf: 'saved', daysSince: 8, bookmarked: true },
  { storyId: 's-nineteenknives', chapterNumber: 1, storyProgress: 0, chapterProgress: 0, shelf: 'saved', daysSince: 15 },
  { storyId: 's-secondchance', chapterNumber: 1, storyProgress: 0, chapterProgress: 0, shelf: 'saved', daysSince: 22 },
]

export const readingHistory: ReadingHistory[] = historySeeds.map((seed, index) => ({
  id: `rh-${index}`,
  userId: currentUser.id,
  storyId: seed.storyId,
  chapterId: `${seed.storyId}-ch${seed.chapterNumber}`,
  chapterProgress: seed.chapterProgress,
  storyProgress: seed.storyProgress,
  lastReadAt: daysAgo(seed.daysSince),
  shelf: seed.shelf,
  bookmarked: seed.bookmarked ?? false,
}))

/* Gamification --------------------------------------------------------- */

export const badges: Badge[] = [
  { id: 'b-first-story', name: 'First Story', description: 'Published your first story on Scribe.', icon: 'book', tier: 'bronze', criteria: 'Publish one story', category: 'writing' },
  { id: 'b-first-chapter', name: 'First Chapter', description: 'Published your first chapter.', icon: 'pencil', tier: 'bronze', criteria: 'Publish one chapter', category: 'writing' },
  { id: 'b-first-review', name: 'First Review', description: 'Left your first review on a story.', icon: 'star', tier: 'bronze', criteria: 'Review one story', category: 'community' },
  { id: 'b-streak-7', name: '7 Day Streak', description: 'Read something every day for a week.', icon: 'flame', tier: 'silver', criteria: 'Read 7 days in a row', category: 'reading' },
  { id: 'b-chapters-100', name: '100 Chapters', description: 'Read one hundred chapters.', icon: 'library', tier: 'silver', criteria: 'Read 100 chapters', category: 'reading' },
  { id: 'b-rising-author', name: 'Rising Author', description: 'Reached 1,000 reads across your stories.', icon: 'trend', tier: 'silver', criteria: 'Earn 1,000 reads', category: 'writing' },
  { id: 'b-popular-writer', name: 'Popular Writer', description: 'Reached 50,000 reads across your stories.', icon: 'crown', tier: 'gold', criteria: 'Earn 50,000 reads', category: 'writing' },
  { id: 'b-club-regular', name: 'Book Club Regular', description: 'Posted in club discussions ten weeks running.', icon: 'users', tier: 'silver', criteria: 'Post 10 weeks in a row', category: 'community' },
  { id: 'b-marathon', name: 'Marathon Reader', description: 'Read for 500 minutes in a single week.', icon: 'clock', tier: 'gold', criteria: 'Read 500 minutes in a week', category: 'reading' },
  { id: 'b-challenge-win', name: 'Challenge Winner', description: 'Placed first in a writing challenge.', icon: 'trophy', tier: 'gold', criteria: 'Win a writing challenge', category: 'writing' },
  { id: 'b-critic', name: 'Thoughtful Critic', description: 'Wrote 25 reviews other readers found helpful.', icon: 'quote', tier: 'silver', criteria: 'Write 25 helpful reviews', category: 'community' },
  { id: 'b-nightowl', name: 'Night Owl', description: 'Read after midnight thirty times.', icon: 'moon', tier: 'bronze', criteria: 'Read after midnight 30 times', category: 'reading' },
]

export const userBadges: UserBadge[] = [
  { badgeId: 'b-first-story', userId: currentUser.id, earnedAt: daysAgo(180), progress: 1 },
  { badgeId: 'b-first-chapter', userId: currentUser.id, earnedAt: daysAgo(182), progress: 1 },
  { badgeId: 'b-first-review', userId: currentUser.id, earnedAt: daysAgo(174), progress: 1 },
  { badgeId: 'b-streak-7', userId: currentUser.id, earnedAt: daysAgo(1), progress: 1 },
  { badgeId: 'b-chapters-100', userId: currentUser.id, earnedAt: daysAgo(96), progress: 1 },
  { badgeId: 'b-rising-author', userId: currentUser.id, earnedAt: daysAgo(42), progress: 1 },
  { badgeId: 'b-nightowl', userId: currentUser.id, earnedAt: daysAgo(9), progress: 1 },
  { badgeId: 'b-popular-writer', userId: currentUser.id, earnedAt: null, progress: 0.64 },
  { badgeId: 'b-club-regular', userId: currentUser.id, earnedAt: null, progress: 0.4 },
  { badgeId: 'b-marathon', userId: currentUser.id, earnedAt: null, progress: 0.57 },
  { badgeId: 'b-challenge-win', userId: currentUser.id, earnedAt: null, progress: 0.2 },
  { badgeId: 'b-critic', userId: currentUser.id, earnedAt: null, progress: 0.72 },
]

/* Challenges ----------------------------------------------------------- */

export const challenges: WritingChallenge[] = [
  {
    id: 'wc-septflash', title: 'September Flash Fiction', slug: 'september-flash-fiction',
    prompt: 'A door that only opens for one person.',
    description: 'One thousand words or fewer. Any genre. The door can be literal, and it is more interesting when it is not. Entries are read blind by three guest authors and the community vote decides the shortlist.',
    hue: 268, state: 'active', startsAt: daysAgo(8), endsAt: daysAhead(6),
    participantCount: 2841, entryCount: 1902, wordTarget: 1000, hostId: 'u-ilse',
  },
  {
    id: 'wc-firstline', title: 'Steal This First Line', slug: 'steal-this-first-line',
    prompt: '"I have been dead for a week and nobody has noticed."',
    description: 'Start with the line exactly as written, then go anywhere. Up to 5,000 words. Last year\'s winner turned it into a novel that has since been read 400,000 times.',
    hue: 6, state: 'active', startsAt: daysAgo(3), endsAt: daysAhead(18),
    participantCount: 1264, entryCount: 613, wordTarget: 5000, hostId: 'u-castellanos',
  },
  {
    id: 'wc-slowromance', title: 'The Slowest Burn', slug: 'the-slowest-burn',
    prompt: 'Two people, one shared task, no confession.',
    description: 'A romance challenge with a rule: nobody may say how they feel. Show it in the work they do together.',
    hue: 342, state: 'active', startsAt: daysAgo(14), endsAt: daysAhead(2),
    participantCount: 3902, entryCount: 2611, wordTarget: 3000, hostId: 'u-adeyemi',
  },
  {
    id: 'wc-octhorror', title: 'Daylight Horror', slug: 'daylight-horror',
    prompt: 'Something is wrong and it is two in the afternoon.',
    description: 'No night scenes. No basements. Make noon frightening.',
    hue: 150, state: 'upcoming', startsAt: daysAhead(9), endsAt: daysAhead(39),
    participantCount: 412, entryCount: 0, wordTarget: 4000, hostId: 'u-lindqvist',
  },
  {
    id: 'wc-worldbuild', title: 'One Map, Many Stories', slug: 'one-map-many-stories',
    prompt: 'Everyone writes in the same invented country.',
    description: 'A shared-setting challenge. The map is published on day one; you claim a region and write it.',
    hue: 96, state: 'upcoming', startsAt: daysAhead(21), endsAt: daysAhead(72),
    participantCount: 188, entryCount: 0, wordTarget: null, hostId: 'u-fairweather',
  },
  {
    id: 'wc-augpoetry', title: 'Thirty Poems, Thirty Days', slug: 'thirty-poems-thirty-days',
    prompt: 'One poem a day for the month.',
    description: 'Completed in August. 1,204 writers finished all thirty days.',
    hue: 224, state: 'completed', startsAt: daysAgo(68), endsAt: daysAgo(38),
    participantCount: 4120, entryCount: 3811, wordTarget: null, hostId: 'u-abadi',
  },
  {
    id: 'wc-junemystery', title: 'The Closed Room', slug: 'the-closed-room',
    prompt: 'A crime with only one possible suspect, who did not do it.',
    description: 'Completed in June. Judged by three crime novelists.',
    hue: 202, state: 'completed', startsAt: daysAgo(120), endsAt: daysAgo(90),
    participantCount: 2210, entryCount: 1640, wordTarget: 6000, hostId: 'u-solano',
  },
]

export const challengeEntries: ChallengeEntry[] = challenges
  .filter((challenge) => challenge.state !== 'upcoming')
  .flatMap((challenge) => {
    const random = seeded(`${challenge.id}-entries`)
    return Array.from({ length: 8 }, (_, index) => ({
      id: `${challenge.id}-e${index}`,
      challengeId: challenge.id,
      userId: (pick(users, random) as User).id,
      storyId: (pick(stories, random) as Story).id,
      submittedAt: daysAgo(between(random, 1, 20)),
      voteCount: 4200 - index * between(random, 180, 420),
      rank: index + 1,
    }))
  })

/* Clubs ---------------------------------------------------------------- */

export const bookClubs: BookClub[] = [
  {
    id: 'bc-northernlights', name: 'Northern Lights Readers', slug: 'northern-lights-readers',
    description: 'Cold-climate fantasy and anything with a map in the front matter. We read one book a month and argue about geography.',
    hue: 268, ownerId: 'u-ilse', memberCount: 12480, currentStoryId: 's-saltglass',
    discussionCount: 942, isPrivate: false, createdAt: daysAgo(620), genreIds: ['g-fantasy', 'g-adventure'],
  },
  {
    id: 'bc-slowburn', name: 'The Slow Burn Society', slug: 'the-slow-burn-society',
    description: 'Romance readers with patience. No spoilers past the current chapter, ever.',
    hue: 342, ownerId: 'u-adeyemi', memberCount: 28910, currentStoryId: 's-lastletter',
    discussionCount: 3120, isPrivate: false, createdAt: daysAgo(830), genreIds: ['g-romance'],
  },
  {
    id: 'bc-redherring', name: 'Red Herring Club', slug: 'red-herring-club',
    description: 'We guess the ending in chapter three and defend it to the death. Mystery and crime, weekly threads.',
    hue: 202, ownerId: 'u-solano', memberCount: 9240, currentStoryId: 's-ninthfloor',
    discussionCount: 1840, isPrivate: false, createdAt: daysAgo(470), genreIds: ['g-mystery', 'g-thriller'],
  },
  {
    id: 'bc-quietfutures', name: 'Quiet Futures', slug: 'quiet-futures',
    description: 'Science fiction without explosions. Repair, maintenance, and the people who stay behind.',
    hue: 190, ownerId: 'u-nakamura', memberCount: 6120, currentStoryId: 's-quietengine',
    discussionCount: 610, isPrivate: false, createdAt: daysAgo(300), genreIds: ['g-scifi'],
  },
  {
    id: 'bc-daylight', name: 'Daylight Horror Support Group', slug: 'daylight-horror-support-group',
    description: 'We read the scary one and then talk about it with the lights on.',
    hue: 150, ownerId: 'u-lindqvist', memberCount: 4310, currentStoryId: 's-noonbell',
    discussionCount: 520, isPrivate: false, createdAt: daysAgo(190), genreIds: ['g-horror'],
  },
  {
    id: 'bc-marginalia', name: 'Marginalia', slug: 'marginalia',
    description: 'A small private club for close reading. One chapter a week, annotated together.',
    hue: 32, ownerId: 'u-okonkwo', memberCount: 240, currentStoryId: 's-ledgerkeepers',
    discussionCount: 1420, isPrivate: true, createdAt: daysAgo(1100), genreIds: ['g-historical', 'g-poetry'],
  },
]

export const clubMemberships: ClubMembership[] = [
  { clubId: 'bc-northernlights', userId: currentUser.id, role: 'member', joinedAt: daysAgo(210) },
  { clubId: 'bc-quietfutures', userId: currentUser.id, role: 'moderator', joinedAt: daysAgo(96) },
  { clubId: 'bc-redherring', userId: currentUser.id, role: 'member', joinedAt: daysAgo(38) },
]

const DISCUSSION_SEEDS: Array<{ title: string; body: string }> = [
  { title: 'Chapter 14 — the keeper\'s ledger', body: 'Did anyone else clock that the names are in the order they were taken, not alphabetical? I went back and checked and it changes the whole timeline.' },
  { title: 'Reading pace for this month', body: 'Proposing four chapters a week so we finish before the challenge starts. Objections?' },
  { title: 'Unpopular opinion about the ending', body: 'I think the ambiguity is a cop-out and I am prepared to be argued out of this.' },
  { title: 'Map thread (spoilers through ch. 9)', body: 'I traced the coastline described in chapter 6 and it does not close. Deliberate?' },
  { title: 'New members — say hello', body: 'Tell us the last thing you read that you could not stop thinking about.' },
]

export const clubDiscussions: ClubDiscussion[] = bookClubs.flatMap((club) => {
  const random = seeded(`${club.id}-threads`)
  return DISCUSSION_SEEDS.map((seed, index) => ({
    id: `${club.id}-d${index}`,
    clubId: club.id,
    userId: (pick(users, random) as User).id,
    title: seed.title,
    body: seed.body,
    createdAt: daysAgo(between(random, 0, 24)),
    replyCount: between(random, 3, 210),
    chapterNumber: index % 2 === 0 ? between(random, 1, 18) : null,
  }))
})

/* Channels ------------------------------------------------------------- */

export const channels: BroadcastChannel[] = [
  {
    id: 'ch-ilse', name: 'Notes from the Coast', slug: 'notes-from-the-coast',
    description: 'Chapter announcements, cut scenes, and the occasional map for readers of The Salt-Glass Coast.',
    authorId: 'u-ilse', subscriberCount: 41200, postCount: 128, createdAt: daysAgo(540),
  },
  {
    id: 'ch-adeyemi', name: 'Kemi, Between Drafts', slug: 'kemi-between-drafts',
    description: 'What I am writing, what I am reading, and why the bakery book took four years.',
    authorId: 'u-adeyemi', subscriberCount: 68900, postCount: 214, createdAt: daysAgo(760),
  },
  {
    id: 'ch-nakamura', name: 'Maintenance Log', slug: 'maintenance-log',
    description: 'Process notes on writing quiet science fiction. Mostly about revision.',
    authorId: 'u-nakamura', subscriberCount: 12400, postCount: 61, createdAt: daysAgo(280),
  },
  {
    id: 'ch-me', name: 'Sunday Pages', slug: 'sunday-pages',
    description: 'My own channel — weekly notes on what I am drafting and what I have been reading.',
    authorId: currentUser.id, subscriberCount: 842, postCount: 19, createdAt: daysAgo(120),
  },
]

export const channelSubscriptions = [
  { channelId: 'ch-ilse', userId: currentUser.id, subscribedAt: daysAgo(200) },
  { channelId: 'ch-nakamura', userId: currentUser.id, subscribedAt: daysAgo(80) },
]

const POST_SEEDS: Array<{ title: string; body: string; linked?: string }> = [
  {
    title: 'Chapter 14 is live',
    body: 'This is the one I have been warning you about. It is also the longest chapter in the book by some margin, so give yourself a proper sitting.\n\nA note on the ledger: everything in it is consistent. If you are the kind of reader who keeps a list, keep going. You are not wrong.',
    linked: 's-saltglass',
  },
  {
    title: 'On writing weather',
    body: 'Somebody asked how I decide what the weather is doing in a scene. The honest answer is that I decide what the scene is doing and then ask what weather would make that harder.\n\nRain is overused. Wind is underused. Cold is the most useful of all because it makes people make bad decisions quickly.',
  },
  {
    title: 'Cut scene: the second walk',
    body: 'This was chapter 9 for about six months. It is a good scene and it was killing the pacing, which is the most annoying combination a scene can be.\n\nPosting it here because you have earned it, and because it will never be canon.',
  },
  {
    title: 'Update schedule for autumn',
    body: 'Thursdays, as usual, with a two-week break in October while I finish the second part. I will post the map before the break.',
  },
]

export const channelPosts: ChannelPost[] = channels.flatMap((channel) => {
  const random = seeded(`${channel.id}-posts`)
  return POST_SEEDS.map((seed, index) => ({
    id: `${channel.id}-p${index}`,
    channelId: channel.id,
    title: seed.title,
    body: seed.body,
    publishedAt: daysAgo(index * between(random, 5, 14) + between(random, 0, 3)),
    likeCount: between(random, 120, 8400),
    commentCount: between(random, 8, 640),
    linkedStoryId: seed.linked ?? null,
  }))
})

/* Author-side aggregates ----------------------------------------------- */

/** Stories written by the signed-in user, used by the author dashboard. */
export const myStoryIds = ['s-glasshour', 's-tidepool']

/** 30 days of view/read counts for the author analytics charts. */
export function viewSeries(storyId: string, days = 30): Array<{ date: string; views: number; reads: number }> {
  const random = seeded(`${storyId}-series`)
  const base = between(random, 400, 1400)

  return Array.from({ length: days }, (_, index) => {
    const drift = Math.sin(index / 4) * base * 0.22
    const noise = (random() - 0.5) * base * 0.3
    const views = Math.max(40, Math.round(base + drift + noise + index * base * 0.02))
    return {
      date: daysAgo(days - 1 - index).slice(0, 10),
      views,
      reads: Math.round(views * (0.42 + random() * 0.16)),
    }
  })
}

export { NOW, daysAgo, daysAhead }
