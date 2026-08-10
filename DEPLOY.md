# Deploying Partner Ledger

Partner Ledger is a two-person split ledger: a mobile PWA appends split-expense rows to one shared Google Spreadsheet. The book (帳目) is a flat, append-only list, not a double-entry ledger.

## 0. Current deploy status

There is no active CI/CD. Deploys are manual today.

The workflow YAML lives in `.github.template/workflows/`, not `.github/workflows/`. GitHub therefore registers zero workflows on this repository, and zero Actions secrets are set.

The three runs visible in the Actions tab all fired from the initial import commit while the workflows were still under `.github/`; none have run since the fork commit. Their presence is misleading.

See §7 for how to activate CI.

## 1. Prerequisites

- Node.js version specified by `package.json` `engines` (`node >=26`); the workflow templates pin Node 26.
- A Cloudflare account with Pages access.
- `wrangler` invoked via `npx`, at the version specified by the `package.json` devDependency.
- The `clasp` CLI authenticated to the Google account that will own the Apps Script project.
- A Google account that can create the shared Spreadsheet.

Keep secrets in three distinct configuration homes:

(a) local shell / `.env` — Cloudflare deploy credentials

(b) the Pages project environment — runtime vars

(c) Apps Script Script Properties — server-side vars

`EXPENSE_API_SECRET` exists in both (b) and (c) and must be byte-identical.

## 2. Cloudflare Pages release (manual, direct-upload mode)

ADR 0001 chose GitHub Actions over Pages Git integration, so the Pages project is not connected to this repository. Do not add a repository-connection step.

1. Install the repository dependencies:

   ```sh
   npm ci
   ```

2. Build the application:

   ```sh
   npm run build
   ```

   This runs `tsc --noEmit && vite build` and outputs `dist/`.

3. Upload the Pages release directly:

   ```sh
   npx wrangler pages deploy dist --project-name=<pages-project-name> --branch=main
   ```

The local shell must provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Set these four runtime environment variables on the Pages project, not in source:

| Variable | Purpose |
| --- | --- |
| `EXPENSE_API_URL` | The Apps Script `/exec` URL |
| `EXPENSE_API_SECRET` | HMAC signing secret — must match the Apps Script Script Property |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain |
| `CF_ACCESS_AUD` | Cloudflare Access AUD tag |

The Pages Function at `functions/api/[action].ts` serves `/api/[action]` and admits exactly these seven actions:

```text
health
auth-check
get_options
create_transaction
list_transactions
settle
reverse_transaction
```

## 3. Apps Script release (manual)

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

Set these Script Properties in the Apps Script editor:

| Property | Required? | Notes |
| --- | --- | --- |
| `LEDGER_SPREADSHEET_ID` | Required | ID of the spreadsheet created above |
| `EXPENSE_API_SECRET` | Required | Byte-identical to the Pages value; generate with `openssl rand -hex 32` |
| `LEDGER_BACKUP_FOLDER_ID` | Optional | Drive folder for weekly backups |

Then choose **Deploy → New deployment → Web app**, execute as **Me**, and set access to **Anyone**. Record the resulting `/exec` URL and set it as the Pages `EXPENSE_API_URL`.

Apps Script `doPost` routes six actions—the seven above minus `auth-check`, which the Pages Function answers itself.

