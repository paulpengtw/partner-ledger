import { describe, expect, it } from 'vitest'
import { loadEntryFunctions } from './helpers/gas'

const { computePayables_ } = loadEntryFunctions()

const partners = ['阿哲', '小語']

type Row = Record<string, unknown>

let nextId = 0
function row(overrides: Row = {}): Row {
  nextId += 1
  return {
    txn_id: `row-${nextId}`,
    日期: '2026-08-09',
    金額: 300,
    付款人: '小語',
    分攤方式: '均分',
    分類: '餐飲',
    交易對象: '',
    記帳人: '阿哲',
    來源: 'pwa',
    沖銷txn_id: '',
    ...overrides,
  }
}

function outstanding(rows: Row[]): Record<string, number> {
  const result = computePayables_(rows, partners)
  const byDebtor: Record<string, number> = {}
  for (const direction of result.directions) {
    byDebtor[direction.debtor] = direction.outstanding
  }
  return byDebtor
}

describe('computePayables_', () => {
  it('returns both directions at zero for an empty book', () => {
    const result = computePayables_([], partners)
    expect(result.directions).toEqual([
      { debtor: '阿哲', creditor: '小語', outstanding: 0 },
      { debtor: '小語', creditor: '阿哲', outstanding: 0 },
    ])
  })

  it('均分 puts half the amount on the non-payer', () => {
    expect(outstanding([row({ 金額: 300, 付款人: '小語' })])).toEqual({
      阿哲: 150,
      小語: 0,
    })
  })

  it('keeps odd-amount 均分 halves exact to NT$0.5', () => {
    expect(outstanding([row({ 金額: 101, 付款人: '小語' })])).toEqual({
      阿哲: 50.5,
      小語: 0,
    })
  })

  it('全額對方 puts the whole amount on the non-payer', () => {
    expect(
      outstanding([row({ 金額: 200, 付款人: '小語', 分攤方式: '全額對方' })]),
    ).toEqual({ 阿哲: 200, 小語: 0 })
  })

  it('全額自己 creates no inter-partner debt', () => {
    expect(
      outstanding([row({ 金額: 200, 付款人: '小語', 分攤方式: '全額自己' })]),
    ).toEqual({ 阿哲: 0, 小語: 0 })
  })

  it('tracks the two directions separately, never netted', () => {
    expect(
      outstanding([
        row({ 金額: 300, 付款人: '小語' }),
        row({ 金額: 100, 付款人: '阿哲' }),
      ]),
    ).toEqual({ 阿哲: 150, 小語: 50 })
  })

  it('a 結清 row discharges the debtor direction', () => {
    expect(
      outstanding([
        row({ 金額: 300, 付款人: '小語' }),
        row({ 金額: 100, 付款人: '阿哲', 分類: '結清', 分攤方式: '' }),
      ]),
    ).toEqual({ 阿哲: 50, 小語: 0 })
  })

  it('excludes voided rows and the 沖銷 mirror itself from arithmetic', () => {
    expect(
      outstanding([
        row({ txn_id: 'meal-1', 金額: 300, 付款人: '小語' }),
        row({ txn_id: 'void-1', 金額: 300, 付款人: '小語', 沖銷txn_id: 'meal-1' }),
      ]),
    ).toEqual({ 阿哲: 0, 小語: 0 })
  })

  it('shows a direction over-settled (negative) when a settled row is voided late', () => {
    expect(
      outstanding([
        row({ txn_id: 'meal-1', 金額: 300, 付款人: '小語' }),
        row({ txn_id: 'pay-1', 金額: 150, 付款人: '阿哲', 分類: '結清', 分攤方式: '' }),
        row({ txn_id: 'void-1', 金額: 300, 付款人: '小語', 沖銷txn_id: 'meal-1' }),
      ]),
    ).toEqual({ 阿哲: -150, 小語: 0 })
  })

  it('counts hand rows without txn_id', () => {
    expect(outstanding([row({ txn_id: '', 來源: '手動' })])).toEqual({
      阿哲: 150,
      小語: 0,
    })
  })

  it('rejects a partners list that is not two distinct names', () => {
    expect(() => computePayables_([], ['阿哲'])).toThrow('partners')
    expect(() => computePayables_([], ['阿哲', '阿哲'])).toThrow('partners')
  })
})
