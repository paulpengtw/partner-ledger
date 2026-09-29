// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHED_OPTIONS,
  LIST_RESULT,
  OVER_SETTLED_RESULT,
  transaction,
} from './pwa-fixtures'

const FIXED_UUID = '3b241101-e2bb-4255-8caf-4136c566a962'

const apiMocks = vi.hoisted(() => ({
  authCheck: vi.fn(),
  listTransactions: vi.fn(),
  loadOptions: vi.fn(),
  reverseTransaction: vi.fn(),
  settle: vi.fn(),
  submitTransaction: vi.fn(),
}))

vi.mock('../src/api', () => apiMocks)

import { mountApp } from '../src/main'

let unmount: (() => void) | undefined

function click(selector: string): void {
  const element = document.querySelector<HTMLButtonElement>(selector)
  if (!element) throw new Error(`button not found: ${selector}`)
  element.click()
}

function input(selector: string, value: string): void {
  const element = document.querySelector<HTMLInputElement>(selector)
  if (!element) throw new Error(`input not found: ${selector}`)
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function mount(result = LIST_RESULT): void {
  apiMocks.listTransactions.mockResolvedValue(result)
  apiMocks.loadOptions.mockReturnValue({
    cached: CACHED_OPTIONS,
    refresh: new Promise(() => {}),
  })
  unmount = mountApp(document.querySelector<HTMLElement>('#app')!, {
    today: () => '2026-08-09',
    randomUUID: () => FIXED_UUID,
  })
}

function enterConfirm(split = '這筆平分'): void {
  for (const key of ['3', '0', '0']) click(`#keypad [data-key="${key}"]`)
  click('#next-amount')
  click('#payer-buttons [data-payer="小語"]')
  click(`#split-buttons [data-split="${split}"]`)
  click('#category-grid [data-category="餐飲"]')
  click('.step-panel[data-step="details"] .step-next')
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
  apiMocks.authCheck.mockReset().mockResolvedValue({
    ok: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  apiMocks.listTransactions.mockReset().mockResolvedValue(LIST_RESULT)
  apiMocks.loadOptions.mockReset()
  apiMocks.reverseTransaction.mockReset().mockResolvedValue({
    ok: true,
    alreadyRecorded: false,
  })
  apiMocks.settle.mockReset().mockResolvedValue({
    ok: true,
    alreadyRecorded: false,
  })
  apiMocks.submitTransaction.mockReset().mockResolvedValue({
    ok: true,
    alreadyRecorded: false,
  })
})

afterEach(() => {
  unmount?.()
  unmount = undefined
})

describe('partner entry wizard', () => {
  it('starts at amount, types 300, and renders two unselected payer buttons', () => {
    mount()

    expect(document.querySelector('#entry-view')?.getAttribute('data-active-step'))
      .toBe('amount')
    expect(document.querySelectorAll('.step-panel[aria-hidden="false"]'))
      .toHaveLength(1)
    expect(document.querySelector('#next-amount'))
      .toHaveProperty('disabled', true)

    for (const key of ['3', '0', '0']) click(`#keypad [data-key="${key}"]`)

    expect(document.querySelector('#amount-display')?.textContent).toBe('300')
    expect(document.querySelector('#next-amount'))
      .toHaveProperty('disabled', false)
    click('#next-amount')

    expect(document.querySelector('#entry-view')?.getAttribute('data-active-step'))
      .toBe('payer')
    const payerButtons = document.querySelectorAll<HTMLButtonElement>(
      '#payer-buttons [data-payer]',
    )
    expect([...payerButtons].map(button => button.dataset['payer']))
      .toEqual(['阿哲', '小語'])
    expect([...payerButtons].map(button => button.getAttribute('aria-pressed')))
      .toEqual(['false', 'false'])
  })

  it('advances from payer to split and from the default equal split to details', () => {
    mount()
    for (const key of ['3', '0', '0']) click(`#keypad [data-key="${key}"]`)
    click('#next-amount')

    click('#payer-buttons [data-payer="小語"]')
    expect(document.querySelector('#entry-view')?.getAttribute('data-active-step'))
      .toBe('split')
    const splitButtons = document.querySelectorAll<HTMLButtonElement>(
      '#split-buttons [data-split]',
    )
    expect([...splitButtons].map(button => button.textContent)).toEqual([
      '這筆平分',
      '幫狗狗付',
      '幫自己付',
    ])
    expect(splitButtons[0]?.getAttribute('aria-pressed')).toBe('true')

    click('#split-buttons [data-split="這筆平分"]')
    expect(document.querySelector('#entry-view')?.getAttribute('data-active-step'))
      .toBe('details')
  })

  it('shows the equal-share payable preview on confirm', () => {
    mount()
    enterConfirm()

    expect(document.querySelector('#entry-view')?.getAttribute('data-active-step'))
      .toBe('confirm')
    expect(document.querySelector('#confirm-card')?.textContent)
      .toContain('300')
    expect(document.querySelector('#confirm-card')?.textContent)
      .toContain('小語')
    expect(document.querySelector('#confirm-card')?.textContent)
      .toContain('這筆平分')
    expect(document.querySelector('#confirm-card')?.textContent)
      .toContain('餐飲')
    expect(document.querySelector('#preview')?.textContent)
      .toContain('阿哲 應付 小語')
    expect(document.querySelector('#preview')?.textContent).toContain('150')
  })

  it('shows no payable for the full-self split', () => {
    mount()
    enterConfirm('幫自己付')

    expect(document.querySelector('#preview')?.textContent)
      .toContain('不產生應付')
  })

  it('edits payer from confirm and returns directly with a reversed preview', () => {
    mount()
    enterConfirm()

    click('#confirm-card [data-edit="payer"]')
    expect(document.querySelector('#entry-view')?.getAttribute('data-active-step'))
      .toBe('payer')
    click('#payer-buttons [data-payer="阿哲"]')

    expect(document.querySelector('#entry-view')?.getAttribute('data-active-step'))
      .toBe('confirm')
    expect(document.querySelector('#confirm-card')?.textContent).toContain('阿哲')
    expect(document.querySelector('#preview')?.textContent)
      .toContain('小語 應付 阿哲')
    expect(document.querySelector('#preview')?.textContent).toContain('150')
  })

  it('submits the exact transaction, resets immediately, and refreshes the list', async () => {
    mount()
    enterConfirm()

    click('#submit-button')
    await vi.waitFor(() => {
      expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(1)
    })

    expect(apiMocks.submitTransaction).toHaveBeenCalledWith({
      date: '2026-08-09',
      amount: 300,
      payer: '小語',
      split: '這筆平分',
      category: '餐飲',
    }, FIXED_UUID)
    expect(document.querySelector('#entry-view')?.getAttribute('data-active-step'))
      .toBe('amount')
    expect(document.querySelector('#split-buttons [data-split="這筆平分"]')
      ?.getAttribute('aria-pressed')).toBe('true')
    await vi.waitFor(() => {
      expect(apiMocks.listTransactions).toHaveBeenCalledTimes(2)
    })
  })

  it('shows backend errors and reuses the idempotency key on retry', async () => {
    apiMocks.submitTransaction
      .mockResolvedValueOnce({
        ok: false,
        kind: 'backend',
        message: '伺服器暫時忙碌',
      })
      .mockResolvedValueOnce({ ok: true, alreadyRecorded: false })
    mount()
    enterConfirm()

    click('#submit-button')
    await vi.waitFor(() => {
      expect(document.querySelector('#submit-note')?.textContent)
        .toContain('伺服器暫時忙碌')
    })
    const firstKey = apiMocks.submitTransaction.mock.calls[0]?.[1]

    click('#submit-button')
    await vi.waitFor(() => {
      expect(apiMocks.submitTransaction).toHaveBeenCalledTimes(2)
    })
    expect(apiMocks.submitTransaction.mock.calls[1]?.[1]).toBe(firstKey)
  })

  it('shows the auth overlay when submit reports an auth failure', async () => {
    apiMocks.submitTransaction.mockResolvedValue({
      ok: false,
      kind: 'auth',
      message: '登入已過期',
    })
    mount()
    enterConfirm()

    click('#submit-button')
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('#auth-overlay')?.hidden)
        .toBe(false)
    })
  })
})

