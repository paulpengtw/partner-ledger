import { beforeEach, describe, expect, it } from 'vitest'
import { buildEnvelope } from '../functions/lib/envelope'
import { CONTRACT_VERSION } from '../src/generated/version'
import { loadGasFunctionsWithFakeGas, type FakeGasHarness } from './helpers/gas'

const entryHeaders = [
  'txn_id', '日期', '金額', '付款人', '分攤方式', '分類', '交易對象', '記帳人', '來源', '沖銷txn_id',
]
const operationHeaders = ['operation_id', 'content_digest', 'kind', 'txn_id', 'personal_group_id', 'committed_at']

type Json = Record<string, any>
let nonceCounter = 0

async function post(harness: FakeGasHarness, payload: Record<string, unknown>): Promise<Json> {
  nonceCounter += 1
  const envelope = await buildEnvelope(
    'test-secret',
    { contractVersion: CONTRACT_VERSION, ...payload },
    Math.floor(Date.now() / 1000),
    `command-${nonceCounter}`,
  )
  return JSON.parse(harness.doPost({ postData: { contents: JSON.stringify(envelope) } }).getContent())
}

function bootstrap(harness: FakeGasHarness, { integration = true } = {}): void {
  harness.spreadsheet.insertSheet('帳目').getRange(1, 1, 1, entryHeaders.length).setValues([entryHeaders])
  harness.spreadsheet.insertSheet('分類').getRange(1, 1, 3, 1).setValues([['分類'], ['結清'], ['餐飲']])
  harness.spreadsheet.insertSheet('選項清單').getRange(1, 1, 1, 1).setValues([['交易對象']])
  harness.spreadsheet.insertSheet('設定').getRange(1, 1, 3, 2).setValues([
    ['設定項目', '值'],
    ['夥伴:cheng@example.com', 'cheng'],
    ['夥伴:yi@example.com', '翊'],
  ])
  if (integration) {
    harness.spreadsheet.insertSheet('整合操作').getRange(1, 1, 1, operationHeaders.length).setValues([operationHeaders])
  }
}

const agreement = (overrides: Record<string, unknown> = {}) => ({
  kind: 'partner-agreement',
  purpose: 'shared-purchase',
  groupId: 'obs-1:group',
  selfName: 'cheng',
  payer: 'cheng',
  allocation: 'equal-halves',
  total: { amount: '1200', currency: 'TWD' },
  effectiveDate: '2026-09-20',
  ...overrides,
})

const command = (operationId: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  action: 'command', operationId, contentDigest: `digest-of-${operationId}`, expectedRevisions: [], content, ...extra,
})

function entryRows(harness: FakeGasHarness): unknown[][] {
  const sheet = harness.spreadsheet.getSheetByName('帳目')!
  return sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, entryHeaders.length).getValues()
}

