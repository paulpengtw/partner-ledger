# PWA Entry Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the partner-ledger PWA entry flow as a state-driven five-step wizard with transaction listing, reversal, auth handling, and an empty balance placeholder.

**Architecture:** `mountApp(root, deps)` owns `FormState`, options, list data, and view state. A single renderer derives the DOM from that state; delegated handlers call the existing `State` functions and API client functions. The entry UI and list UI share the existing shell/style vocabulary, while the balance section remains hidden and empty for the next slice.

**Tech Stack:** TypeScript 7, Vitest 4, jsdom, existing `src/state.ts`, `src/api.ts`, and `src/auth.ts` contracts.

## Global Constraints

- Preserve the old jsdom harness pattern: `// @vitest-environment jsdom`, `vi.hoisted`, `vi.mock('../src/api')`, fixed `today`, fixed `randomUUID`, and click/input helpers.
- Use `mountApp(root, deps)` and return an unmount function.
- Use the full list range `0001-01-01` through `9999-12-31`.
- Keep one idempotency key for a failed submit retry; mint it through `State.beginSubmit`.
- Never preselect either payer on a fresh form; keep `這筆平分` preselected.
- Do not reuse prototype code; use only its visual/layout intent.
- Make only minimal stylesheet additions and preserve unrelated worktree changes.

### Task 1: Replace PWA fixtures and write the red DOM contract

**Files:**
- Modify: `tests/pwa-fixtures.ts`
- Create: `tests/dom.test.ts`
- Read: `src/api.ts`, `src/state.ts`, `git show HEAD:tests/dom.test.ts`

**Interfaces:**
- Fixtures produce `CounterpartyOptions` with `partners: ['阿哲', '小語']`, `categories: ['餐飲', '交通']`, and `counterparties: ['全聯']`.
- The mocked API exposes `authCheck`, `listTransactions`, `loadOptions`, `reverseTransaction`, and `submitTransaction`.
- `LIST_RESULT` contains three `LedgerTransaction` rows: normal 300/這筆平分/小語, one `voided: true`, and one blank-id hand row with `來源: '手動'`; its payables directions are 阿哲→小語 outstanding 150 and the mirror direction outstanding 0.

- [ ] **Step 1: Replace legacy options fixtures**

Define typed `CACHED_OPTIONS` and `REFRESHED_OPTIONS` objects with the exact `CounterpartyOptions` shape. Define `LIST_RESULT` with all required `LedgerTransaction` fields and the two payable directions. Retain any wire fixtures only if existing API tests import them; otherwise remove obsolete account/receivable fixtures from this PWA fixture file.

- [ ] **Step 2: Write the failing DOM test harness**

Use the old module-mock structure and helpers:

```ts
// @vitest-environment jsdom
const apiMocks = vi.hoisted(() => ({
  authCheck: vi.fn(),
  listTransactions: vi.fn(),
  loadOptions: vi.fn(),
  reverseTransaction: vi.fn(),
  submitTransaction: vi.fn(),
}))
vi.mock('../src/api', () => apiMocks)
```

Mount with cached options, a never-resolving refresh by default, `today: () => '2026-08-09'`, and the fixed UUID. Reset `document.body`, mocks, and unmount between tests. Add `click(selector)` and `input(selector, value)` helpers.

- [ ] **Step 3: Add the required red behaviors**

Cover these independent behaviors in named tests:

1. Fresh amount step is active; keypad `3`, `0`, `0` displays 300; amount next reaches payer; exactly two payer buttons are rendered from options and both have `aria-pressed="false"`.
2. Clicking 小語 reaches split; 這筆平分 is first and pressed; clicking 這筆平分 reaches details.
3. Selecting 餐飲, then details next, reaches confirm; summary includes 300, 小語, 這筆平分, 餐飲; preview includes `阿哲 應付 小語` and `150`.
4. Full flow with 幫自己付 shows `不產生應付` in `#preview`.
5. Editing `data-edit="payer"` returns to payer; choosing 阿哲 returns straight to confirm and updates summary/preview to `小語 應付 阿哲`.
6. Submit sends `{ date: '2026-08-09', amount: 300, payer: '小語', split: '這筆平分', category: '餐飲' }` without `payee`, with the fixed UUID; success returns to amount with 這筆平分 pressed and calls list refresh.
7. A backend error writes the server message to `#submit-note`; a second submit sends the identical idempotency key.
8. An auth-kind submit result makes `#auth-overlay` visible.
9. List view renders three rows, marks the voided row `.voided`, omits reversal for the blank-id hand row, and refreshes through `#refresh-transactions`.
10. Clicking a valid 沖銷 opens `#confirm-reverse`; confirmation calls `reverseTransaction({ txn_id, date: '2026-08-09' }, fixedUuid)` and refreshes the list.

