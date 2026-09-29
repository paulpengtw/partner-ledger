import { beforeEach, describe, expect, it } from 'vitest'
import { buildEnvelope } from '../functions/lib/envelope'
import { APP_VERSION, CONTRACT_VERSION } from '../src/generated/version'
import { loadGasFunctionsWithFakeGas, type FakeGasHarness } from './helpers/gas'

const entryHeaders = [
  'txn_id', '日期', '金額', '付款人', '分攤方式', '分類', '交易對象', '記帳人', '來源', '沖銷txn_id',
]

type Json = Record<string, any>

let nonceCounter = 0

async function post(harness: FakeGasHarness, payload: Record<string, unknown>): Promise<Json> {
  nonceCounter += 1
  const envelope = await buildEnvelope(
    'test-secret',
    { contractVersion: CONTRACT_VERSION, ...payload },
    Math.floor(Date.now() / 1000),
    `snapshot-${nonceCounter}`,
  )
  return JSON.parse(harness.doPost({ postData: { contents: JSON.stringify(envelope) } }).getContent())
}

function bootstrap(harness: FakeGasHarness, rows: unknown[][]): void {
  const entries = harness.spreadsheet.insertSheet('帳目')
  entries.getRange(1, 1, 1, entryHeaders.length).setValues([entryHeaders])
  if (rows.length > 0) entries.getRange(2, 1, rows.length, entryHeaders.length).setValues(rows)
  harness.spreadsheet.insertSheet('分類').getRange(1, 1, 3, 1).setValues([['分類'], ['結清'], ['餐飲']])
  harness.spreadsheet.insertSheet('選項清單').getRange(1, 1, 1, 1).setValues([['交易對象']])
  harness.spreadsheet.insertSheet('設定').getRange(1, 1, 3, 2).setValues([
    ['設定項目', '值'],
    ['夥伴:azhe@example.com', '阿哲'],
    ['夥伴:xiaoyu@example.com', '小語'],
  ])
}

function row(txnId: string, overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const values: Record<string, unknown> = {
    txn_id: txnId, 日期: '2026-08-07', 金額: 612, 付款人: '小語', 分攤方式: '這筆平分',
    分類: '餐飲', 交易對象: '全聯', 記帳人: '阿哲', 來源: 'web-app', 沖銷txn_id: '', ...overrides,
  }
  return entryHeaders.map((header) => values[header])
}

describe('integration state', () => {
  it('names the book and reports its read capabilities', async () => {
    const harness = loadGasFunctionsWithFakeGas()
    const state = await post(harness, { action: 'integrationState' })
    expect(state).toMatchObject({
      book: 'partner',
      identity: { contractVersion: CONTRACT_VERSION, appVersion: APP_VERSION },
      maintenance: { kind: 'open' },
      capabilities: ['complete-revisioned-reads', 'stable-identity'],
    })
    expect(state.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*\+08:00$/)
  })
})

