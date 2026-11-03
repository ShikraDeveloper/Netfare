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

### Booking and visa documents can no longer be voided directly (audit H1–H3) — code commit `ed88c81`

From the bookings, visas and invoices audit. Voiding these documents on their own bypassed the cancellation workflow: for example, voiding a paid booking invoice reversed the receipt (bank −1,000 with no money returned), left the booking `confirmed` and its supplier bill payable, and kept the margin in reports.

- **H1 — booking/visa invoices:** `voidInvoice` now refuses an invoice with a `booking_id` or `visa_id`: "Cancel the booking/visa application instead so charges, refunds and supplier credits are handled." Nothing is reversed.
- **H2 — booking/visa supplier bills:** `voidBill` now refuses a bill with a `booking_id` or `visa_id`: "Record a supplier credit for the amount the supplier returns, or cancel the booking/visa application."
- **H3 — cancellation-charges invoices:** `voidInvoice` refuses an invoice with a `cancellation_id` and points to a customer credit note. This is checked first, because these invoices also carry the job id.
- Standalone invoices and bills void exactly as before. A mistaken receipt or bill payment on a job document can still be voided individually.
- **UI:**
  - Invoice screen: for a booking/visa invoice, **Void** is replaced by **Cancel booking / Cancel visa**, linking to the job. A cancellation-charges invoice shows a **Cancellation note** link and the existing **Credit note** action, with no Void.
  - Bill screen: for a booking/visa bill, **Void** is replaced by **Supplier credit**. This opens the new supplier credit form with the supplier, the bill and its booking or visa already selected (`#/supplier-credits?new=1&bill=:id`).
- README: the automatic postings table and a note under it describe the rule.

Key files: `server/services/invoices.js`, `server/services/bills.js`, `public/js/views/invoice-detail.js`, `public/js/views/bill-detail.js`, `public/js/views/supplier-credits.js`, `test/job-void-guards.test.js`, `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 152 JavaScript files syntax OK.
- `npm test`: 88 tests passed, including 6 new tests in `test/job-void-guards.test.js`: a paid booking invoice is refused with no reversing entry, bank unchanged and the booking still confirmed; a visa invoice is refused; a cancellation-charges invoice is refused with cancellation income kept; booking and visa bills are refused; standalone invoices and bills still void; a receipt on a booking invoice can still be corrected.
- `npm run test:e2e`: 19 tests passed, including a new browser test: the API returns 400 for a direct void, the booking invoice shows **Cancel booking** instead of Void, and the booking bill's **Supplier credit** button opens the form with the supplier, bill and booking preselected.
- Live `data/accounting.db` was not modified by the tests. The running app needs a restart to pick up this change.

### Reports use posted documents; internal notes and passport data kept off customer documents (audit M1–M5) — code commit `3fd2de5`

From the bookings, visas and invoices audit.

**Reports (M1–M3)**

- New `server/services/job-costs.js` values every booking and visa the same way for the margin reports, the dashboard margin tiles and the DSR:
  - **M1:** drafts are left out, because they post nothing. `bookingStats` and `visaStats` now return a separate `draft_count`.
  - **M2:** bookings cancelled before cancellation notes existed are left out, as visas already were. Before this, such a booking still counted its full sale and cost.
  - **M3:** cost is the **received supplier bills less issued supplier credits** for the job, not the cost lines typed on the draft. A credit counts when it names the job, or when it is raised against one of the job's bills. Report rows keep `planned_cost_total_cents` for reference.
  - Cancelled jobs with a cancellation note still show their charges and retained cost. `retainedCostCents` now uses the same helper, so it also counts credits raised only against a bill.
- Costs are worked out with two grouped queries per report instead of a query per job.

**Internal notes (M4)**

- Booking and visa **Notes** are now **Internal notes**: shown on screen in a box above the document that never prints, and no longer copied to the customer invoice or printed on the booking confirmation / application summary.
- New optional **Note on invoice** field (`invoice_notes` on bookings and visa applications). It is printed on the booking or visa document and copied to the invoice at confirm/submit. A draft edit that leaves it out keeps the existing value.
- Invoices created before this change keep the notes they were issued with.

**Passport data on customer documents (M5)**

- Invoices and customer statements show a **masked passport number** (`•••• 4567`) and no **date of birth**. The invoice and statement API responses no longer contain the full number or the date of birth; the visa application keeps both for staff. Passport expiry is still shown.
- Supplier portal statements are internal and unchanged; they still show the passport number for matching with the visa agent.
- New `maskPassport` helper in `server/util.js`.

**Schema:** `bookings.invoice_notes` and `visa_applications.invoice_notes` (default `''`), added by migration.

Key files: `server/services/job-costs.js`, `server/services/bookings.js`, `server/services/visas.js`, `server/services/cancellations.js`, `server/services/reports/daily-sales.js`, `server/services/invoices.js`, `server/services/statements.js`, `server/util.js`, `server/schema.js`, `server/migrations.js`, `public/js/views/bookings.js`, `public/js/views/visas.js`, `public/js/views/booking-detail.js`, `public/js/views/visa-detail.js`, `public/js/views/invoice-detail.js`, `public/js/views/statement.js`, `public/css/styles.css`, `test/reports-privacy.test.js`, `test/visas.test.js`, `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 154 JavaScript files syntax OK.
- `npm test`: 93 tests passed, including 5 new tests in `test/reports-privacy.test.js`:
  - drafts out of margin and dashboard;
  - legacy cancelled bookings excluded;
  - cost from bills less a bill-only and a booking-only supplier credit, in both the margin report and the DSR, and restored when a credit is voided;
  - internal notes never reach the invoice, while the invoice note does and survives an edit;
  - masked passport and no date of birth in invoice and statement responses, with full details kept on the visa.
- Two existing assertions in `test/visas.test.js` were updated to expect the masked passport.
- `npm run test:e2e`: 20 tests passed:
  - a new test checks that the internal note is in the screen-only box, absent from the printed booking and the invoice, and that the invoice note appears on both;
  - the invoice and statement tests now check that only the last four passport characters show and no date of birth;
  - the stored-XSS test now looks for the escaped payload in the internal-notes box.
- Migration dry-run on a copy of live `data/accounting.db`: `invoice_notes` columns added, `integrity_check` ok, 8/8 ledger checks matched, visa invoice shows `•••• 2444` with no full passport or date of birth. The live file was not modified. The running app needs a restart to pick up this change.

### Job rules, status history and shared job code (audit Low items) — code commit `e1400ed`

- **Shared code:** new `server/services/jobs.js` holds booking/visa line validation, posting of the invoice and supplier bills with portal settlement, default due dates and status history. `bookings.js` and `visas.js` use it; about 150 duplicated lines removed.
- **Dates:**
  - Booking and visa due dates default to Settings → payment terms (server and forms). A draft edit without a due date keeps the existing one.
  - Return date cannot be before travel date.
  - **Mark travelled** is refused before the travel date; the button is disabled with a tooltip.
  - Invoice payments cannot be dated before the invoice (use an advance); bill payments not before the bill date.
- **Visa passport warning:** expired, or under 6 months after travel/application, shows a warning on save and submit and a callout on the visa page. It never blocks.
- **Zero-cost lines:** refused on save with the line number. Older drafts with a zero line get a clear message at confirm, and nothing is posted.
- **Status history:** new `job_status_history` table records create, confirm/submit, travelled, approve, issue, cancel and reject (with cancellation number and reason). Shown on booking and visa pages (screen only) and in the Audit chain timeline. Deleting a draft removes its history. Jobs created before this change start with an empty history.
- **Demo data:** fixed trips whose return was before travel, and "travelled" bookings dated in the future.

Verification: `npm run check` 156 files OK; `npm test` 100 passed (7 new in `test/job-rules.test.js`); `npm run test:e2e` 21 passed (new job page test). Dry-run on a copy of live `data/accounting.db`: new table created, integrity ok, 8/8 checks. Live file not modified; restart needed.

## 2026-10-27

### "This invoice is for someone else" toggle — code commit `205b818`

Brings the visa applicant toggle to direct invoices, for a customer who pays for another person (traveller, guest or family member).

- **Invoice form:** new checkbox **This invoice is for someone else**. When on, it shows **Name of the person** (required), **Nationality** and **Passport number** (both optional). When off, the fields are hidden and cleared.
- **Ledger:** unchanged. The invoice is billed to, and posts its receivable against, the paying customer.
- **Documents:**
  - The printed invoice shows a **Service for** section (name, nationality, passport masked as `•••• 4567`) beside **Paid by**.
  - The customer statement names the person under the invoice line.
  - The invoice list shows "For <name>" under the customer, and search finds invoices by the person's name.
  - Visa invoices keep their own visa applicant section.
- **Privacy:** sent and void invoices return only the masked passport (`beneficiary_passport_masked`). The full number comes back only for drafts, so it can still be edited.
- **API:**
  - `beneficiary_is_customer` (default true), `beneficiary_name`, `beneficiary_nationality`, `beneficiary_passport` on create and update.
  - A draft edit that leaves them out keeps the saved values; turning the toggle off clears them.
- **Schema:** four new `invoices` columns, added by migration. Existing invoices default to "for the customer".

Key files: `server/services/invoices.js`, `server/services/statements.js`, `server/schema.js`, `server/migrations.js`, `public/js/views/invoices.js`, `public/js/views/invoice-detail.js`, `public/js/views/statement.js`, `test/invoice-beneficiary.test.js`, `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 157 JavaScript files syntax OK.
- `npm test`: 104 passed, including 4 new tests in `test/invoice-beneficiary.test.js`:
  - default is the customer;
  - the person's name is required, the receivable is posted to the customer, the passport is masked on a sent invoice, and search works;
  - draft edits keep, rename and clear the person, and posting keeps it;
  - the statement shows the person with a masked passport.
- `npm run test:e2e`: 22 passed, including a new test: fields hidden by default and shown with a required name when toggled; the printed invoice shows **Service for** with a masked passport and is still billed to the customer; the list shows "For …".
- Migration dry-run on a copy of live `data/accounting.db`: columns added, integrity ok, 8/8 checks, both existing invoices default to the customer. The live file was not modified; restart needed.

### Service invoices: direct invoices are for income with no supplier cost — code commit `1f5a180`

A direct invoice records only revenue. When it was used for a ticket or visa, the supplier cost never met the sale: the DSR showed 100% margin and booking/visa margin reports missed the sale.

- **Rule:** a direct invoice cannot use **4000 Ticket Sales, 4100 Tour & Package Sales or 4320 Visa & Documentation Revenue**. The error names the line and points to a booking or visa.
  - Applies to create, draft edits, and posting older drafts.
  - Booking, visa and cancellation-charges invoices pass an internal `jobInvoice` flag and still post ticket and visa revenue.
  - Sent invoices made before the rule are unchanged and can still be paid. Live data has one: INV-2026-0002 on 4000, already paid.
- **Form:**
  - Renamed **New service invoice**.
  - The account list leaves out the three job accounts and puts 4300 Service Charges first. Service, commission, other income and custom revenue accounts are offered.
  - A note at the top explains the form is for income with no supplier cost. Its booking/visa links close the form and open the right one.
  - The empty state also explains this.
- **DSR:** service invoice rows read **Service income · no supplier cost**, and the footer explains cost.
- **Tests:** existing tests that created direct invoices on 4000/4320 now use 4300; they test payments, refunds and credits, not ticket sales.

Key files: `server/services/invoices.js`, `server/services/jobs.js`, `server/services/cancellations.js`, `public/js/views/invoices.js`, `public/js/views/reports/daily-sales.js`, `test/service-invoice.test.js`, `test/e2e/browser.test.js`, and the test files switched to 4300, plus `README.md`.

Verification:

- `npm run check`: 158 JavaScript files syntax OK.
- `npm test`: 109 passed, including 5 new tests in `test/service-invoice.test.js`:
  - the three accounts are refused, including mixed lines;
  - service, commission, other income and custom accounts are allowed;
  - draft edits and posting an older draft are refused;
  - booking, visa and cancellation invoices still post, and a legacy sent invoice can still be paid;
  - the DSR shows service rows with zero cost.
- `npm run test:e2e`: 23 passed, including a new test: the API refuses a ticket line; the button and form read "New service invoice"; the hint shows; 4000/4100/4320 are not offered and 4300 is first; the booking link opens the booking form.
- No schema change. The live file was not modified; restart needed.

### Basic forms: one row per passenger, visa applicants list, simple service invoice — code commit `1f5a180`

The booking, visa and invoice forms asked for every field up front. The new forms keep only what is needed on every job in view and move the rest under **More details** or a row's **⋯**.

- **Booking — one row per passenger:**
  - Top: Customer, **Destination / description** (one free-text field, e.g. "Dubai–London return · Emirates"), PNR, booking, travel and return dates.
  - Each row: passenger name, sale price, cost, supplier. **⋯** holds ticket no., quantity and accounts. **Add other item** is for a hotel, service fee or insurance.
  - The supplier carries over to the next passenger.
  - Payment due, internal notes and note on invoice are under **More details**.
  - Stored as `booking_items.passenger_name` and `line_group`. The sale and cost lines of a row share a `line_group`.
  - The invoice and bill line reads `<destination> – <passenger>`.
  - The list shows passenger names, and search finds them.
  - Older bookings open with each line as its own row; cost lines pair with the sale line of the same description.
- **Visa — applicants list (option B):**
  - **New visa** takes the shared details once: customer, visa type, country, application and travel dates.
  - Then one row per applicant: name, passport no., expiry, sale, cost, supplier. **⋯** holds nationality, DOB and accounts.
  - The first name defaults to the customer. Price, supplier and accounts carry over to the next row.
  - `POST /api/visas/groups` creates one application per applicant in one transaction, linked by a new `visa_groups` row (`VG-YYYY-####`, new settings counter `next_visa_group_number`, new column `visa_applications.group_id`).
  - One applicant creates a plain application with no group.
  - Any error saves nothing and names the applicant ("Applicant 2: …").
  - Each application keeps its own invoice, status, rejection and cancellation.
  - The detail page shows a **Group VG-…** card with the other applications and **Submit all N drafts** (`POST /api/visas/groups/:groupId/submit`, all or none).
  - The list shows a `VG-… · N` badge and searches by group number.
  - The edit form stays one application, with passport details up front and payment due, duration, embassy ref, nationality, DOB and notes under **More details**.
  - Demo reset and JSON export include `visa_groups`.
- **Service invoice — basic form:**
  - Each line asks for a description and amount. Quantity, account and line total are behind **⋯**, and a new line keeps the account of the line above.
  - A single **Total** replaces Subtotal + Total.
  - Due date, the person's nationality/passport, notes, terms and **Save as draft** are under **More details**.
  - The compact editor is an option of the shared line-items editor; bills keep the full editor.
- **Fix found while testing:** applications returned by the group create are read back after the group is complete, so each shows the full group size.

Key files:
- Server: `server/schema.js`, `server/migrations.js`, `server/services/jobs.js`, `server/services/bookings.js`, `server/services/visas.js`, `server/routes/visas.js`, `server/services/numbering.js`, `server/services/demo.js`, `server/routes/admin.js`.
- Frontend: `public/js/views/booking-passengers.js` (new), `public/js/views/visa-group-form.js` (new), `public/js/views/bookings.js`, `public/js/views/visas.js`, `public/js/views/visa-detail.js`, `public/js/views/invoices.js`, `public/js/line-items.js`, `public/css/styles.css`.
- Tests: `test/booking-passengers.test.js` (new), `test/visa-groups.test.js` (new), `test/e2e/browser.test.js`.
- Docs: `README.md`.

Verification:

- `npm run check`: 162 JavaScript files syntax OK.
- `npm test`: 118 passed.
  - 4 new tests in `test/booking-passengers.test.js`: passenger rows stored with pairing; invoice/bill lines name each passenger; search by passenger; lines without a passenger keep their description.
  - 5 new tests in `test/visa-groups.test.js`: linked applications share the trip details; one applicant creates no group; a bad applicant saves nothing and is named; Submit all posts one invoice per applicant and skips already-submitted ones; rejecting one leaves the others.
- `npm run test:e2e`: 26 passed, with these changes:
  - New: the booking passenger form, the visa applicants form with Submit all and the list badge, and the compact service invoice (two lines, qty 2 behind ⋯, total AED 205.00).
  - The visa toggle test now runs on the edit form.
  - Axe light and dark is clean.
- Visual check on a throwaway server (temp data dir, port 4391, demo data): new visa with two applicants → group card → Submit all → badges in the list; visa edit form; service invoice created on 4300.
- Migration dry-run on a copy of live `data/accounting.db`: all new columns, `visa_groups` and the counter added, integrity ok, existing bookings and visas list normally.
- Schema change is additive (two columns on each item table, `visa_groups`, `group_id`, one settings counter). The live file was not modified; restart needed.

### Ticket, visa and service invoices print differently — code commit `c276b7d`

Ticket and visa sales already made separate invoices, but every invoice printed the same way: the heading said "Invoice", and a ticket invoice showed no PNR, travel dates or ticket numbers.

- **Heading by source** (`document_kind` on `GET /api/invoices/:id`):
  - **Ticket invoice:** a booking with passenger rows.
  - **Booking invoice:** a booking with no passenger rows, e.g. hotel only.
  - **Visa invoice:** made from a visa.
  - **Cancellation invoice:** carries cancellation charges.
  - **Invoice:** a service invoice.
- **Ticket invoice:**
  - The booking number is in the header.
  - A **Trip details** box shows the route/description, passenger count, PNR and travel → return dates.
  - Each passenger line shows `Ticket <no.>` underneath, taken from that passenger's cost line.
- **Visa invoice:**
  - The visa number and group number (if any) are in the header.
  - The **Visa details** box always shows, also when the applicant is the customer: name, nationality, masked passport and expiry, country, visa type, duration and reference.
  - "Paid by <customer>" appears only when the applicant is someone else.
