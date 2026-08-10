import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPTIONS_CACHE_KEY,
  listTransactions,
  loadOptions,
  reverseTransaction,
  settle,
  submitTransaction,
  type LedgerTransaction,
  type Transaction,
} from '../src/api'

const KEY = '3b241101-e2bb-4255-8caf-4136c566a962'
const TRANSACTION: Transaction = {
  date: '2026-07-27',
  amount: 260,
  payer: '小語',
  split: '這筆平分',
  category: '餐飲',
  payee: '全聯',
}
const SETTLEMENT = {
  date: '2026-07-27',
  amount: 200,
  payer: '阿哲',
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

const CACHED_WIRE_OPTIONS = {
  schema_version: 'schema-old',
  categories: ['餐飲', '交通'],
  payees: ['全聯', '小明'],
  partners: ['阿哲', '小語'],
}

const REFRESHED_WIRE_OPTIONS = {
  schema_version: 'schema-new',
  categories: ['餐飲', '交通', '醫療'],
  payees: ['全聯', '小明', '家樂福'],
  partners: ['阿哲', '小語'],
}

const CACHED_OPTIONS = {
  schema_version: 'schema-old',
  categories: ['餐飲', '交通'],
  counterparties: ['全聯', '小明'],
  partners: ['阿哲', '小語'],
}

const REFRESHED_OPTIONS = {
  schema_version: 'schema-new',
  categories: ['餐飲', '交通', '醫療'],
  counterparties: ['全聯', '小明', '家樂福'],
  partners: ['阿哲', '小語'],
}

const LEDGER_TRANSACTION: LedgerTransaction = {
  txn_id: 'txn-001',
  日期: '2026-07-27',
  金額: '260',
  付款人: '小語',
  分攤方式: '這筆平分',
  分類: '餐飲',
  交易對象: '全聯',
  記帳人: '小語',
  來源: 'pwa',
  沖銷txn_id: '',
  voided: false,
}

const jsonFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => jsonResponse(status, body)) as typeof fetch

afterEach(() => {
  vi.useRealTimers()
})

describe('submitTransaction', () => {
  it('posts the flat transaction contract and maps success', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/create_transaction')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        transaction: TRANSACTION,
        idempotencyKey: KEY,
      })
      return jsonResponse(200, { ok: true, txn_id: KEY })
    }) as unknown as typeof fetch

    await expect(submitTransaction(TRANSACTION, KEY, fetchFn)).resolves.toEqual({
      ok: true,
      alreadyRecorded: false,
    })
  })

  it('treats already:true as idempotent success', async () => {
    await expect(
      submitTransaction(TRANSACTION, KEY, jsonFetch({ ok: true, already: true })),
    ).resolves.toEqual({
      ok: true,
      alreadyRecorded: true,
    })
  })

  it.each([
    ['401', () => jsonResponse(401, { ok: false, error: 'unauthorized' })],
    ['opaqueredirect', () => ({
      type: 'opaqueredirect',
      status: 0,
      ok: false,
      json: async () => { throw new TypeError('opaque response has no body') },
    }) as unknown as Response],
  ])('classifies %s as an expired session', async (_label, response) => {
    await expect(submitTransaction(TRANSACTION, KEY, (async () => response()) as typeof fetch))
      .resolves.toEqual({
        ok: false,
        kind: 'auth',
        message: '登入已過期',
      })
  })

  it('classifies an aborted request as a timeout network error', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })) as unknown as typeof fetch

    const request = submitTransaction(TRANSACTION, KEY, fetchFn)
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(request).resolves.toEqual({
      ok: false,
      kind: 'network',
      message: '連線逾時，請再試一次',
    })
  })

  it('passes a backend error message through unchanged', async () => {
    await expect(
      submitTransaction(TRANSACTION, KEY, jsonFetch({ ok: false, error: '分類不存在' }, 400)),
    ).resolves.toEqual({
      ok: false,
      kind: 'backend',
      message: '分類不存在',
    })
  })
})

