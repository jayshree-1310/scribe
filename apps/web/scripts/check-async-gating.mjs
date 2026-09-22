#!/usr/bin/env node
/**
 * Fails when a page reads an async result's `data` without ever consulting its
 * `status`.
 *
 * **The bug this exists to stop.** Under the old mock layer nothing ever
 * failed and everything answered in about 260ms, so "the list is empty", "the
 * list has not arrived" and "the list failed" were one condition, and a lot of
 * code was written that way. Task 17's audit found six surfaces doing it --
 * covers that pulsed forever on a failure, a story picker that submitted an
 * empty id, a genre picker that blocked a writer with nothing to pick -- and
 * fixed them by reading `status` first. That audit was done by reading, so it
 * proved neither that the list was complete nor that the next page would not
 * do it again.
 *
 * This is the part that can be checked mechanically: a `useAsync` result whose
 * `status` is never mentioned in the file it lives in cannot be distinguishing
 * the three cases, whatever it does with `data`. It is a coarse rule on
 * purpose -- it says nothing about *where* the check is or whether the
 * branches are right, only that somebody looked. Getting the branches right is
 * still a review question.
 *
 * Run by `pnpm --filter web lint`, so it fails in the same place ESLint does
 * rather than in a test suite this workspace does not have.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/**
 * Results that are deliberately never gated, with the reason.
 *
 * An entry here is a claim that the three cases genuinely are one for that
 * value -- not that checking was inconvenient.
 */
const ALLOWED = new Map([
  [
    'ClubsPage.tsx:mine',
    'drives a tab count only. Zero while loading and zero on failure read the ' +
      'same as zero clubs, and a badge has no skeleton to leave spinning.',
  ],
  [
    'LandingPage.tsx:trending',
    'decorative cover art in the marketing hero. The layout holds with none, ' +
      'and the page has nothing to tell a signed-out visitor about a failed ' +
      'request for ornament.',
  ],
  [
    'IdeaStudioPage.tsx:stories',
    'KNOWN GAP, not an exemption: this is a story picker, the same shape as ' +
      'the challenge entry dialog Task 17 fixed, and an empty one can submit ' +
      'an empty id. Parked rather than fixed because the file is being ' +
      'written by the in-flight GenAI work and editing it here would conflict. ' +
      'Remove this entry when that lands.',
  ],
])

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory()
      ? walk(full)
      : /\.tsx?$/.test(entry)
        ? [full]
        : []
  })
}

const failures = []

for (const file of walk(SRC)) {
  const source = readFileSync(file, 'utf8')
  const relative = path.relative(SRC, file)

  // `const x = useAsync(` — the only way an AsyncState is produced.
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*useAsync\b/g)) {
    const name = match[1]
    const key = `${path.basename(file)}:${name}`
    if (ALLOWED.has(key)) continue

    const usesData = new RegExp(`\\b${name}\\.data\\b`).test(source)
    const usesStatus = new RegExp(`\\b${name}\\.status\\b`).test(source)

    if (usesData && !usesStatus) {
      failures.push(`${relative}: \`${name}\` reads .data but never .status`)
    }
  }
}

if (failures.length > 0) {
  console.error(
    '\nAsync results read without checking how they arrived:\n\n' +
      failures.map((line) => `  ${line}`).join('\n') +
      '\n\nAn empty list, a list still loading and a list that failed are three\n' +
      'different things. Branch on `.status` before using `.data`, or record the\n' +
      'exception in ALLOWED in scripts/check-async-gating.mjs with its reason.\n',
  )
  process.exit(1)
}

console.log(`async gating: ${'ok'}`)