- **Terms column:** booking and visa invoices used to repeat the destination or visa details there. They now show "Payment due by …", because the new boxes carry those details.
- **What is not printed:** supplier cost and margin, the full passport number and the date of birth.
- **What does not change:** accounting, numbering (`INV-YYYY-####`), payments and statements.
- **Page header fix:** the invoice title no longer squeezes into a narrow column when there are many action buttons; the buttons wrap instead.

Key files: `server/services/invoices.js` (`attachBookingDetails`, `documentKind`, visa group number), `public/js/views/invoice-detail.js`, `public/css/styles.css`, `test/invoice-layout.test.js` (new), `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 163 JavaScript files syntax OK.
- `npm test`: 122 passed. 4 new tests in `test/invoice-layout.test.js`:
  - ticket kind with trip fields and per-passenger ticket numbers, and no cost in the response;
  - booking kind for a hotel-only booking;
  - visa kind with the application and group number and a masked passport;
  - cancellation and service kinds.
- `npm run test:e2e`: 27 passed, including a new test of the ticket, visa (customer as applicant) and service invoice pages. Axe light and dark is clean.
- Visual check on a throwaway server (temp data dir, port 4391, demo data):
  - a two-passenger ticket invoice at desktop and 375px phone width, with no horizontal scroll;
  - a visa invoice for the customer and one for a visitor;
  - the header with seven actions.
- No schema change. The live file was not modified; restart needed.

### Payment column, confirm preview, amount in words, receipt voucher, share by email/WhatsApp — code commit `f8200a4`

- **Payment column** on the booking and visa lists:
  - Shows **Paid / Partial / Unpaid / Overdue** from the job's invoice, with "AED … due" under partial, unpaid and overdue.
  - Drafts show *Not invoiced*; cancelled and rejected jobs show "—".
  - Server: shared `jobs.JOB_INVOICE_COLUMNS` and `jobs.jobPaymentStatus()`. The booking and visa queries join the invoice and return `payment_status` and `payment_balance_cents` in the list and detail payloads.
- **Preview before posting.** **Confirm & post** (booking) and **Submit & post** (visa) now show a "This will post" panel:
  - the customer invoice with its amount;
  - one supplier bill per supplier;
  - for a prepaid portal supplier, whether the wallet pays it (balance before → after) or how much stays payable;
  - the margin.
  - Wallet balances are fetched fresh when the dialog opens.
  - `confirmDialog` gained a `preview` option, reusing the void-preview panel.
- **Amount in words** on every invoice, e.g. "UAE Dirhams Seven Hundred Thirty Only", with fils. The helper is `public/js/amount-words.js`.
- **Receipt voucher:**
  - Each payment on an invoice has a print button that opens `#/receipts/<payment id>`, using the existing payment number (PMT-…).
  - It shows: received from, amount in figures and words, against invoice, booking/visa, method, reference, cheque details, account received into, any refund, invoice total, invoice balance now, and signature lines.
  - A voided payment shows a Void badge.
  - New endpoint `GET /api/invoices/payments/:paymentId/receipt`.