describe('settle', () => {
  it('posts the settlement contract and classifies success like submitTransaction', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/settle')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        ...SETTLEMENT,
        idempotencyKey: KEY,
      })
      return jsonResponse(200, { ok: true })
    }) as unknown as typeof fetch

    await expect(settle(SETTLEMENT, KEY, fetchFn)).resolves.toEqual({
      ok: true,
      alreadyRecorded: false,
    })
  })

  it('classifies an expired session like submitTransaction', async () => {
    const fetchFn = (async () => ({
      type: 'opaqueredirect',
      status: 0,
      ok: false,
      json: async () => { throw new TypeError('opaque response has no body') },
    }) as unknown as Response) as typeof fetch

    await expect(settle(SETTLEMENT, KEY, fetchFn)).resolves.toEqual({
      ok: false,
      kind: 'auth',
      message: '登入已過期',
    })
  })
})

describe('reverseTransaction', () => {
  it('posts the reversal contract and maps success', async () => {
    const reversal = { txn_id: 'txn-001', date: '2026-07-27' }
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/reverse_transaction')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        ...reversal,
        idempotencyKey: KEY,
      })
      return jsonResponse(200, { ok: true })
    }) as unknown as typeof fetch

    await expect(reverseTransaction(reversal, KEY, fetchFn)).resolves.toEqual({
      ok: true,
      alreadyRecorded: false,
    })
  })
})

describe('listTransactions', () => {
  it('posts the inclusive date range and parses transactions with payables', async () => {
    const body = {
      transactions: [LEDGER_TRANSACTION],
      payables: {
        directions: [
          { debtor: '阿哲', creditor: '小語', outstanding: 130 },
          { debtor: '小語', creditor: '阿哲', outstanding: 0 },
        ],
      },
    }
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/list_transactions')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        date_from: '0001-01-01',
        date_to: '9999-12-31',
      })
      return jsonResponse(200, body)
    }) as unknown as typeof fetch

    await expect(
      listTransactions('0001-01-01', '9999-12-31', fetchFn),
    ).resolves.toEqual(body)
  })

  it('returns null for the retired array response shape', async () => {
    await expect(
      listTransactions('2026-07-01', '2026-07-31', jsonFetch([LEDGER_TRANSACTION])),
    ).resolves.toBeNull()
  })

  it('returns null when a payable outstanding value is non-finite', async () => {
    await expect(
      listTransactions(
        '2026-07-01',
        '2026-07-31',
        jsonFetch({
          transactions: [LEDGER_TRANSACTION],
          payables: {
            directions: [{ debtor: '阿哲', creditor: '小語', outstanding: Number.NaN }],
          },
        }),
      ),
    ).resolves.toBeNull()
  })
})

describe('loadOptions', () => {
  it('serves cached options synchronously, refreshes, maps payees, and caches raw wire data', async () => {
    const storage = memoryStorage()
    storage.setItem(OPTIONS_CACHE_KEY, JSON.stringify(CACHED_WIRE_OPTIONS))
    const onRefresh = vi.fn()
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('/api/get_options')
      return jsonResponse(200, REFRESHED_WIRE_OPTIONS)
    }) as unknown as typeof fetch

    const loaded = loadOptions({ storage, fetchFn, onRefresh })

    expect(loaded.cached).toEqual(CACHED_OPTIONS)
    expect(onRefresh).not.toHaveBeenCalled()

    await expect(loaded.refresh).resolves.toEqual(REFRESHED_OPTIONS)
    expect(onRefresh).toHaveBeenCalledWith(REFRESHED_OPTIONS)
    expect(JSON.parse(storage.getItem(OPTIONS_CACHE_KEY)!)).toEqual(REFRESHED_WIRE_OPTIONS)
  })

  it('rejects a response whose partners are not exactly two strings without caching it', async () => {
    const storage = memoryStorage()
    const onRefresh = vi.fn()
    const invalidOptions = {
      ...REFRESHED_WIRE_OPTIONS,
      partners: ['阿哲'],
    }
    const fetchFn = jsonFetch(invalidOptions)

    const loaded = loadOptions({ storage, fetchFn, onRefresh })

    expect(loaded.cached).toBeNull()
    await expect(loaded.refresh).resolves.toBeNull()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(storage.getItem(OPTIONS_CACHE_KEY)).toBeNull()
  })
})