describe('transaction list', () => {
  it('renders voided and hand rows, refreshes, and reverses a real transaction', async () => {
    mount()
    await vi.waitFor(() => {
      expect(document.querySelectorAll('#transaction-list .transaction-row'))
        .toHaveLength(4)
    })

    click('#view-switch [data-view="list"]')
    expect(document.querySelector<HTMLElement>('#list-view')?.hidden).toBe(false)

    const voided = document.querySelector<HTMLElement>('[data-txn-id="txn-voided"]')
    expect(voided?.classList.contains('voided')).toBe(true)
    const handRow = [...document.querySelectorAll<HTMLElement>(
      '#transaction-list .transaction-row',
    )].find(row => row.textContent?.includes('手動'))
    expect(handRow).toBeDefined()
    expect(handRow?.querySelector('[data-reverse]')).toBeNull()

    click('#refresh-transactions')
    await vi.waitFor(() => {
      expect(apiMocks.listTransactions).toHaveBeenCalledTimes(2)
    })

    click('[data-reverse="meal-1"]')
    expect(document.querySelector<HTMLElement>('#confirm-reverse')?.hidden)
      .toBe(false)
    click('#confirm-reverse')

    await vi.waitFor(() => {
      expect(apiMocks.reverseTransaction).toHaveBeenCalledWith({
        txn_id: 'meal-1',
        date: '2026-08-09',
      }, FIXED_UUID)
    })
    await vi.waitFor(() => {
      expect(apiMocks.listTransactions).toHaveBeenCalledTimes(3)
    })
  })
})

