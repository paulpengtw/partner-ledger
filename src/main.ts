import './styles.css'
import {
  authCheck,
  listTransactions,
  loadOptions,
  reverseTransaction,
  settle,
  submitTransaction,
  type CounterpartyOptions,
  type LedgerTransaction,
  type PayableDirection,
} from './api'
import { startSessionGuard } from './auth'
import * as State from './state'

type MountDependencies = {
  today?: () => string
  randomUUID?: () => string
}

type View = 'entry' | 'list' | 'balance'

const RECENT_DATE_FROM = '0001-01-01'
const RECENT_DATE_TO = '9999-12-31'
const SPLITS = ['均分', '全額對方', '全額自己'] as const

function localDate(): string {
  const date = new Date()
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatAmount(amount: number): string {
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

function makeButton(
  text: string,
  dataName?: string,
  dataValue?: string,
): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = text
  if (dataName && dataValue !== undefined) element.dataset[dataName] = dataValue
  return element
}

type StatementLine = {
  transaction: LedgerTransaction
  effect: number
  running: number
}

function deriveStatementLines(
  transactions: LedgerTransaction[],
  direction: PayableDirection,
): StatementLine[] {
  let running = 0
  const lines: StatementLine[] = []

  for (const transaction of [...transactions].reverse()) {
    if (transaction.voided || transaction['沖銷txn_id'].trim()) continue

    const amount = Number(transaction.金額)
    if (!Number.isFinite(amount) || amount <= 0) continue

    let effect = 0
    if (transaction.分類 === '結清') {
      if (transaction.付款人 === direction.debtor) effect = -amount
    } else if (transaction.付款人 === direction.creditor) {
      if (transaction.分攤方式 === '均分') effect = amount / 2
      if (transaction.分攤方式 === '全額對方') effect = amount
    }

    if (effect === 0) continue
    running += effect
    lines.push({ transaction, effect, running })
  }

  return lines
}

function formatSignedAmount(amount: number): string {
  return `${amount < 0 ? '-' : '+'}${formatAmount(Math.abs(amount))}`
}

export function mountApp(
  root: HTMLElement,
  dependencies: MountDependencies = {},
): () => void {
  const today = dependencies.today ?? localDate
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID())
  let state = State.initialState(today())
  let options: CounterpartyOptions | null = null
  let activeView: View = 'entry'
  let transactions: LedgerTransaction[] = []
  let directions: PayableDirection[] = []
  let selectedDirectionIndex = 0
  let settleAmountText = ''
  let settleNote = ''
  let settling = false
  let listRequest = 0
  let pendingReverse: { txnId: string; submitting: boolean } | null = null
  let stopped = false

  root.innerHTML = `
    <nav id="view-switch" class="segmented" aria-label="畫面">
      <button type="button" data-view="entry" aria-pressed="true">記帳</button>
      <button type="button" data-view="list" aria-pressed="false">交易紀錄</button>
      <button type="button" data-view="balance" aria-pressed="false">結餘</button>
    </nav>
    <main id="entry-view" data-active-step="amount">
      <button id="back-button" class="step-back" type="button" hidden>‹ 上一步</button>
      <section class="step-panel" data-step="amount" aria-labelledby="amount-heading">
        <div class="step-content amount-step-content">
          <section id="amount-section" class="form-section" aria-labelledby="amount-heading">
            <div class="section-heading">
              <h2 id="amount-heading" class="step-question">這筆多少？</h2>
              <span id="currency-chip">TWD</span>
            </div>
            <output id="amount-display" aria-live="polite">0</output>
            <div id="keypad" aria-label="金額鍵盤">
              <button type="button" data-key="1">1</button>
              <button type="button" data-key="2">2</button>
              <button type="button" data-key="3">3</button>
              <button type="button" data-key="4">4</button>
              <button type="button" data-key="5">5</button>
              <button type="button" data-key="6">6</button>
              <button type="button" data-key="7">7</button>
              <button type="button" data-key="8">8</button>
              <button type="button" data-key="9">9</button>
              <button type="button" data-key=".">.</button>
              <button type="button" data-key="0">0</button>
              <button type="button" data-key="⌫" aria-label="刪除一位">⌫</button>
            </div>
          </section>
        </div>
        <div class="step-action">
          <button id="next-amount" class="step-next" type="button" disabled>下一步</button>
        </div>
      </section>
      <section class="step-panel" data-step="payer" aria-labelledby="payer-heading" hidden>
        <h2 id="payer-heading" class="step-question">誰付的？</h2>
        <div id="payer-buttons" class="giant-payer-grid"></div>
      </section>
      <section class="step-panel" data-step="split" aria-labelledby="split-heading" hidden>
        <h2 id="split-heading" class="step-question">怎麼分？</h2>
        <div id="split-buttons" class="split-stack"></div>
      </section>
      <section class="step-panel" data-step="details" aria-labelledby="details-heading" hidden>
        <h2 id="details-heading" class="step-question">補充這筆帳</h2>
        <div class="step-content">
          <section class="form-section details-form">
            <div class="form-section-heading">分類</div>
            <div id="category-grid" class="option-grid"></div>
            <div class="form-section-heading">交易對象 <span>選填</span></div>
            <div id="counterparty-suggestions" class="option-grid compact"></div>
            <label class="text-field">
              <span>自訂交易對象</span>
              <input id="counterparty-input" type="text" autocomplete="off" />
            </label>
            <label class="text-field">
              <span>日期</span>
              <input id="date-input" type="date" />
            </label>
          </section>
        </div>
        <div class="step-action">
          <button id="next-details" class="step-next" type="button" disabled>確認內容</button>
        </div>
      </section>
      <section class="step-panel" data-step="confirm" aria-labelledby="confirm-heading" hidden>
        <h2 id="confirm-heading" class="step-question">確認這筆帳</h2>
        <div class="step-content">
          <div id="confirm-card"></div>
          <p id="preview" class="preview" aria-live="polite"></p>
        </div>
        <p id="submit-note" role="alert"></p>
        <div class="step-action">
          <button id="submit-button" class="step-next" type="button">記帳</button>
        </div>
      </section>
    </main>
    <main id="list-view" hidden>
      <section class="recent-panel" aria-labelledby="list-heading">
        <div class="recent-toolbar">
          <h2 id="list-heading">交易紀錄</h2>
          <button id="refresh-transactions" type="button">重新整理</button>
        </div>
        <p id="list-note" role="status"></p>
        <div id="transaction-list"></div>
      </section>
    </main>
    <section id="balance-view" hidden aria-label="結餘"></section>
    <aside id="auth-overlay" class="auth-overlay" role="dialog" aria-modal="true" hidden>
      <div class="auth-card">
        <h2>登入已過期</h2>
        <p>請重新登入後繼續使用。</p>
        <button id="auth-reload" type="button">重新登入</button>
      </div>
    </aside>
    <div id="reverse-confirmation" class="reverse-confirmation" role="status" hidden>
      <span id="reverse-note">確定要沖銷這筆交易嗎？</span>
      <button id="cancel-reverse" type="button">取消</button>
      <button id="confirm-reverse" type="button">確認沖銷</button>
    </div>
  `

  const entryView = root.querySelector<HTMLElement>('#entry-view')!
  const listView = root.querySelector<HTMLElement>('#list-view')!
  const balanceView = root.querySelector<HTMLElement>('#balance-view')!
  const backButton = root.querySelector<HTMLButtonElement>('#back-button')!
  const amountDisplay = root.querySelector<HTMLElement>('#amount-display')!
  const nextAmount = root.querySelector<HTMLButtonElement>('#next-amount')!
  const payerButtons = root.querySelector<HTMLElement>('#payer-buttons')!
  const splitButtons = root.querySelector<HTMLElement>('#split-buttons')!
  const categoryGrid = root.querySelector<HTMLElement>('#category-grid')!
  const counterpartySuggestions = root.querySelector<HTMLElement>(
    '#counterparty-suggestions',
  )!
  const counterpartyInput = root.querySelector<HTMLInputElement>('#counterparty-input')!
  const dateInput = root.querySelector<HTMLInputElement>('#date-input')!
  const nextDetails = root.querySelector<HTMLButtonElement>('#next-details')!
  const confirmCard = root.querySelector<HTMLElement>('#confirm-card')!
  const preview = root.querySelector<HTMLElement>('#preview')!
  const submitNote = root.querySelector<HTMLElement>('#submit-note')!
  const submitButton = root.querySelector<HTMLButtonElement>('#submit-button')!
  const transactionList = root.querySelector<HTMLElement>('#transaction-list')!
  const listNote = root.querySelector<HTMLElement>('#list-note')!
  const reverseConfirmation = root.querySelector<HTMLElement>(
    '#reverse-confirmation',
  )!
  const reverseNote = root.querySelector<HTMLElement>('#reverse-note')!
  const cancelReverse = root.querySelector<HTMLButtonElement>('#cancel-reverse')!
  const confirmReverse = root.querySelector<HTMLButtonElement>('#confirm-reverse')!
  const authOverlay = root.querySelector<HTMLElement>('#auth-overlay')!

  function dispatch(next: State.FormState): void {
    state = next
    render()
  }

  function renderPayers(): void {
    payerButtons.replaceChildren()
    for (const partner of options?.partners ?? []) {
      const button = makeButton(partner, 'payer', partner)
      button.setAttribute('aria-pressed', String(state.payer === partner))
      button.classList.toggle('selected', state.payer === partner)
      payerButtons.appendChild(button)
    }
  }

  function renderSplits(): void {
    splitButtons.replaceChildren()
    for (const split of SPLITS) {
      const button = makeButton(split, 'split', split)
      button.setAttribute('aria-pressed', String(state.split === split))
      button.classList.toggle('selected', state.split === split)
      splitButtons.appendChild(button)
    }
  }

  function renderCategories(): void {
    categoryGrid.replaceChildren()
    for (const category of options?.categories ?? []) {
      const button = makeButton(category, 'category', category)
      button.setAttribute('aria-pressed', String(state.category === category))
      button.classList.toggle('selected', state.category === category)
      categoryGrid.appendChild(button)
    }
  }

  function renderCounterparties(): void {
    counterpartySuggestions.replaceChildren()
    for (const counterparty of options?.counterparties ?? []) {
      const button = makeButton(counterparty, 'counterparty', counterparty)
      button.classList.toggle(
        'selected',
        state.counterparty.trim() === counterparty,
      )
      counterpartySuggestions.appendChild(button)
    }
  }

  function appendSummaryRow(
    label: string,
    value: string,
    editStep: State.EntryStep,
  ): void {
    const row = makeButton('', 'edit', editStep)
    row.className = 'confirm-row'
    const labelElement = document.createElement('span')
    labelElement.className = 'confirm-meta-label'
    labelElement.textContent = label
    const valueElement = document.createElement('strong')
    valueElement.className = 'confirm-meta-value'
    valueElement.textContent = value
    row.appendChild(labelElement)
    row.appendChild(valueElement)
    confirmCard.appendChild(row)
  }

  function renderConfirm(): void {
    confirmCard.replaceChildren()
    appendSummaryRow('金額', formatAmount(State.amountValue(state)), 'amount')
    appendSummaryRow('付款人', state.payer ?? '未選擇', 'payer')
    appendSummaryRow('分攤方式', state.split, 'split')
    appendSummaryRow('分類', state.category ?? '未選擇', 'details')
    appendSummaryRow(
      '交易對象',
      state.counterparty.trim() || '—',
      'details',
    )
    appendSummaryRow('日期', state.date, 'details')

    const effect = State.previewEffect(state, options?.partners ?? [])
    preview.textContent = effect && effect.amount > 0
      ? `${effect.debtor} 應付 ${effect.creditor} +${formatAmount(effect.amount)}`
      : '不產生應付'
  }

  function renderTransactions(): void {
    transactionList.replaceChildren()
    for (const transaction of transactions) {
      const row = document.createElement('article')
      row.className = 'transaction-row'
      row.dataset['txnId'] = transaction.txn_id
      row.classList.toggle('voided', transaction.voided)

      const heading = document.createElement('div')
      heading.className = 'transaction-heading'
      const date = document.createElement('time')
      date.className = 'transaction-date'
      date.textContent = transaction.日期
      const category = document.createElement('span')
      category.className = 'transaction-type'
      category.textContent = transaction.分類 || '結清'
      heading.appendChild(date)
      heading.appendChild(category)

      const body = document.createElement('div')
      body.className = 'transaction-body'
      const amount = document.createElement('strong')
      amount.className = 'transaction-amount'
      amount.textContent = transaction.金額
      const payer = document.createElement('span')
      payer.className = 'transaction-payer'
      payer.textContent = `付款人：${transaction.付款人}`
      body.appendChild(amount)
      body.appendChild(payer)

      const enterer = document.createElement('p')
      enterer.className = 'transaction-accounts'
      enterer.textContent = `記帳人：${transaction.記帳人}`

      const source = document.createElement('p')
      source.className = 'transaction-details'
      source.textContent = `來源：${transaction.來源}`

      row.appendChild(heading)
      row.appendChild(body)
      row.appendChild(enterer)
      row.appendChild(source)
      if (transaction.txn_id.trim()) {
        const reverse = makeButton('沖銷', 'reverse', transaction.txn_id)
        reverse.className = 'reverse-button'
        row.appendChild(reverse)
      }
      transactionList.appendChild(row)
    }
  }

  function selectedDirection(): PayableDirection | undefined {
    return directions[selectedDirectionIndex]
  }

  function canSubmitSettlement(): boolean {
    const direction = selectedDirection()
    if (!direction || direction.outstanding <= 0 || settling) return false

    const amount = Number(settleAmountText)
    if (
      !Number.isFinite(amount)
      || amount < 0.5
      || amount > direction.outstanding
    ) return false

    const halfUnits = amount * 2
    return Math.abs(halfUnits - Math.round(halfUnits)) < 1e-9
  }

  function renderSettleControls(): void {
    const amountInput = balanceView.querySelector<HTMLInputElement>('#settle-amount')
    const submitButton = balanceView.querySelector<HTMLButtonElement>('#settle-submit')
    const note = balanceView.querySelector<HTMLElement>('#settle-note')
    if (!amountInput || !submitButton || !note) return

    const direction = selectedDirection()
    amountInput.value = settleAmountText
    amountInput.max = formatAmount(Math.max(0, direction?.outstanding ?? 0))
    amountInput.disabled = settling
    submitButton.disabled = !canSubmitSettlement()
    submitButton.textContent = settling ? '結清中…' : '結清'
    note.textContent = settleNote
  }

  function renderBalance(): void {
    balanceView.replaceChildren()

    const panel = document.createElement('section')
    panel.className = 'balance-panel'

    const tabs = document.createElement('div')
    tabs.id = 'direction-tabs'
    tabs.className = 'balance-direction-tabs'
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('aria-label', '對帳方向')
    directions.forEach((direction, index) => {
      const button = makeButton(
        `${direction.debtor}→${direction.creditor}`,
        'directionIndex',
        String(index),
      )
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-selected', String(index === selectedDirectionIndex))
      button.classList.toggle('selected', index === selectedDirectionIndex)
      tabs.appendChild(button)
    })
    panel.appendChild(tabs)

    const direction = selectedDirection()
    const summary = document.createElement('section')
    summary.className = 'balance-summary'
    const directionLabel = document.createElement('span')
    directionLabel.className = 'balance-direction-label'
    directionLabel.textContent = direction
      ? `${direction.debtor}→${direction.creditor}`
      : '目前沒有對帳方向'
    summary.appendChild(directionLabel)

    const outstanding = document.createElement('strong')
    outstanding.id = 'outstanding-amount'
    outstanding.textContent = formatAmount(direction?.outstanding ?? 0)
    outstanding.classList.toggle('over-settled', (direction?.outstanding ?? 0) < 0)
    summary.appendChild(outstanding)

    const outstandingUnit = document.createElement('span')
    outstandingUnit.className = 'balance-unit'
    outstandingUnit.textContent = '元 · 目前方向的逐列結餘'
    summary.appendChild(outstandingUnit)
    panel.appendChild(summary)

    const statementHeading = document.createElement('div')
    statementHeading.className = 'statement-heading'
    const statementTitle = document.createElement('h2')
    statementTitle.textContent = '對帳明細'
    statementHeading.appendChild(statementTitle)
    const statementLegend = document.createElement('span')
    statementLegend.textContent = '＋分攤　−結清'
    statementHeading.appendChild(statementLegend)
    panel.appendChild(statementHeading)

    const statementList = document.createElement('div')
    statementList.id = 'statement-list'
    statementList.className = 'statement-list'
    const lines = direction
      ? deriveStatementLines(transactions, direction)
      : []
    if (lines.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'empty-statement'
      empty.textContent = '這個方向目前沒有會計入的列。'
      statementList.appendChild(empty)
    } else {
      for (const line of lines) {
        const row = document.createElement('article')
        row.className = 'statement-line'
        row.dataset['txnId'] = line.transaction.txn_id
        if (line.effect < 0) row.classList.add('statement-settlement')

        const date = document.createElement('time')
        date.className = 'statement-date'
        date.textContent = line.transaction.日期
        row.appendChild(date)

        const copy = document.createElement('div')
        copy.className = 'statement-copy'
        const title = document.createElement('strong')
        title.textContent = line.transaction.分類 || '分攤'
        const detail = document.createElement('span')
        detail.textContent = `付款人：${line.transaction.付款人}`
        copy.appendChild(title)
        copy.appendChild(detail)
        row.appendChild(copy)

        const effect = document.createElement('span')
        effect.className = 'statement-effect'
        effect.textContent = formatSignedAmount(line.effect)
        row.appendChild(effect)

        const running = document.createElement('strong')
        running.className = 'statement-running'
        running.textContent = formatAmount(line.running)
        row.appendChild(running)
        statementList.appendChild(row)
      }
    }
    panel.appendChild(statementList)

    const settleBar = document.createElement('aside')
    settleBar.className = 'balance-settle-bar'
    settleBar.setAttribute('aria-label', '固定結清操作')
    const settleCopy = document.createElement('div')
    settleCopy.className = 'balance-settle-copy'
    const settleDirection = document.createElement('strong')
    settleDirection.textContent = direction
      ? `${direction.debtor}→${direction.creditor}`
      : '結清'
    const settleCap = document.createElement('span')
    settleCap.textContent = direction
      ? `目前還有 ${formatAmount(direction.outstanding)} 元`
      : '目前沒有可結清的應付'
    settleCopy.appendChild(settleDirection)
    settleCopy.appendChild(settleCap)
    settleBar.appendChild(settleCopy)

    const settleForm = document.createElement('div')
    settleForm.className = 'balance-settle-form'
    const amountLabel = document.createElement('label')
    amountLabel.className = 'balance-settle-label'
    const amountLabelText = document.createElement('span')
    amountLabelText.textContent = '這次付多少？'
    amountLabel.appendChild(amountLabelText)
    const amountInput = document.createElement('input')
    amountInput.id = 'settle-amount'
    amountInput.type = 'number'
    amountInput.min = '0.5'
    amountInput.step = '0.5'
    amountInput.inputMode = 'decimal'
    amountInput.autocomplete = 'off'
    amountLabel.appendChild(amountInput)
    settleForm.appendChild(amountLabel)

    const settleSubmit = makeButton('結清')
    settleSubmit.id = 'settle-submit'
    settleSubmit.className = 'balance-settle-submit'
    settleForm.appendChild(settleSubmit)
    settleBar.appendChild(settleForm)

    const settleError = document.createElement('p')
    settleError.id = 'settle-note'
    settleError.setAttribute('role', 'alert')
    settleBar.appendChild(settleError)
    panel.appendChild(settleBar)

    balanceView.appendChild(panel)
    renderSettleControls()
  }

  function renderViews(): void {
    entryView.hidden = activeView !== 'entry'
    listView.hidden = activeView !== 'list'
    balanceView.hidden = activeView !== 'balance'
    root.querySelectorAll<HTMLButtonElement>('#view-switch [data-view]').forEach(
      button => {
        const selected = button.dataset['view'] === activeView
        button.classList.toggle('selected', selected)
        button.setAttribute('aria-pressed', String(selected))
      },
    )
  }

  function renderReverseConfirmation(): void {
    const request = pendingReverse
    reverseConfirmation.hidden = request === null
    if (request === null) return
    const submitting = request.submitting
    cancelReverse.disabled = submitting
    confirmReverse.disabled = submitting
  }

  function render(): void {
    entryView.dataset['activeStep'] = state.step
    entryView.querySelectorAll<HTMLElement>('.step-panel').forEach(panel => {
      const active = panel.dataset['step'] === state.step
      panel.hidden = !active
      panel.setAttribute('aria-hidden', String(!active))
    })
    backButton.hidden = state.step === 'amount'
    amountDisplay.textContent = state.amountText || '0'
    nextAmount.disabled = State.amountValue(state) <= 0
    nextDetails.disabled = state.category === null
    counterpartyInput.value = state.counterparty
    dateInput.value = state.date
    submitButton.disabled = !State.canSubmit(state)
    submitButton.textContent = state.status === 'error' ? '再試一次' : '記帳'
    submitNote.textContent = state.errorMessage ?? ''
    renderPayers()
    renderSplits()
    renderCategories()
    renderCounterparties()
    renderConfirm()
    renderTransactions()
    renderBalance()
    renderViews()
    renderReverseConfirmation()
  }

  function applyOptions(next: CounterpartyOptions): void {
    options = next
    render()
  }

  async function refreshTransactions(): Promise<void> {
    const request = ++listRequest
    listNote.textContent = '載入中…'
    const result = await listTransactions(
      RECENT_DATE_FROM,
      RECENT_DATE_TO,
    )
    if (stopped || request !== listRequest) return
    if (result === null) {
      transactions = []
      directions = []
      selectedDirectionIndex = 0
      settleAmountText = ''
      settleNote = ''
      listNote.textContent = '無法載入交易紀錄'
    } else {
      transactions = result.transactions
      directions = result.payables.directions
      selectedDirectionIndex = Math.min(
        selectedDirectionIndex,
        Math.max(0, directions.length - 1),
      )
      listNote.textContent = ''
    }
    renderTransactions()
    renderBalance()
  }

  function showAuthOverlay(): void {
    authOverlay.hidden = false
  }

  async function submit(): Promise<void> {
    if (!State.canSubmit(state)) return
    const submitting = State.beginSubmit(state, randomUUID)
    const transaction = State.buildTransaction(submitting)
    state = submitting
    render()
    const result = await submitTransaction(
      transaction,
      submitting.idempotencyKey!,
    )
    if (stopped) return
    if (!result.ok) {
      state = State.submitFailed(submitting, result.message)
      render()
      if (result.kind === 'auth') showAuthOverlay()
      return
    }

    state = State.resetForNext(State.submitSucceeded(submitting), today())
    render()
    void refreshTransactions()
  }

  async function submitSettlement(): Promise<void> {
    const direction = selectedDirection()
    if (!direction || !canSubmitSettlement()) return

    const amount = Number(settleAmountText)
    settling = true
    settleNote = ''
    renderSettleControls()
    const result = await settle(
      {
        date: today(),
        amount,
        payer: direction.debtor,
      },
      randomUUID(),
    )
    if (stopped) return

    settling = false
    if (!result.ok) {
      settleNote = result.message
      renderSettleControls()
      if (result.kind === 'auth') showAuthOverlay()
      return
    }

    settleAmountText = ''
    settleNote = ''
    renderSettleControls()
    void refreshTransactions()
  }

  function openReverse(txnId: string): void {
    if (pendingReverse?.submitting) return
    pendingReverse = { txnId, submitting: false }
    reverseNote.textContent = `確定要沖銷 ${txnId} 嗎？`
    renderReverseConfirmation()
  }

  function closeReverse(): void {
    if (pendingReverse?.submitting) return
    pendingReverse = null
    reverseNote.textContent = '確定要沖銷這筆交易嗎？'
    renderReverseConfirmation()
  }

  async function confirmReverseTransaction(): Promise<void> {
    if (!pendingReverse || pendingReverse.submitting) return
    const request = pendingReverse
    request.submitting = true
    reverseNote.textContent = '沖銷中…'
    renderReverseConfirmation()
    const result = await reverseTransaction(
      { txn_id: request.txnId, date: today() },
      randomUUID(),
    )
    if (stopped) return
    if (!result.ok) {
      request.submitting = false
      reverseNote.textContent = result.message
      renderReverseConfirmation()
      if (result.kind === 'auth') showAuthOverlay()
      return
    }
    pendingReverse = null
    renderReverseConfirmation()
    void refreshTransactions()
  }

  root.querySelector('#view-switch')!.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-view]')
    const view = target?.dataset['view']
    if (view !== 'entry' && view !== 'list' && view !== 'balance') return
    activeView = view
    renderViews()
  })

  balanceView.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-direction-index]')
    if (target) {
      const index = Number(target.dataset['directionIndex'])
      if (Number.isInteger(index) && directions[index]) {
        selectedDirectionIndex = index
        settleAmountText = ''
        settleNote = ''
        renderBalance()
      }
      return
    }

    const submitTarget = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('#settle-submit')
    if (submitTarget) void submitSettlement()
  })

  balanceView.addEventListener('input', event => {
    const target = event.target as HTMLInputElement
    if (target.id !== 'settle-amount') return
    settleAmountText = target.value
    renderSettleControls()
  })

  root.querySelector('#keypad')!.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-key]')
    if (!target) return
    dispatch(State.pressKey(state, target.dataset['key'] ?? ''))
  })

  nextAmount.addEventListener('click', () => {
    if (State.amountValue(state) > 0) dispatch(State.goNext(state))
  })

  payerButtons.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-payer]')
    const payer = target?.dataset['payer']
    if (!payer) return
    dispatch(State.selectPayer(state, payer))
  })

  splitButtons.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-split]')
    const split = target?.dataset['split']
    if (split !== '均分' && split !== '全額對方' && split !== '全額自己') return
    dispatch(State.selectSplit(state, split))
  })

  categoryGrid.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-category]')
    const category = target?.dataset['category']
    if (!category) return
    let next = State.selectCategory(state, category)
    if (next.returnToConfirm && State.canSubmit(next)) next = State.goNext(next)
    dispatch(next)
  })

  counterpartySuggestions.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-counterparty]')
    const counterparty = target?.dataset['counterparty']
    if (!counterparty) return
    dispatch(State.setCounterparty(state, counterparty))
  })

  backButton.addEventListener('click', () => {
    dispatch(State.goBack(state))
  })

  nextDetails.addEventListener('click', () => {
    if (state.category !== null) dispatch(State.goNext(state))
  })

  counterpartyInput.addEventListener('input', () => {
    dispatch(State.setCounterparty(state, counterpartyInput.value))
  })

  dateInput.addEventListener('input', () => {
    dispatch(State.setDate(state, dateInput.value))
  })

  confirmCard.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-edit]')
    const step = target?.dataset['edit']
    if (
      step !== 'amount'
      && step !== 'payer'
      && step !== 'split'
      && step !== 'details'
      && step !== 'confirm'
    ) return
    dispatch(State.jumpFromConfirm(state, step))
  })

  submitButton.addEventListener('click', () => { void submit() })

  root.querySelector('#refresh-transactions')!.addEventListener('click', () => {
    void refreshTransactions()
  })

  transactionList.addEventListener('click', event => {
    const target = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('[data-reverse]')
    const txnId = target?.dataset['reverse']
    if (txnId) openReverse(txnId)
  })

  cancelReverse.addEventListener('click', closeReverse)
  confirmReverse.addEventListener('click', () => {
    void confirmReverseTransaction()
  })

  root.querySelector<HTMLButtonElement>('#auth-reload')!
    .addEventListener('click', () => location.reload())

  render()
  void refreshTransactions()

  const loadedOptions = loadOptions()
  if (loadedOptions.cached) applyOptions(loadedOptions.cached)
  void loadedOptions.refresh.then(refreshed => {
    if (!stopped && refreshed) applyOptions(refreshed)
  })

  const sessionGuard = startSessionGuard({
    check: authCheck,
    onExpired: showAuthOverlay,
  })
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') sessionGuard.onVisible()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    stopped = true
    listRequest += 1
    sessionGuard.stop()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

if (!import.meta.env.VITEST) {
  mountApp(document.querySelector<HTMLElement>('#app')!)
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js')
  }
}
