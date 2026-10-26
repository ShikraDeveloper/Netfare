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

---

## 2026-10-24

### Phase 1 — Settlements hub and cross-document clarity — code commit `bd8e02f`

- Grouped Cancellations, Refunds, and Credit notes under a new **Settlements** navigation group. The three accounting documents remain separate.
- Added clearer page titles, settlement/status badges, and source badges:
  - Cancellations: **Cancellations & settlements**, refund-due count, settlement column.
  - Refunds: **Customer & supplier refunds**, source badge and source link, payment-refund-only warning.
  - Credit notes: **Credit notes & customer credits**, cancellation/standalone source badge and filter, issued/partially applied/fully applied status badges.
- Added cross-links:
  - Credit detail → source cancellation, plus a plain-language accounting explanation.
  - Cancellation detail → original invoice.
  - Invoice detail → source cancellation, using a read-only lookup in `getInvoice`.
  - Refund list → source cancellation, invoice, bill, or supplier credit where a detail route exists.
- Added a live cancellation settlement preview: money held, charges, refund due, shortfall invoice, supplier credits, retained supplier cost, and an explanatory note.
- Added a credit-note warning when the selected customer has an open cancellation refund, plus a standalone-credit accounting note.
- Added a refund warning that the form only handles invoice/bill payment refunds; cancellation and advance refunds stay on their source screens.
- No changes to cancellation/refund/credit-note tables, posting rules, or the AED-only, no-VAT setup.

Key files: `public/js/app.js`, `public/js/views/cancellation-modal.js`, `public/js/views/cancellations.js`, `public/js/views/refunds.js`, `public/js/views/refund-modal.js`, `public/js/views/credits.js`, `public/js/views/credit-detail.js`, `public/js/views/cancellation-detail.js`, `public/js/views/invoice-detail.js`, `server/services/invoices.js`, `public/css/styles.css`, `public/css/theme.css`, `README.md`.

Verification:

- `npm run check`: 138 JavaScript files syntax OK.
- `npm test`: 66 tests passed.
- `npm run test:e2e`: 14 tests passed.
- Manual disposable-DB pass on `127.0.0.1:4180`: created cancellation `CNC-2026-0001`, cancellation credit `CR-2026-0001`, and cancellation refund `REF-2026-0001`; verified the Settlements nav, cancellation preview, source badges/links/filters, credit warning, refund warning, invoice cancellation action, and the live recovered data at `127.0.0.1:4173`.
- Live `data/accounting.db` was not modified.

### Next session

1. Start from the latest `main`; the Phase 1 code commit is `bd8e02f`.
2. Read this entry and run the full check suite.
3. Use a disposable database for review; never modify live `data/accounting.db`.
4. Append the next change under a new date heading before committing.

---

## 2026-10-26

### Phase 2 — Settlement choice, customer balances, queue and void preview — code commit `368dd4a`

- Added a post-cancellation settlement choice:
  - Cancelling a booking or visa redirects to `#/cancellations/:id?settle=1`.
  - The panel offers **Pay refund**, **Convert to credit**, or **Decide later**.
  - Partial refunds and credits keep the panel open with the remaining amount; **Settlement options** reopens it later.
  - Deferring leaves the money in `2500 Refund Payable` and removes the query string.
- Added **Customer balances** under **Settlements**:
  - Derived, uncached receivables, overdue amounts, unapplied credits, customer advances, cancellation refunds and net position.
  - List page with KPI cards, search, balance/archived filters and pagination.
  - Detail page with open invoices, customer credits, advances and cancellation refunds, each linking to its source document.
- Added the **Settlement queue** under **Settlements**:
  - Aggregates open cancellation refunds, unapplied customer credits, customer advances and supplier credits.
  - KPI totals by type, search, type filter, age in days, and a direct action link for each item.
  - Queue totals always equal the sum of visible open items; settling a document removes it automatically.
- Added a shared **void preview** to `voidDialog`:
  - Invoice void, invoice payment void, bill void, bill payment void.
  - Customer credit void and credit-application void; supplier credit void and application void.
  - Refund void and booking/visa advance void.
  - Rows are escaped and show the document, linked items, balance impact and reversal note before remarks are required.
- Added keyboard focus to the scrollable cancellation-detail tables so the new axe route audit stays clean.
- Cancellations, refunds and credit notes remain separate accounting documents with unchanged posting rules. AED-only, no-VAT setup preserved.

