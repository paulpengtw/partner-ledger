# 分向對帳 Balance View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each production behavior and superpowers:verification-before-completion before reporting results.

**Goal:** Add the per-direction balance statement and capped settlement bar to the partner-ledger PWA using the payables and transactions returned by one list request.

**Architecture:** Keep the existing fetched transaction list as the shared source for the list and balance views, adding the returned ordered payables directions to the same mount-local data state. Derive statement lines in `src/main.ts` for display only; submit settlements through the existing `settle` API and refresh the shared list state after success. Add only balance-specific presentation rules to `src/styles.css`.

**Tech Stack:** TypeScript, Vitest 4, jsdom, Vite, Node 26.

## Global Constraints

- Run every `npx` command as `source ~/.nvm/nvm.sh && nvm use 26 && npx ...`.
- Follow strict TDD: update fixtures/tests, observe the focused DOM suite fail, then implement.
- Direction order is exactly `payables.directions` order; outstanding is never recomputed on the client.
- Statement derivation ignores voided rows, reversals, and non-effect rows, reverses the API's newest-first transaction order, and preserves returned order for date ties.
- Settlement input uses `type=number`, `min=0.5`, `step=0.5`; submission is disabled for invalid, non-positive, over-cap, or non-positive-outstanding amounts.
- Preserve unrelated dirty-worktree changes.

### Task 1: RED fixtures and balance DOM contract

**Files:**
- Modify: `tests/pwa-fixtures.ts`
- Modify: `tests/dom.test.ts`

Update `LIST_RESULT` to the canonical meal, settlement, voided, and hand rows with outstanding 50; add `OVER_SETTLED_RESULT` with outstanding -150. Add the `settle` hoisted mock and append the balance-view tests for tab selection, statement effects/running balances, zero and over-settled states, successful refresh, overpay blocking, and backend/auth failures. Keep existing list behavior assertions aligned with the four-row fixture and `meal-1` transaction ID.

Run the focused DOM suite under Node 26 and capture its failing output before touching `src/main.ts` or `src/styles.css`.

### Task 2: GREEN balance state and interactions

**Files:**
- Modify: `src/main.ts`

Import `settle`, retain `payables.directions` beside `transactions`, render `#direction-tabs`, `#outstanding-amount`, `#statement-list`, and the pinned settle controls, and wire direction switching/input/submit events. Derive effects from non-voided non-reversal rows in reversed transaction order: equal split contributes half of the direction creditor's paid expense, full-other contributes the full amount, full-self contributes zero, and a settlement paid by the direction debtor contributes a negative amount. Use the API outstanding as the displayed cap, reuse `showAuthOverlay`, preserve the idempotency UUID, reset the entry after success, and refresh through `refreshTransactions`.

Run `tests/dom.test.ts` under Node 26 and make the new behavior plus the existing entry/list behavior pass.

### Task 3: GREEN presentation and final verification

**Files:**
- Modify: `src/styles.css`

Add minimal styles for the direction segment control, balance summary, statement rows, signed effects/running balance, over-settled state, and pinned settlement bar without copying prototype code.

Run the DOM suite, `npx tsc --noEmit`, and the full Vitest suite under Node 26. Capture the green focused pass, compiler result, and full-suite summary; allow only the pre-existing 12 `tests/ci/*.test.ts` failures.
