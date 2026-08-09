# Partner Ledger Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the fork's dead double-entry seams, restore backup coverage, finish the Partner Ledger rebrand, and leave the full Node 26 suite and build clean.

**Architecture:** Preserve the surviving `帳目` entry-book API and its fake-Gas integration harness. Delete the unused `日記帳` posting, consistency, migration, and formula paths, then keep only helpers reachable from the entry-book, health/options, and backup flows.

**Tech Stack:** Node 26, TypeScript, Vitest, Vite, Apps Script JavaScript evaluated through the TypeScript fake-Gas harness, Playwright service-worker fixtures.

## Global Constraints

- Run every shell command as `source ~/.nvm/nvm.sh && nvm use 26`.
- Run `npx vitest run` after each numbered implementation step.
- The workflow test files receive only their path-string changes.
- Do not modify `docs/`, `CLAUDE.md`, `README.md`, or `DEPLOY.md` for the shell rebrand.
- Do not claim completion without fresh Vitest, `npx tsc --noEmit`, and `npm run build` output.

---

### Task 1: Retire the posting seams and fix template workflow paths

**Files:**
- Delete: `tests/posting.test.ts`
- Modify: `tests/ci/workflow.test.ts` path only, `.github` → `.github.template`
- Modify: `tests/ci/deploy-workflow.test.ts` path only, `.github` → `.github.template`

**Interfaces:**
- Produces a suite with the twelve existing CI path failures removed and no posting-loader consumer.

- [ ] **Step 1: Make the minimal test-file changes**

Change only the two `new URL('../../.github/workflows/...')` strings to `new URL('../../.github.template/workflows/...')`, then delete the obsolete posting test file.

- [ ] **Step 2: Verify the checkpoint**

Run `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx vitest run`.

Expected: both CI test files pass and no test imports `loadGasFunctions` for posting behavior.

### Task 2: Add backup coverage red-first

**Files:**
- Create: `tests/backup.test.ts`

**Interfaces:**
- Consumes: `loadGasFunctionsWithFakeGas`, `FakeDriveFile`, `FakeDriveFolder`, `FakeGasHarness` from `tests/helpers/gas.ts`.
- Produces: coverage for `weeklyBackup`, `pruneBackups_`, and `installWeeklyTriggers`; the trigger assertion must fail before production changes.

- [ ] **Step 1: Write three behavior tests**

Use fake timers at `2026-08-09T00:00:00.000Z`, call `setupSpreadsheet()` in `beforeEach`, and restore timers in `afterEach`.

The copy test calls `weeklyBackup()`, reads the persisted `LEDGER_BACKUP_FOLDER_ID`, inspects `drive.getFolderById(id).allFiles()`, and asserts one active file whose name matches `^Solo Ledger backup 20260809-` plus the returned id/name.

The pruning test seeds fifteen `Solo Ledger backup NN` files with ascending creation dates in a fake folder, calls `pruneBackups_(folder, 'Solo Ledger backup ', harness.spreadsheetId)`, and asserts only names 04–15 remain active while 01–03 are trashed.

The trigger test calls `installWeeklyTriggers()` twice and asserts:

```ts
expect(harness.triggers.map(trigger => trigger.handler)).toEqual(['weeklyBackup'])
```

Also assert Monday scheduling and that the second install does not duplicate the trigger. This test is intentionally red against the current two-trigger implementation.

- [ ] **Step 2: Capture the red state**

Run `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx vitest run tests/backup.test.ts`, then run the full `npx vitest run` checkpoint.

Expected: the first two backup tests pass and only the single-trigger assertion fails after Task 1.

### Task 3: Remove dead Apps Script machinery and make backup triggers green

**Files:**
- Modify: `apps-script/Code.gs`

**Interfaces:**
- Consumes: the red trigger test and the surviving entry-book functions.
- Produces: `weeklyBackup`, `pruneBackups_`, and `installWeeklyTriggers` with no consistency trigger; no listed journal/posting/formula/migration symbols remain.

- [ ] **Step 1: Delete the explicitly retired symbols**

Remove `JOURNAL_HEADERS`, `LIST_TRANSACTION_HEADERS`, `BALANCE_FORMULA_SCHEMA_PROPERTY`, all listed journal readers/auditors/consistency functions, `weeklyConsistencyCheck`, `closeAndOpenBooks`, migration helpers, balance/check formula helpers, posting expand/validation/append helpers, and the old vocabulary/settlement validators.

Remove the `list_receivables` and `check_consistency` branches from `route_`.

- [ ] **Step 2: Keep only the backup trigger and rebrand its folder**