Key files: `server/services/customer-balances.js`, `server/services/settlement-queue.js`, `server/routes/customer-balances.js`, `server/routes/settlement-queue.js`, `public/js/views/customer-balances.js`, `public/js/views/customer-balance-detail.js`, `public/js/views/settlement-queue.js`, `public/js/views/cancellation-detail.js`, `public/js/ui.js`, `public/js/app.js`, `public/css/styles.css`, `test/phase2.test.js`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 146 JavaScript files syntax OK.
- `npm test`: 68 tests passed.
- `npm run test:e2e`: 16 tests passed, including the new settlement queue, customer balances, cancellation settlement choice and void preview coverage.
- Browser axe audit passes across light and dark themes for `/settlement-queue`, `/customer-balances`, `/customer-balances/:id`, `/cancellations` and cancellation detail.
- Unit coverage seeds cancellation refunds, customer credits, advances and supplier credits, then verifies derived balances, queue totals, filters and settlement removal.
- Tests used disposable `LEDGERLY_DATA_DIR` databases. Live `data/accounting.db` was not modified (size `802816`, mtime `2026-10-24 20:31`).

### Cash refund of unapplied customer credit, and advance refunds on statements — code commit `1f815dc`

Closes the gap where an unused customer credit note could only be applied to an invoice. A customer who later wants cash instead of credit can now be paid from the credit note.

- New **Refund credit** action on the credit note (header button and **Cash refunds** card):
  - Posting: **Dr 2450 Customer Credits / Cr bank or cash**. Revenue is not reduced a second time.
  - Full or partial refunds; leaving the amount blank refunds the whole remaining credit.
  - Validated against the remaining credit (amount minus applied minus refunded), the credit date, an active cash/bank account, and whole cents.
  - Works for standalone credit notes and for cancellation refunds converted to credit. A cancellation stays fully settled when its converted credit is paid out.
- Each refund is a normal refund document (`REF-YYYY-####`, `refund_type = customer`) linked through the new `refunds.credit_note_id`. It appears in the refund register and voucher as **Customer credit** and links back to the credit note.
- Voiding the refund restores the credit balance and posts the reversing entry. Voiding the credit note now reverses its cash refunds first, then its invoice applications, then the credit itself.
- Remaining customer credit now subtracts cash refunds everywhere:
  - credit notes (detail, list, apply limit);
  - **Customer balances** and the **Settlement queue** (the customer credit action is now **Apply or refund**; a fully refunded credit leaves the queue);
  - customer statement unapplied-credit total, and the 2450 Customer Credits reconciliation.
- The customer statement follows A/R, so a credit refund is not shown as a statement line (it never touches A/R).
- **Bug fix — advance refunds on customer statements:** refunding a customer advance (Dr 2400 Customer Advances / Cr bank) was listed on the customer statement as a debit, so the statement showed money owed that the ledger did not. Example: a 5,000 advance taken and refunded showed 5,000 outstanding while 1100 Accounts Receivable was 0. Advance refunds are now excluded from the A/R statement, like cancellation and credit refunds. Refunds of invoice payments still appear, because they do reopen the receivable.
- Void preview on a credit note lists its active cash refunds.
- Schema and migration: `credit_notes.refunded_cents` (default 0), `refunds.credit_note_id`, index `idx_refunds_credit_note`. Existing data is unchanged.
- README: credit notes feature text and the automatic postings table describe the new refund.
- No change to AED-only or no-VAT behaviour.

