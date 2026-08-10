import { describe, expect, it } from 'vitest'
import {
  closestTrackedFile,
  listMarkdownDocs,
  readTracked,
  significantLines,
} from './docs'

const docs = listMarkdownDocs()

/**
 * A wholesale clobber leaves a doc that is a near-verbatim copy of some other
 * file in the tree: CONTEXT.md was 904 lines of src/main.ts this way, and
 * nothing in the suite noticed. Below 1.0 because the observed clobbers came
 * back with a handful of characters changed.
 */
const NEAR_COPY = 0.9

/**
 * Docs that are known to be clobbered, mapped to the issue that reconstructs
 * each one. A quarantined doc is exempt from the shape guard, and only from
 * that one. Nothing may be parked here quietly: the guards below fail if an
 * entry names a doc that no longer exists, omits its issue, or outlives the
 * defect it was opened for.
 */
const QUARANTINE = new Map([
  [
    'docs/partner-ledger-spec.md',
    'https://github.com/paulpengtw/partner-ledger/issues/7',
  ],
])

function opensAsMarkdown(path: string): boolean {
  const [opening = ''] = significantLines(readTracked(path))
  return /^# \S/.test(opening)
}

describe('tracked Markdown docs', () => {
  it('discovers the docs on disk', () => {
    // An empty list must fail here rather than let the guards below pass
    // vacuously with nothing to check.
    expect(docs.length).toBeGreaterThan(0)
  })

  it.each(docs)(
    '%s is not a near-verbatim copy of another tracked file',
    path => {
      const closest = closestTrackedFile(path)

      expect(closest.ratio >= NEAR_COPY ? closest.path : null).toBeNull()
    },
  )

  it.each(docs.filter(path => !QUARANTINE.has(path)))(
    '%s opens as a Markdown document, not as source',
    path => {
      // A second, independent net. The copy check above only catches a doc
      // replaced by one file wholesale; a doc spliced together from two of
      // them lands under the threshold and walks straight past it.
      expect(opensAsMarkdown(path)).toBe(true)
    },
  )
})

describe('the doc quarantine', () => {
  it('names a tracked doc and the issue that clears it', () => {
    for (const [path, issue] of QUARANTINE) {
      expect(docs).toContain(path)
      expect(issue).toMatch(
        /^https:\/\/github\.com\/paulpengtw\/partner-ledger\/issues\/\d+$/,
      )
    }
  })

  it('holds nothing that has since been fixed', () => {
    // Reconstructing a quarantined doc must fail here, so whoever fixes it is
    // told to drop the entry rather than leaving the doc exempt forever.
    expect([...QUARANTINE.keys()].filter(opensAsMarkdown)).toEqual([])
  })
})
