# partner-ledger

Two-person split ledger: a mobile PWA appends split-expense rows into one
shared Google Spreadsheet, the only datastore. The book is a **flat list,
not double-entry** — month-end payables between the two partners are
derived arithmetic over rows, never posted balances.

Forked from solo-ledger; solo terms not listed here (借/貸 pairs, 會計科目,
應收/應付帳款, 代墊, 結清狀態) are **dead** in this fork.

## Language

### The book

**帳目 (Entry list)**:
The append-only flat list of shared expenses; one row = one expense with
a single positive 金額. Mixed receipts are entered as multiple rows.
_Avoid_: 日記帳, journal, transactions sheet.

**金額**:
The full amount actually paid at the counter — never a share.

**付款人 (Payer)**:
Which partner handed over the money for the row. An explicit per-row
choice; never defaulted, never inferred.

**分攤方式 (Split)**:
Three-state, per row: **均分** (50/50, the default) / **全額對方** (the
whole amount is the *other* partner's share — the pure advance /
forgotten-wallet case) / **全額自己** (the payer's own share; creates no
inter-partner debt). Shares are derived from 金額 + 分攤方式, exact to
NT$0.5, and never stored.
_Avoid_: percentage splits, exact-amount splits, 代墊 (subsumed by 全額對方).

**記帳人 (Enterer)**:
Which partner wrote the row; stamped server-side from the Cloudflare
Access email via the 設定 email→name mapping. Distinct from 付款人, and
distinct from 來源 (the channel, not the person).

**分類 (Category)**:
Spending-category label from the sheet-resident vocabulary. A plain
label — no 類型, no real/nominal distinction.
_Avoid_: tag, label.

**交易對象 (Counterparty)**:
The person or merchant a row relates to; free text, suggested from
選項清單.
_Avoid_: 對象 (legacy header spelling), vendor, payee.

**來源 (Source)**:
Which writer channel produced a row: `pwa` or `手動` (hand-entered by the
sheet owner).

**txn_id**:
Client-generated UUID naming one row; doubles as the idempotency key.
Hand rows may omit it and are then invisible to txn_id-addressed actions.

### Corrections

**沖銷 (Reversal)**:
A mirror row that voids an earlier row, linked via 沖銷txn_id — the only
app-side correction; there is no edit-in-place through the app. Either
partner may 沖銷 any row; the reversal's 記帳人 records who voided it.
_Avoid_: delete, undo, edit.

**Hand edit**:
The sheet owner's out-of-app escape hatch for cases the app doesn't
model (e.g., refunds). Not available to the partner (Viewer access);
not a 沖銷.

### Settlement

**應付 (Payable)**:
A running gross total one partner owes the other, derived — never
stored — from non-voided rows: that partner's shares on rows the other
paid, minus that partner's 結清 rows. Two directions exist and are
tracked separately; there is no month, period, or closing concept.
_Avoid_: 應付帳款, net balance, 月結.

**結清 (Settlement)**:
A row with the reserved 分類「結清」 that discharges part or all of one
應付 direction; its 付款人 is the debtor, its 分攤方式 is empty, its
amount is free (partial fine, never beyond the direction's
outstanding). Records obligation discharge, not bank movements —
physically offsetting the two directions is recorded as two 結清 rows.
_Avoid_: settle up, 沖銷 (that voids rows; 結清 pays debts).

### Ops

**設定 (Settings)**:
Sheet-resident configuration, including the Access-email → partner-name
mapping that identifies 記帳人.

**選項清單**:
Sheet-resident suggestion vocabulary for 分類 and 交易對象.

**schema_version**:
Fingerprint of the sheet-resident vocabulary (分類 list + 選項清單 + 設定);
changes when the owner edits vocabulary by hand.
