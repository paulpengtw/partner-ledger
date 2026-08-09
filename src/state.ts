import type { Split, Transaction } from './api'

export type EntryStep = 'amount' | 'payer' | 'split' | 'details' | 'confirm'

export type FormState = {
  step: EntryStep
  returnToConfirm: boolean
  amountText: string
  date: string
  payer: string | null
  split: Split
  category: string | null
  counterparty: string
  status: 'idle' | 'submitting' | 'success' | 'error'
  errorMessage: string | null
  idempotencyKey: string | null
}

export function initialState(date: string): FormState {
  return {
    step: 'amount',
    returnToConfirm: false,
    amountText: '',
    date,
    payer: null,
    split: '均分',
    category: null,
    counterparty: '',
    status: 'idle',
    errorMessage: null,
    idempotencyKey: null,
  }
}

const STEPS: EntryStep[] = ['amount', 'payer', 'split', 'details', 'confirm']

export function stepSequence(): EntryStep[] {
  return [...STEPS]
}

export function goNext(state: FormState): FormState {
  if (state.returnToConfirm && canSubmit(state)) {
    return { ...state, step: 'confirm', returnToConfirm: false }
  }
  const index = STEPS.indexOf(state.step)
  if (index < 0 || index >= STEPS.length - 1) return state
  return { ...state, step: STEPS[index + 1]! }
}

export function goBack(state: FormState): FormState {
  const index = STEPS.indexOf(state.step)
  if (index <= 0) return state
  return { ...state, step: STEPS[index - 1]! }
}

export function jumpTo(state: FormState, step: EntryStep): FormState {
  if (state.step === step) return state
  if (!STEPS.includes(step)) return state
  return { ...state, step }
}

export function jumpFromConfirm(
  state: FormState,
  step: EntryStep,
): FormState {
  if (state.step !== 'confirm') return state
  return {
    ...jumpTo(state, step),
    returnToConfirm: true,
  }
}

function edited(state: FormState, changes: Partial<FormState>): FormState {
  return {
    ...state,
    ...changes,
    status: 'idle',
    errorMessage: null,
    idempotencyKey: null,
  }
}

export function pressKey(state: FormState, key: string): FormState {
  let amountText = state.amountText
  if (key === '⌫') {
    amountText = amountText.slice(0, -1)
  } else if (key === '.') {
    if (amountText.includes('.')) return state
    amountText = amountText === '' ? '0.' : `${amountText}.`
  } else if (/^\d$/.test(key)) {
    const decimals = amountText.includes('.')
      ? amountText.length - amountText.indexOf('.') - 1
      : -1
    if (decimals >= 2 || amountText.replace('.', '').length >= 10) return state
    amountText = amountText === '0' ? key : `${amountText}${key}`
  } else {
    return state
  }
  return edited(state, { amountText })
}

export function selectPayer(state: FormState, payer: string): FormState {
  return goNext(edited(state, { payer }))
}

export function selectSplit(state: FormState, split: Split): FormState {
  return goNext(edited(state, { split }))
}

export const selectCategory = (state: FormState, category: string): FormState =>
  edited(state, { category })

export const setCounterparty = (
  state: FormState,
  counterparty: string,
): FormState => edited(state, { counterparty })

export const setDate = (state: FormState, date: string): FormState =>
  edited(state, { date })

export function amountValue(state: FormState): number {
  const amount = Number(state.amountText)
  return Number.isFinite(amount) ? amount : 0
}

export function previewEffect(
  state: FormState,
  partners: string[],
): { debtor: string; creditor: string; amount: number } | null {
  if (
    state.payer === null
    || partners.length !== 2
    || partners.some(partner => typeof partner !== 'string')
  ) {
    return null
  }
  const amount = amountValue(state)
  if (amount <= 0) return null
  const debtor = partners.find(partner => partner !== state.payer)
  if (debtor === undefined) return null

  return {
    debtor,
    creditor: state.payer,
    amount: state.split === '均分'
      ? amount / 2
      : state.split === '全額對方' ? amount : 0,
  }
}

export function canSubmit(state: FormState): boolean {
  return (
    state.status !== 'submitting'
    && amountValue(state) > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(state.date)
    && state.payer !== null
    && state.category !== null
  )
}

export function buildTransaction(state: FormState): Transaction {
  const transaction: Transaction = {
    date: state.date,
    amount: amountValue(state),
    payer: state.payer ?? '',
    split: state.split,
    category: state.category ?? '',
  }
  const counterparty = state.counterparty.trim()
  if (counterparty) transaction.payee = counterparty
  return transaction
}

export function beginSubmit(
  state: FormState,
  newUuid: () => string,
): FormState {
  return {
    ...state,
    status: 'submitting',
    errorMessage: null,
    idempotencyKey: state.idempotencyKey ?? newUuid(),
  }
}

export const submitSucceeded = (state: FormState): FormState => ({
  ...state,
  status: 'success',
  errorMessage: null,
})

export const submitFailed = (
  state: FormState,
  errorMessage: string,
): FormState => ({
  ...state,
  status: 'error',
  errorMessage,
})

export const resetForNext = (_state: FormState, date: string): FormState =>
  initialState(date)
