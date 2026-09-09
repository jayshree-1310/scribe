/**
 * Where book records come from.
 *
 * Today that is the hand-written development catalogue at the bottom of this
 * file. The shape above it is deliberately the shape a book API answers with —
 * flat records keyed by natural identifiers (an author handle, genre names)
 * rather than by database ids — so pointing `fetchCatalogue` at a real service
 * is a change to this one function and nothing else. The seed script consumes
 * only `fetchCatalogue`.
 */

export interface RawAuthor {
  /** Natural key. Becomes `auth.User.username`. */
  handle: string;
  bio: string;
}

export interface RawGenre {
  name: string;
  /** Base hue (0-359) the UI composes cover art and chips from. */
  hue: number;
}

export interface RawBook {
  title: string;
  description: string;
  isbn: string;
  publisher: string;
  /** ISO date the edition was published. */
  publishedAt: string;
  pageCount: number;
  authorHandle: string;
  genreNames: string[];
  ratingAverage: number;
  viewCount: number;
  likeCount: number;
  isCompleted: boolean;
  kidsAppropriate: boolean;
}

export interface RawCatalogue {
  authors: RawAuthor[];
  genres: RawGenre[];
  books: RawBook[];
}

/**
 * A stable id for the demo reader the development shelves belong to, so the
 * web app can address a real row before authentication is wired up. Nothing in
 * production depends on it.
 */
export const DEMO_READER_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_READER_USERNAME = "demo_reader";

const GENRES: RawGenre[] = [
  { name: "Fantasy", hue: 268 },
  { name: "Romance", hue: 342 },
  { name: "Mystery", hue: 202 },
  { name: "Thriller", hue: 6 },
  { name: "Science Fiction", hue: 190 },
  { name: "Historical Fiction", hue: 32 },
  { name: "Young Adult", hue: 288 },
  { name: "Horror", hue: 150 },
  { name: "Poetry", hue: 224 },
  { name: "Adventure", hue: 96 },
];

const AUTHORS: RawAuthor[] = [
  {
    handle: "ilse_van_der_meer",
    bio: "Writes cold northern fantasy. Cartographer by training, which explains the maps.",
  },
  {
    handle: "kemi_adeyemi",
    bio: "Romance with sharp edges. Lagos to Lisbon. Tea over coffee, always.",
  },
  {
    handle: "rafael_solano",
    bio: "Detective fiction set in cities that do not sleep because the rent is due.",
  },
  {
    handle: "haru_nakamura",
    bio: "Quiet science fiction about repairing things — machines, mostly people.",
  },
  {
    handle: "amara_okonkwo",
    bio: "Historical fiction, nineteenth century, women who kept the ledgers.",
  },
  {
    handle: "elin_lindqvist",
    bio: "Horror that happens in daylight. Sorry in advance.",
  },
  {
    handle: "priya_mehta",
    bio: "Young adult fiction about ambitious girls and the institutions that underestimate them.",
  },
  {
    handle: "yusuf_abadi",
    bio: "Poems, mostly at night. Occasional essays when the poems refuse.",
  },
  {
    handle: "jo_fairweather",
    bio: "Adventure serials. I have fallen off most things worth falling off.",
  },
  {
    handle: "lucia_castellanos",
    bio: "Thrillers with short chapters, because you have a train to catch.",
  },
];