- [ ] **Step 4: Run and capture the red phase**

Run:

```bash
npx vitest run tests/dom.test.ts
```

Expected: non-zero failure before implementation because the retired `src/main.ts` imports removed API exports and/or cannot satisfy the new DOM contract. Save the complete command output to `/private/tmp/partner-ledger-red.txt` and report an abridged excerpt plus exit status.

### Task 2: Implement the state-driven renderer

**Files:**
- Rewrite: `src/main.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Import only `authCheck`, `listTransactions`, `loadOptions`, `reverseTransaction`, `submitTransaction`, `CounterpartyOptions`, `LedgerTransaction`, and `ListResult` from `src/api.ts`.
- Use `State.initialState`, `pressKey`, `goNext`, `goBack`, `selectPayer`, `selectSplit`, `selectCategory`, `setCounterparty`, `setDate`, `jumpFromConfirm`, `amountValue`, `canSubmit`, `previewEffect`, `buildTransaction`, `beginSubmit`, `submitSucceeded`, `submitFailed`, and `resetForNext`.
- Keep `MountDependencies` as optional `today` and `randomUUID` functions.

- [ ] **Step 1: Build the shell and initial state renderer**

Render `#view-switch`, `#entry-view`, five `.step-panel[data-step]` sections, `#transaction-view`, hidden `#balance-view`, `#auth-overlay`, and reversal confirmation bar. Render controls with DOM APIs or safe text assignment. Ensure only the current step is visible and `#back-button` is hidden only on amount.

- [ ] **Step 2: Add entry event delegation**

Wire keypad keys to `State.pressKey`, amount/details next buttons to `State.goNext`, payer/split buttons to their auto-advancing state functions, category/counterparty/date inputs to state setters, back to `State.goBack`, and confirm edit buttons to `State.jumpFromConfirm`. Re-render after each state transition.

- [ ] **Step 3: Add submission/error/auth behavior**

Guard submit with `State.canSubmit`; call `State.beginSubmit`, build the transaction from the pre-submit state, and pass the stored key to `submitTransaction`. On success, call `submitSucceeded`, immediately reset with today, and refresh transactions. On failure, call `submitFailed`, retain state/key, show the message, and show `#auth-overlay` for `kind: 'auth'`. Use `startSessionGuard({ check: authCheck, onExpired })`, document visibility handling, and a reload button.

- [ ] **Step 4: Add list and reversal behavior**

Fetch `listTransactions('0001-01-01', '9999-12-31')` at mount and on refresh/success/reversal. Render each row with the required fields, `結清` when `分類` is blank only if appropriate for a settlement row, `.voided` for voided rows, and a `data-reverse` button only for non-blank ids. Confirm reversal inline, call `reverseTransaction({ txn_id, date: today() }, randomUUID())`, and refresh on success.

- [ ] **Step 5: Add minimal styles**

Extend existing selectors for wizard giant payer buttons, stacked split buttons, confirm rows, preview, auth overlay, reverse confirmation bar, and `.voided { text-decoration: line-through; }`. Reuse existing variables, radii, shadows, and button conventions.

### Task 3: Green verification and regression checks

**Files:**
- Verify: `tests/dom.test.ts`, `src/main.ts`, `src/styles.css`, all existing test files.

- [ ] **Step 1: Run focused green tests**

Run `npx vitest run tests/dom.test.ts`, confirm all focused tests pass, and capture the pass line to `/private/tmp/partner-ledger-green.txt`.

- [ ] **Step 2: Run the TypeScript compiler**

Run `npx tsc --noEmit`; require exit code 0 and no diagnostics.

- [ ] **Step 3: Run the full suite**

Run `npx vitest run`; record the summary. The only allowed failures are the pre-existing 12 tests in `tests/ci/*`; investigate any other failure before reporting.

- [ ] **Step 4: Inspect the final diff**

Run `git diff --check` and `git status --short`, verify no unrelated files were modified by this slice, and report the red excerpt, green pass line, typecheck result, and full-suite summary.
