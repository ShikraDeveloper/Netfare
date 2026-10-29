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

### Next session

1. Start from the latest `main`; the latest code commit is `01d8088` (bank debits need no supplier).
2. Read this entry and run the full check suite.
3. Use a disposable database for review; never modify live `data/accounting.db`.
4. Append the next change under a new date heading before committing.