Change `BACKUP_FOLDER_NAME` to `'Partner Ledger backups'`. Make `installWeeklyTriggers` delete only existing `weeklyBackup` triggers and create only:

```js
ScriptApp.newTrigger('weeklyBackup')
  .timeBased()
  .onWeekDay(ScriptApp.WeekDay.MONDAY)
  .atHour(8)
  .create();
```

- [ ] **Step 3: Prune unreferenced helpers by grep**

For each remaining helper named in the request (`readSetting_`, `taipeiIsoNow_`, `isTrue_`, vocabulary helpers, `normalizedAmount_`, `blank_`, `hasField_`, `rejectField_`, and peers), search all references in `Code.gs`; delete only helpers with no remaining call sites. Keep `normalizedAmount_` because `settle_` calls it.

- [ ] **Step 4: Verify the checkpoint**

Run `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx vitest run`. The backup trigger test must now pass.

### Task 4: Align the fake-Gas loaders and header coverage

**Files:**
- Modify: `tests/helpers/gas.ts`
- Modify: `tests/headers.test.ts`

**Interfaces:**
- Consumes: the surviving `loadEntryFunctions` loader and `resolveHeaders_`/`ENTRY_HEADERS` in `Code.gs`.
- Produces: a harness with no dead migration/consistency/posting API fields and no journal event special case.

- [ ] **Step 1: Remove the pure posting loader types and function**

Delete `PostingInput`, `PostingRow`, `GasFunctions`, `throwingGasGlobal`’s posting-only loader usage, and `loadGasFunctions`. Extend `EntryGasFunctions` and its evaluate return object with `resolveHeaders_` and `ENTRY_HEADERS`.

- [ ] **Step 2: Migrate `tests/headers.test.ts`**

Import `loadEntryFunctions`, destructure `ENTRY_HEADERS` and `resolveHeaders_`, and replace the journal canonical row with the ten `ENTRY_HEADERS` values while keeping the same reordered, extra-column, missing-header, duplicate-header, and whitespace assertions.

- [ ] **Step 3: Simplify the fake harness**

Remove `closeAndOpenBooks`, `checkConsistency_`, `weeklyConsistencyCheck`, `oldSpreadsheet`, and `oldSpreadsheetId` from types, evaluation, maps, and returned harness data. Remove `FakeSheet.afterSetValues`’s `日記帳` event recording; keep the method as a no-op. Change fake spreadsheet/Drive source names to `Partner Ledger` for hygiene.

- [ ] **Step 4: Verify the checkpoint**

Run `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx vitest run` and confirm `tests/entry-book.test.ts` still sees `lock-acquired` behavior.

### Task 5: Rebrand the shell and service-worker fixtures

**Files:**
- Modify: `index.html`
- Modify: `public/manifest.webmanifest`
- Modify: `package.json`
- Modify: `public/sw.js`
- Modify: `sw-tests/sw-harness.spec.ts`
- Modify: `sw-tests/helpers/server.ts` only if the remaining string is display/cache branding rather than historical verification prose

**Interfaces:**
- Produces: Partner Ledger title/meta/manifest/package/cache identifiers and matching service-worker expectations.

- [ ] **Step 1: Apply exact visible branding**

Set the HTML title to `Partner Ledger`, description to `兩人共同分帳快速輸入`, manifest `name` to `Partner Ledger 共同分帳`, manifest `short_name` to `Partner Ledger`, and package name to `partner-ledger`.

- [ ] **Step 2: Rename cache branding and matching assertions**

Change `CACHE_NAME` and its Playwright expectation from `solo-ledger-shell-v1` to `partner-ledger-shell-v1`; change the offline title expectation to `Partner Ledger`. Do not change historical docs or non-brand fixture identifiers.

- [ ] **Step 3: Verify the checkpoint**

Run `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx vitest run`.

### Task 6: Final verification and audit

**Files:**
- Inspect: `apps-script/Code.gs`, `src/`, `sw-tests/`, `public/sw.js`, and the complete diff

- [ ] **Step 1: Run the full suite**

Run `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx vitest run`; record the final summary with zero failed tests.

- [ ] **Step 2: Run typecheck and build**

Run `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npx tsc --noEmit`, then `source ~/.nvm/nvm.sh && nvm use 26 >/dev/null && npm run build`; record exit status and output.

- [ ] **Step 3: Audit requested cleanup**

Compare `wc -l apps-script/Code.gs` before and after, run `rg -n` for every retired symbol and for `solo-ledger` in `src/`, `sw-tests/`, and `public/sw.js`, and inspect `git diff --check`. Report any intentionally preserved non-brand historical strings separately.
