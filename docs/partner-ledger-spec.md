# partner-ledger — build spec

Locked spec assembled from the wayfinder map
[Wayfinder map: partner-ledger — two-person split-ledger spec](https://github.com/paulpengtw-aiagent/solo-ledger/issues/57).
Every decision below links its ticket; the ticket's resolution comment is
the authoritative detail. Glossary: `CONTEXT.md` (already rewritten for
the fork).

## 1. What this is

A fork of solo-ledger ([fork, not a mode](https://github.com/paulpengtw-aiagent/solo-ledger/issues/57)):
a **shared-expenses-only joint book** for exactly two partners. Both
partners write via the PWA into one shared Google Spreadsheet (the only
datastore). The book is a **flat append-only list, not double-entry**;
running gross payables between the partners are derived arithmetic.
Personal finances stay out; each partner keeps whatever personal books
they like elsewhere.

Out of scope (map): solo-ledger interop, repo/CI/deploy fork mechanics
(build effort's concern, not this spec's), any generalization beyond
two people.

## 2. Data model — [ticket #61](https://github.com/paulpengtw-aiagent/solo-ledger/issues/61)

One sheet, 帳目, one row per expense; mixed receipts become multiple rows.

| Column | Meaning |
| --- | --- |
| txn_id | client UUID, idempotency key; hand rows may omit |
| 日期 | date |
| 金額 | full amount paid, single positive number |
| 付款人 | payer — explicit picker, never defaulted |
| 分攤方式 | 均分 / 全額對方 / 全額自己 |
| 分類 | category label from sheet-resident vocabulary; 「結清」 reserved |
| 交易對象 | optional free text, suggested from 選項清單 |
| 記帳人 | enterer, stamped server-side |
| 來源 | pwa / 手動 |
| 沖銷txn_id | reversal linkage |

Dead solo-ledger concepts: 借/貸 pairs, 會計科目, 應收/應付帳款, 代墊,
結清狀態, 期初餘額. Surviving machinery: append-only + 沖銷, txn_id
idempotency, sheet-resident vocabulary (分類 list + 選項清單 + 設定) with
schema_version fingerprinting.

Corrections: 沖銷 mirror rows are the only app-side correction; either
partner may void any row (the reversal's 記帳人 records who). Refunds
are out of app scope — the owner hand-edits the sheet (escape hatch).

## 3. Split semantics — [ticket #59](https://github.com/paulpengtw-aiagent/solo-ledger/issues/59)

Three-state 分攤方式 per row:

- **均分** (default): 50/50, halves kept exact to NT$0.5 — no per-row
  rounding, nobody absorbs an odd dollar.
- **全額對方**: the whole amount is the other partner's share — the pure
  advance (forgotten-wallet) case.
- **全額自己**: the payer's own share; creates no inter-partner debt;
  optional, exists for receipt completeness.

No percentage or exact-amount entry. Shares are always derived, never
stored.

## 4. Identity & access — [ticket #60](https://github.com/paulpengtw-aiagent/solo-ledger/issues/60)

- **付款人**: explicit per-row picker showing both names; no default.
- **記帳人**: stamped server-side by the Cloudflare Pages Function from
  the `Cf-Access-Authenticated-User-Email` header; 設定 maps email →
  partner name. Client cannot assert it.
- **Partner onboarding**: add their email to the Cloudflare Access
  allowlist. The Apps Script `/exec` endpoint stays execute-as-owner and
  anonymous-behind-HMAC — no Google-side permission on the write path.
- **Raw sheet**: shared to the partner as Viewer; 手動 hand edits remain
  the owner's alone.

## 5. Payables & settlement — [ticket #62](https://github.com/paulpengtw-aiagent/solo-ledger/issues/62)

No month concept — pure running balances; month-end settling is a
household habit, not a book concept. Two gross directions, never netted:

- 阿哲應付小語 = Σ 阿哲's shares on non-voided rows where 付款人=小語
  − Σ non-voided 結清 rows where 付款人=阿哲 (names illustrative)
- the mirror for the other direction

**結清 row**: 分類=「結清」, 付款人 = the debtor, 分攤方式 empty, amount
free — partial fine, overpay blocked (never beyond the direction's
outstanding). Records obligation discharge, not bank movements:
physically offsetting the two directions is recorded as two 結清 rows.
NT$0.5 residue carries indefinitely. A late 沖銷 simply moves today's
payable; a direction pushed negative by voiding an already-settled row
is displayed as over-settled and nets against future shares.

## 6. Bootstrap — [ticket #63](https://github.com/paulpengtw-aiagent/solo-ledger/issues/63)

Start clean: settle any outstanding solo-book 代墊 before cutover; the
shared book opens at zero. Bootstrap = creating empty sheets: 帳目, 分類
vocabulary (with reserved 結清), 選項清單, and 設定 (email→name mapping).
No opening rows of any kind.

## 7. UI — winning prototype variants

- **Entry flow** — [ticket #64](https://github.com/paulpengtw-aiagent/solo-ledger/issues/64):
  wizard, one decision per screen: 金額 → 誰付的 (two giant buttons,
  tapping the answer advances) → 怎麼分 (three stacked buttons, 均分
  first) → 分類 + optional 交易對象 → 確認 with summary and live derived
  應付 preview. Asset: `prototype-entry.html` (variant B of three).
- **Balance & settle-up** — [ticket #65](https://github.com/paulpengtw-aiagent/solo-ledger/issues/65):
  per-direction 分向對帳 statement: segment control per direction,
  outstanding 應付 on top, plus/minus lines with a running-balance
  column, pinned 結清 bar capped at outstanding. Asset:
  `prototype-balance.html` (variant B of three).

Prototype code is throwaway — reimplement properly; the assets are the
reference.

## 8. Prior art — [ticket #58](https://github.com/paulpengtw-aiagent/solo-ledger/issues/58)

Survey of Splitwise / Tricount / partnership double-entry informed the
running-balance choice and the append-only stance (Splitwise's silent
retroactive edits are the failure mode 沖銷-only correction avoids).