describe('agreements snapshot', () => {
  let harness: FakeGasHarness

  beforeEach(() => {
    harness = loadGasFunctionsWithFakeGas()
  })

  it('returns every entry with an exact TWD amount, payer, counterparty and reversal links', async () => {
    bootstrap(harness, [
      row('e1', { 金額: 589.6 }),
      row('s1', { 付款人: '阿哲', 分攤方式: '', 分類: '結清', 交易對象: '', 金額: 300 }),
      row('e2', { 付款人: '阿哲', 分攤方式: '幫狗狗付', 金額: 74 }),
      row('r2', { 付款人: '阿哲', 分攤方式: '幫狗狗付', 金額: 74, 沖銷txn_id: 'e2' }),
    ])

    const page = await post(harness, { action: 'snapshot', scope: 'agreements' })

    expect(page.scope).toBe('agreements')
    expect(page.snapshotRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(page.continuation).toEqual({ kind: 'end' })
    expect(page.records).toHaveLength(4)
    expect(page.records[0]).toMatchObject({
      id: 'e1', sheetRow: 2, kind: 'expense', financialDate: '2026-08-07',
      amount: { amount: '589.6', currency: 'TWD' }, payer: '小語', otherParty: '阿哲',
      split: '這筆平分', category: '餐飲', reverses: null, reversedBy: null, source: 'web-app',
    })
    expect(page.records[1]).toMatchObject({ id: 's1', kind: 'settlement', split: null, payer: '阿哲', otherParty: '小語' })
    expect(page.records[2]).toMatchObject({ id: 'e2', reversedBy: 'r2' })
    expect(page.records[3]).toMatchObject({ id: 'r2', reverses: 'e2' })
    expect(page.records[0].revision).toMatch(/^[0-9a-f]{64}$/)
    expect(page.records[0]).not.toHaveProperty('交易對象')
  })

  it('pages past the cap with a cursor pinned to one revision', async () => {
    bootstrap(harness, Array.from({ length: 205 }, (_unused, index) => row(`e${index}`)))

    const first = await post(harness, { action: 'snapshot', scope: 'agreements' })
    expect(first.records).toHaveLength(200)
    expect(first.continuation).toEqual({ kind: 'cursor', cursor: '200' })

    const second = await post(harness, {
      action: 'snapshot', scope: 'agreements', cursor: '200', snapshotRevision: first.snapshotRevision,
    })
    expect(second.records).toHaveLength(5)
    expect(second.continuation).toEqual({ kind: 'end' })
    expect(second.snapshotRevision).toBe(first.snapshotRevision)
  })

  it('reports a changed revision instead of mixing pages from two states of the book', async () => {
    bootstrap(harness, [row('e1')])
    const first = await post(harness, { action: 'snapshot', scope: 'agreements' })

    harness.spreadsheet.getSheetByName('帳目')!.getRange(3, 1, 1, entryHeaders.length).setValues([row('e2')])

    expect(await post(harness, {
      action: 'snapshot', scope: 'agreements', cursor: '0', snapshotRevision: first.snapshotRevision,
    })).toMatchObject({ kind: 'revision-changed', book: 'partner', expected: first.snapshotRevision })
  })

  it('skips blank rows but refuses the whole read when an entry cannot be read exactly', async () => {
    bootstrap(harness, [row('e1'), entryHeaders.map(() => ''), row('e3')])
    expect((await post(harness, { action: 'snapshot', scope: 'agreements' })).records).toHaveLength(2)

    for (const [label, bad] of [
      ['amount', row('x', { 金額: 'about 300' })],
      ['date', row('x', { 日期: '2026/08/07' })],
      ['payer', row('x', { 付款人: '路人' })],
      ['split', row('x', { 分攤方式: '隨便' })],
    ] as const) {
      const fresh = loadGasFunctionsWithFakeGas()
      bootstrap(fresh, [row('e1'), bad as unknown[]])
      const response = await post(fresh, { action: 'snapshot', scope: 'agreements' })
      expect(response.ok, label).toBe(false)
      expect(response.records, label).toBeUndefined()
    }

    const duplicate = loadGasFunctionsWithFakeGas()
    bootstrap(duplicate, [row('e1'), row('e1')])
    expect(await post(duplicate, { action: 'snapshot', scope: 'agreements' }))
      .toEqual({ ok: false, error: 'duplicate txn_id at row 3' })
  })

  it('refuses unknown scopes, intervals and unpinned continuations', async () => {
    bootstrap(harness, [row('e1')])
    expect(await post(harness, { action: 'snapshot', scope: 'accounts' }))
      .toEqual({ ok: false, error: 'snapshot scope must be agreements or settings' })
    expect(await post(harness, { action: 'snapshot', scope: 'agreements', interval: { from: 'a', to: 'b' } }))
      .toEqual({ ok: false, error: 'snapshot interval is not supported' })
    expect(await post(harness, { action: 'snapshot', scope: 'agreements', cursor: '0' }))
      .toEqual({ ok: false, error: 'snapshot continuation requires snapshotRevision' })
  })

  it('stays behind the maintenance and contract gates', async () => {
    bootstrap(harness, [row('e1')])
    harness.setScriptProperty('INTEGRATION_OPEN', 'false')
    expect(await post(harness, { action: 'snapshot', scope: 'agreements' }))
      .toEqual({ ok: false, error: '系統更新中' })
    harness.setScriptProperty('INTEGRATION_OPEN', 'true')
    expect(await post(harness, { action: 'snapshot', scope: 'agreements', contractVersion: 'old' }))
      .toEqual({ ok: false, error: '版本已更新，請重新整理頁面' })
  })

  it('lists the formal categories a Confirmation may choose', async () => {
    bootstrap(harness, [row('e1')])
    const page = await post(harness, { action: 'snapshot', scope: 'settings' })
    expect(page).toMatchObject({
      scope: 'settings',
      records: [{ id: 'category:餐飲', kind: 'category', name: '餐飲' }],
      continuation: { kind: 'end' },
    })
    expect(page.snapshotRevision).toMatch(/^[0-9a-f]{64}$/)
  })
})
