import type { StoryFact } from '../data/ai-api'

/**
 * The story bible's facts, grouped by who or what they are about.
 *
 * Grouping by the subject as written split one person in two: chapter one
 * calls her "Mira Desai", chapter three "Mira", and the model files each under
 * the name in front of it. So a person's shorter name joins their fuller one —
 * but only under three conditions, each a way the obvious merge goes wrong:
 *
 * - **Every word of the shorter name is in the longer.** "Mira" joins "Mira
 *   Desai"; "Mira Das" does not. Courtesy words ("Dr", "Aunt", "the") are not
 *   counted, so "Dr Mira Desai" and "Mira Desai" are one person too.
 * - **Only one fuller name qualifies.** With both Mira Desai and Ravi Desai in
 *   the cast, a fact filed under "Desai" could be either, so it stays where it
 *   was filed rather than being given to one of them.
 * - **Into a person only.** The fuller name must have character or
 *   relationship facts, and a name with any place facts never moves. "The
 *   lamp" and "the Lamp Room" share a word and are different things; but
 *   "Mira" with only an event filed under it ("lit the lamp") is still Mira.
 *
 * The facts themselves are untouched: this is how the page shows them, and
 * each fact still says the name it was filed under when it is corrected.
 */

/** Mirrors `TITLE_WORDS` in the API's `bible-facts.ts`. */
const COURTESY_WORDS = new Set(
  (
    'the a an old young little big mr mrs ms miss dr doctor sir lady lord ' +
    'captain king queen prince princess aunt uncle father mother brother ' +
    'sister saint st mount lake river'
  ).split(' '),
)

const PERSON_KINDS = new Set<StoryFact['kind']>(['character', 'relationship'])

export interface SubjectGroup {
  /** The fullest name the group goes by. */
  name: string
  /** The other names its facts were filed under, if any. */
  aliases: string[]
  facts: StoryFact[]
}

function wordsOf(name: string): Set<string> {
  return new Set(
    (name.toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? []).filter(
      (word) => word.length >= 3 && !COURTESY_WORDS.has(word),
    ),
  )
}

const containsAll = (outer: Set<string>, inner: Set<string>) =>
  [...inner].every((word) => outer.has(word))

const keyOf = (words: Set<string>) => [...words].sort().join(' ')

/**
 * Groups `facts` by subject, merging a person's names as described above.
 * `show` filters what each group lists; a group left with nothing is dropped,
 * but the merge is decided on every fact, so a filter cannot change who is who.
 */
export function groupBySubject(
  facts: readonly StoryFact[],
  show: (fact: StoryFact) => boolean = () => true,
): SubjectGroup[] {
  const names = new Map<string, StoryFact[]>()
  for (const fact of facts) {
    const list = names.get(fact.subject) ?? []
    list.push(fact)
    names.set(fact.subject, list)
  }

  /** Names that can be joined to: people. */
  const people = [...names.keys()].filter((name) =>
    names.get(name)!.some((fact) => PERSON_KINDS.has(fact.kind)),
  )
  /** Names that may join one: anything that is not, even partly, a place. */
  const movable = new Set(
    [...names.keys()].filter((name) =>
      names.get(name)!.every((fact) => fact.kind !== 'location'),
    ),
  )
  const words = new Map([...names.keys()].map((name) => [name, wordsOf(name)]))

  /** The group a name belongs to: a person's fullest unambiguous name, or itself. */
  const groupKey = (name: string): string => {
    const own = words.get(name)!
    if (!movable.has(name) || own.size === 0) return `name:${name}`

    // Every person whose name holds all of this one's words, this one too.
    const holding = [...new Set([...people, name])]
      .map((other) => words.get(other)!)
      .filter((other) => containsAll(other, own))
    // The fullest of those: the ones no other holding name strictly contains.
    const fullest = new Set(
      holding
        .filter(
          (set) =>
            !holding.some((other) => other.size > set.size && containsAll(other, set)),
        )
        .map(keyOf),
    )
    return fullest.size === 1 ? `person:${[...fullest][0]}` : `name:${name}`
  }

  const groups = new Map<string, { names: string[]; facts: StoryFact[] }>()
  for (const [name, list] of names) {
    const key = groupKey(name)
    const group = groups.get(key) ?? { names: [], facts: [] }
    group.names.push(name)
    group.facts.push(...list.filter(show))
    groups.set(key, group)
  }

  return [...groups.values()]
    .filter((group) => group.facts.length > 0)
    .map((group) => {
      const [name, ...aliases] = [...group.names].sort(
        (a, b) => b.length - a.length || a.localeCompare(b),
      )
      return { name: name!, aliases: aliases.sort((a, b) => a.localeCompare(b)), facts: group.facts }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
