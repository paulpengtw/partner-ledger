import { describe, expect, it } from 'vitest'
import { loadEntryFunctions, type EntryInput } from './helpers/gas'

const { expandEntry_, ENTRY_HEADERS } = loadEntryFunctions()

const partners = ['阿哲', '小語']

function createInput(overrides: EntryInput = {}): EntryInput {
  return {
    kind: 'create',
    date: '2026-08-09',
    amount: 300,
    payer: '小語',
    split: '這筆平分',
    category: '餐飲',
    payee: '全聯',
    enterer: '阿哲',
    partners,
    txnId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  }
}

describe('ENTRY_HEADERS', () => {
  it('lists the flat 帳目 columns in spec order', () => {
    expect(ENTRY_HEADERS).toEqual([
      'txn_id',
      '日期',
      '金額',
      '付款人',
      '分攤方式',
      '分類',
      '交易對象',
      '記帳人',
      '來源',
      '沖銷 txn_id',
    ])
  })
})

describe('expandEntry_ create', () => {
  it('expands a 這筆平分 expense into one flat row', () => {
    expect(expandEntry_(createInput())).toEqual({
      txn_id: '11111111-1111-4111-8111-111111111111',
      日期: '2026-08-09',
      金額: 300,
      付款人: '小語',
      分攤方式: '這筆平分',
      分類: '餐飲',
      交易對象: '全聯',
      記帳人: '阿哲',
      來源: 'pwa',
      沖銷txn_id: '',
    })
  })

  it('keeps 交易對象 optional', () => {
    expect(expandEntry_(createInput({ payee: undefined }))['交易對象']).toBe('')
  })

  it.each(['幫狗狗付', '幫自己付'])('accepts 分攤方式 %s', (split) => {
    expect(expandEntry_(createInput({ split }))['分攤方式']).toBe(split)
  })

  it('rejects a 付款人 who is not one of the two partners', () => {
    expect(() => expandEntry_(createInput({ payer: '路人' }))).toThrow('付款人')
  })

  it('rejects a missing 付款人 — the payer is never defaulted', () => {
    expect(() => expandEntry_(createInput({ payer: undefined }))).toThrow('付款人')
  })

  it('rejects an unknown 分攤方式', () => {
    expect(() => expandEntry_(createInput({ split: '三七分' }))).toThrow('分攤方式')
  })

  it('rejects the reserved 分類 結清 on an expense', () => {
    expect(() => expandEntry_(createInput({ category: '結清' }))).toThrow('結清')
  })

  it('rejects a non-positive 金額', () => {
    expect(() => expandEntry_(createInput({ amount: 0 }))).toThrow('金額')
    expect(() => expandEntry_(createInput({ amount: -10 }))).toThrow('金額')
  })

  it('rejects a missing 記帳人', () => {
    expect(() => expandEntry_(createInput({ enterer: undefined }))).toThrow('記帳人')
  })
})
## 3. Apps Script release (manual)

The current project is titled `狗狗記帳_gs`, has Script ID `1ILn1uVrpUk-SO7SyCaGxG20UOVj4eqVNKYrSmB-uGKV4_tbbSQ1YF5Ko`, and is owned by `paulpeng118@gmail.com`. Its `/exec` web-app deployment ID is `AKfycbzsK256P__IeaEpVzaFwnLfvKk4RVBQTZ-vpHIUG0l71bTD-7zrG9y842SyI_Ku52hC`; it currently serves version 2, has access `ANYONE_ANONYMOUS`, and executes as `USER_DEPLOYING`.

The bound spreadsheet is titled `狗狗記帳_excel` and has ID `1JKJshYxThC9_HmLssoOSaGcKGutiO1EHTkUp_SyDfi8`. `setupSpreadsheet()` has been run; the four sheets exist and `分類` is seeded.

1. Create a blank Google Spreadsheet and record its ID.
2. Create a standalone Apps Script project and record the Script ID.
3. Create `.clasp.json` at the repository root (gitignored):

   ```json
   {"scriptId": "<script-id>", "rootDir": "apps-script"}
   ```

4. Run `clasp login` once:

   ```sh
   clasp login
   ```

5. Run `clasp push` to upload `apps-script/Code.gs` and `apps-script/appsscript.json`:

   ```sh
   clasp push
   ```

Operational warning: `clasp push` alone does **not** change what `/exec` serves. A web-app deployment is pinned to a numbered version, so after pushing you must also cut a new version and re-point the deployment:

```sh
clasp deploy -i <DEPLOYMENT_ID> -d "<description>"
```

Skipping this is what makes `/exec` return the HTML error `找不到以下指令碼函式：doPost` while the source in the editor looks correct.

Set these Script Properties in the Apps Script editor:

