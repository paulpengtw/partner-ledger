import { describe, expect, it } from 'vitest'
import { extractQuotedList, readTracked, splitAvoidNotes } from './docs'

const { defining, avoiding } = splitAvoidNotes(readTracked('CONTEXT.md'))

/**
 * The live vocabulary, read off the validator rather than restated here. A
 * copy in this file would drift with the doc instead of catching it.
 */
const CURRENT_SPLITS = extractQuotedList(
  readTracked('functions/lib/validate.ts'),
  /const SPLITS = new Set\(\[([^\]]*)\]\)/,
)

/**
 * Retired in 7826a3f, which renamed the split vocabulary. Taken from the
 * pre-clobber CONTEXT.md at c16f62f, where these three were the definitions.
 * The commit that renamed them is also the one that clobbered this doc, so a
 * doc carrying them is a doc restored from before the rename.
 */
const RETIRED_SPLITS = ['均分', '全額對方', '全額自己']

describe('CONTEXT.md 分攤方式 vocabulary', () => {
  it('reads three split terms off the validator', () => {
    // Guards the extraction: an empty list would make every case below pass
    // without asserting anything.
    expect(CURRENT_SPLITS).toHaveLength(3)
  })

  it.each(CURRENT_SPLITS)('defines %s', term => {
    expect(defining).toContain(term)
  })

  it.each(RETIRED_SPLITS)('carries %s only as a term to avoid', term => {
    expect(defining).not.toContain(term)
  })

  it('records the retired spellings rather than dropping them silently', () => {
    // The _Avoid_ notes are how a reader who meets an old term in the sheet
    // finds out it is dead.
    for (const term of RETIRED_SPLITS) expect(avoiding).toContain(term)
  })
})
