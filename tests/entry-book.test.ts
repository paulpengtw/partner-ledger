import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEnvelope as productionBuildEnvelope } from '../functions/lib/envelope'
import { CONTRACT_VERSION } from '../src/generated/version'
import {
  loadGasFunctionsWithFakeGas,
  type FakeGasHarness,
  type FakeSheet,
  type FakeTextOutput,
} from './helpers/gas'

const buildEnvelope = (secret: string, payload: Record<string, unknown>, ts: number, nonce: string) =>
  productionBuildEnvelope(secret, { ...payload, contractVersion: CONTRACT_VERSION }, ts, nonce)

const secret = 'test-secret'
const fixedNow = new Date('2026-08-09T00:00:00.000Z')

const entryHeaders = [
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

type JsonResponse = Record<string, unknown>
type Transaction = Record<string, unknown>

describe('partner book doPost', () => {
  let harness: FakeGasHarness

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    harness = loadGasFunctionsWithFakeGas()
    bootstrapPartnerSheets(harness)
    harness.clearEvents()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('create_transaction', () => {
    it('rechecks maintenance under the write lock before appending', async () => {
      harness.onNextLock(() => harness.setScriptProperty('INTEGRATION_OPEN', 'false'))
      expect(await postCreate(harness, 'create-paused-001'))
        .toEqual({ ok: false, error: '系統更新中' })
      expect(entryRows(harness)).toEqual([])
    })

    it('appends exactly one column-complete flat row and stamps 記帳人 from userEmail', async () => {
      const response = await postCreate(harness, 'create-flat-001')

      expect(response).toEqual({ ok: true, txn_id: 'create-flat-001', row: 2 })
      expect(entryRows(harness)).toEqual([
        {
          txn_id: 'create-flat-001',
          日期: '2026-08-09',
          金額: 300,
          付款人: '小語',
          分攤方式: '這筆平分',
          分類: '餐飲',
          交易對象: '全聯',
          記帳人: '阿哲',
          來源: 'web-app',
          沖銷txn_id: '',
        },
      ])
    })

    it('replays the stored result with already true on nonce replay', async () => {
      const envelope = await buildEnvelope(
        secret,
        createPayload('create-replay-001'),
        nowSeconds(),
        'create-replay-001',
      )

      const first = postEnvelope(harness, envelope)
      const second = postEnvelope(harness, envelope)

      expect(first).toEqual({ ok: true, txn_id: 'create-replay-001', row: 2 })
      expect(second).toEqual({
        ok: true,
        txn_id: 'create-replay-001',
        row: 2,
        already: true,
      })
      expect(entryRows(harness)).toHaveLength(1)
    })

    it('uses txn_id as a durable backstop after nonce cache expiry', async () => {
      const envelope = await buildEnvelope(
        secret,
        createPayload('create-backstop-001'),
        nowSeconds(),
        'create-backstop-001',
      )

      postEnvelope(harness, envelope)
      harness.advanceCacheTime(700)
      const replay = postEnvelope(harness, envelope)

      expect(replay).toEqual({
        ok: true,
        txn_id: 'create-backstop-001',
        row: 2,
        already: true,
      })
      expect(entryRows(harness)).toHaveLength(1)
    })

    it('does not cache a failed write and genuinely retries the same envelope', async () => {
      const envelope = await buildEnvelope(
        secret,
        createPayload('create-retry-001'),
        nowSeconds(),
        'create-retry-001',
      )

      requiredSheet(harness, '帳目').failNextSetValues('simulated outage')
      const failed = postEnvelope(harness, envelope)
      const retried = postEnvelope(harness, envelope)

      expect(failed).toEqual({ ok: false, error: 'simulated outage' })
      expect(retried).toEqual({ ok: true, txn_id: 'create-retry-001', row: 2 })
      expect(entryRows(harness)).toHaveLength(1)
    })

    it('rejects an unknown 分類 by name', async () => {
      const response = await postCreate(harness, 'create-category-001', {
        category: '洗車',
      })

      expect(response).toEqual({ ok: false, error: 'unknown 分類: 洗車' })
      expect(entryRows(harness)).toHaveLength(0)
    })

    it('rejects the reserved 結清 分類 on create', async () => {
      const response = await postCreate(harness, 'create-reserved-001', {
        category: '結清',
      })

      expect(response.ok).toBe(false)
      expect(String(response.error)).toContain('結清')
      expect(entryRows(harness)).toHaveLength(0)
    })

    it('rejects a userEmail outside the 設定 partner mapping', async () => {
      const payload = createPayload('create-email-001')
      payload.userEmail = 'stranger@example.com'
      const response = await post(harness, payload, 'create-email-001')

      expect(response).toEqual({
        ok: false,
        error: 'unknown user email: stranger@example.com',
      })
      expect(entryRows(harness)).toHaveLength(0)
    })

    it('rejects a 付款人 outside the two partners', async () => {
      const response = await postCreate(harness, 'create-payer-001', {
        payer: '路人',
      })

      expect(response.ok).toBe(false)
      expect(String(response.error)).toContain('付款人')
      expect(entryRows(harness)).toHaveLength(0)
    })
  })

  describe('envelope security', () => {
    it('rejects a bad signature without acquiring the lock', async () => {
      const envelope = await buildEnvelope(
        secret,
        createPayload('create-badsig-001'),
        nowSeconds(),
        'create-badsig-001',
      )
      const tampered = { ...envelope, sig: `${String(envelope.sig).slice(0, -2)}xx` }

      const response = postEnvelope(harness, tampered)

      expect(response).toEqual({ ok: false, error: 'bad signature' })
      expect(harness.events).not.toContain('lock-acquired')
    })

    it('rejects a timestamp outside the allowed window', async () => {
      const envelope = await buildEnvelope(
        secret,
        createPayload('create-skew-001'),
        nowSeconds() - 301,
        'create-skew-001',
      )

      const response = postEnvelope(harness, envelope)

      expect(response).toEqual({
        ok: false,
        error: 'request timestamp outside allowed window',
      })
      expect(entryRows(harness)).toHaveLength(0)
    })

    it('returns a named error for unsupported actions', async () => {
      const response = await post(
        harness,
        { action: 'setupSpreadsheet' },
        'unsupported-action-001',
      )

      expect(response).toEqual({
        ok: false,
        error: 'unsupported action: setupSpreadsheet',
      })
    })
  })

  describe('list_transactions', () => {
    it('returns display rows in range plus payables derived from the whole book', async () => {
      await postCreate(harness, 'list-a-001', { date: '2026-08-01', amount: 300 })
      await postCreate(harness, 'list-a-002', {
        date: '2026-07-01',
        amount: 100,
        payer: '阿哲',
        split: '幫狗狗付',
      })

      const response = await postList(harness, '2026-08-01', '2026-08-31')

      expect(response.transactions).toEqual([
        {
          txn_id: 'list-a-001',
          日期: '2026-08-01',
          金額: '300',
          付款人: '小語',
          分攤方式: '這筆平分',
          分類: '餐飲',
          交易對象: '全聯',
          記帳人: '阿哲',
          來源: 'web-app',
          沖銷txn_id: '',
          幣別: 'TWD',
          voided: false,
        },
      ])
      expect(response.payables).toEqual({
        directions: [
          { debtor: '阿哲', creditor: '小語', outstanding: 150 },
          { debtor: '小語', creditor: '阿哲', outstanding: 100 },
        ],
        otherCurrencies: [],
      })
    })

    it('marks voided rows struck and excludes them from payables', async () => {
      await postCreate(harness, 'list-void-001', { date: '2026-08-02', amount: 300 })
      seedEntryRow(harness, {
        txn_id: 'list-void-mirror',
        日期: '2026-08-03',
        金額: 300,
        付款人: '小語',
        分攤方式: '這筆平分',
        分類: '餐飲',
        記帳人: '小語',
        來源: 'web-app',
        沖銷txn_id: 'list-void-001',
      })

      const response = await postList(harness, '2026-08-01', '2026-08-31')
      const byId = new Map(
        response.transactions.map((transaction) => [transaction.txn_id, transaction]),
      )

      expect(byId.get('list-void-001')?.voided).toBe(true)
      expect(byId.get('list-void-mirror')?.voided).toBe(false)
      expect(response.payables).toEqual({
        directions: [
          { debtor: '阿哲', creditor: '小語', outstanding: 0 },
          { debtor: '小語', creditor: '阿哲', outstanding: 0 },
        ],
        otherCurrencies: [],
      })
    })

    it('sorts newest-first by 日期 with later sheet rows first on ties', async () => {
      await postCreate(harness, 'list-sort-001', { date: '2026-08-05' })
      await postCreate(harness, 'list-sort-002', { date: '2026-08-07' })
      await postCreate(harness, 'list-sort-003', { date: '2026-08-05' })

      const response = await postList(harness, '2026-08-01', '2026-08-31')

      expect(response.transactions.map((transaction) => transaction.txn_id)).toEqual([
        'list-sort-002',
        'list-sort-003',
        'list-sort-001',
      ])
    })

    it('includes hand rows with a blank txn_id in listing and payables', async () => {
      seedEntryRow(harness, {
        txn_id: '',
        日期: '2026-08-04',
        金額: 101,
        付款人: '小語',
        分攤方式: '這筆平分',
        分類: '餐飲',
        記帳人: '阿哲',
        來源: '手動',
        沖銷txn_id: '',
      })

      const response = await postList(harness, '2026-08-01', '2026-08-31')

      expect(response.transactions).toHaveLength(1)
      expect(response.transactions[0]?.txn_id).toBe('')
      expect(response.transactions[0]?.來源).toBe('手動')
      expect(response.payables?.directions?.[0]).toEqual({
        debtor: '阿哲',
        creditor: '小語',
        outstanding: 50.5,
      })
    })

    it('caps the listing at the 200 most recent rows but keeps payables whole', async () => {
      for (let index = 0; index < 205; index += 1) {
        seedEntryRow(harness, {
          txn_id: `bulk-${String(index).padStart(3, '0')}`,
          日期: '2026-08-06',
          金額: 10,
          付款人: '小語',
          分攤方式: '幫狗狗付',
          分類: '交通',
          記帳人: '小語',
          來源: 'web-app',
          沖銷txn_id: '',
        })
      }

      const response = await postList(harness, '2026-08-01', '2026-08-31')

      expect(response.transactions).toHaveLength(200)
      expect(response.transactions[0]?.txn_id).toBe('bulk-204')
      expect(response.payables?.directions?.[0]?.outstanding).toBe(2050)
    })
  })

  describe('settle', () => {
    it('appends a 結清 row for the debtor and returns the remaining outstanding', async () => {
      await postCreate(harness, 'settle-base-001')

      const response = await postSettle(harness, 'settle-001', {
        payer: '阿哲',
        amount: 100,
        userEmail: 'xiaoyu@example.com',
      })

      expect(response).toEqual({
        ok: true,
        txn_id: 'settle-001',
        row: 3,
        outstanding: 50,
      })
      expect(entryRows(harness)[1]).toEqual({
        txn_id: 'settle-001',
        日期: '2026-08-09',
        金額: 100,
        付款人: '阿哲',
        分攤方式: '',
        分類: '結清',
        交易對象: '',
        記帳人: '小語',
        來源: 'web-app',
        沖銷txn_id: '',
      })

      const list = await postList(harness, '2026-08-01', '2026-08-31')
      expect(list.payables.directions).toEqual([
        { debtor: '阿哲', creditor: '小語', outstanding: 50 },
        { debtor: '小語', creditor: '阿哲', outstanding: 0 },
      ])
    })

    it('allows settling the direction exactly to zero, half-dollars included', async () => {
      await postCreate(harness, 'settle-exact-001', { amount: 101 })

      const response = await postSettle(harness, 'settle-exact-002', {
        payer: '阿哲',
        amount: 50.5,
      })

      expect(response.ok).toBe(true)
      expect(response.outstanding).toBe(0)
    })

    it('blocks overpay beyond the direction outstanding', async () => {
      await postCreate(harness, 'settle-over-001')

      const response = await postSettle(harness, 'settle-over-002', {
        payer: '阿哲',
        amount: 151,
      })

      expect(response).toEqual({
        ok: false,
        error: 'over-settlement: amount 151 exceeds outstanding 150',
      })
      expect(entryRows(harness)).toHaveLength(1)
    })

    it('blocks any 結清 when the direction has nothing outstanding', async () => {
      const response = await postSettle(harness, 'settle-none-001', {
        payer: '阿哲',
        amount: 1,
      })

      expect(response).toEqual({
        ok: false,
        error: 'over-settlement: amount 1 exceeds outstanding 0',
      })
    })

    it('records an offsetting transfer as two 結清 rows, one per direction', async () => {
      await postCreate(harness, 'settle-both-001', { amount: 300 })
      await postCreate(harness, 'settle-both-002', {
        amount: 100,
        payer: '阿哲',
        split: '幫狗狗付',
      })

      const first = await postSettle(harness, 'settle-both-003', {
        payer: '阿哲',
        amount: 100,
      })
      const second = await postSettle(harness, 'settle-both-004', {
        payer: '小語',
        amount: 100,
        userEmail: 'xiaoyu@example.com',
      })

      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)

      const list = await postList(harness, '2026-08-01', '2026-08-31')
      expect(list.payables.directions).toEqual([
        { debtor: '阿哲', creditor: '小語', outstanding: 50 },
        { debtor: '小語', creditor: '阿哲', outstanding: 0 },
      ])
    })

    it('replays a settle envelope idempotently', async () => {
      await postCreate(harness, 'settle-idem-001')
      const envelope = await buildEnvelope(
        secret,
        settlePayload('settle-idem-002', { payer: '阿哲', amount: 100 }),
        nowSeconds(),
        'settle-idem-002',
      )

      const first = postEnvelope(harness, envelope)
      const second = postEnvelope(harness, envelope)

      expect(first.ok).toBe(true)
      expect(second).toEqual({ ...first, already: true })
      expect(entryRows(harness)).toHaveLength(2)
    })

    it('rejects a non-positive settle amount', async () => {
      await postCreate(harness, 'settle-neg-001')

      const response = await postSettle(harness, 'settle-neg-002', {
        payer: '阿哲',
        amount: 0,
      })

      expect(response.ok).toBe(false)
      expect(String(response.error)).toContain('金額')
    })

    it('rejects a 付款人 outside the two partners', async () => {
      const response = await postSettle(harness, 'settle-payer-001', {
        payer: '房東',
        amount: 10,
      })

      expect(response.ok).toBe(false)
      expect(String(response.error)).toContain('付款人')
    })
  })

  describe('reverse_transaction', () => {
    it('voids a row with a mirror 沖銷 row stamped with the voider as 記帳人', async () => {
      await postCreate(harness, 'reverse-base-001')

      const response = await postReverse(harness, 'reverse-001', {
        txn_id: 'reverse-base-001',
        userEmail: 'xiaoyu@example.com',
      })

      expect(response).toEqual({ ok: true, txn_id: 'reverse-001', row: 3 })
      expect(entryRows(harness)[1]).toEqual({
        txn_id: 'reverse-001',
        日期: '2026-08-09',
        金額: 300,
        付款人: '小語',
        分攤方式: '這筆平分',
        分類: '餐飲',
        交易對象: '全聯',
        記帳人: '小語',
        來源: 'web-app',
        沖銷txn_id: 'reverse-base-001',
      })

      const list = await postList(harness, '2026-08-01', '2026-08-31')
      const byId = new Map(
        list.transactions.map((transaction) => [transaction.txn_id, transaction]),
      )
      expect(byId.get('reverse-base-001')?.voided).toBe(true)
      expect(list.payables.directions).toEqual([
        { debtor: '阿哲', creditor: '小語', outstanding: 0 },
        { debtor: '小語', creditor: '阿哲', outstanding: 0 },
      ])
    })

    it('shows a direction over-settled when an already-settled row is voided late', async () => {
      await postCreate(harness, 'reverse-late-001')
      await postSettle(harness, 'reverse-late-002', { payer: '阿哲', amount: 150 })

      const response = await postReverse(harness, 'reverse-late-003', {
        txn_id: 'reverse-late-001',
      })

      expect(response.ok).toBe(true)
      const list = await postList(harness, '2026-08-01', '2026-08-31')
      expect(list.payables.directions[0]).toEqual({
        debtor: '阿哲',
        creditor: '小語',
        outstanding: -150,
      })
    })

    it('voiding a 結清 row restores the direction outstanding', async () => {
      await postCreate(harness, 'reverse-settle-001')
      await postSettle(harness, 'reverse-settle-002', { payer: '阿哲', amount: 100 })

      const response = await postReverse(harness, 'reverse-settle-003', {
        txn_id: 'reverse-settle-002',
      })

      expect(response.ok).toBe(true)
      const list = await postList(harness, '2026-08-01', '2026-08-31')
      expect(list.payables.directions[0]).toEqual({
        debtor: '阿哲',
        creditor: '小語',
        outstanding: 150,
      })
    })

    it('returns already true when the row is already voided, even under a new nonce', async () => {
      await postCreate(harness, 'reverse-idem-001')
      await postReverse(harness, 'reverse-idem-002', { txn_id: 'reverse-idem-001' })

      const repeat = await postReverse(harness, 'reverse-idem-003', {
        txn_id: 'reverse-idem-001',
      })

      expect(repeat).toEqual({ ok: true, txn_id: 'reverse-idem-002', row: 3, already: true })
      expect(entryRows(harness)).toHaveLength(2)
    })

    it('refuses a reversal key reused for another target after cache expiry', async () => {
      await postCreate(harness, 'reverse-key-first')
      await postCreate(harness, 'reverse-key-second')
      await postReverse(harness, 'reverse-key-used', { txn_id: 'reverse-key-first' })
      harness.advanceCacheTime(601)
      const before = entryRows(harness)

      const response = await postReverse(harness, 'reverse-key-used', {
        txn_id: 'reverse-key-second',
      })

      expect(response).toEqual({
        ok: false,
        error: 'idempotency key already used for another reversal',
      })
      expect(entryRows(harness)).toEqual(before)
      const replay = await postReverse(harness, 'reverse-key-used', { txn_id: 'reverse-key-first' })
      expect(replay).toEqual({ ok: true, txn_id: 'reverse-key-used', row: 4, already: true })
      expect(entryRows(harness)).toEqual(before)
    })

    it('refuses a reversal when the script lock cannot be acquired', async () => {
      await postCreate(harness, 'lock-original')
      const before = entryRows(harness)
      harness.failNextLock()
      const response = await postReverse(harness, 'lock-reversal', { txn_id: 'lock-original' })
      expect(response).toEqual({ ok: false, error: 'simulated lock failure' })
      expect(entryRows(harness)).toEqual(before)
    })

    it('rejects an unknown txn_id by name', async () => {
      const response = await postReverse(harness, 'reverse-unknown-001', {
        txn_id: 'no-such-row',
      })

      expect(response).toEqual({ ok: false, error: 'unknown txn_id: no-such-row' })
    })

    it('refuses to reverse a 沖銷 mirror row', async () => {
      await postCreate(harness, 'reverse-mirror-001')
      await postReverse(harness, 'reverse-mirror-002', { txn_id: 'reverse-mirror-001' })

      const response = await postReverse(harness, 'reverse-mirror-003', {
        txn_id: 'reverse-mirror-002',
      })

      expect(response).toEqual({
        ok: false,
        error: 'cannot reverse reversal row: reverse-mirror-002',
      })
    })
  })

  describe('bootstrap and vocabulary', () => {
    it('setupSpreadsheet creates exactly the four partner-book sheets', () => {
      const fresh = loadGasFunctionsWithFakeGas()
      fresh.setupSpreadsheet()

      const names = fresh.spreadsheet.getSheets().map((sheet) => sheet.getName())
      expect(names.sort()).toEqual(['帳目', '選項清單', '設定', '分類'].sort())

      const entrySheet = fresh.spreadsheet.getSheetByName('帳目')
      expect(
        entrySheet?.getRange(1, 1, 1, entryHeaders.length).getValues()[0],
      ).toEqual(entryHeaders)

      const categorySheet = fresh.spreadsheet.getSheetByName('分類')
      const categories = categorySheet
        ?.getRange(1, 1, categorySheet.getLastRow(), 1)
        .getValues()
        .flat()
      expect(categories?.[0]).toBe('分類')
      expect(categories).toContain('結清')

      const settingsSheet = fresh.spreadsheet.getSheetByName('設定')
      const settings = settingsSheet
        ?.getRange(1, 1, settingsSheet.getLastRow(), 2)
        .getValues()
      expect(settings?.[0]).toEqual(['設定項目', '值'])
      expect(
        settings?.filter((row) => String(row[0]).startsWith('夥伴:')),
      ).toHaveLength(2)
    })

    it('setupSpreadsheet is idempotent and never seeds data rows into 帳目', () => {
      const fresh = loadGasFunctionsWithFakeGas()
      fresh.setupSpreadsheet()
      fresh.setupSpreadsheet()

      const entrySheet = fresh.spreadsheet.getSheetByName('帳目')
      expect(entrySheet?.getLastRow()).toBe(1)
      expect(fresh.spreadsheet.getSheets()).toHaveLength(4)
    })

    it('health returns the schema fingerprint without the full spreadsheet id', async () => {
      const response = await post(harness, { action: 'health' }, 'health-001')

      expect(response.ok).toBe(true)
      expect(response.schema_version).toMatch(/^[0-9a-f]{12}$/)
      expect(response.spreadsheet_id_tail).toBe('sheet-id')
    })

    it('schema_version tracks vocabulary edits but ignores 帳目 rows', async () => {
      const before = await post(harness, { action: 'health' }, 'health-schema-001')

      await postCreate(harness, 'schema-noise-001')
      const afterEntry = await post(harness, { action: 'health' }, 'health-schema-002')
      expect(afterEntry.schema_version).toBe(before.schema_version)

      requiredSheet(harness, '分類').getRange(5, 1).setValues([['寵物']])
      const afterVocab = await post(harness, { action: 'health' }, 'health-schema-003')
      expect(afterVocab.schema_version).not.toBe(before.schema_version)
    })

    it('get_options serves categories without 結清, payee suggestions, and the two partners', async () => {
      const response = await post(harness, { action: 'get_options' }, 'options-001')

      expect(response).toEqual({
        schema_version: expect.stringMatching(/^[0-9a-f]{12}$/),
        categories: ['餐飲', '交通'],
        payees: ['全聯'],
        partners: ['阿哲', '小語'],
      })
    })
  })
})