| Property | Required? | Notes |
| --- | --- | --- |
| `LEDGER_SPREADSHEET_ID` | Required | ID of the spreadsheet created above |
| `EXPENSE_API_SECRET` | Required | Byte-identical to the Pages value; generate with `openssl rand -hex 32` |
| `LEDGER_BACKUP_FOLDER_ID` | Optional | Drive folder for weekly backups |

Then choose **Deploy → New deployment → Web app**, execute as **Me**, and set access to **Anyone**. Record the resulting `/exec` URL and set it as the Pages `EXPENSE_API_URL`. (These correspond to `USER_DEPLOYING` and `ANYONE_ANONYMOUS`, which is what the current deployment reports.)

Apps Script `doPost` routes six actions—the seven above minus `auth-check`, which the Pages Function answers itself.

The weekly backup writes to a Drive folder named `Partner Ledger backups`.

Testing note: probing `/exec` with `curl -L` is misleading. On success Apps Script answers a POST with a `302` to `script.googleusercontent.com`, and that second hop is GET-only, so `curl -L` re-POSTs into a `405`/`401` plus a Drive “can't open this file” HTML page that looks like an auth failure. Probe by POSTing without `-L`, then issue a GET to the `Location` URL.

## 4. First-time spreadsheet setup (run from the Apps Script editor)

- `setupSpreadsheet()` creates exactly four sheets: `帳目`, `分類`, `選項清單`, `設定`. It seeds the `分類` vocabulary, including the reserved `結清`, and seeds placeholder email→name rows in `設定`.
- `帳目` carries exactly ten headers in this order:

  ```text
  txn_id
  日期
  金額
  付款人
  分攤方式
  分類
  交易對象
  記帳人
  來源
  沖銷 txn_id
  ```

- Hand-edit `設定` to replace `owner@example.com` and `partner@example.com` with the two real partner emails. `記帳人` is stamped server-side from the Cloudflare Access email via this mapping, so it must agree with the Access allowlist.
- `installWeeklyTriggers()` installs exactly one trigger: `weeklyBackup`, Monday 08:00 Asia/Taipei. There is no consistency-check trigger.
- Do not include any opening-balance step: the shared book opens at zero with no opening rows of any kind.

## 5. Smoke checklist

Steps 1, 4, 5, 6, 7 and 8 were executed and passed on 2026-08-10 against the live deployment. Specifically verified: idempotent replay of a `txn_id` returned `already: true` and appended no second row; `記帳人` was stamped server-side and `來源` was `pwa`; over-settlement was refused with `over-settlement: amount 1150 exceeds outstanding 150`; the `結清` row carried `分類` `結清`, `付款人` the debtor, and an empty `分攤方式`; and 沖銷 appended mirror rows linked by `沖銷txn_id` while leaving both originals unedited and undeleted.

Ordering warning: steps 7 and 8 must be run in the order settle (step 8) before reverse (step 7). `computePayables_` skips voided rows, so reversing the spending row first drops the outstanding balance to zero and leaves step 8 with no real 應付 direction to settle against.

1. **Access gate.** Send an unauthenticated request to `/api/health`. It must be refused, not served. The deployed behaviour distinguishes a plain browser POST, which redirects to the Cloudflare Access login, from an XHR POST, which returns `401`; describe and observe that distinction rather than relying on one exact status locally.

   ```text
   curl -X POST https://partner-ledger.pages.dev/api/health
   unauthenticated; try the plain browser request and the XHR request separately
   ```

2. **Authenticated health.** After Access authentication, send the same request and confirm that `/api/health` succeeds.

   ```text
   curl -X POST https://partner-ledger.pages.dev/api/health
   authenticated through Cloudflare Access
   ```

3. **Caller identity.** Call `auth-check` and confirm that it returns the caller's identity and that the Cloudflare Access email resolves through the `設定` email mapping to a `記帳人` name. If it comes back unmapped, the `設定` edit from §4 was not done.

   ```text
   curl -X POST https://partner-ledger.pages.dev/api/auth-check
   ```

4. **Sheet vocabulary.** Call `get_options` and confirm that it returns the sheet-resident vocabulary: the seeded `分類` list with the reserved `結清` absent, and the `選項清單` suggestions. `getOptions_` filters `結清` out because it is reserved for settlement rows, `create_transaction` rejects it, and it is reachable only via `settle`.

   ```text
   curl -X POST https://partner-ledger.pages.dev/api/get_options
   ```

5. **Create a smoke row.** Call `create_transaction` once with a seeded ordinary spending category such as `餐飲` (the seeded vocabulary also includes `交通`; never use `結清` for this step), an explicit `付款人`, and `分攤方式` `這筆平分`.

   ```text
   curl -X POST https://partner-ledger.pages.dev/api/create_transaction
   txn_id: client-generated UUID
   分類：餐飲
   金額：the full amount paid at the counter
   付款人：explicit payer
   分攤方式：這筆平分
   ```

   `金額` is the full amount paid at the counter, never a share. Shares are derived and never stored. `txn_id` is a client-generated UUID and the idempotency key; resending the same `txn_id` must not double-append the row.

