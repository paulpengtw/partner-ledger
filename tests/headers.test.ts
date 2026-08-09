import { describe, expect, it } from 'vitest'
import { loadEntryFunctions } from './helpers/gas'

const { ENTRY_HEADERS, resolveHeaders_ } = loadEntryFunctions()

const canonicalHeaderRow = [
  'txn_id',
  '日期',
  '金額',
  '付款人',
  '分攤方式',
  '分類',
  '交易對象',
  '記帳人',
  '來源',
  '沖銷txn_id',
]

const canonicalResolution = {
  txn_id: 1,
  日期: 2,
  金額: 3,
  付款人: 4,
  分攤方式: 5,
  分類: 6,
  交易對象: 7,
  記帳人: 8,
  來源: 9,
  沖銷txn_id: 10,
}

describe('resolveHeaders_', () => {
  it('resolves every canonical entry header to its 1-based column index', () => {
    expect(ENTRY_HEADERS).toEqual(canonicalHeaderRow)
    expect(resolveHeaders_(canonicalHeaderRow, ENTRY_HEADERS)).toEqual(canonicalResolution)
  })

  it('resolves every required header after the columns are reordered', () => {
    const reordered = [
      '沖銷txn_id',
      '金額',
      '日期',
      '記帳人',
      '來源',
      '分類',
      '分攤方式',
      '付款人',
      '交易對象',
      'txn_id',
    ]

    expect(resolveHeaders_(reordered, canonicalHeaderRow)).toEqual({
      沖銷txn_id: 1,
      金額: 2,
      日期: 3,
      記帳人: 4,
      來源: 5,
      分類: 6,
      分攤方式: 7,
      付款人: 8,
      交易對象: 9,
      txn_id: 10,
    })
  })

  it('ignores extra columns inserted at the start, middle, and end', () => {
    const withExtras = [
      '備註',
      'txn_id',
      '日期',
      '金額',
      '付款人',
      '匯率',
      '分攤方式',
      '分類',
      '交易對象',
      '記帳人',
      '來源',
      '沖銷txn_id',
      '收據',
      '',
      '   ',
    ]

    expect(resolveHeaders_(withExtras, canonicalHeaderRow)).toEqual({
      txn_id: 2,
      日期: 3,
      金額: 4,
      付款人: 5,
      分攤方式: 7,
      分類: 8,
      交易對象: 9,
      記帳人: 10,
      來源: 11,
      沖銷txn_id: 12,
    })
  })

  it('does not change required-header resolution when an extra column is renamed', () => {
    const before = ['自訂欄位', ...canonicalHeaderRow]
    const after = ['重新命名的自訂欄位', ...canonicalHeaderRow]

    expect(resolveHeaders_(after, canonicalHeaderRow)).toEqual(
      resolveHeaders_(before, canonicalHeaderRow),
    )
  })

  it('ignores repeated extra headers that share names with Object prototype properties', () => {
    const withPrototypeNamedExtras = ['constructor', 'toString', ...canonicalHeaderRow, 'constructor']

    expect(resolveHeaders_(withPrototypeNamedExtras, canonicalHeaderRow)).toMatchObject({
      txn_id: 3,
      沖銷txn_id: 12,
    })
  })

  it.each(canonicalHeaderRow)('throws an error naming a missing required header: %s', (missingHeader) => {
    const withoutHeader = canonicalHeaderRow.filter((header) => header !== missingHeader)

    expect(() => resolveHeaders_(withoutHeader, canonicalHeaderRow)).toThrow(
      new RegExp(missingHeader),
    )
  })

  it('names every missing required header in one error', () => {
    const missingHeaders = ['付款人', '分攤方式', '沖銷txn_id']
    const incomplete = canonicalHeaderRow.filter((header) => !missingHeaders.includes(header))

    let thrown: unknown
    try {
      resolveHeaders_(incomplete, canonicalHeaderRow)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    for (const missingHeader of missingHeaders) {
      expect((thrown as Error).message).toContain(missingHeader)
    }
  })

  it('throws an error naming a duplicated required header', () => {
    const duplicated = [...canonicalHeaderRow]
    duplicated.splice(3, 0, '付款人')

    expect(() => resolveHeaders_(duplicated, canonicalHeaderRow)).toThrow(
      /duplicate required header: 付款人/,
    )
  })

  it('trims surrounding whitespace from header cells before matching', () => {
    const padded = canonicalHeaderRow.map((header) => ` \t${header}\n `)

    expect(resolveHeaders_(padded, canonicalHeaderRow)).toEqual(canonicalResolution)
  })
})