function bootstrapPartnerSheets(harness: FakeGasHarness): void {
  const entries = harness.spreadsheet.insertSheet('帳目')
  entries.getRange(1, 1, 1, entryHeaders.length).setValues([entryHeaders])

  const categories = harness.spreadsheet.insertSheet('分類')
  categories.getRange(1, 1, 4, 1).setValues([['分類'], ['結清'], ['餐飲'], ['交通']])

  const options = harness.spreadsheet.insertSheet('選項清單')
  options.getRange(1, 1, 2, 1).setValues([['交易對象'], ['全聯']])

  const settings = harness.spreadsheet.insertSheet('設定')
  settings.getRange(1, 1, 3, 2).setValues([
    ['設定項目', '值'],
    ['夥伴:azhe@example.com', '阿哲'],
    ['夥伴:xiaoyu@example.com', '小語'],
  ])
}

function createPayload(
  idempotencyKey: string,
  overrides: Transaction = {},
): Record<string, unknown> {
  return {
    action: 'create_transaction',
    idempotencyKey,
    userEmail: 'azhe@example.com',
    transaction: {
      date: '2026-08-09',
      amount: 300,
      payer: '小語',
      split: '這筆平分',
      category: '餐飲',
      payee: '全聯',
      ...overrides,
    },
  }
}

