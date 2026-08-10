import { describe, expect, it } from 'vitest'
import { extractQuotedList, readTracked, splitAvoidNotes } from './docs'

const spec = readTracked('docs/partner-ledger-spec.md')
const backend = readTracked('apps-script/Code.gs')

/**
 * The eight sections the wayfinder map locked, in map order. Titles only —
 * a heading may carry a trailing ticket link, which is provenance rather
 * than structure.
 */
const SECTIONS = [
  'What this is',
  'Data model',
  'Split semantics',
  'Identity & access',
  'Payables & settlement',
  'Bootstrap',
  'UI — winning prototype variants',
  'Prior art',
]

/**
 * The 帳目 columns, read off the backend that writes them rather than
 * restated here, so the spec's table cannot drift from the sheet.
 */
const ENTRY_COLUMNS = extractQuotedList(
  backend,
  /var ENTRY_HEADERS = \[([^\]]*)\]/,
)

/** Every distinct 來源 the backend stamps on a row it writes. */
const SOURCE_STAMPS = [
  ...new Set(
    [...backend.matchAll(/source: '([^']+)'/g)].flatMap(match =>
      match[1] === undefined ? [] : [match[1]],
    ),
  ),
]

/**
 * The live split vocabulary, read off the validator that enforces it. A copy
 * here would drift along with the spec instead of catching it.
 */
const CURRENT_SPLITS = extractQuotedList(
  readTracked('functions/lib/validate.ts'),
  /const SPLITS = new Set\(\[([^\]]*)\]\)/,
)

/**
 * Retired by 7826a3f — the same commit that clobbered this spec. A spec
 * still carrying them is a spec restored from before the rename.
 */
const RETIRED_SPLITS = ['均分', '全額對方', '全額自己']

const { defining: contextDefining, avoiding: contextAvoiding } =
  splitAvoidNotes(readTracked('CONTEXT.md'))

/**
 * Every term CONTEXT.md defines, taken from its bold headwords. Multi-word
 * bold emphasis is not a headword, and a term with no CJK in it is advice
 * about wording rather than a term of the domain.
 */
const DEFINED_TERMS = [...contextDefining.matchAll(/\*\*([^*]+?)\*\*/g)]
  .map(match => (match[1] ?? '').split(' (')[0]?.trim() ?? '')
  .filter(term => /[一-鿿]/.test(term) && !/[ ,]/.test(term))

/**
 * Terms CONTEXT.md retires: named in an `_Avoid_:` note and defined nowhere.
 * A note may also mention live terms in passing — 沖銷 appears in 結清's note
 * to tell the two apart — so being defined is what rules a term back in.
 */
const RETIRED_TERMS = [
  ...new Set(
    [...contextAvoiding.matchAll(/[一-鿿]+/g)].map(match => match[0]),
  ),
].filter(term => !DEFINED_TERMS.includes(term))

/**
 * Whether `text` uses `term` in its own right. A retired term can be a
 * substring of a live one — 對象 inside 交易對象 — so the live terms that
 * contain it are struck out before looking.
 */
function uses(text: string, term: string): boolean {
  const masked = DEFINED_TERMS.filter(
    defined => defined !== term && defined.includes(term),
  ).reduce((stripped, defined) => stripped.split(defined).join(''), text)

  return masked.includes(term)
}

function sectionTitles(doc: string): string[] {
  return [...doc.matchAll(/^## \d+\. (.+)$/gm)].map(
    match => (match[1] ?? '').split(' — [ticket')[0]?.trim() ?? '',
  )
}

function section(doc: string, number: number): string {
  const heading = new RegExp(`^## ${number}\\. `, 'm').exec(doc)
  if (heading === null) throw new Error(`no section ${number}`)
  const rest = doc.slice(heading.index)
  const next = /\n## /.exec(rest)
  return next === null ? rest : rest.slice(0, next.index)
}

/** A Markdown table's data rows, with the header row and its rule dropped. */
function tableRows(markdown: string): string[][] {
  return [...markdown.matchAll(/^\|(.+)\|$/gm)]
    .map(match => (match[1] ?? '').split('|').map(cell => cell.trim()))
    .filter(cells => !cells.every(cell => /^-+$/.test(cell)))
    .slice(1)
}

const dataModel = new Map(
  tableRows(section(spec, 2)).map(
    ([column = '', meaning = '']) => [column, meaning] as const,
  ),
)

/** The spec's own prose, with its `_Avoid_:` notes held apart from it. */
const { defining } = splitAvoidNotes(spec)

describe('the build spec', () => {
  it('carries its eight numbered sections in map order', () => {
    // The clobber that emptied this file was visible as a numbering gap: the
    // first surviving heading was `## 3.`, sections 1 and 2 having been
    // overwritten by test source.
    expect(sectionTitles(spec)).toEqual(SECTIONS)
  })
})

describe('the build spec data model', () => {
  it('reads the 帳目 columns off the backend', () => {
    // An empty extraction would leave the ordering check below vacuous.
    expect(ENTRY_COLUMNS).toHaveLength(10)
  })

  it('lists every 帳目 column, in sheet order', () => {
    expect([...dataModel.keys()]).toEqual(ENTRY_COLUMNS)
  })

  it('reads a single 來源 stamp off the backend', () => {
    expect(SOURCE_STAMPS).toHaveLength(1)
  })

  it('gives 來源 the stamp the backend writes, plus the hand marker', () => {
    // The stamp was renamed pwa -> web-app in ba2b915; a spec restated by
    // hand is exactly what failed to follow.
    expect(dataModel.get('來源')).toBe(`${SOURCE_STAMPS[0]} / 手動`)
  })
})

describe('the build spec 分攤方式 vocabulary', () => {
  it('reads three split terms off the validator', () => {
    // Guards the extraction: an empty list would make every case below pass
    // without asserting anything.
    expect(CURRENT_SPLITS).toHaveLength(3)
  })

  it.each(CURRENT_SPLITS)('spells out %s', term => {
    expect(defining).toContain(term)
  })

  it.each(RETIRED_SPLITS)('carries %s nowhere in its prose', term => {
    expect(defining).not.toContain(term)
  })
})

describe('the build spec against the glossary', () => {
  it('finds the terms CONTEXT.md retires', () => {
    // Both guards keep the check below from passing vacuously: no retired
    // terms means nothing is asserted, and no defined terms means the
    // masking in `uses` has no teeth.
    expect(RETIRED_TERMS.length).toBeGreaterThan(0)
    expect(DEFINED_TERMS).toContain('交易對象')
  })

  it.each(RETIRED_TERMS)('does not write in %s', term => {
    expect(uses(defining, term)).toBe(false)
  })
})