const BOOKS: RawBook[] = [
  {
    title: "The Salt Cartographers",
    description:
      "Every map of the Northern Reach is wrong, and Wren Halloway is the only surveyor who knows why. Sent to redraw a coastline that will not hold still, she finds a guild that has been quietly editing the world for four hundred years — and a mother's signature on the oldest forgery of all.",
    isbn: "9781974300112",
    publisher: "Northwind House",
    publishedAt: "2023-03-14",
    pageCount: 512,
    authorHandle: "ilse_van_der_meer",
    genreNames: ["Fantasy", "Adventure"],
    ratingAverage: 4.6,
    viewCount: 184320,
    likeCount: 12480,
    isCompleted: true,
    kidsAppropriate: false,
  },
  {
    title: "A Winter Without Maps",
    description:
      "The sequel nobody in the guild wanted written. Wren goes south, where the coastlines behave and the people do not, and learns that a country can be forged as easily as a chart.",
    isbn: "9781974300129",
    publisher: "Northwind House",
    publishedAt: "2024-10-01",
    pageCount: 486,
    authorHandle: "ilse_van_der_meer",
    genreNames: ["Fantasy"],
    ratingAverage: 4.4,
    viewCount: 96140,
    likeCount: 8210,
    isCompleted: false,
    kidsAppropriate: false,
  },
  {
    title: "Small Hours in Lisbon",
    description:
      "Ada books a one-way flight to escape a wedding — her own. What she finds is a tiled apartment above a bakery, a landlord who will not explain the piano, and eleven months in which to decide whether running away counts as arriving.",
    isbn: "9781974300136",
    publisher: "Meridian Press",
    publishedAt: "2022-06-07",
    pageCount: 344,
    authorHandle: "kemi_adeyemi",
    genreNames: ["Romance"],
    ratingAverage: 4.5,
    viewCount: 221800,
    likeCount: 19640,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "The Second Time You Left",
    description:
      "Two people, one restaurant, nine years of near-misses. Told backwards, so you know how it ends before you know why it had to.",
    isbn: "9781974300143",
    publisher: "Meridian Press",
    publishedAt: "2024-02-13",
    pageCount: 298,
    authorHandle: "kemi_adeyemi",
    genreNames: ["Romance", "Historical Fiction"],
    ratingAverage: 4.2,
    viewCount: 132400,
    likeCount: 10980,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "The Long Vacancy",
    description:
      "A building superintendent with a photographic memory for tenants. An apartment that has been empty for six years and is still paying its bills. Detective Ruiz has eleven days before the lease renews and the file closes itself.",
    isbn: "9781974300150",
    publisher: "Blackline Books",
    publishedAt: "2021-09-30",
    pageCount: 402,
    authorHandle: "rafael_solano",
    genreNames: ["Mystery", "Thriller"],
    ratingAverage: 4.7,
    viewCount: 268900,
    likeCount: 24310,
    isCompleted: true,
    kidsAppropriate: false,
  },
  {
    title: "Nine Tenths of the Law",
    description:
      "Ruiz returns, older and worse at sleeping. A property dispute becomes a missing-persons case becomes something the department would very much like him to stop pulling on.",
    isbn: "9781974300167",
    publisher: "Blackline Books",
    publishedAt: "2023-11-21",
    pageCount: 438,
    authorHandle: "rafael_solano",
    genreNames: ["Mystery"],
    ratingAverage: 4.3,
    viewCount: 141220,
    likeCount: 11760,
    isCompleted: true,
    kidsAppropriate: false,
  },
  {
    title: "Repair Manual for a Dying Star",
    description:
      "The maintenance crew of a solar collector three light-minutes from home receive a work order for a component that does not exist. Eighty years of shift logs suggest it did, once, and that somebody has been very carefully unremembering it.",
    isbn: "9781974300174",
    publisher: "Orbital Editions",
    publishedAt: "2022-01-18",
    pageCount: 376,
    authorHandle: "haru_nakamura",
    genreNames: ["Science Fiction"],
    ratingAverage: 4.8,
    viewCount: 312450,
    likeCount: 29880,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "Everything We Could Not Fix",
    description:
      "Six linked stories about engineers, each set in the hour after something breaks for good. Quiet, precise, and entirely uninterested in heroics.",
    isbn: "9781974300181",
    publisher: "Orbital Editions",
    publishedAt: "2024-05-09",
    pageCount: 244,
    authorHandle: "haru_nakamura",
    genreNames: ["Science Fiction", "Poetry"],
    ratingAverage: 4.4,
    viewCount: 88600,
    likeCount: 9420,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "The Ledger of Small Mercies",
    description:
      "Lagos, 1868. A trading house keeps two sets of books: one for the company, one for the women who actually run it. When an auditor arrives from Liverpool, Adaeze has three weeks to make the second set disappear — or make it matter.",
    isbn: "9781974300198",
    publisher: "Harrow & Vale",
    publishedAt: "2020-04-02",
    pageCount: 528,
    authorHandle: "amara_okonkwo",
    genreNames: ["Historical Fiction"],
    ratingAverage: 4.6,
    viewCount: 176300,
    likeCount: 15870,
    isCompleted: true,
    kidsAppropriate: false,
  },
  {
    title: "What the Harbour Kept",
    description:
      "A widow, a shipping manifest, and forty years of a port town agreeing not to ask. Historical fiction that reads like a slow tide coming in.",
    isbn: "9781974300204",
    publisher: "Harrow & Vale",
    publishedAt: "2023-08-17",
    pageCount: 460,
    authorHandle: "amara_okonkwo",
    genreNames: ["Historical Fiction", "Mystery"],
    ratingAverage: 4.1,
    viewCount: 74180,
    likeCount: 6240,
    isCompleted: false,
    kidsAppropriate: false,
  },
  {
    title: "Noon",
    description:
      "Nothing in this house has ever happened after dark. That is the first thing the Ferrow family tells you, and the last thing you will find comforting about it.",
    isbn: "9781974300211",
    publisher: "Pale Light Press",
    publishedAt: "2021-10-29",
    pageCount: 288,
    authorHandle: "elin_lindqvist",
    genreNames: ["Horror"],
    ratingAverage: 4.5,
    viewCount: 204770,
    likeCount: 18930,
    isCompleted: true,
    kidsAppropriate: false,
  },
  {
    title: "The Guest Book",
    description:
      "A rural inn where every visitor signs in and nobody signs out. Told entirely through the register, in twenty-two hands, over a hundred and four years.",
    isbn: "9781974300228",
    publisher: "Pale Light Press",
    publishedAt: "2024-08-30",
    pageCount: 216,
    authorHandle: "elin_lindqvist",
    genreNames: ["Horror", "Mystery"],
    ratingAverage: 4.3,
    viewCount: 119050,
    likeCount: 12210,
    isCompleted: true,
    kidsAppropriate: false,
  },
  {
    title: "Girls Who Count Cards",
    description:
      "Ravi Institute takes the top eight hundred students in the country and ranks them weekly. Meera is four hundred and twelfth, and she has worked out that the ranking is the only thing the school cannot afford to have questioned.",
    isbn: "9781974300235",
    publisher: "Fieldstone Young",
    publishedAt: "2022-08-23",
    pageCount: 368,
    authorHandle: "priya_mehta",
    genreNames: ["Young Adult", "Thriller"],
    ratingAverage: 4.7,
    viewCount: 289340,
    likeCount: 31200,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "The Scholarship",
    description:
      "One place, two candidates, and a selection committee that has already decided. A companion novel about what ambition costs when the bill arrives early.",
    isbn: "9781974300242",
    publisher: "Fieldstone Young",
    publishedAt: "2025-01-14",
    pageCount: 322,
    authorHandle: "priya_mehta",
    genreNames: ["Young Adult"],
    ratingAverage: 4.2,
    viewCount: 98720,
    likeCount: 11440,
    isCompleted: false,
    kidsAppropriate: true,
  },
  {
    title: "Night Shift Psalms",
    description:
      "Forty poems written between two and five in the morning, mostly in the staff room of a hospital that has since been demolished.",
    isbn: "9781974300259",
    publisher: "Quarter Tone",
    publishedAt: "2021-05-11",
    pageCount: 96,
    authorHandle: "yusuf_abadi",
    genreNames: ["Poetry"],
    ratingAverage: 4.4,
    viewCount: 61900,
    likeCount: 8870,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "Addendum",
    description:
      "Poems that argue with the poems before them. A short, restless collection about revision as a way of living.",
    isbn: "9781974300266",
    publisher: "Quarter Tone",
    publishedAt: "2024-11-05",
    pageCount: 84,
    authorHandle: "yusuf_abadi",
    genreNames: ["Poetry"],
    ratingAverage: 4.0,
    viewCount: 34210,
    likeCount: 4130,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "Overland",
    description:
      "Four thousand kilometres, one unreliable truck, and a route that three previous expeditions have declined to publish. An account of the crossing, and of the argument that nearly ended it on day nine.",
    isbn: "9781974300273",
    publisher: "Compass Rose",
    publishedAt: "2020-11-19",
    pageCount: 412,
    authorHandle: "jo_fairweather",
    genreNames: ["Adventure"],
    ratingAverage: 4.5,
    viewCount: 158640,
    likeCount: 14020,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "The Wrong Side of the Weather",
    description:
      "A winter traverse attempted by people who should have turned back, told with an honesty that makes the good decisions look accidental.",
    isbn: "9781974300280",
    publisher: "Compass Rose",
    publishedAt: "2023-02-28",
    pageCount: 356,
    authorHandle: "jo_fairweather",
    genreNames: ["Adventure", "Thriller"],
    ratingAverage: 4.3,
    viewCount: 102380,
    likeCount: 9160,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "Fourteen Minutes",
    description:
      "The gap between the alarm and the response. A bank, a hostage who is not one, and a negotiator who recognises the voice on the phone.",
    isbn: "9781974300297",
    publisher: "Blackline Books",
    publishedAt: "2022-03-08",
    pageCount: 334,
    authorHandle: "lucia_castellanos",
    genreNames: ["Thriller"],
    ratingAverage: 4.6,
    viewCount: 243110,
    likeCount: 22540,
    isCompleted: true,
    kidsAppropriate: false,
  },
  {
    title: "Nobody Reads the Minutes",
    description:
      "A city council clerk notices a line item that should not balance. Ninety-one short chapters later, neither does the city.",
    isbn: "9781974300303",
    publisher: "Blackline Books",
    publishedAt: "2024-09-12",
    pageCount: 380,
    authorHandle: "lucia_castellanos",
    genreNames: ["Thriller", "Mystery"],
    ratingAverage: 4.4,
    viewCount: 137960,
    likeCount: 13380,
    isCompleted: false,
    kidsAppropriate: false,
  },
  {
    title: "The Understudy Kingdom",
    description:
      "Every royal heir is raised alongside a double. When the palace burns, the survivor has to decide which of the two she actually is — and whether the answer changes what she owes the country.",
    isbn: "9781974300310",
    publisher: "Northwind House",
    publishedAt: "2021-07-15",
    pageCount: 544,
    authorHandle: "ilse_van_der_meer",
    genreNames: ["Fantasy", "Young Adult"],
    ratingAverage: 4.2,
    viewCount: 129470,
    likeCount: 11930,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "Slow Light",
    description:
      "A generation ship where the archive is the only crew member who remembers Earth, and it has started editing. Told across three shifts, four hundred years apart.",
    isbn: "9781974300327",
    publisher: "Orbital Editions",
    publishedAt: "2020-09-03",
    pageCount: 468,
    authorHandle: "haru_nakamura",
    genreNames: ["Science Fiction", "Mystery"],
    ratingAverage: 4.5,
    viewCount: 197830,
    likeCount: 17650,
    isCompleted: true,
    kidsAppropriate: true,
  },
  {
    title: "House of Borrowed Names",
    description:
      "Vienna, 1938. A forger who has never met the people he saves, and the one commission he cannot complete without meeting her.",
    isbn: "9781974300334",
    publisher: "Harrow & Vale",
    publishedAt: "2019-10-08",
    pageCount: 496,
    authorHandle: "amara_okonkwo",
    genreNames: ["Historical Fiction", "Romance"],
    ratingAverage: 4.7,
    viewCount: 254600,
    likeCount: 23870,
    isCompleted: true,
    kidsAppropriate: false,
  },
  {
    title: "The Quiet Part",
    description:
      "A boarding school, a group chat, and a rumour that turns out to be a confession. Young adult fiction with no villains and no easy exits.",
    isbn: "9781974300341",
    publisher: "Fieldstone Young",
    publishedAt: "2023-06-20",
    pageCount: 302,
    authorHandle: "priya_mehta",
    genreNames: ["Young Adult", "Mystery"],
    ratingAverage: 4.1,
    viewCount: 84550,
    likeCount: 8940,
    isCompleted: true,
    kidsAppropriate: true,
  },
];

/**
 * Returns the full catalogue to import.
 *
 * Replace the body with a call to a real book API — keeping the `RawCatalogue`
 * shape — and the seed script keeps working unchanged.
 */
export function fetchCatalogue(): Promise<RawCatalogue> {
  return Promise.resolve({ authors: AUTHORS, genres: GENRES, books: BOOKS });
}
