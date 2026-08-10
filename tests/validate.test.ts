import { describe, expect, it } from 'vitest'
import {
  isValidUuid,
  validateReversal,
  validateSettlement,
  validateTransaction,
  validateTransactionDateRange,
} from '../functions/lib/validate'

const valid = {
  date: '2026-08-09',
  amount: 300,
  payer: '小語',
  split: '這筆平分',
  category: '餐飲',
  payee: '全聯',
} as const

describe('validateTransaction', () => {
  it('accepts the full flat transaction', () => {
    expect(validateTransaction(valid)).toEqual({
      ok: true,
      transaction: valid,
    })
  })

  it('accepts an omitted payee', () => {
    const { payee: _payee, ...withoutPayee } = valid

    expect(validateTransaction(withoutPayee)).toEqual({
      ok: true,
      transaction: withoutPayee,
    })
  })

  it.each(['這筆平分', '幫狗狗付', '幫自己付'] as const)(
    'accepts the split %s',
    split => {
      expect(validateTransaction({ ...valid, split })).toEqual({
        ok: true,
        transaction: { ...valid, split },
      })
    },
  )

  it('rejects a split outside the closed enum', () => {
    expect(validateTransaction({ ...valid, split: '三七分' })).toEqual({
      ok: false,
      error: 'invalid split',
    })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '300'])(
    'rejects invalid amount %s',
    amount => {
      expect(validateTransaction({ ...valid, amount })).toEqual({
        ok: false,
        error: 'invalid amount',
      })
    },
  )

  it.each(['2026/08/09', '2026-02-30', '2026-13-01'])(
    'rejects invalid date %s',
    date => {
      expect(validateTransaction({ ...valid, date })).toEqual({
        ok: false,
        error: 'invalid date',
      })
    },
  )

  it('accepts leap day 2024-02-29', () => {
    expect(validateTransaction({ ...valid, date: '2024-02-29' }).ok).toBe(true)
  })

  it('rejects a blank payer', () => {
    expect(validateTransaction({ ...valid, payer: ' ' })).toEqual({
      ok: false,
      error: 'invalid payer',
    })
  })

  it('rejects a missing payer', () => {
    const { payer: _payer, ...withoutPayer } = valid

    expect(validateTransaction(withoutPayer)).toEqual({
      ok: false,
      error: 'invalid payer',
    })
  })

  it('rejects a blank category', () => {
    expect(validateTransaction({ ...valid, category: '' })).toEqual({
      ok: false,
      error: 'invalid category',
    })
  })

  it('rejects a present but blank payee', () => {
    expect(validateTransaction({ ...valid, payee: ' ' })).toEqual({
      ok: false,
      error: 'invalid payee',
    })
  })

  it('drops unknown fields', () => {
    expect(validateTransaction({ ...valid, userEmail: 'spoof@example.com' })).toEqual({
      ok: true,
      transaction: valid,
    })
  })

  it('rejects null input', () => {
    expect(validateTransaction(null)).toEqual({
      ok: false,
      error: 'invalid transaction',
    })
  })
})

describe('isValidUuid', () => {
  it('accepts a valid UUID shape', () => {
    expect(isValidUuid('3b241101-e2bb-4255-8caf-4136c566a962')).toBe(true)
  })

  it('rejects a non-UUID idempotency key', () => {
    expect(isValidUuid('not-a-uuid')).toBe(false)
  })
})

describe('validateSettlement', () => {
  const settlement = {
    date: '2026-08-09',
    amount: 100,
    payer: '阿哲',
  } as const

  it('accepts the flat settlement', () => {
    expect(validateSettlement(settlement)).toEqual({
      ok: true,
      settlement,
    })
  })

  it('requires amount', () => {
    const { amount: _amount, ...withoutAmount } = settlement

    expect(validateSettlement(withoutAmount)).toEqual({
      ok: false,
      error: 'invalid amount',
    })
  })

  it.each([0, -0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid amount %s',
    amount => {
      expect(validateSettlement({ ...settlement, amount })).toEqual({
        ok: false,
        error: 'invalid amount',
      })
    },
  )

  it('rejects a blank payer', () => {
    expect(validateSettlement({ ...settlement, payer: ' ' })).toEqual({
      ok: false,
      error: 'invalid payer',
    })
  })

  it('rejects an impossible date', () => {
    expect(validateSettlement({ ...settlement, date: '2026-02-30' })).toEqual({
      ok: false,
      error: 'invalid date',
    })
  })

  it('drops unknown fields', () => {
    expect(validateSettlement({ ...settlement, userEmail: 'spoof@example.com' })).toEqual({
      ok: true,
      settlement,
    })
  })
})

describe('validateReversal', () => {
  it('accepts only txn_id and a real calendar date', () => {
    expect(validateReversal({
      txn_id: 'row-1',
      date: '2026-08-09',
    })).toEqual({
      ok: true,
      reversal: {
        txn_id: 'row-1',
        date: '2026-08-09',
      },
    })
  })

  it('rejects a blank txn_id', () => {
    expect(validateReversal({
      txn_id: ' ',
      date: '2026-08-09',
    })).toEqual({
      ok: false,
      error: 'invalid txn_id',
    })
  })

  it('rejects an impossible date', () => {
    expect(validateReversal({
      txn_id: 'row-1',
      date: '2026-02-30',
    })).toEqual({
      ok: false,
      error: 'invalid date',
    })
  })
})

describe('validateTransactionDateRange', () => {
  it('accepts an inclusive real-calendar range', () => {
    expect(validateTransactionDateRange({
      date_from: '2026-07-01',
      date_to: '2026-07-31',
    })).toEqual({
      ok: true,
      date_from: '2026-07-01',
      date_to: '2026-07-31',
    })
  })

  it.each([
    [{ date_from: '2026/07/01', date_to: '2026-07-31' }, 'invalid date_from'],
    [{ date_from: '2026-02-30', date_to: '2026-07-31' }, 'invalid date_from'],
    [{ date_from: '2026-07-01', date_to: 'July 31, 2026' }, 'invalid date_to'],
    [{ date_from: '2026-07-01', date_to: '2026-02-30' }, 'invalid date_to'],
  ])('rejects malformed or impossible range boundary %#', (input, error) => {
    expect(validateTransactionDateRange(input)).toEqual({ ok: false, error })
  })

  it('names date_from later than date_to distinctly', () => {
    expect(validateTransactionDateRange({
      date_from: '2026-08-01',
      date_to: '2026-07-31',
    })).toEqual({
      ok: false,
      error: 'date_from later than date_to',
    })
  })
})