async function post(
  harness: FakeGasHarness,
  payload: Record<string, unknown>,
  nonce: string,
): Promise<JsonResponse> {
  const envelope = await buildEnvelope(secret, payload, nowSeconds(), nonce)
  return postEnvelope(harness, envelope)
}

async function postCreate(
  harness: FakeGasHarness,
  idempotencyKey: string,
  overrides: Transaction = {},
): Promise<JsonResponse> {
  return post(harness, createPayload(idempotencyKey, overrides), idempotencyKey)
}

function postEnvelope(harness: FakeGasHarness, envelope: unknown): JsonResponse {
  return parseOutput(
    harness.doPost({ postData: { contents: JSON.stringify(envelope) } }),
  )
}

function parseOutput(output: FakeTextOutput): JsonResponse {
  expect(output.getMimeType()).toBe('application/json')
  return JSON.parse(output.getContent()) as JsonResponse
}

function nowSeconds(): number {
  return Math.floor(fixedNow.getTime() / 1000)
}

function requiredSheet(harness: FakeGasHarness, name: string): FakeSheet {
  const sheet = harness.spreadsheet.getSheetByName(name)
  if (!sheet) {
    throw new Error(`missing test sheet: ${name}`)
  }
  return sheet
}

function entryRows(harness: FakeGasHarness): Array<Record<string, unknown>> {
  const entries = requiredSheet(harness, '帳目')
  const lastRow = entries.getLastRow()
  if (lastRow < 2) {
    return []
  }
  const values = entries
    .getRange(2, 1, lastRow - 1, entryHeaders.length)
    .getValues()
  return values.map((row) => {
    const record: Record<string, unknown> = {}
    entryHeaders.forEach((header, index) => {
      record[header] = row[index]
    })
    return record
  })
}

