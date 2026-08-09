export type Transaction = {
  date: string
  amount: number
  payer: string
  split: '均分' | '全額對方' | '全額自己'
  category: string
  payee?: string
}

export type Settlement = { date: string; amount: number; payer: string }
export type Reversal = { txn_id: string; date: string }

type ValidationResult =
  | { ok: true; transaction: Transaction }
  | { ok: false; error: string }

type TransactionDateRangeValidationResult =
  | { ok: true; date_from: string; date_to: string }
  | { ok: false; error: string }

type SettlementValidationResult =
  | { ok: true; settlement: Settlement }
  | { ok: false; error: string }

type ReversalValidationResult =
  | { ok: true; reversal: Reversal }
  | { ok: false; error: string }

const SPLITS = new Set(['均分', '全額對方', '全額自己'])

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1] ?? 0
  return day >= 1 && day <= daysInMonth
}

export function validateTransactionDateRange(
  input: unknown,
): TransactionDateRangeValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'invalid date_from' }
  }
  const candidate = input as Record<string, unknown>

  if (!isRealDate(candidate.date_from)) {
    return { ok: false, error: 'invalid date_from' }
  }
  if (!isRealDate(candidate.date_to)) {
    return { ok: false, error: 'invalid date_to' }
  }
  if (candidate.date_from > candidate.date_to) {
    return { ok: false, error: 'date_from later than date_to' }
  }

  return {
    ok: true,
    date_from: candidate.date_from,
    date_to: candidate.date_to,
  }
}

export function validateTransaction(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'invalid transaction' }
  }
  const candidate = input as Record<string, unknown>

  if (
    typeof candidate.amount !== 'number'
    || !Number.isFinite(candidate.amount)
    || candidate.amount <= 0
  ) {
    return { ok: false, error: 'invalid amount' }
  }
  if (!isRealDate(candidate.date)) {
    return { ok: false, error: 'invalid date' }
  }
  if (
    typeof candidate.payer !== 'string'
    || candidate.payer.trim() === ''
  ) {
    return { ok: false, error: 'invalid payer' }
  }
  if (
    typeof candidate.split !== 'string'
    || !SPLITS.has(candidate.split)
  ) {
    return { ok: false, error: 'invalid split' }
  }
  if (
    typeof candidate.category !== 'string'
    || candidate.category.trim() === ''
  ) {
    return { ok: false, error: 'invalid category' }
  }
  if (
    candidate.payee !== undefined
    && (
      typeof candidate.payee !== 'string'
      || candidate.payee.trim() === ''
    )
  ) {
    return { ok: false, error: 'invalid payee' }
  }

  const transaction: Transaction = {
    date: candidate.date,
    amount: candidate.amount,
    payer: candidate.payer,
    split: candidate.split as Transaction['split'],
    category: candidate.category,
  }
  if (typeof candidate.payee === 'string') transaction.payee = candidate.payee

  return { ok: true, transaction }
}

export function validateSettlement(input: unknown): SettlementValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'invalid settlement' }
  }
  const candidate = input as Record<string, unknown>

  if (!isRealDate(candidate.date)) {
    return { ok: false, error: 'invalid date' }
  }
  if (
    typeof candidate.amount !== 'number'
    || !Number.isFinite(candidate.amount)
    || candidate.amount <= 0
  ) {
    return { ok: false, error: 'invalid amount' }
  }
  if (
    typeof candidate.payer !== 'string'
    || candidate.payer.trim() === ''
  ) {
    return { ok: false, error: 'invalid payer' }
  }

  return {
    ok: true,
    settlement: {
      date: candidate.date,
      amount: candidate.amount,
      payer: candidate.payer,
    },
  }
}

export function validateReversal(input: unknown): ReversalValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'invalid txn_id' }
  }
  const candidate = input as Record<string, unknown>

  if (
    typeof candidate.txn_id !== 'string'
    || candidate.txn_id.trim() === ''
  ) {
    return { ok: false, error: 'invalid txn_id' }
  }
  if (!isRealDate(candidate.date)) {
    return { ok: false, error: 'invalid date' }
  }

  return {
    ok: true,
    reversal: {
      txn_id: candidate.txn_id,
      date: candidate.date,
    },
  }
}
