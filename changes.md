# Ledgerly change log

This is the running record of changes made to Ledgerly. Start each new session here, read the latest entry, and append a new entry for every future change.

## How to use this file

- Keep entries in date order, newest date at the bottom.
- Record the commit hash, time, what changed, key files, and verification.
- Do not rewrite old entries; add a correction note if something changes later.
- Never point tests or the review server at the live `data/accounting.db`. Use a disposable `LEDGERLY_DATA_DIR`.
- Run `npm run check`, `npm test`, and `npm run test:e2e` before committing.

---

## 2026-10-22

### End-of-day status

- **HEAD:** `4d5e52e Show visa applicant and items on customer statements`
- **Working tree:** clean
- **Checks:** `npm run check` passed 138 files; `npm test` passed 66 tests; `npm run test:e2e` passed 14 tests
- **Live database:** `data/accounting.db` untouched (size `417792`, mtime `2026-10-21 13:09:49`)
- **Visual checks:** customer statement at 846px, 390px mobile, and print; vendor statement checked with no applicant/item artifacts

### Today's commits

| Time | Commit | Change |
| --- | --- | --- |
| 14:51 | `d113299` | Distinguish customer and visitor visa applicants |
| 16:03 | `4e352b5` | Add cascading void workflows and audit log |
| 16:20 | `9eca7cb` | Add Visa Agent supplier portal type with safe migration |
| 16:41 | `612c99a` | Show visitor visa applicant details on invoices |
| 16:50 | `e6af640` | Add visa duration in days |
| 17:12 | `1a9b0bf` | Show visa applicant on portal statements |
| 17:41 | `0048c6e` | Polish customer statements |
| 18:24 | `4d5e52e` | Show visa applicant and items on customer statements |

### 1. Customer vs visitor visa applicants — `d113299` (14:51)

- Added `visa_applications.applicant_is_customer` with a migration that classifies legacy rows once.
- Visa editor now has **This visa is for someone else**:
  - Off: applicant name follows the selected customer and is read-only.
  - On: visitor name becomes required, with passport and nationality details.
- Server normalizes the flag and still supports older callers that do not send it.
- Customer invoice still belongs to the paying customer; the visitor is stored as the applicant.
- Added unit, hardening, and browser coverage.

Key files: `server/schema.js`, `server/migrations.js`, `server/services/visas.js`, `public/js/views/visas.js`.

### 2. Cascading void workflows and audit log — `4e352b5` (16:03)

- Every financial void now requires remarks and retains the original record.
- Voiding a document cascades through linked payments, refunds, credit applications, supplier credits, advances, and journal entries.
- Portal top-ups, refunds, and credits can be voided, with historical wallet-balance checks.
- Added a searchable **System → Audit log** page with entity, amount, remarks, action, and timestamp.
- Added void actions/routes across invoices, bills, credits, supplier credits, advances, openings, reconciliations, cheques, journals, and portals.
- Added `audit_logs` table, void metadata columns, indexes, and route/API coverage.

Key files: `server/services/audit.js`, `server/routes/audit-logs.js`, `public/js/views/audit-logs.js`, plus the void service/route changes.

### 3. Visa Agent supplier portal type — `9eca7cb` (16:20)

- Added `visa_agent` to allowed supplier portal types.
- Added a safe migration that rebuilds the `supplier_portals` table while preserving IDs and wallet references.
- Updated portal UI labels, dashboard/report labels, and README wording.
- Added migration and browser coverage.

Key files: `server/migrations.js`, `server/schema.js`, `server/services/portals/common.js`, `public/js/views/portals.js`.

### 4. Visitor applicant details on invoices — `612c99a` (16:41)

- Invoice detail API now attaches linked visa fields when `visa_id` exists.
- Visitor visa invoices show a separate **Visa applicant** panel with:
  - applicant name
  - nationality
  - passport number and expiry
  - date of birth when present
  - visa number, destination/type, and embassy reference
- The invoice **Bill To** remains the paying customer.
- Added responsive and print styles, plus unit and browser tests.

Key files: `server/services/invoices.js`, `public/js/views/invoice-detail.js`, `public/css/styles.css`.

### 5. Visa duration in days — `e6af640` (16:50)

- Added optional `visa_applications.duration_days`.
- Duration accepts whole days from 1 to 3650; blank/0 means not fixed.
- Duration appears in the visa list, visa detail, invoice terms, and applicant panel.
- Added migration, server validation, demo data, and tests.

Key files: `server/schema.js`, `server/migrations.js`, `server/services/visas.js`, `public/js/views/visas.js`, `public/js/views/visa-detail.js`.

### 6. Visa applicant on portal statements — `1a9b0bf` (17:12)

- Portal lifecycle now joins the linked visa applicant onto wallet settlements and open bills.
- Portal detail shows `Visa ... · Applicant: ... · nationality · passport` for visa-linked rows.
- Added unit and browser coverage.

Key files: `server/services/portals/lifecycle.js`, `public/js/views/portal-detail.js`.

### 7. Customer statement polish — `0048c6e` (17:41)

- Added statement KPI cards: opening balance, invoiced, received, and amount due.
- Added **This month**, **This year**, and **All time** presets with active state.
- Added clean transaction titles, coloured status dots, due/method detail lines, and zero-value dashes.
- Added settled/payment-due/credit status badge and improved statement footer.
- Added explicit table columns, responsive rules, and print styling.
- Added browser coverage for summary cards, presets, and clean ledger rows.

Key files: `public/js/views/statement.js`, `public/css/styles.css`.

### 8. Invoice items + visa applicant on customer statements — `4d5e52e` (18:24)

- Customer statement service now enriches invoice rows with:
  - `items`: invoice line descriptions, quantity, unit price, and amount
  - `visa`: linked applicant and visa details when the invoice came from a visa
- Customer statement invoice rows now show:
  - up to 3 item lines, then `+N more item(s)`
  - a separate **Visa applicant** card with Visitor/Customer tag, name, nationality, passport, expiry, DOB when present, and visa number/type/destination/duration/reference
- Bill To remains the paying customer.
- Vendor statement rows are unchanged and show no applicant/item artifacts.
- Tightened statement table spacing and kept print/light/mobile behaviour intact.
- Added unit coverage for statement enrichment and browser coverage for applicant/item display.

Key files: `server/services/statements.js`, `public/js/views/statement.js`, `public/css/styles.css`, `test/visas.test.js`, `test/e2e/browser.test.js`.

---

## Next session

1. Start from `4d5e52e`.
2. Read the latest entry above and run the full check suite.
3. Use a disposable database for review; never modify live `data/accounting.db`.
4. Append the next change under a new date heading in this file before committing.
