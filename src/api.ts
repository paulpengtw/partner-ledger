export type Split = '這筆平分' | '幫狗狗付' | '幫自己付'

export type Transaction = {
  date: string
  amount: number
  payer: string
  split: Split
  category: string
  payee?: string
}

export type LedgerTransaction = {
  txn_id: string
  日期: string
  金額: string
  付款人: string
  分攤方式: string
  分類: string
  交易對象: string
  記帳人: string
  來源: string
  沖銷txn_id: string
  voided: boolean
}

export type PayableDirection = {
  debtor: string
  creditor: string
  outstanding: number
}

export type ListResult = {
  transactions: LedgerTransaction[]
  payables: {
    directions: PayableDirection[]
  }
}

export type LedgerOptions = {
  schema_version: string
  categories: string[]
  payees: string[]
  partners: string[]
}

export type CounterpartyOptions = {
  schema_version: string
  categories: string[]
  counterparties: string[]
  partners: string[]
}

export type Settlement = {
  date: string
  amount: number
  payer: string
}

export type Reversal = {
  txn_id: string
  date: string
}

export type SubmitResult =
  | { ok: true; alreadyRecorded: boolean }
  | { ok: false; kind: 'network' | 'auth' | 'backend'; message: string }

export const OPTIONS_CACHE_KEY = 'partner-ledger:get_options:v1'
const TIMEOUT_MS = 15_000

async function post(
  path: string,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetchFn(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Marks the call as programmatic so Cloudflare Access answers 401, not a 302.
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function submitWrite(
  path: string,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<SubmitResult> {
  let response: Response
  try {
    response = await post(path, body, fetchFn)
  } catch (error) {
    return {
      ok: false,
      kind: 'network',
      message: isTimeout(error) ? '連線逾時，請再試一次' : '沒有網路連線，請再試一次',
    }
  }

  if (response.status === 401 || response.type === 'opaqueredirect') {
    return { ok: false, kind: 'auth', message: '登入已過期' }
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return {
      ok: false,
      kind: 'backend',
      message: `伺服器錯誤 (${response.status})`,
    }
  }

  const result = typeof parsed === 'object' && parsed !== null
    ? parsed as Record<string, unknown>
    : {}
  if (response.ok && result.ok === true) {
    return { ok: true, alreadyRecorded: result.already === true }
  }
  return {
    ok: false,
    kind: 'backend',
    message: typeof result.error === 'string'
      ? result.error
      : `伺服器錯誤 (${response.status})`,
  }
}

export async function submitTransaction(
  transaction: Transaction,
  idempotencyKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<SubmitResult> {
  return submitWrite(
    '/api/create_transaction',
    { transaction, idempotencyKey },
    fetchFn,
  )
}

export async function settle(
  settlement: Settlement,
  idempotencyKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<SubmitResult> {
  return submitWrite(
    '/api/settle',
    { ...settlement, idempotencyKey },
    fetchFn,
  )
}

export async function reverseTransaction(
  reversal: Reversal,
  idempotencyKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<SubmitResult> {
  return submitWrite(
    '/api/reverse_transaction',
    { ...reversal, idempotencyKey },
    fetchFn,
  )
}

export async function authCheck(
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; exp: number } | { ok: false }> {
  try {
    const response = await post('/api/auth-check', {}, fetchFn)
    if (!response.ok) return { ok: false }
    const body = await response.json() as { ok?: boolean; exp?: number }
    if (body.ok === true && typeof body.exp === 'number') {
      return { ok: true, exp: body.exp }
    }
  } catch {
    // A failed auth check cannot prove that the session is still valid.
  }
  return { ok: false }
}

const LEDGER_TRANSACTION_FIELDS = [
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
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isLedgerTransaction(value: unknown): value is LedgerTransaction {
  if (!isRecord(value)) return false
  return LEDGER_TRANSACTION_FIELDS.every(field => typeof value[field] === 'string')
    && typeof value.voided === 'boolean'
}

function isPayableDirection(value: unknown): value is PayableDirection {
  if (!isRecord(value)) return false
  return (
    typeof value.debtor === 'string'
    && typeof value.creditor === 'string'
    && typeof value.outstanding === 'number'
    && Number.isFinite(value.outstanding)
  )
}

function isListResult(value: unknown): value is ListResult {
  if (!isRecord(value) || !isRecord(value.payables)) return false
  return (
    Array.isArray(value.transactions)
    && value.transactions.every(isLedgerTransaction)
    && Array.isArray(value.payables.directions)
    && value.payables.directions.every(isPayableDirection)
  )
}

export async function listTransactions(
  dateFrom: string,
  dateTo: string,
  fetchFn: typeof fetch = fetch,
): Promise<ListResult | null> {
  try {
    const response = await post(
      '/api/list_transactions',
      { date_from: dateFrom, date_to: dateTo },
      fetchFn,
    )
    if (!response.ok) return null
    const body: unknown = await response.json()
    return isListResult(body) ? body : null
  } catch {
    return null
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && [...value].every(item => typeof item === 'string')
}

function isLedgerOptions(value: unknown): value is LedgerOptions {
  if (!isRecord(value)) return false
  return (
    typeof value.schema_version === 'string'
    && isStringArray(value.categories)
    && isStringArray(value.payees)
    && isStringArray(value.partners)
    && value.partners.length === 2
  )
}

export async function fetchOptions(
  fetchFn: typeof fetch = fetch,
): Promise<LedgerOptions | null> {
  try {
    const response = await post('/api/get_options', {}, fetchFn)
    if (!response.ok) return null
    const body: unknown = await response.json()
    return isLedgerOptions(body) ? body : null
  } catch {
    return null
  }
}

function toCounterpartyOptions(options: LedgerOptions): CounterpartyOptions {
  const { payees: counterparties, ...rest } = options
  return { ...rest, counterparties }
}

function readCachedOptions(storage: Storage | undefined): CounterpartyOptions | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(OPTIONS_CACHE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isLedgerOptions(parsed) ? toCounterpartyOptions(parsed) : null
  } catch {
    return null
  }
}

export function loadOptions(deps: {
  storage?: Storage
  fetchFn?: typeof fetch
  onRefresh?: (options: CounterpartyOptions) => void
} = {}): {
  cached: CounterpartyOptions | null
  refresh: Promise<CounterpartyOptions | null>
} {
  const storage = deps.storage ?? (
    typeof localStorage === 'undefined' ? undefined : localStorage
  )
  const cached = readCachedOptions(storage)
  const refresh = fetchOptions(deps.fetchFn).then(wireOptions => {
    if (!wireOptions) return null
    try {
      storage?.setItem(OPTIONS_CACHE_KEY, JSON.stringify(wireOptions))
    } catch {
      // Private browsing or a full quota must not block entry.
    }
    const options = toCounterpartyOptions(wireOptions)
    deps.onRefresh?.(options)
    return options
  })
  return { cached, refresh }
}