The weekly backup writes to a Drive folder named `Partner Ledger backups`.

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
  沖銷txn_id
  ```

- Hand-edit `設定` to replace `owner@example.com` and `partner@example.com` with the two real partner emails. `記帳人` is stamped server-side from the Cloudflare Access email via this mapping, so it must agree with the Access allowlist.
- `installWeeklyTriggers()` installs exactly one trigger: `weeklyBackup`, Monday 08:00 Asia/Taipei. There is no consistency-check trigger.
- Do not include any opening-balance step: the shared book opens at zero with no opening rows of any kind.

## 5. Smoke checklist

1. **Access gate.** Send an unauthenticated request to `/api/health`. It must be refused, not served. The deployed behaviour distinguishes a plain browser POST, which redirects to the Cloudflare Access login, from an XHR POST, which returns `401`; describe and observe that distinction rather than relying on one exact status locally.

   ```text
   curl -X POST https://<pages-project-name>.pages.dev/api/health
   unauthenticated; try the plain browser request and the XHR request separately
   ```

2. **Authenticated health.** After Access authentication, send the same request and confirm that `/api/health` succeeds.

   ```text
   curl -X POST https://<pages-project-name>.pages.dev/api/health
   authenticated through Cloudflare Access
   ```

3. **Caller identity.** Call `auth-check` and confirm that it returns the caller's identity and that the Cloudflare Access email resolves through the `設定` email mapping to a `記帳人` name. If it comes back unmapped, the `設定` edit from §4 was not done.

   ```text
   curl -X POST https://<pages-project-name>.pages.dev/api/auth-check
   ```

4. **Sheet vocabulary.** Call `get_options` and confirm that it returns the sheet-resident vocabulary: the seeded `分類` list, including the reserved `結清`, and the `選項清單` suggestions.

   ```text
   curl -X POST https://<pages-project-name>.pages.dev/api/get_options
   ```

5. **Create a smoke row.** Call `create_transaction` once with a seeded ordinary spending category such as `餐飲` (the seeded vocabulary also includes `交通`; never use `結清` for this step), an explicit `付款人`, and `分攤方式` `均分`.

   ```text
   curl -X POST https://<pages-project-name>.pages.dev/api/create_transaction
   txn_id: client-generated UUID
   分類: 餐飲
   金額: the full amount paid at the counter
   付款人: explicit payer
   分攤方式: 均分
   ```

   `金額` is the full amount paid at the counter, never a share. Shares are derived and never stored. `txn_id` is a client-generated UUID and the idempotency key; resending the same `txn_id` must not double-append the row.

6. **Read the smoke row.** Call `list_transactions` and confirm that the row just written appears with `記帳人` stamped server-side and `來源` set to `pwa`.

   ```text
   curl -X POST https://<pages-project-name>.pages.dev/api/list_transactions
   ```

7. **Reverse the smoke row (沖銷).** Call `reverse_transaction` for the test row. Confirm that a mirror row appears linked by `沖銷txn_id`, while the original row is not edited in place or deleted. 沖銷 is the only app-side correction.

   ```text
   curl -X POST https://<pages-project-name>.pages.dev/api/reverse_transaction
   original txn_id: the smoke row's txn_id
   ```

8. **Settle a real 應付 direction (結清).** Call `settle` against a real outstanding 應付 direction and confirm that the resulting 結清 row carries the reserved 分類「結清」, its 付款人 is the debtor, its 分攤方式 is empty, and its amount may be partial but never beyond that direction's outstanding amount. 應付 is derived from non-voided rows and never stored; the two directions are tracked separately. There is no month, period, or closing concept.

   ```text
   curl -X POST https://<pages-project-name>.pages.dev/api/settle
   ```

9. **PWA install check.** Confirm that the app installs as `Partner Ledger 夥伴記帳` and that `short_name` is `記帳`.

10. **Backup check.** Confirm that the weekly backup can write and that the Drive folder is named `Partner Ledger backups`.

After the checklist, remove the smoke rows via 沖銷, or hand-edit them out as the sheet owner, so the shared book does not open with test data.

## 6. Access policy

Use ONE Cloudflare Access Allow policy containing BOTH partner emails from §4. Keep both emails within that one policy; do not create a separate policy for either email.

Partner onboarding is exactly this: add the partner's email to the allowlist. There is no separate account system.

The Pages Function stamps `Cf-Access-Authenticated-User-Email` into each row as `記帳人` server-side. Therefore, the Access allowlist and the `設定` email→name mapping must agree. An email that is allowed but unmapped produces rows whose `記帳人` is not a partner name.

The sheet owner additionally has an out-of-app hand-edit escape hatch; the partner with Viewer access does not.

## 7. Activating CI (not yet done)

The following activation work has NOT been performed; CI is not current behaviour.

1. Copy the workflow files from `.github.template/workflows/` to `.github/workflows/`. GitHub only registers workflows under `.github/workflows/`, which is why nothing runs today.
2. Set three repository Actions secrets, none of which currently exist: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLASPRC_JSON` (the contents of the local `~/.clasprc.json` produced by a one-time `clasp login`).
3. In `.github/workflows/deploy.yml`, replace the inherited solo-ledger Pages project name and the inherited `solo-ledger.pages.dev` smoke-check URL with the real partner-ledger values. Refer to the `<pages-project-name>` placeholder convention already used earlier in DEPLOY.md rather than inventing a name.
4. In `.github/workflows/deploy-apps-script.yml`, replace the hardcoded `SCRIPT_ID` and `DEPLOYMENT_ID`. These were inherited verbatim from solo-ledger at the import commit and were not updated by the fork; check them before activating.

The inactive templates stay in the repo because the test suite parses those YAML files and asserts their structure, so the workflow definitions are tested for correctness even while no workflow is registered. Deleting them would break those tests.

## 8. Unverified / TBD

- Whether a Cloudflare Pages project exists for `partner-ledger` at all, and under what name. No wrangler config, CNAME, or deployed URL appears anywhere in the repo except the inherited template.
- Whether the `SCRIPT_ID` and `DEPLOYMENT_ID` in `.github.template/workflows/deploy-apps-script.yml` are partner-ledger's or still solo-ledger's. The values cannot be verified from the repo.
- Whether `EXPENSE_API_SECRET` has been generated and stored in both homes. It is gitignored and absent from GitHub secrets; its presence in the Apps Script Script Properties is not observable from the repo.
- Whether the Cloudflare Access application is configured. `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` values live only in the Pages environment, not in source.

As each item is settled, replace it here and in the section that depends on it, rather than leaving both.