describe('Partner integration commands', () => {
  let harness: FakeGasHarness

  beforeEach(() => {
    harness = loadGasFunctionsWithFakeGas()
    bootstrap(harness)
  })

  it('reports outcome capabilities only once the integration sheet exists', async () => {
    expect((await post(harness, { action: 'integrationState' })).capabilities)
      .toEqual(['complete-revisioned-reads', 'stable-identity', 'durable-operation-outcomes', 'link-metadata', 'pending-confirmation-states'])
    const bare = loadGasFunctionsWithFakeGas()
    bootstrap(bare, { integration: false })
    expect((await post(bare, { action: 'integrationState' })).capabilities).toEqual(['complete-revisioned-reads', 'stable-identity'])
    expect(await post(bare, command('op-1', agreement())))
      .toEqual({ kind: 'unavailable', book: 'partner', reason: 'integration-schema-unavailable' })
  })

  it('writes one pending agreement in Partner terms and links it to the Personal group', async () => {
    const outcome = await post(harness, command('op-1', agreement()))
    expect(outcome).toMatchObject({ kind: 'committed', operationId: 'op-1', destinations: [{ id: 'op-1' }] })
    expect(entryRows(harness)).toEqual([
      ['op-1', '2026-09-20', 1200, 'cheng', '這筆平分', '尚未分類', '', 'cheng', 'dashboard-import', ''],
    ])

    const snapshot = await post(harness, { action: 'snapshot', scope: 'agreements' })
    expect(snapshot.records[0]).toMatchObject({
      id: 'op-1',
      revision: outcome.destinations[0].revision,
      origin: 'integration',
      link: { personalGroupId: 'obs-1:group' },
      category: '尚未分類',
    })
  })

  it('maps allocations relative to the payer', async () => {
    await post(harness, command('a', agreement({ allocation: 'entirely-partner' })))
    await post(harness, command('b', agreement({ payer: 'partner', allocation: 'entirely-cheng' })))
    await post(harness, command('c', agreement({ payer: 'partner', allocation: 'entirely-partner' })))
    expect(entryRows(harness).map((row) => [row[3], row[4]])).toEqual([
      ['cheng', '幫狗狗付'],
      ['翊', '幫狗狗付'],
      ['翊', '幫自己付'],
    ])
  })

  it('replays the recorded outcome and refuses a reused id with different content', async () => {
    const first = await post(harness, command('op-1', agreement()))
    expect(await post(harness, command('op-1', agreement()))).toEqual(first)
    expect(entryRows(harness)).toHaveLength(1)
    expect(await post(harness, command('op-1', agreement({ total: { amount: '1300', currency: 'TWD' } }), {
      contentDigest: 'another-digest',
    }))).toMatchObject({ kind: 'conflict', reason: 'operation-id-reused-with-different-content' })
    expect(entryRows(harness)).toHaveLength(1)
  })

  it('recovers an entry that landed before its operation was recorded, without appending again', async () => {
    const operations = harness.spreadsheet.getSheetByName('整合操作')!
    operations.failNextSetValues('lost before the operation row')
    expect((await post(harness, command('op-1', agreement()))).ok).toBe(false)
    expect(entryRows(harness)).toHaveLength(1)
    expect(await post(harness, { action: 'outcome', operationId: 'op-1' }))
      .toEqual({ kind: 'unavailable', book: 'partner', reason: 'no-such-operation' })

    expect(await post(harness, command('op-1', agreement()))).toMatchObject({ kind: 'committed' })
    expect(entryRows(harness)).toHaveLength(1)
    expect(await post(harness, { action: 'outcome', operationId: 'op-1' })).toMatchObject({ kind: 'committed' })
  })

  it('discovers an outcome during maintenance', async () => {
    await post(harness, command('op-1', agreement()))
    harness.setScriptProperty('INTEGRATION_OPEN', 'false')
    expect(await post(harness, { action: 'outcome', operationId: 'op-1' })).toMatchObject({ kind: 'committed' })
    expect(await post(harness, command('op-2', agreement()))).toEqual({ ok: false, error: '系統更新中' })
  })

  it('reports stale expected revisions as a conflict and writes nothing', async () => {
    const first = await post(harness, command('op-1', agreement()))
    const current = first.destinations[0].revision
    expect(await post(harness, command('op-2', agreement(), {
      expectedRevisions: [{ id: 'op-1', revision: current }, { id: 'gone', revision: 'r' }],
    }))).toEqual({
      kind: 'conflict',
      operationId: 'op-2',
      reason: 'expected-revision-changed',
      conflicts: [{ id: 'gone', expected: 'r', actual: 'missing' }],
    })
    expect(entryRows(harness)).toHaveLength(1)
  })

  it('refuses content the book cannot hold exactly instead of converting it', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ total: { amount: '20', currency: 'USD' } }, 'currency-not-supported-by-partner-book'],
      [{ total: { amount: '0.1000000000000000055511', currency: 'TWD' } }, 'amount-not-exactly-storable'],
      [{ selfName: '路人' }, 'self-name-is-not-a-partner'],
      [{ payer: 'someone' }, 'invalid-payer'],
      [{ allocation: 'thirds' }, 'invalid-allocation'],
      [{ category: '結清' }, 'unknown-category'],
      [{ effectiveDate: '20/09/2026' }, 'invalid-effective-date'],
      [{ purpose: 'refund-of-something' }, 'purpose-not-supported-by-partner-book'],
      [{ total: { amount: '20', currency: 'usd' } }, 'currency-not-supported-by-partner-book'],
      [{ purpose: undefined }, 'purpose-not-supported-by-partner-book'],
    ]
    for (const [overrides, reason] of cases) {
      expect(await post(harness, command(`bad-${reason}`, agreement(overrides))), reason)
        .toEqual({ kind: 'rejected', operationId: `bad-${reason}`, reason })
    }
    expect(await post(harness, command('x', { kind: 'settle' })))
      .toEqual({ kind: 'rejected', operationId: 'x', reason: 'unsupported-command-kind' })
    expect(entryRows(harness)).toEqual([])
  })

  it('records a shared settlement as a 結清 row and refuses one larger than what is owed', async () => {
    await post(harness, command('owed', agreement({ payer: 'partner', allocation: 'equal-halves' })))
    const settle = (id: string, amount: string) => command(id, agreement({
      purpose: 'shared-settlement', payer: 'cheng', allocation: undefined, total: { amount, currency: 'TWD' },
    }))
    expect(await post(harness, settle('too-much', '601'))).toMatchObject({ kind: 'rejected', reason: 'settlement-exceeds-outstanding' })
    expect(await post(harness, settle('settle-1', '600'))).toMatchObject({ kind: 'committed' })
    expect(entryRows(harness)[1]).toEqual(['settle-1', '2026-09-20', 600, 'cheng', '', '結清', '', 'cheng', 'dashboard-import', ''])
    const snapshot = await post(harness, { action: 'snapshot', scope: 'agreements' })
    expect(snapshot.records[1]).toMatchObject({ kind: 'settlement', split: null, origin: 'integration' })
  })

  it('records a refund beside the purchase, so both gross directions stay visible', async () => {
    await post(harness, command('buy', agreement({ total: { amount: '1200', currency: 'TWD' } })))
    await post(harness, command('refund', agreement({ purpose: 'shared-refund', total: { amount: '1200', currency: 'TWD' } })))
    expect(entryRows(harness).map((row) => [row[0], row[3], row[4], row[5]])).toEqual([
      ['buy', 'cheng', '這筆平分', '尚未分類'],
      ['refund', 'cheng', '這筆平分', '退款'],
    ])
    const snapshot = await post(harness, { action: 'snapshot', scope: 'agreements' })
    expect(snapshot.records[1]).toMatchObject({ kind: 'refund', split: '這筆平分', payer: 'cheng' })
    // 翊 still owes the original 600; cheng now owes 翊 their 600 of the refund.
    const list = await post(harness, { action: 'list_transactions', date_from: '2026-01-01', date_to: '2026-12-31' })
    expect(list.payables.directions).toEqual([
      { debtor: 'cheng', creditor: '翊', outstanding: 600 },
      { debtor: '翊', creditor: 'cheng', outstanding: 600 },
    ])
  })

  it('keeps another currency apart once the book has a 幣別 column', async () => {
    expect(await post(harness, command('usd-before', agreement({ total: { amount: '20', currency: 'USD' } }))))
      .toMatchObject({ kind: 'rejected', reason: 'currency-not-supported-by-partner-book' })

    harness.setupIntegrationSheet()
    harness.setupIntegrationSheet()
    const header = harness.spreadsheet.getSheetByName('帳目')!.getRange(1, 1, 1, 11).getValues()[0]!
    expect(header.filter((cell) => cell === '幣別')).toHaveLength(1)

    await post(harness, command('twd', agreement({ total: { amount: '100', currency: 'TWD' } })))
    await post(harness, command('usd', agreement({ total: { amount: '20', currency: 'USD' } })))
    const snapshot = await post(harness, { action: 'snapshot', scope: 'agreements' })
    expect(snapshot.records.map((record: Json) => record.amount)).toEqual([
      { amount: '100', currency: 'TWD' },
      { amount: '20', currency: 'USD' },
    ])
    const list = await post(harness, { action: 'list_transactions', date_from: '2026-01-01', date_to: '2026-12-31' })
    expect(list.payables).toEqual({
      directions: [
        { debtor: 'cheng', creditor: '翊', outstanding: 0 },
        { debtor: '翊', creditor: 'cheng', outstanding: 50 },
      ],
      otherCurrencies: [{
        currency: 'USD',
        directions: [
          { debtor: 'cheng', creditor: '翊', outstanding: 0 },
          { debtor: '翊', creditor: 'cheng', outstanding: 10 },
        ],
      }],
    })
    expect(list.transactions.map((transaction: Json) => transaction['幣別'])).toEqual(['USD', 'TWD'])

    const settleUsd = (id: string, amount: string) => command(id, agreement({
      purpose: 'shared-settlement', payer: 'partner', allocation: undefined, total: { amount, currency: 'USD' },
    }))
    expect(await post(harness, settleUsd('too-much', '11'))).toMatchObject({ reason: 'settlement-exceeds-outstanding' })
    expect(await post(harness, settleUsd('ok', '10'))).toMatchObject({ kind: 'committed' })
    expect(await post(harness, command('eur-none', agreement({
      purpose: 'shared-settlement', payer: 'partner', allocation: undefined, total: { amount: '1', currency: 'EUR' },
    })))).toMatchObject({ reason: 'settlement-exceeds-outstanding' })
  })

  it('accepts an exact decimal amount written with trailing zeros', async () => {
    expect(await post(harness, command('op-1', agreement({ total: { amount: '589.60', currency: 'TWD' } }))))
      .toMatchObject({ kind: 'committed' })
    expect(entryRows(harness)[0]![2]).toBe(589.6)
  })

  describe('Confirmation', () => {
    async function pendingAgreement(): Promise<string> {
      const created = await post(harness, command('op-1', agreement()))
      return created.destinations[0].revision
    }
    const confirm = (operationId: string, revision: string, overrides: Record<string, unknown> = {}) =>
      command(operationId, { kind: 'confirm-agreement', agreementId: 'op-1', category: '餐飲', ...overrides }, {
        expectedRevisions: [{ id: 'op-1', revision }],
      })

    it('sets the formal category and answers with the resulting revision', async () => {
      const reviewed = await pendingAgreement()
      const outcome = await post(harness, confirm('confirm-1', reviewed))
      expect(outcome).toMatchObject({ kind: 'committed', destinations: [{ id: 'op-1' }] })
      expect(outcome.destinations[0].revision).not.toBe(reviewed)
      expect(entryRows(harness)[0]![5]).toBe('餐飲')
      expect(await post(harness, confirm('confirm-1', reviewed))).toEqual(outcome)
    })

    it('rejects an invalid confirmation without editing the entry', async () => {
      const reviewed = await pendingAgreement()
      for (const [overrides, reason] of [
        [{ category: '尚未分類' }, 'confirmation-needs-a-formal-category'],
        [{ category: '結清' }, 'confirmation-needs-a-formal-category'],
        [{ category: '不存在' }, 'confirmation-needs-a-formal-category'],
        [{ agreementId: 'nope' }, 'unknown-agreement'],
      ] as const) {
        expect(await post(harness, confirm(`bad-${reason}-${overrides.category ?? ''}`, reviewed, overrides)))
          .toMatchObject({ kind: 'rejected', reason })
      }
      expect(await post(harness, command('no-rev', { kind: 'confirm-agreement', agreementId: 'op-1', category: '餐飲' })))
        .toMatchObject({ kind: 'rejected', reason: 'confirmation-needs-the-reviewed-revision' })
      expect(entryRows(harness)[0]![5]).toBe('尚未分類')
    })

    it('conflicts when the agreement changed after review, and accepts the state a lost response left', async () => {
      const reviewed = await pendingAgreement()
      harness.spreadsheet.getSheetByName('帳目')!.getRange(2, 3, 1, 1).setValues([[1300]])
      expect(await post(harness, confirm('confirm-1', reviewed))).toMatchObject({
        kind: 'conflict', reason: 'expected-revision-changed', conflicts: [{ id: 'op-1', expected: reviewed }],
      })
      expect(entryRows(harness)[0]![5]).toBe('尚未分類')

      const operations = harness.spreadsheet.getSheetByName('整合操作')!
      const current = (await post(harness, { action: 'snapshot', scope: 'agreements' })).records[0].revision
      operations.failNextSetValues('response lost after the category was written')
      expect((await post(harness, confirm('confirm-2', current))).ok).toBe(false)
      expect(entryRows(harness)[0]![5]).toBe('餐飲')
      expect(await post(harness, confirm('confirm-2', current))).toMatchObject({ kind: 'committed' })
    })

    it('refuses to confirm a settlement or a reversed agreement', async () => {
      const reviewed = await pendingAgreement()
      const sheet = harness.spreadsheet.getSheetByName('帳目')!
      sheet.getRange(3, 1, 1, entryHeaders.length).setValues([
        ['r1', '2026-09-21', 1200, 'cheng', '這筆平分', '尚未分類', '', 'cheng', 'web-app', 'op-1'],
      ])
      expect(await post(harness, confirm('confirm-1', reviewed)))
        .toMatchObject({ kind: 'rejected', reason: 'agreement-cannot-be-confirmed' })
    })
  })
})