- **Share** (sent and paid invoices):
  - Opens an editable message: greeting, invoice title and number, booking/visa, date, total, and either amount due or "fully paid".
  - Buttons: **Email** (`mailto:` to the customer's email), **WhatsApp** (`wa.me`; local UAE numbers `05…` become `9715…`, and `00…` is stripped) and **Copy text**.
  - Ledgerly sends nothing itself; the window says to attach the PDF with Print → Save as PDF.
  - Helpers are in `public/js/share-links.js`. New `send` and `mail` icons.

Key files:
- Server: `server/services/jobs.js`, `server/services/bookings.js`, `server/services/visas.js`, `server/services/invoices.js`, `server/routes/invoices.js`.
- Frontend: `public/js/ui.js`, `public/js/amount-words.js` (new), `public/js/share-links.js` (new), `public/js/views/receipt.js` (new), `public/js/app.js`, `public/js/views/invoice-detail.js`, `public/js/views/job-modals.js`, `public/js/views/booking-detail.js`, `public/js/views/visa-detail.js`, `public/js/views/bookings.js`, `public/js/views/visas.js`, `public/css/styles.css`.
- Tests: `test/collections.test.js` (new), `test/e2e/browser.test.js`.
- Docs: `README.md`.

Verification:

- `npm run check`: 167 JavaScript files syntax OK.
- `npm test`: 128 passed. 6 new tests in `test/collections.test.js`:
  - booking payment status through not invoiced → unpaid → partial → paid;
  - overdue, and cancelled shows none;
  - visa partial, and rejected shows none;
  - receipt voucher data and the 404 case;
  - amount in words;
  - WhatsApp number forms, mailto and the message text.
- `npm run test:e2e`: 28 passed.
  - New test: Not invoiced → confirm preview names the supplier bill and AED 130.00 margin → Unpaid → payment → amount in words → Share links (`mailto:`, `wa.me`) → receipt voucher (AED 300.00, words, balance AED 430.00) → list shows "Partial AED 430.00 due".
  - The receipt page is added to the axe audit, which is clean in light and dark.
- Visual check on a throwaway server (temp data dir, port 4391, demo data): booking list payment column, confirm preview on a draft booking, invoice amount in words, Share window and receipt voucher.
- No schema change. The live file was not modified; restart needed.

### Cancelled sales stay on their day in the DSR and statement — code commit `06db786`

Before this change, cancelling a booking or visa voided its invoice. The DSR and the customer statement then dropped the original sale: a DSR printed for the sale day changed later, and the customer's history vanished. The ledger was already right: the sale was on its day and the reversal on the cancellation date.

- **DSR:**
  - The original sale stays on its own day with its original sale, cost and paid amounts. It is marked **Cancelled** with the date and a link to the cancellation note.
  - A red **cancellation line** on the cancellation date has:
    - sale = charges − original sale;
    - cost = − supplier credits raised by the cancellation;
    - paid = amount kept as charges − amount originally received;
    - balance = any open charges invoice.
  - The two lines net to the old result: charges less retained cost.
  - The line names the cancellation (CNC-…), shows "Reverses AED … sale · charges AED … · supplier credit …", and links to the cancellation note. It used to link to `#/invoices/<cancellation id>`, which was wrong.
- **Customer statement:**
  - A cancelled invoice and its payments stay on their own dates; the invoice shows "Cancelled · CNC-…".
  - On the cancellation date: **Booking or visa cancelled** (credit, the invoice total reversed) and **Cancellation charges** (debit, the part taken from money received).
  - Any charges invoice follows the cancellation line.
  - Then **Refund issued** for a cancellation refund, or **Refund kept as credit** (debit) when the money becomes a credit note. Applying that credit later shows as **Credit applied**, as before.
  - The running balance shows what the customer owes or is owed.
- **Mistake voids** (e.g. a duplicate service invoice) stay out of both.
- **Tests:** three DSR assertions in `test/cancellations.test.js` pinned the old cancel-day figures. They now check the sale-day line, the cancellation line and their net, which equals the old figures.

Key files: `server/services/reports/daily-sales.js`, `server/services/statements.js`, `public/js/views/reports/daily-sales.js`, `public/js/views/statement.js`, `public/css/styles.css`, `test/cancellation-history.test.js` (new), `test/cancellations.test.js`, `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 168 JavaScript files syntax OK.
- `npm test`: 134 passed. 6 new tests in `test/cancellation-history.test.js`:
  - full statement sequence with refund;
  - a statement for the sale period is unchanged after a later cancellation;
  - credit-note route;
  - charges invoice after the cancellation;
  - DSR sale-day line plus cancellation line and net totals;
  - a mistake void stays out.
- `npm run test:e2e`: 29 passed. New test: DSR shows the sale as Cancelled and the red cancellation line; statement titles read Invoice raised → Payment received → Booking or visa cancelled → Cancellation charges. Axe light and dark is clean.
- Visual check on a throwaway server (temp data dir, port 4391, demo data): DSR (12 Oct sale marked Cancelled, 27 Oct cancellation lines) and the Aisha Khan statement (balance 3,080 → 2,590 after the unpaid invoice was reversed).
- No schema change. The live file was not modified; restart needed.

### New DSR layout: counter-style sections A–H — code commit `d7fd636`

Built from the sample DSR the user shared (Cozmo, 9 Jan): sales lists by type with Cash / Card / Credit columns, a refund list, money paid out, and a cash summary. The staff column and visa security deposit are left out for now; staff needs login (Phase 2).

- **A. Header:** company, period, "Amounts in AED · printed <date time>". Prints on A4 landscape (`@page dsr`).
- **B. Ticket & booking sales**, one row per booking invoice:
  - invoice no. with date and time;
  - booking no.;
  - customer, passengers with ticket nos. and remarks (invoice note);
  - PNR / route;
  - Fare, Fee, Total;
  - Cash / Card / Bank / Other / Credit.
  - Cancelled sales show the Cancelled badge and the CNC link.
- **C. Visa sales:** applicant ("Paid by …" when different), country / type, visa fee, fee, total and the same settlement columns.
- **D. Service income:** description, total and settlement.
- **E. Cancellations & refunds:**
  - cancellations on their date: sale reversed, charges kept, supplier credit, net sale;
  - every customer refund paid in the period, with what it was against and the method.
- **F. Money collected for older invoices & advances:** payments in the period against invoices from earlier days (linking to the receipt voucher), and customer advances.
- **G. Money paid out:** ledger outflows from 1000 / 1010 by source type.
- **H. Summary:**
  - Sales by type and total;
  - Collected by mode (cash, card, bank, total received, advance/credit used, on credit, refunds paid);
  - Cash and Bank as opening + in − out = closing.
- **Settlement columns** show how each sale stood at the end of the period. Payment method maps to the column: Cash; Credit card → Card; Bank transfer or Cheque → Bank. Advances and credit notes go to Other; whatever is still unpaid is Credit (zero for a cancelled sale).
- **Show profit** switch adds cost and margin columns and the summary margin. It is off by default, so printed copies for staff carry no profit, and is remembered per computer.
- Server: new `server/services/reports/dsr-sections.js` adds `sections` to `GET /api/reports/daily-sales`. The existing `days` and `totals` are unchanged.

Key files: `server/services/reports/dsr-sections.js` (new), `server/services/reports/daily-sales.js`, `public/js/views/reports/daily-sales.js`, `public/js/views/reports.js`, `public/css/styles.css`, `test/dsr-sections.test.js` (new), `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 170 JavaScript files syntax OK.
- `npm test`: 140 passed. 6 new tests in `test/dsr-sections.test.js`:
  - method mapping;
  - a ticket row with passengers, ticket nos., fare/fee/total, cash + card + credit split and cost/margin;
  - visa and service sections;
  - collections for an older invoice and an advance;
  - cash and bank reconcile: cash in = cash settled + cash collected, bank in = bank + card + bank collected, closing = opening + in − out; supplier payment in money out; sales totals;
  - a cancellation and its cash refund in section E, with the visa still on its sale day marked cancelled.
- `npm run test:e2e`: 30 passed.
  - New test: all sections render; a service sale shows 300.00 total, 100.00 cash, 200.00 credit; profit is hidden by default and appears with the switch; the summary shows the cash position.
  - The cancellation E2E test is updated for section E.
  - Axe light and dark is clean.
- Visual check on a throwaway server (temp data dir, port 4391, demo data):
  - at 1500px, every table fits with profit off; with profit on, the ticket table scrolls inside its box;
  - summary boxes checked;
  - at 375px phone width there is no page-level horizontal scroll.
  - Print preview was not checked in a browser.
- No schema change. The live file was not modified; restart needed.

### Visa security deposit engine — code commit `5374819`

A refundable visa security deposit is the customer's money, not a sale. This adds a full engine for it.

- **Accounts:** **1460 Deposits with Suppliers**, **2600 Visa Security Deposits Held** and **4340 Forfeited Deposit Income**.
  - Added to the default chart and adopted as system accounts by migration.
  - 1460 and 2600 are control accounts, so manual journals cannot post to them.
  - The codes were checked free on a copy of the live database.
- **Data:**
  - `visa_deposits` (`DEP-YYYY-####`, new settings counter `next_deposit_number`) and `visa_deposit_events`.
  - New columns `refunds.deposit_id` and `payments.deposit_id`.
  - Balances are always worked out from the active events.
- **Steps** (`server/services/visa-deposits.js`, routes under `/api/visa-deposits`):
  - Take deposit: Dr cash/bank, Cr 2600.
  - Pay to supplier: Dr 1460, Cr cash/bank.
  - Supplier returned, with an optional deduction the customer bears: Dr cash/bank net, Dr 2600 deduction, Cr 1460 gross.
  - Refund: Dr 2600, Cr cash/bank, plus a customer refund row.
  - Use for invoice: Dr 2600, Cr 1100, as a "Deposit applied" payment.
  - Forfeit, with a reason: Dr 2600, Cr 4340 when we keep it, or Cr 1460 when the supplier kept it.
  - Void latest step (remarks): reverses its entry, voids the refund or payment, and voids the deposit when it is the first step.
- **Guards:**
  - Money still with the supplier cannot be refunded, used or forfeited by us until the supplier return is recorded.
  - Amounts are capped at what is in hand or held.
  - No new deposit on a cancelled or rejected visa.
  - A step cannot be dated before the deposit.
- **Visa form:** a **Sec. deposit** column per applicant. When a deposit is entered, "Deposit received by / into" appears; the deposit is shown under the totals as "not a sale". `POST /api/visas/groups` records each applicant's deposit in the same transaction.
- **Visa page:** a **Security deposit** card with received / with supplier / refunded / used / forfeited, the amount still held, the history, and buttons for each step.
- **DSR:**
  - The visa row has a **Sec. deposit** column, and the money received for it counts in cash / card / bank.
  - Deposits for visas not sold in the period go under *Money collected*.
  - Deposit refunds appear in section E ("Visa deposit DEP-…"), with a new "Visa deposits forfeited or deducted" table.
  - A summary box shows received, refunded, forfeited/deducted and still held.
  - Ledger flow labels are added for the deposit source types.
- **Customer statement:** a separate **Security deposits held for you** section with its own running balance, never part of the amount due.
- **Reports → Visa deposits:** a register showing still held or all deposits, with 2600 / 1460 / in-hand totals, *refund due* (cancelled or rejected visa) and *held over 90 days* flags.
- **Ledger checks:** two new checks, 2600 against deposits still held and 1460 against deposits with suppliers. The dashboard now has 10 checks.
- **Demo reset and JSON export** include the new tables.

Key files:
- Server: `server/services/visa-deposits.js` (new), `server/routes/visa-deposits.js` (new), `server/schema.js`, `server/migrations.js`, `server/default-accounts.js`, `server/accounting.js`, `server/services/numbering.js`, `server/services/visas.js`, `server/services/reconciliation.js`, `server/services/statements.js`, `server/services/reports/dsr-sections.js`, `server/routes/reports.js`, `server/routes/index.js`, `server/services/demo.js`, `server/routes/admin.js`.
- Frontend: `public/js/views/visa-deposit-card.js` (new), `public/js/views/reports/visa-deposits.js` (new), `public/js/views/visa-group-form.js`, `public/js/views/visa-detail.js`, `public/js/views/reports/daily-sales.js`, `public/js/views/reports.js`, `public/js/views/statement.js`, `public/css/styles.css`.
- Tests: `test/visa-deposits.test.js` (new), `test/phase3.test.js`, `test/e2e/browser.test.js`.
- Docs: `README.md`.

Verification:

- `npm run check`: 175 JavaScript files syntax OK.
- `npm test`: 149 passed. 9 new tests in `test/visa-deposits.test.js`:
  - system accounts;
  - held, not revenue, full refund;
  - supplier route with a deduction, then refund, with the refund blocked while the supplier holds the money;
  - use for invoice;
  - forfeit to us (4340) and to the supplier (1460);
  - voiding steps one at a time;
  - limits and cancelled-visa guard;
  - deposits entered with a visa group;
  - DSR deposit column, cash and summary, refund in section E, and the statement deposit section kept apart from the invoice balance.
  - The 2600 and 1460 ledger checks match after every step.
  - `test/phase3.test.js` now lists the two new checks.
- `npm run test:e2e`: 31 passed.
  - New test: deposit column in the new-visa form (not in the margin) → card shows 4,000 held → refund 1,500 → 2,500 held → register row → ledger checks match.
  - The dashboard check count is updated to 10.
  - The register page is added to the axe audit, which is clean in light and dark.
- Visual check on a throwaway server (temp data dir, port 4391, demo data with two deposits):
  - deposit card (to supplier, returned less 500, 3,500 held);
  - today's DSR (deposits in *Money collected*, paid to supplier in *Money paid out*, summary box 6,000 received / 1,000 forfeited or deducted / 5,000 held; cash and bank add up; every table fits);
  - deposit register.
- Migration dry-run on a copy of live `data/accounting.db`: the three accounts were added as system accounts, both tables created, integrity ok, all 10 ledger checks match. The live file was not modified; restart needed.
- Not done yet: paying a deposit to the supplier from a prepaid portal wallet (cash or bank only for now).

### Audit fixes F1–F12 (OpenCode audit of 2026-10-28) — code commit `ff6dba3`

OpenCode ran a full read-only audit at `9a986cd`. All 12 findings were confirmed before fixing: 8 reproduced on a temp database, 4 confirmed in the code.

- **F1 (High) — DSR section F was empty on days with no sales.** With no sale invoices, the "exclude this period's sales" filter became `NOT IN (NULL)`, which hides every row. The filter is now added only when there are sales.
- **F2 (High) — voiding a deposit-funded payment desynced 2600.** `deleteInvoicePayment` now refuses a payment made from a visa deposit, with a message pointing to the deposit card. This also covers voiding the invoice, which voids its payments. The deposit card's "Void latest step" passes `fromDeposit` and still works.
  - On the invoice page, such payments show "Paid from visa deposit SD-… · undo it on the visa's deposit card" and have no Void button.
  - They are not cash-refundable from the invoice (`refundable_cents` is 0).
- **F3 (High) — deposit refunds were counted twice on the customer statement.** The general refund branch now excludes `deposit_id`. Deposit refunds only appear in the deposit section.
- **F4 (Medium) — deposit refund page.** It showed "Invoice —" with `#/invoices/null`, and its Void always failed.
  - It now shows source "Visa security deposit SD-…", linking to the visa.
  - "Remaining refundable" excludes money used for invoices, forfeited or deducted.
  - The Void button is replaced by a note to use the deposit card.
  - `voidRefund` refuses deposit refunds with the same guidance.
- **F5 (Medium) — an earlier period's DSR changed after a later cancellation.** A sale now counts as cancelled in a DSR only when the cancellation date is on or before the period end. Credit, balance, status and the Cancelled badge for an earlier period stay as they were. The sale-day cost still includes cost later credited by the cancellation, since that credit belongs to the cancellation line.
- **F6 (Low)** — the statement deposit table is wrapped in `.table-wrap`, so there is no page-level horizontal scroll at 375px.
- **F7 (Low)** — `numbering.js` declared `deposit` twice, once for visa deposits and once for cash deposits. Visa security deposits now use their own series, `visa_deposit` / `SD-YYYY-####`, with counter `next_visa_deposit_number`; `DEP-` stays the cash deposit series. Live data has no visa deposits yet.
- **F8 (Low)** — `reverseEntry` never dates a reversal before the entry it reverses. Voiding a future-dated document today no longer makes earlier as-of balances negative. This one central change covers every void.
- **F9 (Low)** — audit log labels added: "Visa security deposit", "Created", "Forfeit".
- **F10 (Low)** — a group applicant error is prefixed once: "Applicant 2: Enter the applicant name".
- **F11 (Low)** — indexes added on `invoice_items.invoice_id`, `bill_items.bill_id`, `invoices.booking_id`, `invoices.visa_id`, `bills.booking_id` and `bills.visa_id`.
- **F12 (Low)** — README lists of control accounts and ledger checks now include 2600 and 1460.
- **Not changed (product decision):** a partly paid invoice past its due date shows **Overdue**, not Partial; the amount due is still shown.

Key files:
- Server: `server/services/reports/dsr-sections.js`, `server/services/reports/daily-sales.js`, `server/services/statements.js`, `server/services/invoices.js`, `server/services/refunds.js`, `server/services/visa-deposits.js`, `server/services/numbering.js`, `server/accounting.js`, `server/migrations.js`, `server/services/demo.js`, `server/services/visas.js`.
- Frontend: `public/js/views/invoice-detail.js`, `public/js/views/refund-detail.js`, `public/js/views/statement.js`, `public/js/views/audit-logs.js`.
- Tests: `test/audit-fixes.test.js` (new), `test/cancellations.test.js`, `test/dsr-sections.test.js`, `test/visa-deposits.test.js`, `test/e2e/browser.test.js`.
- Docs: `README.md`.

Verification:

- `npm run check`: 176 JavaScript files syntax OK.
- `npm test`: 158 passed. 9 new tests in `test/audit-fixes.test.js`, one per finding: F1, F2, F3, F4, F5, F7, F8, F10, F11.
  - Four existing assertions now follow the as-of-period rule (F5): the sale-day report is unchanged, and a report covering the cancellation marks it cancelled.
  - One assertion now expects the SD prefix.
- `npm run test:e2e`: 31 passed. The deposit test now also checks:
  - the deposit refund page (note, link to the visa, no Void) for F4;
  - a statement with deposits at 375px with no horizontal scroll, for F6.
  - Axe light and dark is clean.
- Visual check on a throwaway server (temp data dir, port 4391, demo data):
  - deposit-funded payment on an invoice (note, no Void);
  - deposit refund page;
  - audit log labels.
  - Found and fixed while checking: the refund page's remaining refundable amount ignored the part of the deposit used for the invoice.
- Migration dry-run on a copy of live `data/accounting.db`: the new counter and six indexes were added, integrity ok, all 10 ledger checks match. The live file was not modified; restart needed.

### UI/UX cleanup — simpler navigation, Today box, summary strips, phone layout — code commit `32d54f9`

The goal was to make the app friendlier for everyday staff work. Accounting, data, reports and printouts do not change.

**Phase 1 — everyday screens**
- **Sidebar:**
  - Reorganised from 9 groups / 22 items into: Dashboard; Travel (Bookings, Visas); Sales (Invoices, Customers); Money back (To settle, Cancellations, Refunds, Credit notes, Customer balances); Suppliers (Suppliers, Bills & expenses, Supplier credits, Portals & wallets); Reports.
  - **More** starts closed and holds Banking, Bank reconciliation, Cheques, Compliance, Journal, Opening balances, Chart of accounts, Audit log and Settings.
  - Groups fold on click and are remembered (`ledgerly.nav.groups` in localStorage).
  - Landing on a page inside a folded group opens that group.
- **Dashboard:**
  - A new **Today** box lists overdue invoices, money to give back (settlement queue), visa deposits to refund (cancelled or rejected visa), overdue bills, draft bookings and draft visas. Each is a link with its count and amount. The data comes from a new `todo` block on `GET /api/reports/dashboard`.
  - Eight summary tiles in two rows; "Active bookings" was folded into the booking margin tile.
  - Ledger checks are one line ("All 10 checks match") that opens the table. It opens by itself when a check does not match.
- **Booking, visa and invoice pages:**
  - A **summary strip** at the top: status, customer, total, paid, balance (red when due), margin (booking and visa) or due date (invoice).
  - The main step stays as a button: Confirm / Submit / Send & post / Record payment, plus Approve / Issue / Reject and Mark travelled. Booking and visa pages link to their invoice with "Record payment" when money is due.
  - All-list link, Print, Audit chain, Cancel / Void, credit note and cancellation links move into a **More ⋯** menu. It closes on a choice, an outside click or Escape. Items keep their `data-action`, so existing handlers work.
- **Wording:** "Vendor" becomes **Supplier** across screens, including the list, forms, bills, cheques, compliance, aging and settings. Routes and the API are unchanged.

**Phase 2 — tidier details**
- Account-code columns on booking and visa documents are hidden unless switched on with **More → Show or hide account codes**, which is remembered per browser.
- **Today** and **This month** quick-date buttons on every list date filter. The statement keeps its own presets.
- The internal-notes box is smaller ("Staff only · not printed").

**Phase 3 — phones**
- A bottom **tab bar** (Home, Bookings, Visas, Invoices, More) at ≤900px. More opens the full sidebar.
- The bookings, visas and invoices lists become **cards** at ≤680px. Cells are labelled from their column headers automatically, so each figure reads clearly.
- Bigger touch targets: buttons and inputs at least 40–42px, and 16px input text so phones do not zoom in.
- Header buttons keep their labels on phones; they used to show bare "+" icons.

**Fixed during the work:** a constant name clashed with an existing one (`NAV_STATE_KEY`) and stopped the app loading. E2E caught it; `npm run check` did not, because it only checks each file's syntax.

Key files:
- Frontend: `public/js/app.js`, `public/js/ui.js`, `public/js/views/dashboard.js`, `public/js/views/booking-detail.js`, `public/js/views/visa-detail.js`, `public/js/views/invoice-detail.js`, `public/js/views/bookings.js`, `public/js/views/visas.js`, `public/js/views/invoices.js`, `public/js/views/statement.js`, `public/js/views/parties.js`, plus the supplier wording in `bills.js`, `bill-detail.js`, `cheques.js`, `supplier-credits.js`, `portals.js`, `refund-modal.js`, `settings.js`, `compliance/modal.js`, `reports/aging.js`; and `public/css/styles.css`.
- Server: `server/services/reports/dashboard.js`.
- Tests: `test/e2e/browser.test.js`.
- Docs: `README.md`.

Verification:

- `npm run check`: 176 JavaScript files syntax OK.
- `npm test`: 158 passed.
- `npm run test:e2e`: 32 passed.
  - New test: More group folded and opening; Suppliers label; Today links; summary strip; account codes hidden then shown from More; More closes after a choice; This month quick date; at 375px, the tab bar is active on Bookings, cells are labelled, there is no horizontal scroll, and More opens the sidebar.
  - Existing tests open the More menu where Void, Print or Audit chain moved (`clickPageAction`).
  - The ledger checks test opens the folded card first.
  - Axe light and dark is clean.
- Visual check on a throwaway server (temp data dir, port 4391, demo data):
  - desktop dashboard (Today box, 8 tiles, one-line checks);
  - booking page (strip, open More menu, no account codes);
  - at 375px: bookings cards with the tab bar, dashboard Today box, labelled header buttons, invoice page with strip; no horizontal scroll.
- No schema change. The live file was not modified; restart needed.

### Quiet transitions (patterns adapted from transitions.dev) — code commit `17a0ad3`

The user asked whether to add the transitions.dev library. The decision was to add five subtle effects written in our own CSS, and not to install the library, its CLI, agent skill or Refine tool. Those would bring outside code, an injected script and a sign-in into a local app that runs on live data, and the library's flashy effects (such as blurred number flips) do not suit money. The licence allows using the patterns in our own project.

1. **More menu** opens from its button: a 160ms fade/scale from the top right.
2. **Panel reveal** (220ms fade/slide) when "More details", the ledger checks line or a sidebar group opens.
3. **Success check:** the ✓ in a success toast pops and draws itself after Confirm / Submit / Record payment and other successful saves.
4. **Shake on a wrong entry:** when a form is refused, the error message and the first empty required field give a small shake. The field is marked `aria-invalid` with a red outline until you type in it. Implemented with a new `replayAnimation()` helper in `ui.js`.
5. **Page change:** a gentle 220ms fade/slide as each page appears.

- Shared timing tokens `--t-fast` and `--t-base`, plus an ease-out curve. Amounts are never animated.
- **Reduced motion:** every effect is off when the system asks for reduced motion (`prefers-reduced-motion: reduce`), and none run in print.

Key files: `public/css/styles.css`, `public/js/ui.js`, `public/js/app.js`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 176 JavaScript files syntax OK.
- `npm test`: 158 passed.
- `npm run test:e2e`: 33 passed.
  - New test: no motion under the suite's reduced-motion setting; with motion allowed, pages use `t-page`, the More menu uses `t-menu-in`, and a refused form marks the empty customer field `aria-invalid`.
  - Axe light and dark is clean.
- Visual check on a throwaway server (temp data dir, port 4391, demo data, motion on): new service invoice saved with no customer shakes and outlines the Customer field and shows "Choose a customer".
- No schema change. The live file was not modified; restart needed.

### Phone menu: "More" turns into "Close" (⋮ → ✕) — code commit `171f853`

The user asked for a hamburger transition. transitions.dev has no dedicated one; the closest is its "Icon swap" pattern.

- **First try:** swap ☰ → ✕ on the header menu button. E2E showed that on a phone the open sidebar (248–262px from the left) covers that button, so the ✕ would never be seen or tapped. Reverted.
- **Final:** the **More** button in the phone tab bar becomes **Close** with a ✕ while the sidebar is open, using a 160ms scale/rotate/blur icon swap. Tapping it closes the sidebar. The tab bar sits above the sidebar and the dark overlay (z-index 45 vs 40 / 35), so the button stays visible on the right.
- `aria-expanded` and `aria-label` ("Open menu" / "Close menu") stay in step through `syncMenuState()`.
- Off for reduced motion. The tab bar is not printed.

Key files: `public/js/app.js`, `public/css/styles.css`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 176 JavaScript files syntax OK.
- `npm test`: 158 passed.
- `npm run test:e2e`: 33 passed. The motion test now also checks at 375px: More shows ⋮; tapping it gives `aria-expanded=true`, the ✕ icon and "Close"; tapping again closes the sidebar and brings ⋮ back.
- Visual check at 375px on a throwaway server (temp data dir, port 4391, demo data): the sidebar opens and the tab bar shows ✕ Close.
- Minor note for later: at phone width the scrollable invoice item table (`.doc-items-wrap`) is not keyboard-focusable, which axe flags at 375px. Desktop axe is clean.
- No schema change. The live file was not modified; restart needed.

### Hamburger ☰ → ✕ at the top of the phone sidebar — code commit `2e40bd5`

The user wanted the hamburger itself to animate. On phones the header ☰ is covered by the open sidebar, so the hamburger now also appears at the **top-right of the open sidebar**.

- As the sidebar opens it turns **☰ → ✕**: the ☰ rotates out and the ✕ rotates in with a light blur, 220ms. Tapping it closes the sidebar.
- It is hidden on desktop. The brand gets right padding so the two do not overlap.
- With reduced motion it simply shows ✕.
- The tab bar's More → Close (previous entry) stays.

Key files: `public/index.html`, `public/js/app.js`, `public/css/styles.css`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 176 JavaScript files syntax OK.
- `npm test`: 158 passed.
- `npm run test:e2e`: 33 passed. The motion test now also checks at 375px: the sidebar hamburger is visible when open; under reduced motion it shows ✕; with motion it uses `t-burger-in`; tapping it closes the sidebar.
- Visual check at 375px on a throwaway server (temp data dir, port 4391, demo data): ✕ in the top-right of the open sidebar next to the Ledgerly brand.
- No schema change. The live file was not modified; restart needed.

### Desktop hamburger ☰ ↔ ← — code commit `8344b1b`

On desktop the ☰ button hides and shows the sidebar, but its icon never changed. The user chose ☰ ↔ ← over ☰ ↔ ✕: the sidebar is open most of the time, and a calm ← reads as "hide sidebar" without an ✕ on every page.

- The header icon is now three SVG lines. At ≥901px, while the sidebar is shown, the top and bottom lines fold into the head of a **←** (rotate ±45°, scale 0.53, 220ms). When the sidebar is hidden they open back into **☰**.
- Driven by the button's existing `aria-expanded`.
- Phones keep the plain ☰ in the header (the sidebar covers it there) and use the ✕ inside the sidebar.
- Off for reduced motion.

Key files: `public/index.html`, `public/css/styles.css`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 176 JavaScript files syntax OK.
- `npm test`: 158 passed.
- `npm run test:e2e`: 33 passed. The motion test now also checks at 1440px: the top line is transformed (arrow) while expanded, untransformed (☰) after hiding, and expanded again after a second click.
- Visual check at 1400px on a throwaway server (temp data dir, port 4391, demo data): ← next to the page title with the sidebar open, ☰ with it hidden.
- No schema change. The live file was not modified; restart needed.

### IFRS wording across reports, accounts and screens — code commit `95165e5`

The user asked for accounting-standard wording. The rule applied: proper IFRS terms in reports and on accounting screens; on staff screens, the same terms kept short. Sources checked: IAS 1 (presentation and line items; IAS 1 allows label changes), IFRS 15 (contract liabilities, refund liabilities, trade receivables, principal vs agent) and the FTA tax invoice / tax credit note rules.

- **Statement of Profit or Loss** (was Income Statement):
  - Revenue → **Cost of sales** → **Gross profit** → **Operating expenses** → **Profit (or Loss) for the period**.
  - `incomeStatement` adds `cost_of_sales`, `operating_expenses`, `cost_of_sales_total_cents`, `gross_profit_cents`, `operating_expenses_total_cents` and `profit_cents`. The old fields are kept.
  - Cost of sales is every expense account of subtype `cogs`. **5120 is moved from operating expense to cost of sales**, alongside 5000 and 5100. The label "Cost of goods sold" becomes "Cost of sales".
- **Statement of Financial Position** (was Balance Sheet): the unclosed result reads "Profit for the period (not yet closed to retained earnings)". Report tabs read "Profit or loss" and "Financial position".
- **Account names:**
  - 1100 Trade Receivables, 1200 Prepayments, 1400 Advances to Suppliers, 1460 Refundable Deposits Paid.
  - 2000 Trade Payables, 2400 Contract Liabilities (Customer Advances), 2500 Refund Liabilities, 2600 Refundable Security Deposits Held.
  - 4300 Service Fee Income, 4330 Cancellation Fee Income.
  - 5000 / 5100 / 5120 Cost of Sales – Air Tickets / Hotels & Tours / Visas.
  - A migration renames an account only when it still has the old default name; a name the user changed is kept. The old "Cost of Goods Sold" → 5000 rename now goes straight to the new name.
  - `ensureRequiredAccount` uses the new names.
  - The same names replace the old ones in screen hints, server messages, previews and the README (30 files).
- **Statement of account:** columns **Debit / Credit**; balance label **Balance due** (customer) / **Balance payable** (supplier).
- **Gross profit wording** (was "Margin" / "Profitability"):
  - Booking and visa forms, pages and lists; summary strips; confirm preview; the DSR column, summary and switch ("Show cost & gross profit").
  - The dashboard tiles "Booking / Visa gross profit"; the report tabs "Booking / Visa gross profit"; "Gross margin %".
- **Dashboard:** Cash in hand / Cash at bank, Trade receivables, Trade payables, "Profit for the month".
- **Settlements:** the menu item and page title both read "Settlements".
- **"Post" kept** as the standard ledger term.
- **Help lines:**
  - Void dialog: "Void is for a mistake … if a customer cancelled, use Cancel".
  - Cancellation form: "Cancel is for a customer cancellation (for a mistake, void instead)".
  - Draft delete: "Delete is only for drafts".
- **Vouchers:** a customer refund prints as **Payment voucher · customer refund**; a supplier refund as **Receipt voucher · supplier refund**.
- **For the accountant (not changed):** under IFRS 15 an agency acting as agent reports ticket revenue net (commission or markup). Ledgerly records gross sales with cost of sales. Profit is the same; revenue differs.

Key files:
- Server: `server/default-accounts.js`, `server/migrations.js`, `server/services/reports/financials.js`, plus the account names in `server/services/*`.
- Frontend: `public/js/views/reports/financials.js`, `public/js/views/reports.js`, `public/js/views/statement.js`, `public/js/views/dashboard.js`, `public/js/views/settlement-queue.js`, `public/js/views/customer-balances.js`, `public/js/app.js`, `public/js/ui.js`, `public/js/views/cancellation-modal.js`, `public/js/views/refund-detail.js`, `public/js/views/accounts.js`, the booking / visa / DSR / margin views, and `public/css/styles.css`.
- Tests: `test/ifrs-terms.test.js` (new), `test/credit-refunds.test.js`, `test/e2e/browser.test.js`.
- Docs: `README.md`.

Verification:

- `npm run check`: 176 JavaScript files syntax OK.
- `npm test`: 161 passed. 3 new tests in `test/ifrs-terms.test.js`:
  - the new names, with 5000 / 5100 / 5120 as cost of sales;
  - an old default name is renamed on start, a custom name is kept, and 5120 moves to cogs;
  - P&L revenue 1,000 − cost of sales 800 = gross profit 200 − rent 50 = profit 150, with the right accounts in each section; the financial position shows "Profit for the period".
- `npm run test:e2e`: 33 passed. Five assertions now expect the new wording: Settlements, Debit/Credit, Gross profit in the confirm preview, the DSR profit column and the summary strip.
- Migration dry-run on a copy of live `data/accounting.db`: all 13 accounts still had their default names and were renamed; 5120 moved to cost of sales; integrity ok; all 10 ledger checks match. P&L for 2026: revenue 700.00, cost of sales 569.00, gross profit 131.00, profit 131.00.
- Visual check on a throwaway server (temp data dir, port 4391, demo data): the Statement of Profit or Loss with cost of sales and gross profit.
- No schema change (data only). The live file was not modified; restart needed.

### Reports section simplified — code commit `4d30e9f`

The reports page had a strip of 10 tabs with accounting names and the same date fields everywhere.

- **Reports home** (`#/reports`): cards in three groups, each with an icon and one line explaining it.
  - **Daily work:** Daily sales, Who owes us (trade receivables aging), Visa deposits.
  - **How the business is doing:** Profit or loss, Booking gross profit, Visa gross profit.
  - **For your accountant:** Financial position, Trial balance, What we owe suppliers (trade payables aging), Portal wallets.
- **Each report:**
  - The page title is the report's proper name (e.g. Statement of Profit or Loss), with its one-line explanation as the subtitle.
  - An **All reports** button and Print are in the header. The tab strip is gone.
- **Quick periods:**
  - Date-range reports: **Today, This month, Last month, This year**, then From / To.
  - Single-date reports: **Today, End of last month**, then As of.
  - Reports with no date (Visa deposits, Portal wallets) show no date controls.
  - The chosen quick button is highlighted.
- Report URLs are unchanged, so dashboard and other links still work.

Key files: `public/js/views/reports.js`, `public/css/styles.css`, `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 177 JavaScript files syntax OK.
- `npm test`: 161 passed.
- `npm run test:e2e`: 34 passed.
  - New test: the three groups and 10 cards; opening Profit or loss shows the proper title with no tab strip; This year sets 1 January; Last month sets a date; All reports goes back.
  - The reports home is added to the axe audit, which is clean in light and dark.
- Visual check at 1400px on a throwaway server (temp data dir, port 4391, demo data): the reports home, and Booking gross profit with the quick periods.
- No schema change. The live file was not modified; restart needed.

### Quick expense (paid now) — code commit `8e454ae`

Before this, a small expense already paid took two steps: a bill, then a payment on that bill.

- A **Quick expense** button on Bills & expenses (also in the empty state) opens one form:
  - what it was for, amount and date paid;
  - expense account (default 6900 Other Expenses), paid from (default 1000 Cash) and method (Cash, Credit card, Bank transfer, Cheque with its number, Other);
  - optional supplier, receipt no., and receipt photo or PDF.
- `POST /api/bills/quick-expense` (`createQuickExpense`) creates a received bill and a full payment on the same date, in one transaction:
  - Dr expense / Cr 2000, then Dr 2000 / Cr cash or bank.
  - Trade Payables nets to zero, so the result is Dr expense / Cr cash or bank.
  - Because it is an ordinary bill it voids, appears on the P&L, the DSR "money paid out", the supplier statement and the audit log like any bill.
- With no supplier, a **Sundry (cash expenses)** supplier is created once and reused (reactivated if it was archived).
- The bill note reads "Quick expense · paid now".
- The receipt is uploaded as a bill attachment after saving. If the upload fails, the expense stays saved and a message says to attach the receipt on the bill page.

Key files: `server/services/bills.js`, `server/routes/bills.js`, `public/js/views/quick-expense.js` (new), `public/js/views/bills.js`, `test/quick-expense.test.js` (new), `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 178 JavaScript files syntax OK.
- `npm test`: 164 passed. 3 new tests in `test/quick-expense.test.js`:
  - without a supplier it is paid, on the sundry supplier, with expense up, cash down, 2000 at zero and ledger checks matched; the sundry supplier is reused;
  - with a named supplier, voiding brings the cash back;
  - validation (description, amount, expense account, cash or bank account, cheque number) with nothing half-saved.
- `npm run test:e2e`: 35 passed. New test: Quick expense from the Bills page with AED 45 creates a paid bill on Sundry (cash expenses), paid in cash.
- Visual check at 1400px on a throwaway server (temp data dir, port 4391, demo data): the form with its defaults.
- No schema change. The live file was not modified; restart needed.

### Customer advances: used on confirm, on the statement, recordable from the customer page — code commit `ee22a2d`

These are the three gaps from the advance review, plus a fourth found while fixing them.

- **Used on confirm / submit:**
  - `confirmBooking`, `submitVisa` and `submitVisaGroup` take `{ apply_advances: true }`, which the screens send. Within the same transaction, `jobs.applyOpenAdvances` applies the job's open advances to the new invoice: oldest first, up to the invoice total, each dated the later of the invoice date and the advance date.
  - The result lists `applied_advances`; the screen shows a message per advance; the confirm preview lists "Paid from advance ADV-… −AED …".
  - Any remaining amount stays as an advance.
  - Without the option (old API callers), nothing changes.
- **On the customer statement:** a new **Advances held for you** section, built from advances (received, credit), "Advance applied" payments (used for invoice X, debit) and advance refunds (debit), with opening and closing held balances. Voided advances, payments and refunds are excluded. It is never part of the amount due. The deposit section's table is reused with its own title and note.
- **Recordable from the customer side:** **Customer balances → customer** has a **Record advance** button for an advance with no booking or visa (new `customer-advance-modals.js`).
- **Found while fixing:** an advance with no job sent Settlements to the customer balance page, which had no way to use or refund it. Each advance row there now has **Use for invoice** (choose an unpaid invoice of the customer) and **Refund**.

Key files: `server/services/jobs.js`, `server/services/bookings.js`, `server/services/visas.js`, `server/routes/bookings.js`, `server/routes/visas.js`, `server/services/statements.js`, `public/js/views/job-modals.js`, `public/js/views/booking-detail.js`, `public/js/views/visa-detail.js`, `public/js/views/statement.js`, `public/js/views/customer-advance-modals.js` (new), `public/js/views/customer-balance-detail.js`, `test/advance-fixes.test.js` (new), `test/e2e/browser.test.js`, `README.md`.

Verification:

- `npm run check`: 180 JavaScript files syntax OK.
- `npm test`: 169 passed. 5 new tests in `test/advance-fixes.test.js`:
  - two advances pay a booking invoice oldest first, with dates and the remainder kept, and ledger checks matched;
  - nothing is applied without the option or to another job's invoice;
  - visa submit and group submit apply their own advances;
  - the statement advances section (received / applied / refunded, a voided one excluded, opening balance) and the amount due unaffected;
  - an advance with no job is used and refunded.
- `npm run test:e2e`: 36 passed.
  - New test: the confirm preview shows "Paid from advance … −AED 200.00" and the invoice is paid 200; Record advance on the customer balance page shows Use for invoice; the statement shows "Advances held for you" with "Advance used to pay invoice".
  - The statement summary test reads the first statement table, because a customer with advances now has two.
- Visual check on a throwaway server (temp data dir, port 4391, demo data): the Record advance button on the customer balance page and the statement.
- No schema change. The live file was not modified; restart needed.

### Simpler customer statement — code commit `2f59a97`

The user found the customer statement too complex. On demo data, Aisha Khan's statement was about 1,980px tall for 13 rows. It is now about 1,480px.

- **One summary line:** Opening · Debit · Credit · **Balance due** with the Settled / Payment due / Credit balance pill. It sits inside the document, so it also prints. It replaces the four KPI cards above the page and the separate balance-due box. On a phone, Opening and Balance due take a full row and Debit / Credit sit side by side.
- **Short rows:** each row shows its title plus one muted line: the first item ("+N more" if there are others), then the due date, method or "Against INV-…". All items, the visa applicant box and the "Service for" traveller box are folded behind a small **Details ▸** button on the row.
- **Show details switch:** in the toolbar, shown only when some row has details. It opens every row and is remembered per browser (`ledgerly.statement.details`). The print follows the switch.
- **Held balances:** **Advances held for you** and **Security deposits held for you** each show as one line with the amount. The history table opens with **History ▸** (a `<details>`). An empty one (AED 0.00 held) is left off the printout; a section with no history at all is not shown.
- **Print:** period controls, Details buttons and the skip link are hidden. Debit / Credit / Balance columns and all amounts are unchanged.
- Supplier statements use the same screen and get the same layout.

Key files: `public/js/views/statement.js`, `public/css/styles.css`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 181 JavaScript files syntax OK.
- `npm test`: 169 passed.
- `npm run test:e2e`: 36 passed, axe clean. Updated tests:
  - The summary test checks that no KPI cards remain, the summary line has 4 parts (Debit, Credit, Balance due), period controls don't print and the summary line does.
  - In the visa applicant test the details are hidden until the row's Details button is clicked; Show details hides the row buttons, survives a reload, and is switched back off.
  - The advances test checks the history table is folded until the summary is clicked.
- Visual check on a throwaway server (temp data dir, port 4391, demo data) at 1400px, 375px (no sideways scroll) and an A4 PDF print.
- No schema change. The live file was not modified; restart needed.

### Bank Charges account and bank debits in Compliance — code commit `0afceae`

The user wanted the monthly bank account maintenance charges to be a recurring Compliance item. Before this change a recurring bill always made a draft bill that had to be approved and then paid, even though the bank had already taken the money.

- **New account 6700 Bank Charges** (expense, operating_expense). It is added on start through the default chart (`INSERT OR IGNORE`), so the live file gets it on restart. It is not a system account; the name can be changed.
- **Bank debit on recurring bills:**
  - New column `compliance_items.auto_debit_account_id`: an `ensureColumn` migration plus the schema for new files.
  - The form has a checkbox **"The bank takes this amount itself (bank debit)"** with **Debited from** (cash and bank accounts, 1010 by default). When it is ticked, Payment method and the auto-draft option are hidden.
  - `generateBill` with a bank debit creates the bill as `received` and records its payment from that account on the bill date, method "Bank debit". The bill is paid at once: Dr expense · Cr 2000, then Dr 2000 · Cr bank, so in net Dr 6700 · Cr 1010.
  - The log reads "Bill BILL-… recorded as paid by bank debit".
  - A fixed amount is created by **Run due bills**; each due month is recorded on its own date. A variable amount waits; the row button reads **Record debit**, and its form asks for the amount and the "Date debited".
  - The account must be an active cash or bank account. Turning the option off brings back draft bills.
- **"Bank charges" category:** choosing it on a new item fills in 6700 Bank Charges and ticks the bank debit.
- The list shows "Bank debit · Bank Account". The toasts and the callout say "bills created" instead of "draft bills created".
- **Correction to the earlier explanation:** due bills, including bank debits, are created when **Run due bills** is clicked on Compliance. Nothing runs on its own in the background.

Key files: `server/default-accounts.js`, `server/migrations.js`, `server/schema.js`, `server/services/compliance.js`, `public/js/views/compliance.js`, `public/js/views/compliance/modal.js`, `public/js/views/compliance/shared.js`, `test/bank-debit.test.js` (new), `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 182 JavaScript files syntax OK.
- `npm test`: 173 passed. 4 new tests in `test/bank-debit.test.js`:
  - 6700 exists as an operating expense;
  - a fixed bank debit makes three paid bills for three due months, each paid on its date with method Bank debit, nothing left in 2000, the next due date moved on, and ledger checks matched;
  - a variable one waits, then is recorded paid and the bank goes down;
  - turning it off gives a draft again, and a non-bank account is refused.
- `npm run test:e2e`: 37 passed, axe clean. New test: Bank charges category → bank debit on, 6700 and 1010 chosen, payment method and auto-draft hidden; save; Run due bills; a paid AED 26.25 bill on the due date.
- Visual check of the form on a throwaway server (temp data dir, port 4391, demo data) at 1400px.
- Schema change: one nullable column, added by migration on start. The live file was not modified; restart needed.

### Bank debits need no supplier — code commit `01d8088`

The user found that the bank charges form still asked for a supplier.

- With **"The bank takes this amount itself"** ticked, the supplier field reads **Supplier (optional)**. Its empty choice reads "None — the bank itself", and a hint explains it.
- Left empty, `normalizePayload` uses a supplier named after the debit account, "`<account name>` (bank debits)" (for example "Bank Account (bank debits)"). It is created on first use with a note and reused after that, the same way as the Sundry supplier for quick expenses. A named supplier can still be chosen.
- A normal recurring bill (no bank debit) still says "Choose a vendor".

Key files: `server/services/compliance.js`, `public/js/views/compliance/modal.js`, `test/bank-debit.test.js`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 182 files OK.
- `npm test`: 174 passed. New test: a bank debit with no supplier gets "Bank Account (bank debits)", which is reused, and its bill is paid; a rent bill without a supplier is still refused.
- `npm run test:e2e`: 37 passed. The bank charges test now saves without choosing a supplier and sees "Bank Account (bank debits)" on the row.
- Visual check of the form on a throwaway server (port 4391).
- No schema change; restart needed.

### Bank charges, petty cash, portal-wallet deposits and two small fixes — code commit `ed5e74f`

The user picked items 1, 2, 3, 7, 8, 11 and 12 from the pending list.

1. **Bank charges field on payment forms.**
   - New optional "Bank charges" field on **Record payment** (invoice), **Record bill payment** and the **Refund** form. It is hidden and cleared for Cash.
   - New columns `bank_charges_cents` on `payments`, `bill_payments` and `refunds`. The helpers `bankChargesCents` / `bankChargeLines` are in `server/accounting.js`.
   - The charge is added to the same journal entry: Dr 6700 Bank Charges · Cr the bank. The document is settled for the full amount: for example, invoice 1,000 paid with 15 charges → 1100 is credited 1,000, the bank nets 985, and 6700 gets 15. A void reverses the whole entry, charge included.
   - On a receipt, and on money from a supplier refund, the charge cannot be more than the amount. On a bill payment or customer refund it is extra, on top.
   - The invoice payment row shows "Bank kept AED …"; the bill payment row shows "Plus bank charges AED …".
2. **Bank reconciliation → Add bank charge.**
   - A fold-out "Add bank charge: on the statement but not in the books" takes the amount, the date on the statement and a description.
   - `POST /api/bank-reconciliations/bank-charge` saves a paid Quick expense to 6700 from the account being reconciled, method "Bank debit", supplier "`<account>` (bank debits)".
   - The list reloads, keeps the lines already ticked, and ticks the new line. The charge must be dated after the last reconciliation. It is undone from Bills & expenses.
   - `bankDebitVendor` moved from compliance.js to bills.js.
3. **Today box reminder:** "Recurring bills due" (count, plus the total of fixed amounts) links to Compliance while any active recurring bill is due. This is a reminder only; Run due bills is still a click.
4. **Petty cash** (new page under More → Petty cash).
   - New account **1020 Petty Cash** (cash). Banking's bank total no longer counts it.
   - **Top up** from bank or cash reuses the cash transfer, with the memo "Petty cash top-up".
   - **Record spend** opens Quick expense paid from 1020.
   - **Count cash** saves to the new table `petty_cash_counts`. A difference posts to 6900 Other Expenses: a shortage is Dr 6900 · Cr 1020, an overage the opposite way. A count that matches posts nothing. A count can be voided.
   - The **float** (`settings.petty_cash_float_cents`) shows how much to top up.
   - The page has an activity table with a running balance, and a counts table. The DSR labels count entries "Petty cash count differences".
5. **Visa deposit paid from a portal wallet.**
   - The deposit card's **Paid from** list adds prepaid portal wallets that have a balance. Choosing one fills in the supplier and posts Dr 1460 · Cr 1400 Advances to Suppliers. The wallet balance must cover it on that date.
   - A supplier return can go **Back to portal wallet** (Dr 1400 for the net).
   - New column `visa_deposit_events.portal_id`. Portal balances (`aggregates`, `balanceAsOf`, `lockBalance`), the portal ledger (rows "Visa deposit … paid / returned") and the 1400 comparison all count these events; voided ones are left out.
6. **Small fixes:**
   - A short statement prints on one A4 page (tighter print spacing; the footer is kept together).
   - The `.doc-items-wrap` tables on invoice, bill, booking, visa, portal, credit, cancellation and refund pages have `tabindex="0"`, `role="region"` and a focus outline, so they scroll with the keyboard on a phone.

Key files: `server/accounting.js`, `server/services/{invoices,bills,refunds,bank-reconciliations,cash-deposits,petty-cash,visa-deposits,compliance}.js`, `server/services/portals/{common,ledger,lifecycle}.js`, `server/services/reports/{dashboard,dsr-sections}.js`, `server/routes/{petty-cash,bank-reconciliations,index}.js`, `server/{default-accounts,migrations,schema}.js`, `public/js/bank-charges.js` (new), `public/js/views/petty-cash.js` (new), `public/js/views/{invoice-detail,bill-detail,refund-modal,bank-reconciliation,dashboard,quick-expense,visa-deposit-card}.js`, `public/js/app.js`, `public/css/styles.css`, tests.

Verification:

- `npm run check`: 188 files OK.
- `npm test`: 182 passed. New tests:
  - `test/bank-charges.test.js`: invoice net to bank with the void reversing it; bill payment with charges on top; refunds both ways and the limits; reconciliation charge as a paid 6700 bill and a tickable line.
  - `test/petty-cash.test.js`: 1020 is not counted as bank; top-up, spend, running balance and the top-up to the float; shortage, overage, matched count and void.
  - The wallet deposit test in `test/visa-deposits.test.js`: wallet pays with no bank movement, the 1400 and deposit checks match, the portal ledger row and zero difference, return net into the wallet, insufficient balance refused.
  - The Today reminder in `test/bank-debit.test.js`.
- `npm run test:e2e`: 38 passed, axe clean, with `/petty-cash` added to the axe routes. New test: the payment form's bank charges field (hidden for Cash), AED 15 saved and shown; the reconciliation charge added and ticked; petty cash top-up 500 and a short count of 490.
- Visual check: an A4 PDF of the statement (one page) on a throwaway server (port 4391). The in-app browser pane's screenshots did not show the open dialogs, so the new forms were checked through the E2E suite instead.
- Schema changes: new table `petty_cash_counts`; nullable or defaulted columns on payments, bill_payments, refunds, visa_deposit_events and settings; account 1020 added on start. The live file was not modified; restart needed.

## 2026-10-30

### Card and payment link settlements — code commit `99071f0`

The user asked how card payments, payment links and their charges work. Before this change "Credit card" was only a method label and there was no payment link. Gateway payouts arrive days later, several payments in one batch, less the fee, so they did not match the books. The user asked to build the clearing and settlement flow.

- **New account 1030 Card & Payment Link Clearing** (asset, cash-type so it can be chosen as "Deposit to"). It is a control account, so manual journals cannot post to it, and it is kept out of Banking's bank total (`card_clearing_cents`).
- **New method "Payment link"** (`public/js/payment-methods.js`) on Record payment, advances (booking, visa, customer), visa deposits and refunds. Choosing Credit card or Payment link sets Deposit to → 1030, Cash → 1000, and the others → 1010. The Bank charges field is hidden when Deposit to is 1030, because the fee is taken at settlement.
- **Card settlements page** (More → Card settlements, `/api/card-settlements`):
  - The open items are the 1030 journal lines not yet settled. Voided entries and their reversals drop out.
  - Tick the items in a payout, enter the amount received, the date and the bank account; the fee is worked out (selected − received). Saving posts one entry, `CS-YYYY-NNNN`: Dr bank (net) · Dr 6700 Bank Charges (fee) · Cr 1030 (gross).
  - Rules: the date cannot be before the last item, the net cannot be more than the items, and an item can only be settled once.
  - Voiding a settlement reverses its entry and puts the items back; it is blocked while the payout is ticked in a bank reconciliation.
  - `reverseEntry` now refuses to reverse an entry whose 1030 line is in a posted settlement. So a settled card payment must have its settlement voided first, or be refunded instead.
  - New tables `card_settlements` and `card_settlement_lines`, and `settings.next_card_settlement_number`.
- **Payment link on invoices:** More → Add / Change payment link (`PUT /api/invoices/:id/payment-link`, https only, empty removes it; new column `invoices.payment_link`). While a balance is due, the invoice shows "Pay online by card: …" under Payment terms, which also prints, and the WhatsApp/email message adds the link.
- The DSR counts "Payment link" in the Card column; its row is labelled "Card & payment link". Settlement entries are labelled "Card & payment link settlements".

Key files: `server/services/card-settlements.js` (new), `server/routes/card-settlements.js` (new), `server/accounting.js`, `server/services/{invoices,cash-deposits,numbering}.js`, `server/services/reports/dsr-sections.js`, `server/{default-accounts,migrations,schema}.js`, `public/js/payment-methods.js` (new), `public/js/views/card-settlements.js` (new), `public/js/bank-charges.js`, `public/js/share-links.js`, `public/js/views/{invoice-detail,booking-detail,visa-detail,job-modals,customer-advance-modals,visa-deposit-card,refund-modal}.js`, `public/js/views/reports/daily-sales.js`, `public/js/app.js`, `public/css/styles.css`.

Verification:

- `npm run check`: 193 files OK.
- `npm test`: 186 passed. New `test/card-settlements.test.js` (4 tests):
  - 1030 is kept out of the bank total;
  - a payout of two items settles 70,000 into the bank as 68,250 with a 1,750 fee, after refusing a too-high net and a too-early date; the first item still waits, the open items equal the 1030 balance, and ledger checks match; settling an item twice is refused;
  - a settled payment cannot be voided; after the settlement is voided its items wait again, and once the payment is voided it is not offered;
  - 1030 is a control account, and the payment link is saved, refused for http, and cleared.
  - The share message test checks the "Pay online by card" line.
- `npm run test:e2e`: 39 passed, axe clean, with `/card-settlements` added to the axe routes. New test: add a payment link and see it on the invoice; Payment link method → Deposit to 1030 with Bank charges hidden; after payment the link is gone; settle with 390 received of 400 → fee 10.00, and the open items equal the 1030 balance.
- The forms were not checked visually: the in-app browser pane does not show open dialogs, so the E2E suite covers them.
- Schema changes: two new tables, `invoices.payment_link`, a settings counter and account 1030 (added on start). Older "Credit card" payments already posted to 1010 are unchanged. The live file was not modified; restart needed.
- Housekeeping: an empty `test/share-links.test.js` was created by mistake during this work and removed before the commit.

### Code cleanup after the full check — code commit `7c56032`

The user asked for a read-only check of the whole backend and frontend for dead code, dead schema, conflicts and record integrity, then a second, deeper verification of that report, then "Yes, fix them". The live records were already sound (10/10 ledger checks, no unbalanced entries, every document has its entry). This commit removes what the check found.

- **Dead functions removed:**
  - Backend: `compliance.nextDate`, `audit.forEntity`, `cancellations.cancellationAdjustment` plus `retainedCostCents` (used only by it, so its `job-costs` require went too), `util.conflict`, `cash-deposits.accountBalance`, and the `AUDIT_CHAIN_TYPES` export.
  - Frontend: `ui.formValues`, `ui.debounce`, `store.accountById`, `portals.portalSubtitle`.
- **16 unused imports removed:** `portal-reconcile.js` (9), `visas.js` (3), `visa-detail.js`, `reports/daily-sales.js`, `routes/reports.js`, `services/advances.js`.
- **Dead column:** `post_dated_cheques.batch_index` was never written or read. It is removed from the schema and dropped by migration (`dropColumn`). The migration was tested on a copy of the live files: the column is gone, integrity ok, 10/10 checks.
- **CSS:**
  - 15 unused classes removed (36 rules or rule parts): `amount-pos`, `daily-sales-table`, `daily-summary`, `dsr-reversal`, `flush`, `form-section-title`, `mono`, `payment-list`, `quick-stat(s)`, `report-day-*` and `tabs`. The script that removed them also checked the braces stay balanced.
  - An emptied `@media (min-width: 901px)` block was removed.
  - Duplicate selectors were merged, keeping what applied before: `.row-actions` (gap 2px), `.source-cash_deposit` (blue; the overridden teal rule removed), `.statement-parties` (padding 18px 0 14px) and `.internal-notes p`.
- **Routes:**
  - Removed the duplicate DELETE routes that only repeated Void: `DELETE /bank-reconciliations/:id`, `DELETE /portals/topups/:id`, `DELETE /credits/applications/:id` and `DELETE /supplier-credits/applications/:id`. The pass-through `deleteReconciliation` and `deleteTopup` were removed too; tests now call `voidReconciliation`.
  - Removed `DELETE /api/advances/:id` and `deleteAdvance`, which erased the advance row and left its journal entries without a source. No screen used it; Void Advance remains.
- **Payment method accounts:** new `bindMethodAccount` in `public/js/payment-methods.js`, used by invoice payment, booking/visa advances, customer advance, visa deposit, visa group deposit and refunds. Card and Payment link now go to 1030 everywhere money is received. On refunds, customer refunds follow the same rule, while supplier refunds go to Cash or Bank. The visa group deposit list also gained "Payment link".
- **Not changed (reported only):** no ledger check for 1030 yet; the `chart.js` npm package is not needed at runtime (the dashboard loads `public/vendor/chart.umd.js`); large files, repeated balance SQL and per-view KPI helpers were left as they are.

Key files: 36 files across `server/` and `public/` (net 213 lines removed), `test/hardening.test.js`, `test/p1.test.js`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 193 files OK.
- `npm test`: 186 passed.
- `npm run test:e2e`: 39 passed, axe clean. The payment link test now also checks that Record advance switches to 1030 for Payment link and 1000 for Cash.
- Re-scans after the change: no unused exports among the removed names, no functions that are never called, no unused imports, no dead CSS classes, no duplicate selectors.
- Schema change: one column dropped on start. The live file was not modified; restart needed.

## 2026-10-31

### Fix: Record customer advance on booking and visa pages — code commit `46d02f2`

Found by the security audit's wave-3 hunter (as a non-security note). In `99071f0`, `public/js/views/job-modals.js` began using `methodOptionsHtml` and `MONEY_IN_METHODS`, but the import was never added. The edit script anchored on an `api.js` import line, and this file does not have one, so the edit silently did nothing. As a result, "Record customer advance" on booking and visa pages threw a ReferenceError and the form never opened. The live server has had this bug since `99071f0` was deployed. The customer-side advance form was not affected.

- Added `import { MONEY_IN_METHODS, methodOptionsHtml } from '../payment-methods.js'`.
- Scanned every file in public/js for names from `payment-methods.js` and `bank-charges.js` that are used without being imported: none remain.
- New browser test: it opens Record customer advance on a booking and on a visa, chooses Payment link and checks that the account becomes 1030. The test fails without the fix and passes with it.

Verification: `npm run check` 193 files OK; `npm test` 186 passed; `npm run test:e2e` 40 passed. Restart needed.

### Rebrand: Ledgerly is now Netfare — code commit `58cc5ff`

The user named the app **Netfare** and supplied a logo kit at `Netfare/logo/` with its README and concepts. The final concept is Option 2 "Ticket Ledger" (a flight ticket with ledger lines), tagline "Invoicing & Books", described as "a ShikraGroup brand". The kit colours are navy `#0B1B2E`, sky `#4FB3E8`, blue `#2B8FCB` (with light blue `#8FD0F5` on dark backgrounds) and slate `#55657A` / `#9FB0C3`. The logos are outlined SVGs, so no fonts are needed.

- **Assets in `public/brand/`:** the logo kit SVGs (with and without tagline, light and white versions, icon, mark) and PNGs (16/32/180/192/512 icons, OG image). The SVGs were checked: they contain no scripts.
- **App shell:**
  - The page title is "Netfare — Invoicing & Books", and every page title reads "… · Netfare".
  - The meta description mentions non-IATA agencies and ShikraGroup.
  - The favicon is the SVG icon with PNG fallbacks, plus an Apple touch icon.
  - The sidebar shows the white no-tagline logo with a monospace INVOICING & BOOKS tagline.
- **About card (Settings):** shows the full logo (a light and a white version that switch with the theme) and the line "Invoicing & books for non-IATA travel agencies · a ShikraGroup brand".
- **Theme (`public/css/theme.css`):**
  - Light mode moves from warm cream with gold to cool neutrals: page `#f3f6fa`, white surfaces, blue-grey borders, slate muted text `#55657a`. Navy primary buttons stay, the sky `#4fb3e8` accent has navy ink, and the revenue chart is blue `#2b8fcb`.
  - Dark mode keeps its backgrounds and switches primary and accent to sky, with light blue for the dark variant.
  - Hard-coded gold and cream (nav hover and active, select arrow, theme swatches, print accent) and the browser theme-color are updated.
  - Amber status colours are unchanged.
- **Text:** every visible "Ledgerly" now says Netfare: dashboard welcome, settings, opening balances, portal reconcile and ledger footers, health and export app name, the server start line, migration errors, and restore script messages. README is renamed too, with the logo and the new colour description.
- **Files:** new backups and downloads are named `netfare-…`. Retention matches only the suffix (`-auto`, `-pre-reset`, `-pre-restore`), so existing `ledgerly-…` backups are kept and pruned as before.
- **Customer documents:** the ten document headers (invoice, receipt, bill, booking, visa, refund, cancellation, supplier credit, portal and portal ledger) showed a fixed "L", Ledgerly's letter. They now show the agency's own initial through a new `companyMark(company)` helper in ui.js.
- **Deliberately unchanged:** the `LEDGERLY_*` environment variables, so the operator's setup and scripts keep working, and the browser storage keys `ledgerly.*`, so saved theme and sidebar state are kept. The package name is now `netfare`.

Key files: `public/index.html`, `public/css/theme.css`, `public/css/styles.css`, `public/js/ui.js`, `public/js/theme.js`, `public/js/theme-boot.js`, ten document views, `public/js/views/{settings,dashboard,opening-balances,portal-reconcile}.js`, `server/{index,migrations}.js`, `server/routes/{index,admin,settings}.js`, `server/services/backup.js`, `scripts/restore.js`, `README.md`, `package.json`, `package-lock.json`, `public/brand/` (new), tests.

Verification:

- `npm run check`: 193 files OK.
- `npm test`: 186 passed.
- `npm run test:e2e`: 41 passed, including the axe audit on every route in light and dark mode, so the new colours pass contrast. New checks: the sidebar logo loads with alt "Netfare", the favicon points at the kit, and an invoice shows the company initial while the About logo loads. The first axe run flagged the brand link's aria-label ("Netfare home") for not matching its visible text; the label was removed.
- Visual check on a throwaway server (port 4391, demo data): the dashboard in light and dark, an invoice (shows "S" for Skyline Travels), and the Settings About card.
- No schema change. Restart needed.

### Fix: Align the sidebar tagline under the logo — code commit `e03dc09`

- The "INVOICING & BOOKS" tagline under the sidebar logo was wider than the wordmark and started at an odd offset, so it looked out of line. It now starts at the ticket icon's left edge and ends where the "Netfare" wordmark ends, sits closer under the logo, and is slightly smaller (8.5px, 0.3em spacing).
- Key file: `public/css/styles.css` (`.brand-tagline`).
- Verification: measured on a throwaway server (port 4391): the tagline runs from 24px to 151.8px against the lockup's 24.5px to 151.6px at desktop width, and it looks right in the phone sidebar. `npm run check` 193 files OK; `npm run test:e2e` 41 passed. CSS only; the live server serves it on refresh, so no restart is needed.

### Fix: Books health — opening 1030 guard, reset leftovers, 1030 ledger check — code commit `48ff903`

- **Opening balances and card money:**
  - Changing or voiding opening balances reversed the old entry without the card-settlement guard that every other reversal has.
  - The reversal was linked only by `source_id`, not `reversal_of_id`, so the old opening 1030 line stayed in the open card items next to the new one. It could be settled twice, double counting card money.
  - The reversal now refuses money already in a posted card settlement ("Void that settlement first"). The check is a shared `settledCardNumber()` helper in accounting.js, also used by `reverseEntry`.
  - The reversal now sets `reversal_of_id`. A migration links existing opening balance reversals the same way; the live copy had none unlinked.
- **Clear all data:** now also deletes `card_settlement_lines`, `card_settlements` and `petty_cash_counts`, resets `next_card_settlement_number`, and resets their id sequences. The petty cash float setting is kept, like other settings.
- **New ledger check (11 in all):** 1030 Card & Payment Link Clearing balance vs the unsettled card and payment link items, linking to Card settlements.

Key files: `server/accounting.js`, `server/services/{opening-balances,demo,card-settlements,reconciliation}.js`, `server/migrations.js`, `test/card-settlements.test.js`, `test/phase3.test.js`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 193 files OK.
- `npm test`: 189 passed. The three new tests fail against the old server code.
- `npm run test:e2e`: 41 passed; the dashboard now shows "All 11 checks match".
- On a copy of the latest live backup: 11/11 checks match, and the 1030 check is 0 = 0.
- Includes a migration that only updates links. Restart needed.

### Security batch (step 1 of the multi-user plan) — code commit `5153a86`

These close the security audit (run-1) leads that need no login.

- **Cross-site reads (audit leads 2 and 3):** `apiGuard` in `server/security.js` now refuses any `/api` request that the browser marks `Sec-Fetch-Site: cross-site` or `same-site`.
  - Other websites and other local ports (`localhost:3000` counts as same-site) can no longer start backup downloads, pull exports or probe attachment images.
  - The app's own pages (same-origin) and typed or bookmarked URLs (none) still work, and so do scripts and curl, which send no header. An origin listed in `LEDGERLY_ALLOWED_ORIGINS` is still allowed.
  - Every response now also sends `Cross-Origin-Resource-Policy: same-origin`.
- **File permissions (lead 5):** new `server/file-safety.js`.
  - At startup the process sets umask 077. The data folder, `backups/` and `attachments/` become 700, and files in them become 600, including files left by older versions.
  - New backups, download copies, restore temp files and safety backups are made 600.
  - This does nothing on volumes that ignore ownership. The current "Mac SSD" volume reports "Owners: Disabled", so on it other Mac users can still read the files. The fix takes effect on a normal disk, for example the app-data folder of the desktop app in step 4.
- **Restore (lead 7):** `scripts/restore.js` refuses a backup that contains any trigger or view (Netfare creates none) or that fails `PRAGMA foreign_key_check`. The latest live backup and the three oldest backups all pass. Changed table definitions are still not compared, because older backups have older shapes.
- **Portal ledger (lead 8):** the credit portal's "Opening payable" date is escaped. `fmtDate` returns "—" for a value that is not a date instead of returning it unchanged.
- **Cleanup:** removed the unused `chart.js` npm package (and `@kurkle/color`). The bundled `public/vendor/chart.umd.js` is unchanged and still used.
- **Still open:**
  - Lead 1 (no login): solved by step 2 (login and roles). A separate API key would be readable from the page by any local program.
  - Lead 4 (LAN mode gate): part of step 3.
  - Lead 6 (opening balances bypassing the card guard): fixed in `48ff903`.

Key files: `server/security.js`, `server/index.js`, `server/file-safety.js` (new), `server/db.js`, `server/services/backup.js`, `scripts/restore.js`, `public/js/ui.js`, `public/js/views/portal-ledger.js`, `package.json`, `package-lock.json`, `test/http-security.test.js`, `test/hardening.test.js`.

Verification:

- `npm run check`: 194 files OK.
- `npm test`: 192 passed. New tests cover: cross-site and same-site backup and attachment requests get 403; same-origin and none get 200; the CORP header is sent; restore refuses a trigger, a view and a broken link; and the data folder, database and backups are owner-only, including tightening a legacy folder.
- `npm run test:e2e`: 41 passed. In-app downloads, attachments and the dashboard chart still work.
- No schema change. Restart needed.

## 2026-11-02

### Sign-in, admin setup and staff users (step 2a) — code commit `a0daf49`

The user asked for no fixed roles: the admin creates each staff login from Settings. Rights per user come in step 2b.

- **First run:** with no users, Netfare shows "Create the admin account" (full name, username, password). After that, every `/api` route except `/health` and `/auth/*` needs a signed-in user (401 otherwise). This closes security audit lead 1.
- **Sessions:**
  - A session token is 32 random bytes in an HttpOnly, SameSite=Strict cookie that lasts up to 7 days. Only its SHA-256 is stored in the new `sessions` table.
  - The cookie name includes the port (`netfare_session_4173`), so a test copy on another port never signs you out of the real one.
  - A session ends after 12 idle hours, on sign-out, when the admin disables the user or sets a new password, and on restore (`scripts/restore.js` clears sessions in the restored copy).
- **Passwords:** salted scrypt hashes in the new `users` table. They need at least 8 characters and cannot equal the username. Five wrong attempts lock a username for 5 minutes. An unknown username costs the same hashing time, so timing does not reveal which usernames exist.
- **Settings → Users & logins** (admin only): list with status and last sign-in, plus New user, Rename, Set a new password and Disable/Enable. The admin cannot be disabled. On the server, `/users` and `/admin` (backups, restore download, demo, Clear all data) are admin-only. Staff do not see the Data & backup and Danger zone cards.
- **Sidebar:** shows who is signed in (Admin or Staff · company), with buttons to change your own password (other browsers are signed out) and to sign out. If a session ends while the app is open, the sign-in screen comes back.
- **Forgotten admin password:** `npm run reset-admin` (new `scripts/reset-admin.js`) prints a one-time password. Until it is changed, the API answers 403 `password_change_required` and the app shows "Choose a new password".
- **Audit:** new `audit_logs.user_name` column, filled from the signed-in user through `server/request-context.js` (AsyncLocalStorage). The audit log shows "#id · name" and searches by name. Creating a user, disabling or enabling one and setting a new password are audited.
- **Not included:** the JSON export (`GET /api/admin/backup`) leaves out `users` and `sessions`. "Clear all data" keeps the users.
- **Tests:**
  - The browser suite creates an admin and sends its cookie.
  - Two report tests failed on the committed code too, because on 2 November "this month" no longer held their October fixtures. They now set the report period themselves.

Key files: `server/services/auth.js`, `server/routes/{auth,users,index}.js`, `server/request-context.js`, `server/schema.js`, `server/migrations.js`, `server/services/audit.js`, `scripts/{reset-admin,restore}.js`, `public/js/{auth,api,app,store,ui}.js`, `public/js/views/{account,settings,audit-logs}.js`, `public/css/{styles,theme}.css`, `README.md`, `package.json`, `test/auth.test.js` (new), `test/http-security.test.js`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 202 files OK.
- `npm test`: 201 passed. New tests cover:
  - scrypt hashing;
  - one-time admin setup;
  - idle expiry;
  - restore signing everyone out;
  - 401 without a session or with a forged cookie;
  - cookie flags;
  - lockout;
  - staff getting 403 on users and admin routes;
  - a password reset or disable ending sessions;
  - the audit user name;
  - `reset-admin` end to end.
- `npm run test:e2e`: 42 passed. The new browser test has the admin add a user in Settings (including the mismatch error). A fresh browser sees only the sign-in screen, which is axe-clean in light and dark; a wrong password shows an error; the staff user signs in and gets no Users or Clear card; and sign-out returns to sign-in.
- Visual check on a throwaway server (port 4391): setup, dashboard, the Users card, and staff sign-in.
- Schema change: new `users` and `sessions` tables and the `audit_logs.user_name` column (all additive). Restart needed. After the restart, the live app asks once for the admin account.

### Rights per user (step 2b) — code commit `1c417d3`

- **Rights model** (new `server/permissions.js`): 14 areas. For each one the admin picks No access, View or Edit. Dashboard, Reports and Audit log are view-only. A separate **Void, cancel & delete** tick covers any `DELETE` and any `…/void` or `…/cancel` request, and it also needs Edit for that area. The rights are stored in the new `users.permissions` column (JSON; migration adds it). The admin is never limited.
- **Server enforcement:** the API guard in `server/routes/index.js` matches each request to an area by its prefix. GET needs View; other methods need Edit (and Void where it applies). It answers 403 with `code: 'no_right'` and a plain message such as "You do not have Edit rights for Invoices, payments & advances. Ask the admin." Unknown prefixes, `/users` and `/admin` are admin-only.
  - **Readable by everyone:** the picker lists every screen loads (`GET /settings`, `/accounts`, `/customers`, `/vendors`, `/portals`), and `/reports/dashboard` and `/reports/reconciliation` with Dashboard rights.
  - **Related reads:** booking and visa screens may read invoices (outstanding invoices for advances), portals and cancellations, and may record customer advances. Documents may open their own journal entry (one entry, not the journal list). Supplier credits may read bookings and visas. Cheques may read compliance.
  - **Attachments** follow the rights of the document they belong to.
  - Rights changes apply on the next request, without signing in again, and are audited (action "rights", with a summary).
- **Settings → Users & logins:**
  - **Rights checklist:** New user and a new Rights button (shield) on each user open a checklist table with No access, View and Edit radio buttons per area, "Set all" buttons and the Void tick.
  - **List:** a Rights column ("Edit 1 · View 2 · Void").
  - **Defaults:** a new user starts with Dashboard View only.
- **App:**
  - **Menu:** the menu and the phone tab bar show only allowed screens.
  - **Blocked screens:** opening a screen without View shows "You do not have access to this screen". The home screen goes to the first allowed screen.
  - **Buttons:** one generated stylesheet hides "New …" buttons and void, cancel and delete buttons without the right, plus Audit chain links without Audit rights.
  - **Settings:** company settings are read-only without Edit.
- **Not done yet:** "created by" on each document. It needs a column on about ten document tables; it is left for the DSR staff column work. The audit log already records who voided, cancelled or deleted.

Key files: `server/permissions.js` (new), `server/routes/{index,users}.js`, `server/services/auth.js`, `server/schema.js`, `server/migrations.js`, `public/js/{app,store}.js`, `public/js/views/{account,settings}.js`, `public/css/styles.css`, `README.md`, `test/permissions.test.js` (new), `test/http-security.test.js`, `test/e2e/browser.test.js`.

Verification:

- `npm run check`: 204 files OK.
- `npm test`: 207 passed.
  - **Unit (new):** each prefix belongs to one area; unknown areas and levels are dropped; view, edit and void decisions; shared lists; dashboard, journal and attachment rules; the admin is unlimited.
  - **HTTP (new):** View allows reading but not creating, and the message names the area; deleting without Void is 403; granting Void works at once; removed rights are gone at once; the journal list stays closed; the admin's rights cannot be set; the rights change is audited.
- `npm run test:e2e`: 42 passed. The sign-in test now sets rights in the checklist (Reports has no Edit option). The staff menu shows only Dashboard, Bookings, Invoices, Settlements, Customer balances and Settings. New booking shows, New bill and New invoice are hidden, Bills shows No access, and the company settings form is disabled.
- **Visual check on a throwaway server (port 4391, demo data):**
  - The staff menu and dashboard buttons follow the rights.
  - A booking detail page opens with Cancel booking hidden.
  - The admin Rights modal is shown.
- Schema change: `users.permissions` (additive). Restart needed.

### Office network mode and edit conflicts (step 3) — code commit `23b6b58`

- **Office network mode** (new `server/network.js`, admin card in Settings, `GET/PUT /api/admin/network`):
  - **Setting:** "Allow other computers" saves `settings.lan_enabled`, and "Extra names" (for example a Tailscale name) saves `settings.lan_hosts`. Both columns are added by migration. Changes are audited.
  - **Binding:** at startup, `server/index.js` listens on `0.0.0.0` when the setting is on and `127.0.0.1` otherwise. `HOST` still overrides both. So turning the setting on or off needs a restart, and the card says so.
  - **Links:** once running on the network, the card and the start-up log list the links to open on other computers: office IPv4 addresses, the computer's `.local` name, Tailscale addresses and added names.
  - The card also notes the firewall prompt, that office Wi-Fi traffic is not encrypted (Tailscale is), and that the main computer must stay awake.
- **Who may connect** (security audit lead 4):
  - **Client address:** a new first middleware refuses any address other than loopback. In office mode it also allows private LAN (10/8, 172.16/12, 192.168/16), Tailscale (100.64/10, fd7a:115c:a1e0::) and link-local. Internet addresses get 403, even if a router port is forwarded.
  - **Host names:** `hostGuard` and `apiGuard` take an `extra` check. In office mode, Host and Origin may also be an office IP, this computer's name or an added name. Any other name is still refused (DNS rebinding protection), and the Origin port must match.
- **Edit conflicts:**
  - `public/js/api.js` remembers the `updated_at` of every record it loads (lists and single records) for accounts, bills, bookings, cheques, compliance, customers, invoices, portals, suppliers and visas, and sends it as `X-Record-Version` on `PUT`.
  - A new check in `server/routes/index.js` answers 409 `record_changed` ("Someone else changed this record while you were editing…") when the record changed since then, so the edit form shows the message instead of overwriting.
  - Requests without the header (scripts) are not checked.
  - Customers, suppliers and accounts gain `updated_at`, which their edits now set; the others already had it.

Key files: `server/network.js` (new), `server/index.js`, `server/security.js`, `server/routes/{index,admin,customers,vendors,accounts}.js`, `server/migrations.js`, `public/js/api.js`, `public/js/views/{network,settings,audit-logs}.js` (`network.js` new), `public/css/styles.css`, `README.md`, `test/network.test.js` (new), `test/http-security.test.js`.

Verification:

- `npm run check`: 207 files OK.
- `npm test`: 213 passed.
  - **Unit (new):** which addresses count as office or Tailscale; added names are cleaned. While listening on this computer only, office names are refused. In office mode, office IPs, this computer's name and added names pass; evil names, public IPs and suffix tricks fail; an Origin from another port fails.
  - **HTTP (new):** a second save from an old copy of a booking gets 409 and the first save stays; a fresh copy and a request without a version both save; customers record their edit time and conflict too. The network setting is admin-only (a staff user with Company settings Edit gets 403), and office names are still refused until a restart.
- `npm run test:e2e`: 42 passed (Settings with the new card is axe-clean).
- **Visual check on a throwaway server:** the Office network card shows. A customer edit form saved after "another user" changed the customer shows the conflict message.
- **Not tested from a second computer:** that needs the user's own office network. The live server stays on this computer only until the admin turns the setting on and restarts.
- Schema change: `settings.lan_enabled`, `settings.lan_hosts`, `customers/vendors/accounts.updated_at` (all additive). Restart needed.

### Desktop app code (step 4, written but not built) — code commit `fc50020`

The user chose not to download Electron yet (about 160 MB) and to keep the desktop app's books in the app folder on the internal disk. So the code is written, but the app has not been run.

- **`desktop/main.js` (Electron):** the first run shows `desktop/setup.html`, with three choices.
  - **Start new books here:** the main computer runs `server/index.js` inside the app. It sets `LEDGERLY_DATA_DIR` to `~/Library/Application Support/Netfare/data` and `PORT` to 4173.
  - **Start from a backup (.db):** uses `scripts/restore.js` into the empty app data folder. It is refused if books already exist.
  - **Connect to the office computer:** cleans the typed address, checks `/api/health` answers "Netfare", then opens it.
  - The choice is saved in `desktop.json` (owner-only) in the app folder.
  - If the office computer does not answer at start-up, the setup screen returns with a message.
  - If the port is busy, an error dialog is shown.
  - **Menu:** Change setup… (clears the choice and relaunches; the books are kept), Show books folder, and Edit, View and Window menus.
- **Window security:**
  - contextIsolation, sandbox and no nodeIntegration.
  - Navigation stays on the Netfare origin; other http(s) links open in the normal browser.
  - The preload exposes only the three setup calls, and the main process accepts them only from the `file://` setup page, never from a Netfare page (local or office).
  - One app instance at a time; closing the window quits the app and stops the server.
- **`desktop/config.js`:** plain Node, tested. It holds the saved choice, office address cleaning (adds `http://` and port 4173, refuses other schemes and credentials) and the same-origin check.
- **`scripts/build-desktop.js` (`npm run desktop`, `npm run desktop:dist`):**
  - Copies the server, `public/`, the package files and the restore, backup and reset-admin scripts into `desktop/build/app-server`.
  - Runs `npm ci --omit=dev` there (a download).
  - Rebuilds `better-sqlite3` for the installed Electron with `@electron/rebuild`.
  - Then opens the app or runs electron-builder (`--mac dmg`). `desktop/package.json` holds the builder config: appId `com.shikragroup.netfare`, the server staged as `extraResources`, and the 512 px icon.
  - The project's own `node_modules` stay on system Node, so `npm start` and the tests are unaffected.
  - `desktop/build/` and `desktop/dist/` are git-ignored.
- **`server/index.js`:** exports `{ app, server, ready, shutdown }`. `ready` resolves once listening. A busy port now prints "Port 4173 is already in use. Is Netfare already running?" and exits 1, instead of a stack trace.
- **`scripts/check.js`:** also checks `desktop/`, skipping `node_modules`, `build` and `dist`.
- **Not done:** downloading Electron and electron-builder, running and building the app, signing and auto-update (step 5).
- **Session note:** a test command that would have started the server without a temporary data folder was blocked by the permission check. It was re-run against a temporary folder and a spare port.

Key files: `desktop/{main,preload,config,setup}.js`, `desktop/setup.html`, `desktop/package.json`, `scripts/build-desktop.js` (new), `scripts/check.js`, `server/index.js`, `package.json`, `.gitignore`, `README.md`, `test/desktop-config.test.js` (new).

Verification:

- `npm run check`: 213 files OK (now including `desktop/`).
- `npm test`: 217 passed. The new desktop config tests cover the data folder path, saving, reading and clearing the choice (owner-only file, a broken file asks again), office address cleaning, and the same-origin check.
- `npm run test:e2e`: 42 passed.
- The busy-port message was checked against a temporary data folder on spare port 4392.
- The setup screen was looked at in the browser pane (design only; the buttons need Electron).
- No schema change. No restart needed: the server behaves the same when started with `npm start`.

### Desktop app built and tested (step 4) — code commit `7fb4ec9`

The user approved downloading Electron and electron-builder, then approved upgrading better-sqlite3.

- **Versions:** Electron **44.9.0** (released 2026-10-17) and electron-builder **26.17.0** (2026-09-26) are pinned exactly in `desktop/package.json`; `desktop/package-lock.json` is added. Newer releases existed but were less than two weeks old.
- **npm cache:** `~/.npm` holds root-owned files, so `npm install` failed with EACCES. The fix (`sudo chown`) needs the user's password. The installs used a separate cache instead (`npm_config_cache=<scratchpad>/npm-cache`), and README notes this.
- **better-sqlite3 11.10.0 → 13.0.3 (whole project):**
  - **Why:** 11.10.0 failed to compile for Electron 44 (V8 API errors). A scratch test showed 13.0.3 compiles for Electron 42, 43 and 44.
  - **Why no rebuild:** 13.x ships Node-API prebuilds (`prebuilds/darwin-arm64.node`), which load in Electron without rebuilding. So `scripts/build-desktop.js` no longer rebuilds native modules; it copies the server and runs `npm ci --omit=dev` in `desktop/build/app-server`.
  - **Checks:** SQLite is now 3.53.4. All suites pass on it. The live server picks it up at its next restart.
- **Packaging fix:** electron-builder silently drops `node_modules` from an `extraResources` folder, even with a filter. The first packaged app failed with "Cannot find module 'express'". The staged `node_modules` now ship as a second `extraResources` entry (`build/app-server/node_modules` → `app-server/node_modules`).
- **Testing hook:** `NETFARE_USER_DATA` in `desktop/main.js` points the app folder elsewhere, so test runs never write to the real `~/Library/Application Support/Netfare`.
- **Built:** `desktop/dist/Netfare-1.0.0-arm64.dmg` (143 MB; the `.app` is 311 MB). It is unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`, to avoid keychain prompts), so macOS warns on first open. Signing is step 5. electron-builder also downloaded its icons and dmgbuild bundles. `desktop/dist` and `desktop/build` are git-ignored.

Verification (Playwright `_electron`, with test app folders and spare ports, never the live data):

- **From source** (`desktop/`, port 4393):
  - The setup screen opens, and "Start new books here" starts the server in the app.
  - The Netfare "Create the admin account" screen loads at `127.0.0.1:4393`.
  - `data/accounting.db` and `desktop.json {"mode":"main"}` are created in the test app folder.
  - Navigating to `https://example.com` leaves the window on Netfare.
  - Calling the setup bridge from a Netfare page returns "Not allowed".
  - A second start goes straight to the books.
- **Connect path** (a temporary server on port 4391 as the office computer):
  - `ftp://office` gives "Use an http:// address".
  - An address with nobody listening gives "No Netfare answered at http://127.0.0.1:4399…".
  - `127.0.0.1:4391` opens the office Netfare and saves `{"mode":"connect","office_url":"http://127.0.0.1:4391"}`.
- **Packaged `Netfare.app`** (port 4395): "Start new books here" runs the bundled server and creates the books.
- **Suites:** `npm run check` 213 files OK, `npm test` 217 passed, `npm run test:e2e` 42 passed.
  - **Flaky test:** the new sign-in browser test failed once out of four runs (`not ok 41`). The rerun output did not capture the failing step, so it is still to be hardened.
- **Not tested:** "Start from a backup (.db)" (it needs the native file dialog), and running on a second physical computer.

Key files: `desktop/package.json`, `desktop/package-lock.json` (new), `desktop/main.js`, `scripts/build-desktop.js`, `package.json`, `package-lock.json`, `README.md`.

(The live server was restarted on better-sqlite3 13.0.3 after this entry: the backup was verified, and the process loads `prebuilds/darwin-arm64.node`.)

### Update notice and one-click download (step 5) — code commit `78a3c2d`

The user has no Apple Developer account and will not get one. So the desktop app stays unsigned, and macOS asks "Open Anyway" once. An unsigned Mac app cannot replace itself (electron-updater and Squirrel need signing). The user chose "notification + one-click download" instead.

- **`server/services/updates.js`:**
  - **Feed:** reads `latest.json` (`version`, `released`, `notes[]`, `downloads{"mac-arm64":…}`, `page`) from the update address the admin sets. The address is stored in the new column `settings.update_feed`. It must be https, or http on this computer for testing.
  - **Checking:** at most once a day, cached in memory, with "Check now" to force it. It fetches with an 8-second timeout, no redirects and a 64 KB limit.
  - **Rules:** versions compare by number. Notes are trimmed and capped. Links must be https and others are dropped (a `javascript:` page link is never kept). The download picks the link for this platform, or falls back to the page.
  - **Errors** ("answered 404", "not valid JSON") show in the card, never as a crash.
- **API:** `GET /api/admin/updates` (with `?force=1`) and `PUT /api/admin/updates {feed_url}`. Both are admin-only.
- **App:** after the admin signs in, a banner shows when a newer version exists: "Netfare 1.1.0 is available. You have 1.0.0." with What's new, Download and Later.
  - Later hides that version in this browser.
  - What's new lists the notes and the three update steps (download, replace in Applications, Open Anyway). It says the books are not in the app and are backed up before an update.
  - In the desktop app, Download opens the normal browser.
- **Settings → Updates (admin):** the installed version, the status, the update address, Check now, and "How updating works".
- **One version source:** `package.json` `version` feeds `/api/health`, the JSON export, the About card (now `store.version`) and the update check. `scripts/build-desktop.js` copies it into `desktop/package.json`.
- **Releases:** `scripts/release-feed.js` (`npm run release:feed -- --download-base https://… --note "…" [--page https://…]`) writes `desktop/dist/latest.json` with the electron-builder `.dmg` name. README lists the release steps.
- **Hosting not chosen yet:** the project has no git remote and no website folder. Until the admin sets an update address, checking stays off.
- The dmg was rebuilt with this code: `desktop/dist/Netfare-1.0.0-arm64.dmg`, 143 MB, unsigned.

Key files: `server/services/updates.js` (new), `server/routes/{admin,index}.js`, `server/migrations.js`, `public/js/updates.js` (new), `public/js/views/updates-card.js` (new), `public/js/{app,store}.js`, `public/js/views/settings.js`, `public/css/styles.css`, `scripts/release-feed.js` (new), `scripts/build-desktop.js`, `package.json`, `README.md`, `test/updates.test.js` (new), `test/http-security.test.js`.

Verification:

- `npm run check`: 218 files OK.
- `npm test`: 223 passed.
  - **Unit (new):** numeric version order; feed cleaning (a bad key or an http link is dropped, a `javascript:` page is dropped, long notes are cut); address rules (http only on this computer, no credentials); status when off, available, cached for a day, up to date, invalid JSON and 404; the release script's feed is accepted by the parser and refuses http and missing notes.
  - **HTTP (new):** a real local `latest.json` (99.1.0) shows as available, with the download falling back to the page. A plain-http address on another host is refused. A staff user with Company settings Edit gets 403. `/api/health` reports the `package.json` version.
- `npm run test:e2e`: 42 passed.
- **Visual check on a throwaway server with a local feed (1.1.0):** the admin banner, What's new with the steps, Later hiding it across a reload, and the Updates card.
- Schema change: `settings.update_feed` (additive). Restart needed.

### Preparing to publish on GitHub — code commit `2b0f99d`

The user created a public, empty repository: https://github.com/ShikraDeveloper/Netfare (account id 254118030).

- **History check before publishing** (all 111 commits, read-only):
  - no `.db`, backup, `.env`, key, PDF or spreadsheet files were ever committed (`data/` was always git-ignored);
  - no API keys, tokens or private keys;
  - passwords appear only as test values; phone numbers are demo `555` numbers; demo emails use `@example`;
  - no personal paths and no "Shikra Travel FZE" in the docs.
  - **Will be public:** the commit author `Shikra-Travel <shikratravel@gmail.com>` on the 111 existing commits.
- **User's decisions:**
  - keep the history as it is, since rewriting it would break the commit hashes in this file;
  - future commits use the GitHub noreply email: `git config user.email 254118030+ShikraDeveloper@users.noreply.github.com`, set in this repository only;
  - MIT license.
- **LICENSE:** added (MIT, © 2026 ShikraGroup). README's License section and `"license": "MIT"` in both `package.json` files point to it.
- **GitHub CLI:** Homebrew has no bottle for macOS 27, so gh **2.102.0** (released 2026-09-30) was downloaded from github.com/cli/cli releases. Its SHA-256 matched the official checksums file, and the binary is signed (Team VEKTX9H2N7). It is installed at `~/.local/bin/gh`, which is on PATH.

### Published on GitHub (2026-11-02)

- **Login:** `gh auth login` as **ShikraDeveloper** (token stored in the keyring; scopes `repo`, `read:org`, `gist`; no `workflow` yet). The first try sat at gh's "Authenticate Git?" prompt, so the login ran again with `< /dev/null` to print the device code straight away.
- **Remote:** `origin` = `https://github.com/ShikraDeveloper/Netfare.git`. Global git settings are untouched: pushes run with `-c credential.https://github.com.helper='!~/.local/bin/gh auth git-credential'`.
- **First push:** GitHub had made one "Initial commit" (`f4b7163`, a two-line README, author `riskcontrol96@gmail.com`). With the user's OK it was replaced with `git push --force-with-lease=main:f4b7163`; the README content is already covered by ours.
- **Checked on GitHub:** public; "MIT License" detected; 113 commits, the same as local; no `data/`; `desktop/` holds only source (no `node_modules`, `build` or `dist`).

### Release builds on GitHub Actions (Qadam 4) — code commits `6996d63`, `a94ee37`

- **`.github/workflows/release.yml`:**
  - **Triggers:** a `v*` tag, or a manual run, which builds and tests only.
  - **Build matrix:** `macos-latest` builds arm64 and x64 `.dmg`; `windows-latest` builds the NSIS `.exe`.
  - **Steps:** `npm ci` (root with `--ignore-scripts`; `desktop/` with scripts, so Electron downloads itself). Unit tests run on the Mac runner. Then `scripts/build-desktop.js dist mac|win`, `scripts/smoke-desktop.js`, and upload of the installers.
  - **Release job** (tags only, `contents: write`): checks that the tag matches `package.json`, writes `latest.json` from the annotated tag's message lines (`scripts/release-feed.js --notes-from-tag`), and runs `gh release create` with the three installers, `latest.json` and install notes.
  - **Pinned actions:** checkout v7.0.1 (`3d3c42e…`), setup-node v7.1.0 (`949feb2…`), upload-artifact v7.0.2 (`cf430e0…`), download-artifact v8.0.2 (`9000827…`). Each is the newest release at least two weeks old.
  - Top-level permissions are `contents: read`, and steps run in `bash`.
- **Installer names never change:** `Netfare-mac-arm64.dmg`, `Netfare-mac-x64.dmg` and `Netfare-windows-x64.exe`, so `…/releases/latest/download/<file>` always points at the newest version.
  - The NSIS installer is per-user, with a choosable folder and a "Netfare" shortcut.
  - The Hide, Hide Others and Show All menu items exist only on a Mac.
- **`scripts/build-desktop.js`:** runs npm, Electron and electron-builder through node, so the same commands work on Windows; `dist` takes `mac` or `win`. The staged install uses `--ignore-scripts`: better-sqlite3 13 ships `win32-x64` and darwin prebuilds, and without the flag npm runs node-gyp, which needs Visual Studio on Windows.
- **`scripts/smoke-desktop.js` (new):** opens the packaged app (Mac or Windows) with a temporary app folder and port 4397, clicks "Start new books here", and checks `/api/health` and that `accounting.db` was created.
- **Update check:**
  - Netfare's GitHub releases are now the default address (`settings.update_feed` blank). `off` turns checking off, and Settings → Updates gained a "Check for new versions" switch.
  - Redirects are followed by hand, up to 5, https only; a 404 on the default address says "No Netfare release has been published yet".
  - `NETFARE_UPDATE_FEED` overrides the default; the test servers set it to `off`, so tests never reach the internet.
- **Workflow permission:** pushing workflow files needed the `workflow` scope (`gh auth refresh -s workflow`). The first device code was never authorized; the second (`79D1-1EC9`) worked.
- **Trial runs (manual):**
  - Run 41438222363 (`6996d63`): Mac passed. Windows built the `.exe`, but root `npm ci` had failed on node-gyp. PowerShell carried on, so the smoke test failed on a missing `playwright-core`. That led to `a94ee37`.
  - Run 41439053865 (`a94ee37`): **Success** on both. The artifacts were netfare-mac (276 MB) and netfare-win (125 MB), and the Windows smoke test passed.
  - During the runs `api.github.com` stopped resolving on this network for a few minutes while `github.com` worked. The result was read from the run page.
- **Local checks:**
  - `npm run check`: 219 files OK.
  - `npm test`: 224 passed.
  - `npm run test:e2e`: 42 passed.
  - Both Mac builds were made here, and the smoke test passed.
- **Not done yet:** publishing a real release (a tag), and a person opening the Windows app on a Windows PC.

### First public release: Netfare 1.0.0 (2026-11-02)

- **Tag:** with the user's OK, the annotated tag `v1.0.0` was made on `62a801a` with seven note lines (features), and pushed.
- **Release:** run 41439758691: Build (mac), Build (win) and Publish release all succeeded. https://github.com/ShikraDeveloper/Netfare/releases/tag/v1.0.0 holds:
  - `Netfare-mac-arm64.dmg` (142 MB);
  - `Netfare-mac-x64.dmg` (146 MB);
  - `Netfare-windows-x64.exe` (130 MB);
  - `latest.json`.
- **Checked after publishing:**
  - Each `https://github.com/ShikraDeveloper/Netfare/releases/latest/download/<file>` link redirects to `release-assets.githubusercontent.com` with HTTP 200.
  - `latest.json` holds version 1.0.0, the seven notes, versioned download links and the release page.
  - The app's own update check (`server/services/updates.js`, default address, temporary data folder) read it: latest 1.0.0, not newer than the installed 1.0.0, no error.
- **Not checked yet:** a person installing from the release on a Mac (Open Anyway) and on a Windows PC (SmartScreen → Run anyway).

### Website / landing page (Qadam 5) — code commits `e88b0e5`, `db43ff0`

- **`website/` (plain HTML, CSS and JS, no build step, 940 KB):**
  - **Hero:** an OS-aware Download button. Mac Apple Silicon or Intel comes from userAgentData architecture or the WebGL renderer; Windows and phones are handled too. It links to the stable `releases/latest/download/` files.
  - **Sections:** a strip of key facts, nine feature cards, real screenshots captured from demo data on a throwaway server (invoices, booking, DSR, rights; JPEG), For your team, How it works (diagram), Download (three cards, with "your computer" highlighted), and install steps for Mac (Open Anyway), Windows (SmartScreen) and the first start.
  - **What's new:** read live from `api.github.com/repos/ShikraDeveloper/Netfare/releases/latest`, as text only. If that fails, built-in text shows.
  - **FAQ** and footer.
  - **Look:** brand fonts (Bricolage Grotesque, Quicksand) and colours, light and dark, a phone layout, and a strict meta CSP (fetch only to api.github.com).
  - **Checks:** desktop and phone, light and dark — no horizontal scroll, no script errors, axe WCAG 2.1 AA clean. 16 light-mode contrast issues were fixed by darkening the text accent to `#1a6a9e`.
- **Hosting:** the user will host the page on their own website, not GitHub Pages.
  - So the Pages workflow from `e88b0e5` was removed in `db43ff0`.
  - `npm run website:zip` makes `netfare-website.zip` (751 KB, git-ignored).
  - README has the hosting checklist: keep the paths, use https, allow CSP `connect-src` for api.github.com, set `og:image` to a full address.
  - The zip was tested when served from a `/netfare/` sub-folder: no 404s, no errors, fonts load, the live version shows and the Download link is right.
- **Not pushed yet:** `e88b0e5` and `db43ff0` are local only. The user chose not to publish via Pages, so a push is asked separately.

(`e88b0e5`, `db43ff0` and `c3cf6ab` were pushed later with the user's OK.)

### Netfare installed on the user's Mac (2026-11-02)

- **Found:** the user was running the desktop app from the build folder `desktop/dist/mac/Netfare.app`. That is the **Intel** build, running under Rosetta, and the build folder is wiped by every `desktop:dist`.
  - Its books are at `~/Library/Application Support/Netfare/data`: Shikra Travel FZE, admin `jamal`, 1 customer, 2 suppliers, 2 visas, 2 invoices, 2 payments, 3 bills, 8 entries; integrity ok on a copy.
  - The desktop app was listening on 127.0.0.1:4173. The old `npm start` server (project `data/`, nearly empty) was not running, so these are now two separate sets of books. The user was advised to use only the desktop app.
- **Install (user's OK):**
  1. Quit the app gracefully (`osascript … quit`); the WAL files disappeared.
  2. Made the safety copy `backups/netfare-2026-11-02T17-19-16-000Z-pre-install.db` (integrity ok, 2 invoices, 8 entries).
  3. Downloaded the v1.0.0 `Netfare-mac-arm64.dmg` from GitHub; its SHA-256 matched the release digest.
  4. Copied it with `ditto` to `/Applications/Netfare.app` (arm64) and opened it: health ok, `setup_needed: false`, and the same `accounting.db` is open.

### Mac signing fix and release 1.0.1 — code commit `ed98285`, tag `v1.0.1`

- **Problem:** the installed v1.0.0 failed `codesign --verify` ("code has no resources but signature indicates they must be present"). Only Electron's linker signature on the main binary (identifier "Electron") was present, because `CSC_IDENTITY_AUTO_DISCOVERY=false` skipped bundle signing. A browser-downloaded (quarantined) copy is then reported as **damaged**, without Open Anyway.
- **Fix:** `desktop/package.json` sets `mac.identity: "-"` (electron-builder 26 ad-hoc signing) and `hardenedRuntime: false`, which electron-builder documents as needed for ad-hoc signing; otherwise library validation rejects Electron's frameworks.
- **Local checks:**
  - both builds pass `codesign --verify --deep --strict`, identifier `com.shikragroup.netfare`, Signature=adhoc;
  - the smoke test passed;
  - a quarantined copy gets `spctl` "rejected" (not notarized, so Open Anyway works); `syspolicy_check distribution` only warns "Adhoc Signed App".
- **Version 1.0.1:** set in `package.json`, `package-lock.json` and `desktop/package.json`; README explains the signing. `npm run check` 220 files OK, `npm test` 224 passed, `npm run test:e2e` 42 passed.
- **Release:** tag `v1.0.1` (two note lines), run 41491088053: Build (mac), Build (win) and Publish release all succeeded. The assets are arm64 dmg 141 MB, x64 dmg 148 MB, Windows exe 130 MB, and `latest.json`.
- **Checked from GitHub:** both released dmgs match their digests, contain version 1.0.1 (arm64 and x86_64), pass deep verify (ad-hoc, `com.shikragroup.netfare`), and a quarantined copy is "rejected", not damaged. `latest.json` reports 1.0.1, which the update check counts as newer than the installed 1.0.0.

(The changes.md record above was pushed later with the user's OK. On the user's Mac the 1.0.1 dmg was downloaded in Safari and installed. macOS showed "Apple could not verify Netfare" — not "damaged" — and Open Anyway worked. Netfare 1.0.1 runs from /Applications on the same books.)

### Created by on documents, staff in the DSR — code commit `95dd1e5`

- **Schema:** `created_by TEXT NOT NULL DEFAULT ''` (the signed-in user's full name) is added by migration to 21 tables: bookings, visa_applications, visa_groups, visa_deposits, invoices, payments, customer_advances, credit_notes, refunds, cancellations, bills, bill_payments, supplier_credit_notes, portal_topups, portal_refunds, portal_credits, cash_deposits, post_dated_cheques, card_settlements, petty_cash_counts and journal_entries.
- **Stamping:**
  - `postEntry` writes it for every posting. New `server/created-by.js` (`markCreated(db, table, id)`, limited to these tables) stamps the other 30 insert sites: 24 were found by script after `const X = Number(info.lastInsertRowid)`; 6 were done by hand in visa-deposits (3), advances, visas (groups) and cheques.
  - Records from before logins, and records made by scripts, stay blank. Sample data takes the name of the admin who loaded it.
  - It is a plain UPDATE after the insert, so `updated_at` (edit versions) is unchanged.
- **Pages:** booking, visa, invoice, bill, receipt, refund, credit note, cancellation and supplier credit subtitles end with "· by <name>" (`createdByText` in ui.js).
- **DSR:**
  - **Who made each sale:** each item has `staff` — the booking's or visa's creator, else the invoice's; for a cancellation, its own creator. "Not recorded" if blank.
  - **Display:** each ticket, visa, service and cancellation row shows "by <name>".
  - **Staff picker:** "Staff: All staff / names", shown when there are two or more names, and not printed. It sends `?staff=` and narrows sales and cancellations to that person. Money collected, refunds and money paid out stay for everyone, and the header shows the name.
  - **Sales by staff:** a table under the Summary (sales count, amount, gross profit with Show profit) always covers the whole period.
- **Tests:**
  - New `test/created-by.test.js`: every tracked table has the column; a signed-in posting carries the name while a script posting is blank; untracked tables are refused.
  - New HTTP test: a staff user's booking, its invoice and the invoice's journal entry carry her name, while the admin's booking carries the admin's; the DSR's staff totals and the staff filter are checked.
  - `npm run check` 222 files OK, `npm test` 227 passed, `npm run test:e2e` 42 passed.
- **Visual check on a throwaway server (demo data plus 3 bookings by two users):** the booking subtitle reads "… · Confirmed · by Omar Siddiqui"; the DSR shows the "by" lines, Sales by staff (Omar 2 · 4,400.00; Aisha 1 · -2,690.00 net of a demo cancellation), and the Omar filter (2 rows, name in the header). No errors.
- **Not yet in the desktop app:** the user runs the desktop app (1.0.1), so this reaches them only in a new release (1.0.2). Not pushed yet.

(`95dd1e5` and `03cfbd7` were pushed without a tag at the user's choice, so 1.0.1 is still the latest release.)

### Second copy of backups — code commit `20079cb`

Until now every backup sat on the same computer as the books.

- **`server/services/backup-mirror.js` (new):**
  - **Copying:** after every backup made by `createDatabaseBackup` (automatic, manual, Save locally, pre-demo/pre-reset), the file is copied to `<chosen folder>/Netfare backups/`. It is written as `*.copying`, then renamed and made owner-only. The newest 30 `netfare-*/ledgerly-*.db` there are kept.
  - **Missing folder** (unplugged USB, signed-out cloud app): the backup is still made, the error is saved in `settings.backup_mirror_error` and shown, and the 6-hourly auto-backup check copies the newest local backup once the folder is back. Download copies are not mirrored.
  - **Suggestions:** on a Mac, iCloud Drive, `~/Library/CloudStorage` (Google Drive "My Drive", OneDrive, Dropbox), `~/Dropbox`, and other volumes under `/Volumes` except the system disk. On Windows, OneDrive / Dropbox / Google Drive under the user folder, a Google Drive letter, and other drive letters.
  - **Rules:** the folder must be absolute, existing, writable (a test file is written and removed) and outside Netfare's own data folder.
- **Settings:** new columns `backup_mirror_dir`, `backup_mirror_at` and `backup_mirror_error`, added by migration. Scripts that open an older database without them are tolerated.
- **API (admin-only):** `GET`/`PUT /api/admin/backup-mirror` and `POST /api/admin/backup-mirror/copy`. Saving a folder makes a fresh backup and copies it at once. Changes are audited ("Backup copy" enable/disable).
- **Settings card "Second copy of backups":**
  - an amber warning while backups are only on this computer;
  - a picker (Not copied anywhere / the suggestions / Another folder… with a path field), Save and Copy now;
  - the status (where, last copy, how many kept, or the last error);
  - a note on how to restore from there (`npm run restore`, or "Start from a backup" in the desktop app).
- **Tests:**
  - New `test/backup-mirror.test.js`: folder rules; each backup is copied; only the newest 30 are kept (35 old files pruned); owner-only copy; with an unplugged folder the backup is still made and the error recorded; the copy catches up when the folder is back; nothing happens when the newest is already there; turning it off stops copying.
  - New HTTP test: staff get 403; a relative path gets 400; saving copies one backup at once; Copy now makes two; clearing turns it off.
  - `npm run check` 225 files OK, `npm test` 231 passed, `npm run test:e2e` 42 passed.
- **Visual check on a throwaway server:** on this Mac it suggests "iCloud Drive" and "Drive: Mac SSD". Nothing was saved to them. No errors.
- **Not in the desktop app yet:** it needs a release (1.0.2, with "Created by" and DSR staff). Not pushed yet.

## 2026-11-03

### Security audit run-2 (changed code since run-1)

A source-only audit of everything changed since run-1 (`54119c3..233c2c2`), using the Cloudflare security-audit skill. 38 agents ran; nothing was executed and no real data was touched.

- **Result:** 0 confirmed findings and 9 "needs validation" leads. 7 of the 9 run-1 leads are now fixed in source.
- **Reports** (outside the repo): `~/security-audit-skill/ledgerly/run-2/REPORT.md` and `NEEDS-VALIDATION.md`.
- **The 3 staff-rights leads are fixed below.** The other 6 each depend on one office fact, so they are left as leads:
  - login lockout used to keep the admin out;
  - plain http on the office LAN;
  - a backup file from someone else (table definitions are kept);
  - the session cookie reaching other ports on the same Mac;
  - a custom Windows install folder;
  - another user holding port 4173 on a shared PC.

### Staff-rights bypasses closed — code commit `db5a7d4`

Fixes the three audit leads that needed no special office setup. Each one let a staff user go beyond the rights the admin gave them.

- **`/VOID` in another case** (`server/permissions.js`): the void check was case-sensitive, but Express routes are not. So `POST /api/invoices/5/VOID` voided an invoice with only Edit rights. The check now ignores case.
- **Void under other names:** three actions undo or cancel records but did not need the void right. They now do:
  - `POST /visa-deposits/:id/void-last` (undo a deposit step);
  - `POST /visas/:id/reject` (the same cancellation as Cancel);
  - `POST /opening-balances` with no non-zero amounts, which reverses the posted entry the same way Clear does.

  Saving opening balances that have amounts, and deposit refunds, stay normal edits.
- **Encoded attachment id:** `GET /api/attachments/%35/download?entity_type=booking` skipped the lookup of the file's real area, because `req.path` is not decoded but the route's `:id` is. A staff user with bookings rights could open any file, passport scans included. An attachment id must now be plain digits, and the area always comes from the stored row.
- **UI** (`public/js/app.js`): staff without the void right no longer see these buttons:
  - the deposit "Void the latest step";
  - visa Reject;
  - opening-balance Clear.
- **Tests** (`test/permissions.test.js`): 3 new tests cover:
  - upper- and mixed-case void and cancel;
  - `void-last` and `reject`;
  - empty, zero and missing opening-balance saves;
  - encoded attachment ids on download and delete.
- **Checks:** `npm run check` 225 files OK, `npm test` 234 passed, `npm run test:e2e` 42 passed, all on a temporary data folder.
- **Not in the desktop app yet:** it needs release 1.0.2. Not pushed yet. (Both commits were pushed later with the user's OK.)

### Release 1.0.2 — code commit `c5cc202`, tag `v1.0.2`

- **Version:** 1.0.2 is set in `package.json`, the root of `package-lock.json`, and `desktop/package.json`. `npm run check` 225 files OK, and `npm test` 234 passed.
- **What it brings to the desktop app:**
  - "Created by" on documents;
  - staff in the DSR;
  - the second copy of backups;
  - the staff-rights fixes from audit run-2.
- **Release:** tag `v1.0.2` (three note lines), run 41618596717. Build (mac), Build (win) and Publish release all succeeded. The assets are:
  - arm64 dmg, 142 MB;
  - x64 dmg, 149 MB;
  - Windows exe, 131 MB;
  - `latest.json`.
- **Checked:** `releases/latest/download/latest.json` reports 1.0.2 with the three notes and the v1.0.2 download links. The 1.0.1 app on the user's Mac should now show the update banner to the admin.
- **Not checked:** the released dmgs were not downloaded and verified on this Mac this time.
- **On the user's Mac:** no banner appeared. The user updated to 1.0.2 through Settings → "Check for updates".

### Notification bell for updates — code commit `30c2301`

- **Why the banner did not appear:** the app checks once when it opens, and the server kept the answer (and any error) for 24 hours. An app that was already open before 1.0.2 was published kept saying "up to date".
- **Fix** (`server/services/updates.js`, `public/js/updates.js`):
  - the server goes to GitHub at most every 3 hours, and retries a failed check (no internet) after 15 minutes;
  - the open app asks again every hour.
- **Bell instead of the banner** (`public/index.html`, `public/js/updates.js`, `public/css/styles.css`, a `bell` icon in `ui.js`):
  - a bell in the top bar, top right, for the admin only;
  - a red dot shows while there is a version the admin has not seen. Opening the bell removes the dot (stored per browser);
  - the panel shows "Netfare X is available", the current version and the release date, with What's new and Download. With nothing new it shows "No new notifications";
  - on a phone the bell stays next to the page title.
- **Tests:**
  - `test/updates.test.js` adds: a release published while the app is open shows within 3 hours, and a failed check is retried after 15 minutes;
  - `npm run check` 225 files OK, `npm test` 235 passed, `npm run test:e2e` 42 passed.
- **Visual check:** a throwaway server (temp data, a local test feed reporting 9.9.9), on desktop, at phone width and in dark mode. The dot, the panel and What's new all worked. The light-only hover colour of icon buttons was fixed for the bell.
- **Not in the desktop app yet:** it needs release 1.0.3. Not pushed yet. (Pushed later with the user's OK.)

## 2026-11-04

### Lockout per computer, safer restores, staff settings — code commit `85b3785`

Three more leads from audit run-2. These ones don't depend on the office setup to be worth fixing.

- **Login lockout** (`server/services/auth.js`, `server/routes/auth.js`):
  - Old behaviour: 5 wrong passwords locked the account itself for 5 minutes. Anyone who could reach the sign-in page could keep the admin locked out with about one request a minute.
  - Now the count is kept per computer (the connection's address) and username. 5 wrong tries lock only that computer for that name. A computer that gets 20 wrong across any usernames is locked for 5 minutes as a whole.
  - The admin at the main computer, or at any other computer, still signs in.
  - Unknown and known usernames get the same answers. The counts are kept in memory, newest 5,000.
- **Restore** (`scripts/restore.js`, `server/services/auth.js`):
  - A backup whose `users` table makes new accounts admins by default is refused, with the message "backup has a changed users table (new users would become admins)".
  - `createUser` now sets `is_admin = 0`, `is_active = 1` and `must_change_password = 0` itself, instead of trusting table defaults.
  - Stored scrypt hashes above N 2^17, r 16 or p 4 are refused rather than computed, so a restored hash cannot stall sign-in.
- **Staff settings** (`server/routes/settings.js`): `GET` and `PUT /api/settings` leave these out for staff:
  - `backup_mirror_dir`, `backup_mirror_at`, `backup_mirror_error`;
  - `update_feed`;
  - `lan_enabled`, `lan_hosts`.

  The admin still gets everything. The client only reads them from admin endpoints.
- **Tests:**
  - `auth.test.js`:
    - a lock from one address does not stop another;
    - the lock ends after 5 minutes;
    - many usernames from one computer;
    - extreme hash costs are refused;
    - a table defaulting to admin still gives staff `is_admin = 0`.
  - `hardening.test.js`: restore refuses the changed users table.
  - `http-security.test.js`: staff do not see the admin-only settings.
  - `npm run check` 225 files OK, `npm test` 239 passed, `npm run test:e2e` 42 passed.
- **Audit leads still open:**
  - plain http on the office LAN (use Tailscale);
  - the session cookie reaching other ports when used in a browser;
  - a custom Windows install folder;
  - port squatting on a shared PC.

### Release 1.0.3 prepared — code commit `67b138e`, tag `v1.0.3` (local only)

- Version 1.0.3 is set in `package.json`, the root of `package-lock.json`, and `desktop/package.json`. `npm test` 239 passed.
- The annotated tag `v1.0.3` has three note lines (the bell; lockout per computer; restore and staff settings). Pushing the tag was held back: the user chose "Push only", so the commits are on GitHub but no release has been built. Pushing the tag starts the release.

### Website address — code commit `91736ee`

- The user's site address is **https://shikragroup.com/netfare/**.
- `website/index.html`:
  - the share preview now uses absolute addresses: `og:url`, `og:image` (with 1200×630 size), `link rel="canonical"`;
  - `twitter:card` is `summary_large_image`.
- The app's Settings → About card has a **Website** row linking to the site. In the desktop app it opens in the browser.
- The README hosting notes give the address.
- `npm run check` OK, `npm test` 239 passed. The About card was checked on a throwaway server. `netfare-website.zip` was rebuilt (19 files).
- **Not live yet:** on 2026-11-04 every path on shikragroup.com (including `/netfare`) served a parking page that redirects to `/lander`. The user still needs to upload the zip's contents into a `netfare` folder there.

### Bank charges on top-ups, top-ups on credit portals — code commit `aa5615c`

The user asked for bank charges on top-ups, and for top-ups on credit-account portals as well. They chose:
- on a credit portal, a top-up pays the oldest open bills first;
- bank charges are an optional field on each top-up.

- **Bank charges** (`server/services/portals/transactions.js`, migration `portal_topups.bank_charges_cents`):
  - the top-up form has the shared "Bank charges (optional)" field, which is hidden for Cash;
  - the portal gets the full amount, and the charges come out of the bank to 6700 Bank Charges in the same entry (Dr 1400 · Dr 6700 · Cr bank), so a void reverses both;
  - the wallet list shows "bank charges AED x".
- **Credit portals:**
  - `topUp` no longer refuses them. After posting the top-up, `payOpenBills` settles the supplier's received bills dated on or before the top-up date, oldest due first, through `settleBillFromPortal` (Dr 2000 · Cr 1400, a `Portal wallet` bill payment). Bills dated later wait.
  - Money left over stays as the portal balance (an advance). `autoSettleBill` now uses it for the next bills when a booking or visa is issued. With no advance it returns nothing, so there is no "portal has no balance" warning on credit.
  - Left-over money can be withdrawn. The Advances to Suppliers ledger check already counts every portal's balance.
  - Voiding a credit top-up that already paid bills says: delete those bill payments first, then void.
- **Credit portal page:**
  - a Top up button (in the header, for active portals);
  - a **Top-ups** card with Withdraw when money is left;
  - "· AED x advance" under Balance due;
  - the form subtitle shows the balance due, and after saving the toast says how many bills were paid.
- **Tests:**
  - new `test/portal-topups.test.js`:
    - charges and their void;
    - oldest-first payment across two top-ups;
    - the advance paying a later bill;
    - no warning on credit;
    - withdrawing the left-over;
  - the old test that expected credit portals to refuse top-ups was updated to the new rule;
  - `npm run check` 226 files OK, `npm test` 243 passed, `npm run test:e2e` 42 passed.
- **Visual check:** on a throwaway server, a credit portal with bills of 4,000 + 6,000 + 2,000 and a 9,000 top-up with 25 charges. Two bills were paid and the toast said "paid 2 bills". Balance due went to 3,000 and credit available to 47,000. The entry was 1400 Dr 9,000 / bank Cr 9,000 / 6700 Dr 25 / bank Cr 25.
- **Release note:** the local tag `v1.0.3` points at `67b138e`, before this change. Before releasing, move the tag to the latest commit (`git tag -f -a v1.0.3 …`) so 1.0.3 includes it.

### Next session

1. Start from the latest `main`. The tags `v1.0.0`, `v1.0.1` and `v1.0.2` exist. The user's Mac runs the 1.0.2 desktop app; its books are in `~/Library/Application Support/Netfare/data`. Never touch that folder in tests: use `NETFARE_USER_DATA` and `LEDGERLY_DATA_DIR` pointing at temp folders.
2. The user's Mac runs 1.0.2. Release 1.0.3 brings the notification bell; after that, the next release is the first real test of the bell.
3. **Release 1.0.3:** when the user asks, first move the local tag `v1.0.3` to the latest commit so it includes the top-up changes, then push it.
4. **Website:** the user uploads `netfare-website.zip` into `shikragroup.com/netfare/` (the domain currently shows a parking page). Then check the page, the download buttons and the share preview.
5. **Still open:**
   - the 4 remaining audit leads (see `NEEDS-VALIDATION.md` in run-2; login lockout and restore are fixed);
   - testing the installers by hand on Mac and Windows;
   - the flaky sign-in browser test;
   - testing "Start from a backup" in the desktop app by hand.
6. Use a disposable database for review; never modify live data. Append the next change under a new date heading before committing.
