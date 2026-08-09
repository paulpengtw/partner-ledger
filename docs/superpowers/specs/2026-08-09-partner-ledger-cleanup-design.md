# Partner Ledger Cleanup Design

## Goal

Finish the solo-ledger to partner-ledger fork by retiring the unused double-entry Apps Script surface, restoring backup coverage, aligning test harnesses with the surviving entry-book API, and completing the visible shell rebrand.

## Scope and architecture

The surviving Apps Script backend is the partner-entry flow: `帳目`, `分類`, `設定`, transaction listing, create, settle, reverse, health, options, backup, and trigger installation. The old `日記帳`/posting, consistency-audit, migration, and spreadsheet-formula paths are dead seams and will be removed from `apps-script/Code.gs` rather than retained behind compatibility adapters.

Backup behavior remains an editor-installed Drive operation. `weeklyBackup` copies the configured spreadsheet into a lazily-created folder, persists that folder id, and prunes matching copies to the newest twelve. `installWeeklyTriggers` will manage only `weeklyBackup`.

## Test strategy

- Keep the workflow tests unchanged except for their file paths into `.github.template/workflows`.
- Add `tests/backup.test.ts` before changing production backup code. It covers a dated copy and persisted folder id, retention of twelve copies, and the single-trigger contract; the final assertion must fail against the current implementation.
- Make the smallest production deletion needed to turn that red trigger assertion green, then run the complete Vitest suite.
- Keep `resolveHeaders_` covered by moving the header loader to `loadEntryFunctions` and use `ENTRY_HEADERS` as the canonical schema after `JOURNAL_HEADERS` is removed.
- Finish with fresh `npx vitest run`, `npx tsc --noEmit`, and `npm run build` runs under Node 26.

## Rebranding rules

Rename display, manifest, package, service-worker cache, and related shell/cache strings in the requested source/test-support surfaces. Do not alter `docs/`, `CLAUDE.md`, `README.md`, or `DEPLOY.md`, and do not rewrite historical fixtures whose identifiers are not display or cache branding.

## Acceptance criteria

The complete Vitest suite has zero failed tests, TypeScript emits no errors, and the production build exits successfully. `apps-script/Code.gs` contains no listed double-entry machinery or unreferenced helpers, the weekly trigger handlers are exactly `['weeklyBackup']`, and the shell identifies itself as Partner Ledger.
