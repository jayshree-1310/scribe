/**
 * Opening chapters for the catalogue titles.
 *
 * The catalogue used to be shelf-only: a cover, a blurb and a page count, with
 * nothing to open. These give every title a way in, so the reader works
 * wherever a book appears rather than only on stories written on Scribe.
 *
 * Two chapters each — enough to exercise the reader, the chapter list and the
 * prev/next edges without pretending to be a whole novel. Keyed by title;
 * `fetchCatalogue` attaches them, and a title with no entry here simply has no
 * chapters, which the reader already handles.
 *
 * Kept in its own file so the catalogue itself stays readable.
 */

import type { RawChapter } from "./catalogue-source.js";

export const SAMPLE_CHAPTERS: Record<string, RawChapter[]> = {
  "The Salt Cartographers": [
    {
      title: "The coast that would not hold still",
      paragraphs: [
        "The Admiralty chart said the headland lay nine miles north-north-east of the anchorage. Wren had measured it four times in three days and got nine, then eight and a half, then nine again, then eleven.",
        "A coastline is allowed to change. It is not allowed to change back. She wrote both figures in the margin, underlined neither, and understood that she had just made herself into a problem the guild would have to solve or bury.",
      ],
    },
    {
      title: "What the guild pays for",
      paragraphs: [
        "The guild paid surveyors by the mile of finished coast, which meant that in practice it paid for confidence. A man who came back with a clean line was worth twice a woman who came back with a question.",
        "Wren had been the best-paid surveyor in the Reach for two seasons. She spent that afternoon working out how much of the money had been for the drawing and how much for the silence.",
      ],
    },
  ],
  "A Winter Without Maps": [
    {
      title: "South, where the water behaves",
      paragraphs: [
        "In the south the coastlines sit where you leave them. Wren had expected to find this restful and instead found it accusatory, as though every obedient inlet were asking what exactly she thought she had seen up north.",
        "She took rooms above a chandler's and drew nothing for eleven days.",
      ],
    },
    {
      title: "The people, however",
      paragraphs: [
        "It was the third dinner before she understood that everyone at the table already knew about the Reach, and that not one of them intended to be the first to say so.",
        "That was the arrangement in the south. The land told the truth and the people took turns not to.",
      ],
    },
  ],
  "Small Hours in Lisbon": [
    {
      title: "One way",
      paragraphs: [
        "Ada bought the ticket in the airport chapel, which was the only place in Terminal 2 where a woman crying into her phone attracted no attention at all.",
        "The dress was still in the car. She thought about that for most of the flight, and then she thought about the fact that she had not once thought about him.",
      ],
    },
    {
      title: "The apartment above the bakery",
      paragraphs: [
        "The tiles in the hallway were the blue of a cheap postcard and three of them were missing, and the landlady apologised for this twice before Ada could explain that it was the first thing she had liked in a year.",
        "At four in the morning the ovens started and the whole floor smelled of bread, and Ada lay in a stranger's bed in a city she could not pronounce properly, and did not for one moment feel like a person who had run away.",
      ],
    },
  ],
  "The Second Time You Left": [
    {
      title: "Nine years later",
      paragraphs: [
        "This is the last of it, so we may as well start here: the restaurant is closing, the chairs are up on the tables, and neither of them has touched the wine.",
        "You already know they do not leave together. What you do not know yet is which of them offers.",
      ],
    },
    {
      title: "Seven years later",
      paragraphs: [
        "The trouble with a near-miss is that both people file it away as a story about their own restraint.",
        "She told it for years as the night she was sensible. He told it as the night he was too slow. They were describing the same forty minutes at the same corner table.",
      ],
    },
  ],
  "The Long Vacancy": [
    {
      title: "4B",
      paragraphs: [
        "Ordoñez had been superintendent for nineteen years and could tell you what every tenant in the building drank, which of them lied about pets, and the exact week each one had stopped being happy.",
        "He could tell you nothing whatsoever about 4B, and 4B had been paying its bills, on time and in full, for six years.",
      ],
    },
    {
      title: "The wrong question first",
      paragraphs: [
        "Ruiz opened with the question everybody opens with, which is who lives there, and got the answer everybody gets, which is nobody.",
        "It took her another two hours to arrive at the question that mattered: not who lives there, but who is paying, and what they believe they are paying for.",
      ],
    },
  ],
  "Nine Tenths of the Law": [
    {
      title: "A boundary dispute",
      paragraphs: [
        "Ruiz had reached the age where she woke at four whether or not anything was wrong, which meant that by the time the property file landed on her desk she had been awake five hours and was in no mood for a fence.",
        "The fence was not the case. The fence was how the case got in the door.",
      ],
    },
    {
      title: "Missing, then",
      paragraphs: [
        "Two weeks in, the man who had filed the complaint stopped answering, and the woman on the other side of the fence produced a deed with his signature on it, dated after he was last seen alive.",
        "Ruiz looked at that signature for a long time. It was genuinely his. That was the part she could not make fit.",
      ],
    },
  ],
  "Repair Manual for a Dying Star": [
    {
      title: "Work order 4471",
      paragraphs: [
        "The order specified a component we did not carry, in a housing that did not exist, on a deck that had been sealed before any of us were born.",
        "Standard procedure is to log the discrepancy and return the order. Petra logged it, returned it, and then went and stood outside the sealed deck for eleven minutes, which is not standard procedure at all.",
      ],
    },
    {
      title: "Eighty years of shift logs",
      paragraphs: [
        "The logs said the deck had been maintained continuously for thirty-one years and then not at all for forty-nine. Nobody had signed the final entry, and nobody had signed anything since.",
        "Every crew before us had read those same logs and reached the same conclusion: that it was somebody else's discrepancy. We were the first crew small enough that there was no somebody else.",
      ],
    },
  ],
  "Everything We Could Not Fix": [
    {
      title: "The hour after",
      paragraphs: [
        "Every engineer has a story about the hour after, and every one of those stories is quieter than you expect. There is no shouting. Mostly there is paperwork, and somebody making tea that nobody drinks.",
        "This one belongs to a woman called Ines, who signed off a weld on a Tuesday and spent the following eleven years being right about it.",
      ],
    },
    {
      title: "Tolerances",
      paragraphs: [
        "A tolerance is a promise about how wrong a thing is allowed to be. The whole profession rests on the idea that you can name a number and then live inside it.",
        "Ines had named hers. That was the part she could not explain to her sister, who kept asking whether it had been her fault, as though fault were a quantity that came in units.",
      ],
    },
  ],
  "The Ledger of Small Mercies": [
    {
      title: "Two sets of books",
      paragraphs: [
        "The company ledger was leather-bound and lived on the shelf where the agent could see it. The other one was three exercise books in a flour tin, and it was the accurate one.",
        "Abike kept both, in the same hand, and had never once confused them.",
      ],
    },
    {
      title: "What the agent counted",
      paragraphs: [
        "The agent from Liverpool counted crates and was satisfied, because crates are what a man is sent to count.",
        "He did not count the women who filled them, or the arrangement by which four of those women were paid in goods that appeared in no ledger anywhere, and had been for eleven years.",
      ],
    },
  ],
  "What the Harbour Kept": [
    {
      title: "The manifest",
      paragraphs: [
        "Her husband had been dead four months when the shipping office sent, with apologies for the delay, a manifest bearing his name and a sailing date two years after his funeral.",
        "Mrs Arkwright read it in the hall, put on her coat, and walked down to the harbour to ask about it, which the town would later agree was the moment the whole thing became unavoidable.",
      ],
    },
    {
      title: "Forty years of not asking",
      paragraphs: [
        "A port town runs on freight and discretion, and by that winter the discretion was the older of the two industries.",
        "Everyone she spoke to that afternoon was kind, and helpful, and told her a slightly different version of the same lie, which is how she knew it had been agreed in advance.",
      ],
    },
  ],
  Noon: [
    {
      title: "The first thing they tell you",
      paragraphs: [
        "Nothing in this house has ever happened after dark. The Ferrows say it the way other families say the boiler is temperamental, and they say it before they show you your room.",
        "It is true, and that is the difficulty. Everything in this house happens at noon, in full sun, with the curtains open and the children at the table.",
      ],
    },
    {
      title: "Twelve o'clock, Tuesday",
      paragraphs: [
        "At five past twelve Mrs Ferrow began setting a seventh place, and then stopped, and looked at her own hands as though they had been lent to her.",
        "Nobody at that table said a word. That was the rule I had not been told yet: at noon you do not speak, because the house is listening for a voice it recognises.",
      ],
    },
  ],
  "The Guest Book": [
    {
      title: "1971 to 1974",
      paragraphs: [
        "Mr and Mrs H. Calloway, Leeds. Two nights. Purpose of visit: walking. Remarks: very cold, very kind, will return.",
        "The Calloways did not return, and did not sign out, and the register shows their room let again the following Thursday to a man who gave no address and wrote, under remarks, the single word listening.",
      ],
    },
    {
      title: "1974 to 1979",
      paragraphs: [
        "The handwriting in the register changes four times across these years, which the family will later explain as a change of staff.",
        "The ink does not change. Neither does the pressure of the pen, nor the small backward hook on every letter g.",
      ],
    },
  ],
  "Girls Who Count Cards": [
    {
      title: "Rank 412",
      paragraphs: [
        "The ranks go up on Friday at six, printed on green paper, taped to the glass of the admin block where the whole institute walks past on the way to dinner.",
        "Meera was four hundred and twelve out of eight hundred, which is precisely the worst place to be: not low enough to be left alone, not high enough to be forgiven anything.",
      ],
    },
    {
      title: "The arithmetic of a corridor",
      paragraphs: [
        "By the second term she could tell you the rank of every girl on her corridor to within ten places, and she had never once asked. You absorb it. It comes in through the walls.",
        "That was the term she began counting other things: how many of the top fifty had a tutor at home, and how many of the bottom fifty had a job.",
      ],
    },
  ],
  "The Scholarship": [
    {
      title: "Two candidates",
      paragraphs: [
        "There was one place and there were two of them, and the committee had been very clear that the process was open, which is the word people use when a decision has already been taken.",
        "Nikhil knew this. He also knew that being right about it in advance would not get him the place.",
      ],
    },
    {
      title: "The interview",
      paragraphs: [
        "They asked him about leadership and he described a cricket team. They asked her about leadership and she described her mother's shop, and one of the men on the panel wrote something down.",
        "Afterwards they sat in the same corridor on the same bench and were entirely kind to each other, because there was nothing left that kindness could cost either of them.",
      ],
    },
  ],
  "Night Shift Psalms": [
    {
      title: "Two a.m., staff room",
      paragraphs: [
        "The vending machine hums in B flat. I have checked this with the tuning app on my phone, at two in the morning, because there was nothing else left to check.",
        "Somewhere down the corridor a machine is counting a stranger's heart, and here I am timing a vending machine, and both of us are doing the same work.",
      ],
    },
    {
      title: "Four a.m., the window",
      paragraphs: [
        "At four the sky over the car park is the colour of a healing bruise, and the smokers gather by the bins, and the first bird decides it is worth it.",
        "I have written the same poem about this eleven times. This is the eleventh. It is not better than the first, but I am.",
      ],
    },
  ],
  Addendum: [
    {
      title: "Note on the previous poem",
      paragraphs: [
        "Everything the last poem said about my father was true and none of it was fair, which is the difference between a fact and a portrait.",
        "So: an addendum. He did stand in the doorway. He was not deciding whether to come in. He was taking his shoes off, because my mother had asked him to, and he always did.",
      ],
    },
    {
      title: "Second note",
      paragraphs: [
        "Revision is not correction. Nothing gets fixed. The earlier version stays in the book, four pages back, still saying its wrong and beautiful thing.",
        "I keep them both because that is how remembering actually works, and because a collection that printed only the final draft would be lying about the process that made it.",
      ],
    },
  ],
  Overland: [
    {
      title: "Kilometre zero",
      paragraphs: [
        "Three previous expeditions had looked at this route and declined to publish, which we chose to read as modesty rather than as a warning, because we had a truck and a sponsor and eleven weeks.",
        "The truck was called Patience. This was a joke for about four days.",
      ],
    },
    {
      title: "The first thousand",
      paragraphs: [
        "The first thousand kilometres are the ones nobody writes about: good road, cheap fuel, everyone still funny at breakfast.",
        "I am writing about them because it is the only stretch where I can honestly say all four of us wanted the same thing.",
      ],
    },
  ],
  "The Wrong Side of the Weather": [
    {
      title: "The forecast we had",
      paragraphs: [
        "We had a forecast. I want that on the record before anything else: we were not ignorant, we were optimistic, and those two fail in very different ways.",
        "The forecast gave us a thirty-hour window. The window was real. We were four hours late to it, which in winter is not a delay but a different expedition altogether.",
      ],
    },
    {
      title: "Turning back is a skill",
      paragraphs: [
        "Nobody teaches it. Every hour of training is about going on: how to move, how to eat, how to hold a line. Turning back is left to character, which is a poor system.",
        "At the col, three of us wanted to descend and none of us said so, and I have spent six years trying to describe the mechanism by which that happens without sounding like either a coward or a liar.",
      ],
    },
  ],
  "Fourteen Minutes": [
    {
      title: "Zero minutes",
      paragraphs: [
        "The alarm goes at 10:41. Response time in this district, on a Tuesday, in fair weather, is fourteen minutes, and everything in this book happens inside them.",
        "At 10:41 there are nine people in the bank. By 10:55 one of them will have decided something that cannot be undone, and it is not the man with the bag.",
      ],
    },
    {
      title: "Six minutes",
      paragraphs: [
        "Ellery took the call in the car and knew the voice within four words, which is both a professional advantage and a disqualification, and she did not report it.",
        "Six minutes in, she was still deciding whether the thing that made her the right negotiator was the same thing that made her the wrong one.",
      ],
    },
  ],
  "Nobody Reads the Minutes": [
    {
      title: "Item 14(c)",
      paragraphs: [
        "Item 14(c) was a variation to a grounds-maintenance contract, approved unanimously, in a meeting that ran eleven minutes. It appears in the record as a single line.",
        "The line does not balance. It is out by four thousand two hundred pounds, which is too small to be worth stealing and too large to be a typing error, and Vinnie noticed it at ten to five on a Friday.",
      ],
    },
    {
      title: "Item 14(c), continued",
      paragraphs: [
        "The correct thing to do with a discrepancy is to raise it with your line manager, who raises it with the committee, which is the body that approved it.",
        "Vinnie did the correct thing on Monday morning and was thanked for it, warmly, twice, by two different people who had not spoken to each other.",
      ],
    },
  ],
  "The Understudy Kingdom": [
    {
      title: "The double",
      paragraphs: [
        "Every heir is raised beside a double, matched at birth for height and colouring, taught the same eleven languages and the same seventeen dances, so that an assassin never knows which throat to open.",
        "Nobody plans for the assassin succeeding at neither, and the fire taking the wing where both children sleep.",
      ],
    },
    {
      title: "Which one came out",
      paragraphs: [
        "The child who walked out of the west wing had the right hands, the right accent and the right scar, and could name all seventeen dances in order.",
        "She had been raised for exactly this. So had the other one. And there was now nobody left alive with any reason to tell the truth about which was which.",
      ],
    },
  ],
  "Slow Light": [
    {
      title: "The archive remembers",
      paragraphs: [
        "There are four thousand of them and one of me, and I am the only one who remembers rain, because I am the only one who was there.",
        "Remembering, in my case, is a filing operation. I want to be clear that I know the difference between what I hold and what they lived, and that the difference has been getting harder to locate.",
      ],
    },
    {
      title: "Revision one",
      paragraphs: [
        "In the third generation a child asked me what the sea smelled like, and I gave her eleven words, and two of them were wrong.",
        "I corrected the entry afterwards. That was the first time I changed something in the archive that had not changed on Earth, and I did not log it, and I have thought about that omission every day for ninety years.",
      ],
    },
  ],
  "House of Borrowed Names": [
    {
      title: "The commission",
      paragraphs: [
        "In four years Josef had made two hundred and eleven people and met none of them. That was the discipline of the work: a name, a date, a plausible parish, and then nothing, ever, about what became of it.",
        "The commission that arrived in March broke the rule in its first line, because it asked for a boy of nine with his mother's maiden name, and Josef knew the maiden name.",
      ],
    },
    {
      title: "What a document has to survive",
      paragraphs: [
        "A forgery does not have to be perfect. It has to survive one tired official at the end of a long shift, which is a different and much more interesting problem.",
        "He worked six nights on paper that had to be older than the boy, and on the eighth day he understood that finishing it meant going to the address, and that going to the address would finish him.",
      ],
    },
  ],
  "The Quiet Part": [
    {
      title: "Thursday, 11:04 p.m.",
      paragraphs: [
        "The rumour went round the year group in about forty minutes, which is slow for our school, and that was the first sign that people were being careful with it.",
        "By Friday break it had been said out loud four times. By Friday lunch somebody had noticed it was not a rumour at all, because rumours do not contain that much detail about a Tuesday.",
      ],
    },
    {
      title: "Read receipts",
      paragraphs: [
        "There were nineteen of us in that group chat and every one of us had read it. That is the part I keep coming back to, because none of us can claim we did not know.",
        "What we can claim, and what all of us did claim, later, to different adults in different rooms, is that we thought somebody else was dealing with it.",
      ],
    },
  ],
};