6. **Read the smoke row.** Call `list_transactions` and confirm that the row just written appears with `記帳人` stamped server-side and `來源` set to `pwa`.

   ```text
   curl -X POST https://partner-ledger.pages.dev/api/list_transactions
   ```

7. **Reverse the smoke row (沖銷).** Call `reverse_transaction` for the test row. Confirm that a mirror row appears linked by `沖銷txn_id`, while the original row is not edited in place or deleted. 沖銷 is the only app-side correction.

   ```text
   curl -X POST https://partner-ledger.pages.dev/api/reverse_transaction
   original txn_id: the smoke row's txn_id
   ```

8. **Settle a real 應付 direction (結清).** Call `settle` against a real outstanding 應付 direction and confirm that the resulting 結清 row carries the reserved 分類「結清」, its 付款人 is the debtor, its 分攤方式 is empty, and its amount may be partial but never beyond that direction's outstanding amount. 應付 is derived from non-voided rows and never stored; the two directions are tracked separately. There is no month, period, or closing concept.

   ```text
   curl -X POST https://partner-ledger.pages.dev/api/settle
   ```

9. **PWA install check.** Confirm that the app installs as `狗狗記帳` and that `short_name` is `狗狗帳`.

10. **Backup check.** Confirm that the weekly backup can write and that the Drive folder is named `Partner Ledger backups`.

After the checklist, remove the smoke rows via 沖銷，or hand-edit them out as the sheet owner, so the shared book does not open with test data.

The 2026-08-10 smoke rows were subsequently removed by the sheet owner; list_transactions over 2026-01-01..2026-12-31 returns an empty transactions array with both payable directions at 0, and schema_version is unchanged at da7e535836ce. The book is empty.

## 6. Access policy

The current self-hosted application is named `Partner Ledger` and covers `partner-ledger.pages.dev`. Its AUD is `9d2bfc582e8eca1fb00a38c34790a1038b26df9bedfe487310bf821329842682`, and its session duration is `730h`.

The team domain is `damp-brook-2531.cloudflareaccess.com`. It is account-wide and shared with the `solo-ledger` app.

Exactly one Allow policy named `Partners` contains both partner emails.

Verified on 2026-08-10: an unauthenticated plain POST to `/api/health` returns `302` to the Access login, while an XHR POST returns `401`.

The current `設定` mapping is `夥伴:paulpeng118@gmail.com` → `cheng` and `夥伴:amyevaleo0830@gmail.com` → `翊`. `get_options` confirms partners `cheng` / `翊`, and this mapping agrees with the Access policy.

Use ONE Cloudflare Access Allow policy containing BOTH partner emails from §4. Keep both emails within that one policy; do not create a separate policy for either email.

Partner onboarding is exactly this: add the partner's email to the allowlist. There is no separate account system.

The Pages Function stamps `Cf-Access-Authenticated-User-Email` into each row as `記帳人` server-side. Therefore, the Access allowlist and the `設定` email→name mapping must agree. An email that is allowed but unmapped produces rows whose `記帳人` is not a partner name.

The sheet owner additionally has an out-of-app hand-edit escape hatch; the partner with Viewer access does not.

## 7. Active CI operations

CI/CD is active through the workflows described in §0. The manual procedures in §2 and §3 remain valid as the fallback / first-time path.

Operational caveats:

1. `deploy-apps-script.yml` has no test gate. Any push touching `apps-script/**` re-points the live `/exec` deployment that the PWA calls. The §3 warning that `clasp push` alone does not change what `/exec` serves is what this workflow's `clasp deploy -i` step exists to handle.
2. clasp refresh tokens expire (roughly 6 months unused, or on Google password change). When Apps Script deploys begin failing to authenticate, re-run `clasp login` locally and reset the `CLASPRC_JSON` secret.

## 8. Unverified / TBD

- `installWeeklyTriggers()` was reported run on 2026-08-10, but Apps Script exposes no trigger-inspection API, so it cannot be confirmed from outside the editor. It proves itself on first fire when the `Partner Ledger backups` folder appears in Drive; if that folder never appears after the first Monday 08:00 Asia/Taipei, the trigger did not install.
- Smoke steps 2, 3, and 9 have not been executed because they need a real browser session or device.
- Step 10 (backup) has not been verified. Note: `LEDGER_BACKUP_FOLDER_ID` being unset is expected behaviour — `weeklyBackup` calls `DriveApp.createFolder` and stores the ID on first run — so this is not an open problem.

As each item is settled, replace it here and in the section that depends on it, rather than leaving both.
