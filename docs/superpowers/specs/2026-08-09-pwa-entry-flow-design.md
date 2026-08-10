# PWA Entry Flow Design

**Date:** 2026-08-09

**Goal:** Replace the retired double-entry browser UI with the partner-ledger two-partner entry wizard, transaction list, and balance placeholder while preserving the existing session guard and application shell conventions.

## Scope

This slice changes only the browser entry flow. The balance view is a presentational placeholder for the next slice. The existing `src/state.ts`, `src/api.ts`, and `src/auth.ts` contracts are the source of truth; prototype HTML is visual reference only.

## Architecture

`mountApp(root, deps)` owns one immutable `FormState` value and one loaded `CounterpartyOptions` value. Rendering derives all visible controls from those values, and delegated event handlers dispatch the state-machine functions from `src/state.ts`. The mount function returns an unmount callback that stops the session guard, removes document listeners, and clears pending timers.

The root contains a three-button view switch. Entry renders the five wizard panels (`amount`, `payer`, `split`, `details`, `confirm`) and keeps exactly one active. List renders the full-range transaction result and owns reversal confirmation. Balance is an empty hidden section with the required id.

Options are applied from the synchronous `loadOptions().cached` result and then from its refresh promise. The initial state uses `deps.today()`, and `deps.randomUUID()` is used only when `State.beginSubmit` or a reversal needs a key. Transaction submission builds the API payload from state, retains the generated key across backend/network failures, resets immediately after success, and refreshes the list.

## UI behavior

- Amount uses `State.pressKey`; the next button is disabled until the parsed amount is positive.
- Payer renders exactly the two configured partners with no fresh-form selection. `State.selectPayer` advances directly to split.
- Split renders `這筆平分`, `幫狗狗付`, `幫自己付` in that order. `這筆平分` is the initial selection, and any choice advances directly to details.
- Details renders category choices, optional counterparty suggestions/free text, and a date defaulted to today. Its next button is disabled without a category.
- Confirm renders editable rows using `data-edit`, a live `State.previewEffect` sentence, and submit/error feedback.
- An auth-kind write failure and a failed session check show `#auth-overlay` with a reload button.
- List rows show date, category or `結清`, amount, payer, and enterer. Voided rows receive `.voided`; only non-blank transaction ids receive reversal controls. Reversal requires an in-view confirmation bar and refreshes the list after success.

## Testing

`tests/pwa-fixtures.ts` supplies typed counterparty options and a three-row full-range list result. `tests/dom.test.ts` preserves the old jsdom harness pattern (`vi.hoisted`, mocked API module, fixed date/UUID, click/input helpers) and verifies the wizard transitions, live preview, editing, exact submission/idempotency behavior, auth overlay, list rendering, and reversal flow. The required red run happens before `src/main.ts` is rewritten; the green run is followed by TypeScript and full-suite verification.

## Error and cleanup rules

Backend/network submission errors remain on confirm, display the server message, and leave the same idempotency key in state for retry. Auth errors additionally show the overlay. List/reversal failures are displayed in the relevant status area without corrupting current state. Unmount prevents late async results from mutating the DOM.
