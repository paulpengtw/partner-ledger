import { describe, expect, it } from 'vitest'
import { loadEntryFunctions, type EntryInput } from './helpers/gas'

const { expandEntry_, ENTRY_HEADERS } = loadEntryFunctions()

const partners = ['阿哲', '小語']

function createInput(overrides: EntryInput = {}): EntryInput {
  return {
    kind: 'create',
    date: '2026-08-09',
    amount: 300,
    payer: '小語',
    split: '這筆平分',
    category: '餐飲',
    payee: '全聯',
    enterer: '阿哲',
    partners,
    txnId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  }
}

describe('ENTRY_HEADERS', () => {
  it('lists the flat 帳目 columns in spec order', () => {
    expect(ENTRY_HEADERS).toEqual([
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
    ])
  })
})

describe('expandEntry_ create', () => {
  it('expands a 這筆平分 expense into one flat row', () => {
    expect(expandEntry_(createInput())).toEqual({
      txn_id: '11111111-1111-4111-8111-111111111111',
      日期: '2026-08-09',
      金額: 300,
      付款人: '小語',
      分攤方式: '這筆平分',
      分類: '餐飲',
      交易對象: '全聯',
      記帳人: '阿哲',
      來源: 'web-app',
      沖銷txn_id: '',
    })
  })

  it('keeps 交易對象 optional', () => {
    expect(expandEntry_(createInput({ payee: undefined }))['交易對象']).toBe('')
  })

  it.each(['幫狗狗付', '幫自己付'])('accepts 分攤方式 %s', (split) => {
    expect(expandEntry_(createInput({ split }))['分攤方式']).toBe(split)
  })

  it('rejects a 付款人 who is not one of the two partners', () => {
    expect(() => expandEntry_(createInput({ payer: '路人' }))).toThrow('付款人')
  })

  it('rejects a missing 付款人 — the payer is never defaulted', () => {
    expect(() => expandEntry_(createInput({ payer: undefined }))).toThrow('付款人')
  })

  it('rejects an unknown 分攤方式', () => {
    expect(() => expandEntry_(createInput({ split: '三七分' }))).toThrow('分攤方式')
  })

  it('rejects the reserved 分類 結清 on an expense', () => {
    expect(() => expandEntry_(createInput({ category: '結清' }))).toThrow('結清')
  })

  it('rejects a non-positive 金額', () => {
    expect(() => expandEntry_(createInput({ amount: 0 }))).toThrow('金額')
    expect(() => expandEntry_(createInput({ amount: -10 }))).toThrow('金額')
  })

  it('rejects a missing 記帳人', () => {
    expect(() => expandEntry_(createInput({ enterer: undefined }))).toThrow('記帳人')
  })
})