Key files: `server/services/credits.js`, `server/services/refunds.js`, `server/routes/credits.js`, `server/services/customer-balances.js`, `server/services/settlement-queue.js`, `server/services/statements.js`, `server/services/reconciliation.js`, `server/schema.js`, `server/migrations.js`, `public/js/views/credit-detail.js`, `public/js/views/refund-detail.js`, `public/js/views/refunds.js`, `test/credit-refunds.test.js`, `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 147 JavaScript files syntax OK.
- `npm test`: 75 tests passed, including 7 new tests in `test/credit-refunds.test.js`: partial and full refunds, validation, refund void and credit void, cancellation-converted credit paid out in cash, balances/queue/statement totals, the refund register, and a statement regression test (an advance refund leaves the statement at 0; a payment refund still shows and the closing balance equals the open receivable).
- `npm run test:e2e`: 17 tests passed, including the new credit-note refund flow and an axe audit of the credit note detail page in light and dark themes.
- Migration dry-run on a copy of live `data/accounting.db`: new columns added, `integrity_check` ok, all control-account reconciliations matched, trial balance unchanged (6,450.00 = 6,450.00). The live file itself was not modified (size `802816`).

### Settlements Phase 3 — ledger checks card, settlement attachments, audit chain — code commit `fad4313`

Approvals and permissions are deliberately left for the login/users phase, because an approval needs to know who is acting.

**1. Ledger checks card (dashboard)**

- New **Ledger checks** card under the KPI tiles. Eight rows, each with the ledger balance, the document total, the difference and a Matched / Difference badge, linking to the screen that explains it:
  - Trial balance: total debits vs total credits.
  - 1100 Accounts Receivable vs open invoices.
  - 2000 Accounts Payable vs open bills (net of supplier credit applications).
  - 2400 Customer Advances vs unapplied, unvoided advances.
  - 2500 Refund Payable vs unpaid cancellation refunds.
  - 2450 Customer Credits vs open customer credit notes (net of applications and cash refunds).
  - 1450 Supplier Credits vs open supplier credits.
  - 1400 Supplier Advances vs portal wallet balances.
- The header reads **All 8 checks match** or **N checks need attention**. The card is hidden on an empty ledger, and the dashboard still loads if the checks request fails.
- `GET /api/reports/reconciliation` now also returns `checks`, `difference_count`, and an `all_matched` that covers all eight checks. The earlier per-account fields are unchanged.
- A difference is informative, not an error. Example: an opening balance posted straight to 1100 shows as an A/R difference, because no invoice explains it.

**2. Attachments on settlement documents**

- Attachments now work on **cancellations** (airline/embassy proof, customer request), **refunds** (bank receipt, cash voucher), **customer credit notes** and **supplier credits**, using the same card as invoices and bills. Each card has a hint for the expected proof.
- `attachments.entity_type` now allows `cancellation`, `refund`, `credit_note` and `supplier_credit`. Existing databases are migrated once by rebuilding the attachments table (SQLite cannot widen a CHECK constraint). Files, ids and the lookup index are preserved.
- Customer advances still have no detail page, so they have no attachment card yet.

**3. Audit chain**

- New read-only **Audit chain** page (`#/audit-chain/:type/:id`), opened from an **Audit chain** button on booking, visa, invoice, bill, cancellation, refund, credit note and supplier credit pages.
- It shows:
  - **Linked documents**: everything connected to the document (job, invoices, payments, advances, credit notes and applications, cancellation, refunds, bills, bill payments, supplier credits, portal wallet credits), with party, amount, status and links.
  - **Timeline**: journal postings in date order with their Dr/Cr lines, reversals marked, and void remarks from the audit log.
  - **Net ledger effect**: what the whole chain leaves in each account after reversals, with debit/credit totals and a Balanced check.
- Reversals are traced through `journal_entries.reversal_of_id`. Postings of reversed (deleted) credit applications are still traced through their invoice or bill reference, and their audit rows through metadata.
- Shared documents (a credit note, supplier credit or advance used on several jobs) only fan out to the other jobs when the chain is opened from that document. A booking's chain stays on that booking.
- `GET /api/audit-chain/:type/:id`; unknown types return 400 and missing documents 404. Chains are capped at 400 documents, with a notice if cut short.

Key files: `server/services/reconciliation.js`, `server/services/audit-chain.js`, `server/routes/audit-chain.js`, `server/routes/attachments.js`, `server/schema.js`, `server/migrations.js`, `public/js/views/dashboard.js`, `public/js/views/audit-chain.js`, `public/js/attachments.js`, the eight detail views listed above, `public/js/app.js`, `public/css/styles.css`, `test/phase3.test.js`, `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 151 JavaScript files syntax OK.
- `npm test`: 82 tests passed, including 7 new tests in `test/phase3.test.js`: all eight checks matching, an opening balance on A/R reported as a difference, the new attachment types allowed and others rejected, the one-time attachments migration preserving a legacy file and index, a full cancelled-booking chain (documents, balanced totals, net account effect, void remarks, date-ordered timeline, reachable from a refund), the shared credit-note rule, and 400/404 errors.
- `npm run test:e2e`: 18 tests passed, including a new test for the dashboard card, a cancellation attachment upload shown on the page, and the audit chain opened from the job page. The axe WCAG 2.1 AA audit now also covers the dashboard card and `/audit-chain/booking/:id` in light and dark themes.
- Migration dry-run on a copy of live `data/accounting.db`: attachments table widened, `integrity_check` ok, no foreign key violations, all eight ledger checks matched on the real data, and the visa audit chain balanced. The live file itself was not modified (size `802816`).

### Next session

1. Start from the latest `main`; the latest code commit is `fad4313` (Settlements Phase 3: ledger checks, settlement attachments, audit chain).
2. Read this entry and run the full check suite.
3. Use a disposable database for review; never modify live `data/accounting.db`.
4. Append the next change under a new date heading before committing.