type ListResponse = {
  transactions: Array<Record<string, unknown>>
  payables: { directions: Array<Record<string, unknown>> }
}

async function postList(
  harness: FakeGasHarness,
  dateFrom: string,
  dateTo: string,
): Promise<ListResponse> {
  return (await post(
    harness,
    { action: 'list_transactions', date_from: dateFrom, date_to: dateTo },
    `list-${dateFrom}-${dateTo}-${Math.random().toString(36).slice(2)}`,
  )) as unknown as ListResponse
}

function seedEntryRow(
  harness: FakeGasHarness,
  fields: Record<string, unknown>,
): void {
  const entries = requiredSheet(harness, '帳目')
  const row = entryHeaders.map((header) =>
    header in fields ? fields[header] : '',
  )
  entries
    .getRange(entries.getLastRow() + 1, 1, 1, entryHeaders.length)
    .setValues([row])
}

function settlePayload(
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { userEmail, ...fields } = overrides
  return {
    action: 'settle',
    idempotencyKey,
    userEmail: userEmail ?? 'azhe@example.com',
    date: '2026-08-09',
    ...fields,
  }
}

async function postSettle(
  harness: FakeGasHarness,
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
): Promise<JsonResponse> {
  return post(harness, settlePayload(idempotencyKey, overrides), idempotencyKey)
}

async function postReverse(
  harness: FakeGasHarness,
  idempotencyKey: string,
  overrides: Record<string, unknown> = {},
): Promise<JsonResponse> {
  const { userEmail, ...fields } = overrides
  return post(
    harness,
    {
      action: 'reverse_transaction',
      idempotencyKey,
      userEmail: userEmail ?? 'azhe@example.com',
      date: '2026-08-09',
      ...fields,
    },
    idempotencyKey,
  )
}