describe('分向對帳 balance view', () => {
  async function showBalance(result = LIST_RESULT): Promise<void> {
    mount(result)
    click('#view-switch [data-view="balance"]')
    await vi.waitFor(() => {
      expect(document.querySelector('#outstanding-amount')?.textContent)
        .toBe(result.payables.directions[0]?.outstanding.toString())
    })
  }

  it('shows ordered direction tabs and the first outstanding amount by default', async () => {
    await showBalance()

    const tabs = document.querySelectorAll<HTMLButtonElement>(
      '#direction-tabs button',
    )
    expect([...tabs].map(tab => tab.textContent)).toEqual([
      '阿哲→小語',
      '小語→阿哲',
    ])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(document.querySelector('#outstanding-amount')?.textContent)
      .toBe('50')
  })

  it('derives oldest-first statement effects and running balances without voided lines', async () => {
    await showBalance()

    const lines = document.querySelectorAll<HTMLElement>(
      '#statement-list .statement-line',
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]?.textContent).toContain('+150')
    expect(lines[0]?.textContent).toContain('150')
    expect(lines[1]?.textContent).toContain('-100')
    expect(lines[1]?.textContent).toContain('50')
    expect(document.querySelector('#statement-list [data-txn-id="txn-voided"]'))
      .toBeNull()
  })

  it('adds a refund to its recipient\'s side, lists another currency apart and leaves it out of the TWD statement', async () => {
    const result = {
      transactions: [
        transaction({ txn_id: 'usd-1', 日期: '2026-08-08', 金額: '20', 付款人: '小語', 分攤方式: '幫狗狗付', 分類: '餐飲', 幣別: 'USD' }),
        transaction({ txn_id: 'refund-1', 日期: '2026-08-07', 金額: '300', 付款人: '阿哲', 分攤方式: '這筆平分', 分類: '退款' }),
        ...LIST_RESULT.transactions,
      ],
      payables: {
        directions: [
          { debtor: '阿哲', creditor: '小語', outstanding: 200 },
          { debtor: '小語', creditor: '阿哲', outstanding: 0 },
        ],
        otherCurrencies: [{
          currency: 'USD',
          directions: [
            { debtor: '阿哲', creditor: '小語', outstanding: 20 },
            { debtor: '小語', creditor: '阿哲', outstanding: 0 },
          ],
        }],
      },
    }
    await showBalance(result)

    const lines = [...document.querySelectorAll<HTMLElement>('#statement-list .statement-line')]
    expect(lines).toHaveLength(3)
    expect(lines[2]?.textContent).toContain('+150')
    expect(lines[2]?.textContent).toContain('200')
    expect(document.querySelector('#statement-list [data-txn-id="usd-1"]')).toBeNull()
    expect(document.querySelector('#other-currency-note')?.textContent).toContain('20 USD')

    click('#direction-tabs button:nth-child(2)')
    expect(document.querySelector('#other-currency-note')).toBeNull()
  })

  it('shows an empty statement and disables settlement for the zero direction', async () => {
    await showBalance()

    click('#direction-tabs button:nth-child(2)')

    expect(document.querySelector('#outstanding-amount')?.textContent)
      .toBe('0')
    expect(document.querySelectorAll('#statement-list .statement-line'))
      .toHaveLength(0)
    expect(document.querySelector<HTMLButtonElement>('#settle-submit')?.disabled)
      .toBe(true)
  })

  it('submits a capped settlement with today and refreshes the shared list', async () => {
    await showBalance()

    input('#settle-amount', '30')
    expect(document.querySelector<HTMLButtonElement>('#settle-submit')?.disabled)
      .toBe(false)
    click('#settle-submit')

    await vi.waitFor(() => {
      expect(apiMocks.settle).toHaveBeenCalledWith({
        date: '2026-08-09',
        amount: 30,
        payer: '阿哲',
      }, FIXED_UUID)
    })
    await vi.waitFor(() => {
      expect(apiMocks.listTransactions).toHaveBeenCalledTimes(2)
    })
  })

  it('blocks an entry above the selected direction outstanding', async () => {
    await showBalance()

    input('#settle-amount', '51')

    expect(document.querySelector<HTMLButtonElement>('#settle-submit')?.disabled)
      .toBe(true)
    expect(apiMocks.settle).not.toHaveBeenCalled()
  })

  it('keeps settlement disabled when the selected direction is zero', async () => {
    await showBalance()
    click('#direction-tabs button:nth-child(2)')

    expect(document.querySelector<HTMLButtonElement>('#settle-submit')?.disabled)
      .toBe(true)
  })

  it('marks negative outstanding as over-settled and disables settlement', async () => {
    await showBalance(OVER_SETTLED_RESULT)

    const outstanding = document.querySelector<HTMLElement>('#outstanding-amount')
    expect(outstanding?.classList.contains('over-settled')).toBe(true)
    expect(outstanding?.textContent).toBe('-150')
    expect(document.querySelector<HTMLButtonElement>('#settle-submit')?.disabled)
      .toBe(true)
  })

  it('routes settle backend errors to the note and auth failures to the overlay', async () => {
    apiMocks.settle
      .mockReset()
      .mockResolvedValueOnce({
        ok: false,
        kind: 'backend',
        message: 'over-settlement: exceeds outstanding',
      })
      .mockResolvedValueOnce({
        ok: false,
        kind: 'auth',
        message: '登入已過期',
      })
    await showBalance()

    input('#settle-amount', '30')
    click('#settle-submit')
    await vi.waitFor(() => {
      expect(document.querySelector('#settle-note')?.textContent)
        .toContain('over-settlement: exceeds outstanding')
    })

    click('#settle-submit')
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>('#auth-overlay')?.hidden)
        .toBe(false)
    })
  })
})
