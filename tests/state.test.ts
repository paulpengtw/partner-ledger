import { describe, expect, it, vi } from 'vitest'
import {
  amountValue,
  beginSubmit,
  buildTransaction,
  canSubmit,
  goBack,
  goNext,
  initialState,
  jumpFromConfirm,
  jumpTo,
  pressKey,
  previewEffect,
  resetForNext,
  selectCategory,
  selectPayer,
  selectSplit,
  setCounterparty,
  setDate,
  stepSequence,
  submitFailed,
  submitSucceeded,
  type FormState,
} from '../src/state'

const DATE = '2026-07-27'
const PARTNERS = ['阿哲', '小語']

function amountState(amount: string): FormState {
  let state = initialState(DATE)
  for (const key of amount) state = pressKey(state, key)
  return state
}

function submitReady(): FormState {
  let state = amountState('300')
  state = selectPayer(state, '小語')
  state = selectSplit(state, '這筆平分')
  state = selectCategory(state, '餐飲')
  state = setCounterparty(state, '全聯')
  return state
}

describe('fresh form and wizard navigation', () => {
  it('preselects 這筆平分 on a fresh form', () => {
    expect(initialState(DATE)).toMatchObject({
      step: 'amount',
      split: '這筆平分',
      payer: null,
      category: null,
    })
  })

  it('walks amount to payer to split to details to confirm', () => {
    let state = initialState(DATE)
    expect(stepSequence()).toEqual(['amount', 'payer', 'split', 'details', 'confirm'])

    const steps = [state.step]
    for (let index = 0; index < 4; index += 1) {
      state = goNext(state)
      steps.push(state.step)
    }

    expect(steps).toEqual(['amount', 'payer', 'split', 'details', 'confirm'])
    expect(goNext(state)).toEqual(state)
    expect(goBack(state).step).toBe('details')
  })

  it('selectPayer and selectSplit set their values and advance one step', () => {
    const afterPayer = selectPayer(goNext(initialState(DATE)), '小語')
    expect(afterPayer).toMatchObject({ payer: '小語', step: 'split' })

    const afterSplit = selectSplit(afterPayer, '幫狗狗付')
    expect(afterSplit).toMatchObject({ split: '幫狗狗付', step: 'details' })
  })

  it('returns to confirm after selecting a payer while editing from confirm', () => {
    const confirm = jumpTo(submitReady(), 'confirm')
    const editing = jumpFromConfirm(confirm, 'payer')

    expect(editing).toMatchObject({ step: 'payer', returnToConfirm: true })

    const selected = selectPayer(editing, '阿哲')
    expect(selected).toMatchObject({
      payer: '阿哲',
      step: 'confirm',
      returnToConfirm: false,
    })
  })
})

describe('derived preview', () => {
  it('derives a half share for 300 這筆平分 paid by 小語', () => {
    const state = selectPayer(amountState('300'), '小語')

    expect(previewEffect(state, PARTNERS)).toEqual({
      debtor: '阿哲',
      creditor: '小語',
      amount: 150,
    })
  })

  it('keeps odd 這筆平分 amounts exact to the half dollar', () => {
    const state = selectPayer(amountState('101'), '小語')

    expect(previewEffect(state, PARTNERS)).toEqual({
      debtor: '阿哲',
      creditor: '小語',
      amount: 50.5,
    })
  })

  it.each([
    ['幫狗狗付', 300],
    ['幫自己付', 0],
  ] as const)('derives %s as %s for the payer', (split, amount) => {
    let state = selectPayer(amountState('300'), '小語')
    state = selectSplit(state, split)

    expect(previewEffect(state, PARTNERS)).toEqual({
      debtor: '阿哲',
      creditor: '小語',
      amount,
    })
  })

  it('returns null before a payer is chosen', () => {
    expect(previewEffect(amountState('300'), PARTNERS)).toBeNull()
  })
})

describe('submit gating and transaction construction', () => {
  it('requires a positive amount, payer, category, and YYYY-MM-DD date', () => {
    const ready = submitReady()

    expect(canSubmit(ready)).toBe(true)
    expect(canSubmit(initialState(DATE))).toBe(false)
    expect(canSubmit({ ...ready, amountText: '' })).toBe(false)
    expect(canSubmit({ ...ready, payer: null })).toBe(false)
    expect(canSubmit({ ...ready, category: null })).toBe(false)
    expect(canSubmit({ ...ready, date: '2026/07/27' })).toBe(false)
    expect(canSubmit({ ...ready, status: 'submitting' })).toBe(false)
  })

  it('builds the flat transaction and omits a blank payee', () => {
    const state = setCounterparty(submitReady(), '   ')

    expect(buildTransaction(state)).toEqual({
      date: DATE,
      amount: 300,
      payer: '小語',
      split: '這筆平分',
      category: '餐飲',
    })
    expect(buildTransaction(state)).not.toHaveProperty('payee')
  })

  it('includes a trimmed payee when counterparty has content', () => {
    const state = setCounterparty(submitReady(), '  全聯  ')

    expect(buildTransaction(state)).toEqual({
      date: DATE,
      amount: 300,
      payer: '小語',
      split: '這筆平分',
      category: '餐飲',
      payee: '全聯',
    })
  })

  it('keeps keypad amount parsing immutable', () => {
    const state = amountState('12.50')

    expect(state.amountText).toBe('12.50')
    expect(amountValue(state)).toBe(12.5)
    expect(pressKey(state, '.')).toEqual(state)
  })
})

describe('submission lifecycle', () => {
  it('mints one idempotency key, keeps it across retry, and edited clears it', () => {
    const firstUuid = vi.fn(() => 'uuid-1')
    const secondUuid = vi.fn(() => 'uuid-2')
    const ready = submitReady()

    const submitting = beginSubmit(ready, firstUuid)
    expect(submitting).toMatchObject({ status: 'submitting', idempotencyKey: 'uuid-1' })
    expect(firstUuid).toHaveBeenCalledTimes(1)

    const failed = submitFailed(submitting, '沒有網路連線，請再試一次')
    expect(failed).toMatchObject({
      status: 'error',
      errorMessage: '沒有網路連線，請再試一次',
      idempotencyKey: 'uuid-1',
    })

    const retrying = beginSubmit(failed, secondUuid)
    expect(retrying).toMatchObject({ status: 'submitting', idempotencyKey: 'uuid-1' })
    expect(secondUuid).not.toHaveBeenCalled()

    const edited = setCounterparty(retrying, '家樂福')
    expect(edited).toMatchObject({
      status: 'idle',
      errorMessage: null,
      idempotencyKey: null,
    })

    expect(submitSucceeded(retrying)).toMatchObject({
      status: 'success',
      errorMessage: null,
      idempotencyKey: 'uuid-1',
    })
  })

  it('resetForNext starts a new form with 這筆平分 selected', () => {
    const reset = resetForNext({ ...submitReady(), split: '幫自己付' }, '2026-07-28')

    expect(reset).toEqual(initialState('2026-07-28'))
    expect(reset).toMatchObject({ step: 'amount', split: '這筆平分', returnToConfirm: false })
  })
})
