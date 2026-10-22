# Ledgerly

Ledgerly is a local-first invoicing and double-entry accounting app built for a **non-IATA travel agency** (Dubai / UAE, currency **AED**). It runs entirely on your machine — no cloud account, no external services, no telemetry. Data lives in a single SQLite file under `data/`.

## Features

- **Travel bookings** — every booking is a job with a customer, sale items (what the traveller pays), supplier cost items (what the airline/hotel/visa supplier charges you), and live profit margin. Confirming a booking automatically creates the customer invoice and the supplier bills and posts them to the ledger.
- **Visa applications** — a dedicated visa workflow beside bookings: applicant and passport details, destination, embassy reference, sale/cost lines and live margin. Submitting posts the customer invoice and supplier bills; approve and issue milestones track the application, while rejection or cancellation reverses the documents.
- **Supplier portals & wallets** — track the money you hold with airline logins, IATA agencies, consolidators and GDS accounts. Top up a prepaid portal, spend it on bookings, or run a supplier on credit; every movement is posted to the ledger. Prepaid wallets reconcile against the supplier's own statement, while credit accounts show a full bills, payments and supplier-refund ledger and statement.
- **Booking lifecycle** — `draft → confirmed → travelled`, plus a cancellation workflow that reverses the sale, keeps every receipt and supplier payment, and records any cancellation charge, refund or credit.
- **Customer advances** — take a deposit before the trip, hold it as a liability, then apply it to the invoice or refund it (ideal for cancellations).
- **Invoicing & billing** — customers, invoices, line items, printable PDF-style documents, send/post, void, and payments.
- **Refunds** — refund a customer payment, a cancellation balance, an advance, or a supplier credit. Refunds keep the original payment intact, post their own journal entry, track the remaining refundable amount, and can be voided without deleting history.
- **Void & audit trail** — every void asks for remarks, reverses the document and its linked payments, refunds, credits or journal entry, and keeps the original in history. A searchable **Audit log** under **System** records each void with its entity, amount, remarks, action and timestamp.
- **Credit notes & customer credits** — issue a credit note against a revenue account, post it to **2450 Customer Credits**, then apply it to one or more open invoices. Credit applications reduce the invoice balance without pretending cash was received, can be reversed, and are included on customer statements and A/R aging. A cancellation refund can also be converted into customer credit.
- **Supplier credit notes** — record a credit from a supplier standalone or against a bill, optionally linked to a booking, visa or cancellation. Apply it to any open bill for the same supplier, refund the unused balance in cash, or move a prepaid-portal credit into the portal wallet. **1450 Supplier Credits** always equals the total unused supplier credit.
- **Opening balances** — a guided balance-sheet page creates one balanced opening journal entry. Enter each account as a debit or credit; the difference posts automatically to **3900 Opening Balance Equity**. Replacing or clearing balances posts a reversal, so reconciled lines and audit history are never deleted.
- **Bank reconciliation** — reconcile any active cash or bank account against a statement closing balance. Tick cleared transactions, see the cleared balance and difference, keep a reconciliation history, and reopen the latest reconciliation when a correction is needed.
- **Customer & vendor statements** — printable statements with opening balance, invoices or bills, payments, refunds, applied credits and a running balance. Filter by period and print directly from the browser.
- **Expenses & bills** — vendors (consolidators, hotels, visa agents, DMCs), bills with expense/asset coding, receive/post, void, and bill payments. Bill payments can be recorded by **cheque** with cheque number, cheque date and bank; compliance items carry a default payment method so office rent can open directly as a cheque payment.
- **Compliance engine** — recurring overheads such as office rent, utilities, salaries and insurance can generate draft bills on schedule, while corporate tax, trade licence, lease, insurance and visa-quota deadlines sit in the same calendar with reminders and activity history.
- **Post-dated cheques** — schedule a batch of 12 monthly cheques (or any 1–60 cheques) from a recurring compliance item. Track cheque number, date, amount, bank and status; recording the matching cheque payment on the bill automatically marks the register cheque **Cleared**.
- **Banking & cash deposits** — at the end of the day, move cash sales from **1000 Cash** into a bank account with a dedicated deposit entry. The deposit posts Dr Bank / Cr Cash, tracks the slip reference and can be voided without deleting history.
- **Date filters & pagination** — bookings, visas, invoices, bills, refunds, credit notes, journal entries and cheques can be narrowed to a date range, with filtered totals and a one-click reset. The main list views — including customers, vendors, portals, bookings, visas, cheques and compliance — paginate in the browser with a selectable page size.
- **Grouped navigation** — Travel, Sales, Purchases, Treasury, Compliance and Accounting are separated in the sidebar so the daily workflow stays short and predictable.
- **Accessibility** — skip link, keyboard focus rings, keyboard-openable table rows, modal focus trapping/restore, labelled dialogs and busy-state announcements are built in. Every data table has a screen-reader caption and scoped column headers, and the browser suite runs an axe WCAG 2.1 AA audit across the main pages in both light and dark themes.
- **Attachments** — attach PDFs, images, spreadsheets, Word files or text documents to invoices, bills, bookings and visas. Files are stored in the local SQLite database, so full database backups include them.
- **Double-entry ledger** — every document posts balanced journal entries automatically. A general journal supports manual accruals and adjustments.
- **Financial reports** — dashboard with charts, income statement, balance sheet, trial balance, daily sales (DSR), booking and visa margin, and A/R / A/P aging.
- **Light & dark themes** — a warm cream/navy/gold look by default, with a one-click dark mode under **Settings → Appearance**. The choice is remembered per browser; printing always uses light paper.
- **Local by design** — Express API + SQLite + a small vanilla-JS single-page app. Chart.js is bundled locally in `public/vendor/`.
- **Backup** — download a complete SQLite database, or export table data as JSON from `GET /api/admin/backup`.

## Requirements

- Node.js 20 or newer (required by the browser test runner; the app itself also runs on Node 18)
- npm

## Setup

```bash
npm install
npm start
```

Then open **http://127.0.0.1:4173**.

Run the automated checks with:

```bash
npm test          # backend/API tests
npm run test:e2e  # browser end-to-end and accessibility tests
npm run test:all  # both suites
npm run check     # syntax-check every JavaScript file
```

`npm run check` syntax-checks every server, browser and script JavaScript file without starting the app.

The browser suite uses the locally installed Google Chrome (override with `CHROME_PATH` if needed) and `playwright-core`, so it does not download another browser. It starts a temporary server with its own throwaway SQLite data directory, loads the demo agency, seeds extra pagination fixtures, and then verifies navigation, keyboard row opening, table captions/scopes, pagination and filter resets, modal focus trapping, theme persistence and light-only printing. It finishes with an axe-core WCAG 2.1 AA audit of the main list, detail, treasury, compliance and report pages in both light and dark themes, including colour contrast.

For development with auto-reload:

```bash
npm run dev
```

## Theme & appearance

Ledgerly ships with a warm cream, navy and gold look inspired by UAE travel brands, and a matching dark mode. Open **Settings → Appearance** and pick **Light** or **Dark**; the change applies immediately and is saved per browser/device, so a laptop can stay light while a phone stays dark.

- **Default** is light. Dark mode swaps the cream paper for a deep navy and keeps the gold accents, including on charts.
- **Per device** — the preference is stored in the browser (`localStorage`, key `ledgerly.theme`), not in the ledger. Other windows/tabs update live.
- **No flash** — the saved theme is applied before the first paint, so a dark-mode reload never flashes light.
- **Printing stays light** — invoices, statements and reports always print on white paper, whatever theme the screen is using. Use **Print / Save as PDF** and the browser's *Save as PDF* option for a copy.

The theme is a thin layer (`public/css/theme.css`) over the base stylesheet: it overrides colours, typography (Bricolage Grotesque headings, Quicksand body) and component polish without changing layout. `public/js/theme.js` owns reading, applying and syncing the choice.

## Demo data

The first run creates an empty ledger with a default chart of accounts and travel-agency settings.

To load a fully populated demo agency (**Skyline Travels**, Dubai) — customers, suppliers, supplier portals with topped-up wallets, eight bookings across every status, six visa applications across the visa lifecycle, customer advances, payments, supplier bills, and posted journal entries:

```bash
curl -X POST http://127.0.0.1:4173/api/admin/demo \
  -H 'Content-Type: application/json' \
  -d '{}'
```

To erase everything and start clean (this signs out all data):

```bash
curl -X POST http://127.0.0.1:4173/api/admin/reset \
  -H 'Content-Type: application/json' \
  -d '{"confirm":"RESET"}'
```

The reset keeps your chart of accounts and settings and clears customers, vendors, bookings, visa applications, supplier portals, invoices, bills, payments, advances, and all journal entries.

## Travel-agency workflow

1. **Create a customer** (the traveller or corporate account).
2. **Set up your portals** under **Portals & wallets** — one per airline login or IATA agency. Link each to the supplier you bill, and top up the prepaid ones. See [Supplier portals & wallets](#supplier-portals--wallets).
3. **Create a booking** under **Bookings** — add sale items (ticket, hotel, package, visa) and cost items (each with the supplier who is charging you). The editor shows the live margin as you type.
4. **Confirm the booking** — this posts the customer invoice (status `sent`) and one supplier bill per vendor (status `received`) in a single step, keeping the ledger balanced. Bills for suppliers linked to a prepaid portal are settled from that wallet automatically.
5. **Collect payment** on the invoice, or **record a customer advance** first and **apply** it to the invoice later.
6. **Pay suppliers** from the linked bills, from a portal wallet, or from the bank.
7. **Mark the booking travelled** when the trip is done, or **cancel** it to reverse everything.

### Booking fields

| Field | Purpose |
| --- | --- |
| Booking number | Auto-generated as `BK-YYYY-####` |
| Customer | Traveller / account being invoiced |
| Booking date / due date | Drives invoice dates and payment terms |
| Travel date / return date | Trip dates |
| Destination | Free text, e.g. `London, United Kingdom` |
| PNR / ticket | Airline record locator |
| Notes | Free text shown on the booking |

### Visa applications

Visas live in their own **Visas** section (Travel group) because they carry applicant and passport details and have a different lifecycle from a flight.

| Field | Purpose |
| --- | --- |
| Visa number | Auto-generated as `VIS-YYYY-####` (prefix configurable in Settings) |
| Customer | The traveller or corporate account being invoiced |
| Applicant name | The person on the application; defaults to the customer name |
| Nationality / passport no. / expiry / date of birth | Applicant details recorded with the application |
| Application date / travel date | Application date drives invoice dates; travel date is the planned trip |
| Visa type | Tourist, visit/family, business, transit, student, work, other |
| Destination country | e.g. `Saudi Arabia`, `France (Schengen)` |
| Embassy / application reference | The reference on the embassy or visa-centre receipt |
| Sale items | Visa fee and service charge, coded to revenue (defaults to **4320 Visa & Documentation Revenue**) |
| Cost items | Embassy, typing-centre and agent fees, each with a supplier (defaults to **5120 Visa & Supplier Cost**) |
| Notes | Document checklist, appointment time, internal remarks |

The lifecycle is **draft → submitted → approved → issued**, with **rejected** and **cancelled** as terminal states:

| Action | Effect |
| --- | --- |
| Submit & post | Creates the customer invoice and one supplier bill per vendor, exactly like confirming a booking. Prepaid portals settle their bill automatically; credit accounts stay payable. |
| Mark approved | Records that the visa was approved. No extra posting. |
| Mark issued | Records that the visa was issued/collected. No extra posting. |
| Reject | Reverses the invoice and supplier bills (available while submitted or approved). If the embassy keeps its fee, record it as an expense. |
| Cancel | Reverses the invoice and supplier bills for a customer cancellation, including payments and applied advances. |

Draft applications can be edited or deleted; once submitted they are part of the ledger and can only be rejected or cancelled. The detail page shows the invoice, supplier bills, customer advances and payments side by side, and prints as a clean A4 application summary. Advances recorded on a visa are linked to that application, held in **2400 Customer Advances**, and can be applied to its invoice or refunded in the same way as booking advances. **Reports → Visa margin** lists every application in a period with its sale, cost and margin; rejected and cancelled applications are excluded.

### Supplier portals & wallets

Most airlines and IATA agencies work on a **deposit**: you top up a balance in their portal first, then issue tickets and services against it. Ledgerly models each portal as its own account so you always know how much money is sitting with each supplier.

Create portals under **Portals & wallets** (Travel group). Each portal has:

| Field | Purpose |
| --- | --- |
| Name | e.g. `Emirates Trade`, `Amadeus via XYZ` |
| Type | Airline / BSP, IATA agency, consolidator, GDS, other |
| How you settle | **Prepaid wallet** (top up first) or **Credit account** (book now, pay later) |
| Linked supplier | The vendor whose bills this portal pays. For prepaid portals, confirming a booking then settles that supplier's bill from the wallet automatically. |
| Credit limit | Optional cap for credit accounts |
| Login / URL reference | Portal URL and username for your own reference — **never store passwords here** |

Prepaid portals use the wallet actions below. Credit accounts do not hold a deposit wallet; their bills stay in **Accounts Payable** until you pay them from **Bills & expenses**.

| Action | Effect |
| --- | --- |
| Top up | Dr Supplier Advances · Cr bank/cash — money becomes an asset, not an expense |
| Spend on a booking | On confirmation the supplier's bill is created and settled from the wallet: Dr Accounts Payable · Cr Supplier Advances |
| Settle an existing bill | Same posting, run manually from the portal or the bill |
| Withdraw / refund | Dr bank/cash · Cr Supplier Advances (limited to the available balance) |

A **prepaid** portal balance is always derived — top-ups minus withdrawals minus what bills have consumed — so it can never drift out of step with the ledger. Deleting a portal payment (or cancelling a booking with a portal-paid bill) returns the money to the wallet automatically. If a wallet runs short, the bill is settled up to the available balance and the remainder stays payable, with a warning shown after confirmation.

A **prepaid** portal has a printable **wallet statement**. Choose a period (or use *This month*, *This year*, *All time*) and the statement shows an opening balance, each top-up, withdrawal and settlement with a running balance, totals in and out, and a closing balance. **Print / PDF** opens the browser print dialog with a clean A4 layout — use *Save as PDF* there to keep a copy. The period only affects the statement; the management cards below always show the full history.

A **credit account** portal uses a **supplier account statement** instead. It shows the opening payable, every posted supplier bill and supplier refund (*Billed / refunded*) and payment (*Paid*) with a running payable balance, totals billed/refunded and paid, and the closing payable. Supplier refunds increase the payable because they return cash to you while the bill remains due. It covers the linked supplier's bills, payments and refunds — there is no deposit wallet to report.

Each portal also has a **supplier ledger** (**Ledger** on the portal page). For a prepaid portal it lists every wallet movement — top-ups, withdrawals and bill settlements — with debit and credit columns, a running balance, and opening/closing totals for any period. A reconciliation card compares the total of all portal balances with account **1400 Supplier Advances**; a difference means something was posted to that account outside a portal. For a credit account it lists the supplier's bills, payments and supplier refunds against **2000 Accounts Payable**, with the running balance being the amount owed. Open a row to see the double-entry lines that were posted for it (for example *Dr Accounts Payable · Cr Supplier Advances* for a wallet settlement, or *Dr Hotel & Tour Cost · Cr Accounts Payable* for a bill). The ledger prints with the journal lines expanded.

Use **Reconcile** on a prepaid portal to check your books against the statement the supplier portal exports. Paste or load the file (CSV, TSV or rows copied from the portal), pick the date and amount columns, and compare. Ledgerly matches each statement line to a top-up, withdrawal or bill settlement by direction and amount within a configurable date window, preferring a matching reference. The result shows:

- **Matched lines** — with the statement date, your date and the day gap.
- **On the statement, missing in Ledgerly** — with a *Record top-up*, *Settle bill* or *Withdraw* shortcut that opens the normal form already filled with that line's date, amount and reference.
- **In Ledgerly, not on the statement** — movements to double-check on the portal.
- **Balance check** — if the file has a running balance column, the statement's opening and closing balances are compared with yours.

Nothing is written to the ledger by the comparison; it only reports differences until you record the missing items.

The **Portal wallets** report (and the dashboard card) show topped-up, used, balance and supplier payable for every portal.

### Customer advances

An advance is money received before the trip is settled. It is held in the **2400 Customer Advances** liability account and never touches revenue until it is applied.

| Action | Effect |
| --- | --- |
| Record advance | Dr deposit (bank/cash) · Cr Customer Advances |
| Apply to invoice | Dr Customer Advances · Cr Accounts Receivable, and the invoice balance drops |
| Refund advance | Dr Customer Advances · Cr deposit (bank/cash), and a voidable refund document is created |

### Payment refunds

Use **Refunds** (or the refund action beside a payment on an invoice or bill) to send money back to a customer or record money returned by a supplier, in full or in part. Refunds keep the original payment row and post their own journal entry. Cancellation refunds and advance refunds are linked to their own source document, so the remaining balance and void action stay accurate.

| Action | Effect |
| --- | --- |
| Refund a customer payment | Dr Accounts Receivable · Cr Bank/Cash account, and the invoice balance increases |
| Record a supplier refund | Dr Bank/Cash account · Cr **1450 Supplier Credits**, and a supplier credit note is created; the bill stays paid |
| Refund a cancellation balance | Dr **2500 Refund Payable** · Cr Bank/Cash account |
| Convert a cancellation balance to credit | Dr **2500 Refund Payable** · Cr **2450 Customer Credits** |
| Refund an unused supplier credit | Dr **1450 Supplier Credits** · Cr Bank/Cash account |
| Void a refund | Reverses the refund entry and restores the relevant invoice, bill, advance, cancellation or supplier-credit balance |

- Refund numbers use **REF-YYYY-####**.
- The engine refuses refunds larger than the source's remaining refundable amount. Voiding an invoice, bill, credit note, supplier credit or advance reverses its linked payments, refunds and credit applications first, so a document with activity can still be voided as one operation. A payment with an active refund still requires the refund to be voided first. A void is rejected if a linked portal movement can no longer be reversed safely (for example, a top-up that has already been spent).
- A customer payment funded by an advance must be refunded through **Advances**, not the payment refund engine. A bill payment made from a supplier wallet must be restored through the portal.
- Customer and supplier refunds have their own list and printable voucher under **Accounting → Refunds**.
- Supplier credits, not Accounts Payable, are used for money returned by a supplier. **1450 Supplier Credits** must equal the total unused supplier credit on the supplier-credit list.
- **2500 Refund Payable** must equal the total unpaid cancellation refund. The reconciliation report checks both balances.

### Refunds & cancellations

Cancelling a booking or visa does **not** delete the invoice, a bill, a payment or a receipt. Ledgerly records a cancellation document and posts every cancellation entry on the cancellation date you choose:

1. Any applied customer credit notes are reversed back to their notes.
2. The sent invoice is voided with a reversing entry, while its receipts stay intact.
3. Money actually received (cash/bank payments less active refunds, plus applied advances) is moved from Accounts Receivable to **2500 Refund Payable**.
4. Cancellation charges are recognised in **4330 Cancellation Charges Income**. If the charges are more than the amount held, a cancellation invoice is issued for the shortfall.
5. Supplier bills are retained at their original cost unless you enter a per-bill creditable amount. A supplier credit note is created for that amount and automatically applied to the bill's unpaid balance first; any remainder stays open in **1450 Supplier Credits**. A prepaid-portal credit is added to the portal wallet.

The cancellation screen shows the resulting customer refund, cancellation income and retained supplier cost. The remaining refund can be paid later from **2500 Refund Payable**, converted to customer credit, or left open. Unapplied customer advances stay in **2400 Customer Advances**. A printable cancellation note is available from the booking or visa.

A recorded cancellation **cannot be undone**. There is no undo button: the cancellation note, voided customer invoice and linked refunds or credits remain in the audit trail. If a cancellation was recorded by mistake, do not edit the database directly. Review the cancellation note and any refunds or credits it created; unused credits can be voided, and a refund can be voided only if the money has been recovered. Then create a new booking or invoice for the reinstated trip and ask your accountant to review adjusting entries.

### Compliance engine

**Accounting → Compliance** combines recurring overheads and a UAE compliance calendar.

- **Recurring bills** — office rent, utilities, salaries, internet, software, insurance, trade-licence instalments and similar costs. Set the vendor, expense account, amount, frequency, next due date and optional end date.
- **Variable amounts** — for Etihad WE, DEWA, phone or other bills that change every month, tick **Amount varies each period**. The stored amount becomes an estimate, auto-draft is disabled, and **Create bill** opens a form where you enter the actual amount, bill date and due date for that period.
- **Filings & renewals** — corporate tax, payroll, trade licence, lease, insurance, vehicle registration and visa quota. Set the frequency and reminder window; amounts are optional estimates.
- **Auto-create draft bills** — for fixed recurring costs only. When enabled, pressing **Run due bills** on Compliance (or `POST /compliance/run-due`) creates draft bills for every missed period up to today. Opening the list never writes data. Monthly schedules stay on the original anchor day (31 January → 28/29 February → 31 March). The draft bill is not posted to the ledger until you review it and receive it under **Bills**.
- **Payment method** — set a default method on each recurring item. Office rent can default to **Cheque**; the generated bill’s payment form then opens with Cheque selected and asks for cheque number, cheque date and bank. Cheque payments post through the normal Dr Accounts Payable / Cr Bank entry.
- **Reminders** — each item has a reminder window in days. The page shows overdue, due soon and active counts; the dashboard shows a compliance alert when something needs attention.
- **Actions** — create a draft bill, mark a filing/renewal complete, skip one period, pause/resume, edit or delete. Completing or skipping advances the next due date automatically; month-end dates stay at month-end.
- **Activity log** — each item records creation, edits, generated bills, completions and skips.
- **Post-dated cheque register** — from **Accounting → Cheques**, create a batch of up to 60 cheques for an active recurring bill. The batch increments cheque numbers, preserves month-end dates and tracks `planned → issued → cleared` (or `bounced`/`cancelled`). The register is not posted to the ledger; recording the cheque payment on the bill posts the entry and auto-matches the cheque by vendor, number and amount.

### Banking & cash deposits

**Accounting → Banking** is the end-of-day cash workflow.

- Shows **Cash in hand** (account 1000), total **Bank balance**, deposits this month and the last deposit.
- **New cash deposit** defaults the amount to the full cash balance; adjust it if you keep a float.
- Choose the cash account and destination bank account, add the deposit-slip reference and notes.
- Posting: **Dr Bank account / Cr Cash 1000**. This is a transfer, not revenue or an expense, so profit does not change.
- A deposit cannot exceed the available cash balance.
- **Void** posts a reversing entry and restores both balances; the deposit remains in history as `void`.
- The dashboard **Cash on hand** card links directly to the deposit form when cash is available.

### List date filters

The main list toolbars include a date range: **Bookings** (booking date), **Visas** (application date), **Invoices** (issue date), **Bills** (bill date), **Refunds** (refund date) and **General journal** (entry date). Choose the dates, then press the **search icon** button to apply the range; the list and its totals update. If the start date is after the end date, the two are swapped automatically. The clear button resets the range and restores the full list.

### Daily sales report (DSR)

**Reports → Daily sales** is a day-by-day sales register for any period. Every sent invoice is listed under the day it was issued, with the customer, the booking or visa it came from, the sale amount, supplier cost, margin, amount paid and balance. Each day gets a subtotal and the report ends with a grand total and a six-tile summary: **Sales**, **Cost**, **Margin** (with margin percentage), **Paid**, **Outstanding** and **Cash in hand** (with the bank balance).

- Only **sent** invoices count; draft and void documents are excluded.
- Cost is read from the linked booking or visa. Direct invoices have no linked cost, so their full value shows as margin — the note at the bottom of the report makes this clear.
- Each day header shows the closing **Cash in hand** and **Bank** balance. Cash uses account **1000 Cash**; bank uses **1010 Bank Account**. The summary tile shows the position at the report's end date.
- *Paid* and *Balance* are current as of today; the report groups sales by invoice date.
- **Today** switches the period to the current date; **Print** produces a clean A4 copy with day subtotals.
- Invoice numbers link to the invoice, and the reference under each number links to the booking or visa.

## Accounting model

Ledgerly uses double-entry bookkeeping. Monetary values are stored as integer cents.

### Chart of accounts

The default chart includes these system accounts, which the posting engine depends on:

| Code | Account | Type |
| --- | --- | --- |
| 1100 | Accounts Receivable | asset (receivable) |
| 1400 | Supplier Advances | asset |
| 1450 | Supplier Credits | asset |
| 2000 | Accounts Payable | liability (payable) |
| 2400 | Customer Advances | liability |
| 2450 | Customer Credits | liability |
| 2500 | Refund Payable | liability |
| 3100 | Retained Earnings | equity |
| 3900 | Opening Balance Equity | equity |
| 4300 | Service Charges & Markup | revenue |
| 4330 | Cancellation Charges Income | revenue |

Travel-specific defaults also include revenue accounts **4000 Ticket Sales**, **4100 Tour & Package Sales**, **4310 Commission Income**, **4320 Visa & Documentation Revenue**, and cost accounts **5000 Air Ticket Cost**, **5100 Hotel & Tour Cost**, **5120 Visa & Supplier Cost**.

You can rename accounts and add your own under **Chart of accounts**. System accounts must keep their code; their display names can be customised. Don't archive them or posting will fail with a clear error. Manual journal entries cannot post to control accounts **1100, 1400, 1450, 2000, 2400, 2450 or 2500**; use the related invoice, bill, refund, advance, credit or cancellation screen. Opening balances remain exempt. Payment and deposit pickers accept only active **cash/bank** accounts. Bill, booking and visa cost lines accept expense accounts plus valid non-cash assets such as Prepaid Expenses and Equipment; they cannot be coded to cash, receivables, payables or system accounts.

### Automatic postings

| Event | Debit | Credit |
| --- | --- | --- |
| Send an invoice | Accounts Receivable | Revenue accounts |
| Receive a customer payment | Bank/Cash account | Accounts Receivable |
| Receive a bill | Expense/asset accounts | Accounts Payable |
| Pay a bill | Accounts Payable | Bank/Cash account |
| Confirm a booking | Posts the customer invoice and each supplier bill | (as above) |
| Submit a visa application | Posts the customer invoice and each supplier bill | (as above) |
| Record a customer advance | Bank/Cash account | Customer Advances |
| Apply an advance to an invoice | Customer Advances | Accounts Receivable |
| Refund an advance | Customer Advances | Bank/Cash account |
| Refund a customer payment | Accounts Receivable | Bank/Cash account |
| Issue a customer credit note | Revenue account | Customer Credits |
| Apply a customer credit to an invoice | Customer Credits | Accounts Receivable |
| Record a supplier refund | Bank/Cash account | **1450 Supplier Credits** |
| Issue a supplier credit note | **1450 Supplier Credits** | Bill cost accounts |
| Apply a supplier credit to a bill | Accounts Payable | **1450 Supplier Credits** |
| Move a supplier credit to a prepaid portal | Supplier Advances | **1450 Supplier Credits** |
| Refund an unused supplier credit | **1450 Supplier Credits** | Bank/Cash account |
| Cancel an invoice and hold receipts | Accounts Receivable | **2500 Refund Payable** |
| Recognise cancellation charges | **2500 Refund Payable** | **4330 Cancellation Charges Income** |
| Cancellation shortfall invoice | Accounts Receivable | **4330 Cancellation Charges Income** |
| Refund a cancellation balance | **2500 Refund Payable** | Bank/Cash account |
| Convert a cancellation balance to credit | **2500 Refund Payable** | **2450 Customer Credits** |
| Deposit cash into the bank | Bank account | Cash account |
| Void a customer or supplier refund | Reverses the refund entry | Reverses the refund entry |
| Top up a supplier portal | Supplier Advances | Bank/Cash account |
| Spend a portal wallet on a booking | Accounts Payable | Supplier Advances |
| Withdraw from a supplier portal | Bank/Cash account | Supplier Advances |
| Void an invoice or bill | Reverses the original entry | Reverses the original entry |
| Remove a payment | Reverses the payment entry | Reverses the payment entry |
| Cancel a booking | Reverses its invoices and bills | Reverses its invoices and bills |
| Reject or cancel a visa | Reverses its invoices and bills | Reverses its invoices and bills |

Manual entries are created under **Journal** and must balance before they can be posted. Bills generated by the compliance engine are **drafts**; they post through the normal bill workflow when you receive them.

### Statuses

Document statuses (`draft`, `sent`/`received`, `void`) are stored. Display statuses such as `paid`, `partial`, and `overdue` are derived from the balance due and due date at read time. Bookings use `draft`, `confirmed`, `travelled` and `cancelled`; visa applications use `draft`, `submitted`, `approved`, `issued`, `rejected` and `cancelled`; refunds use `paid` and `void`; compliance items use `active`, `paused` and `done`; post-dated cheques use `planned`, `issued`, `cleared`, `bounced` and `cancelled`; cash deposits use `posted` and `void`.

## Data & backups

- Database: `data/accounting.db` (SQLite, WAL mode)
- **Full database backup:** `GET /api/admin/backup/database` downloads a consistent `.db` file from a temporary copy. The Settings page can also save a copy under `data/backups/`; the newest 30 manual backups are kept. Automatic backups are kept for 90 days. Pre-reset and pre-restore safety backups are never removed by these retention rules.
- **Restore:** stop the app, then run `npm run restore -- data/backups/<file>.db`. The restore script validates the SQLite file, saves a safety backup of the current database, verifies a temporary copy, then atomically replaces the live file. It refuses to restore while Ledgerly is running, including with `--force`; `--force` only bypasses the leftover WAL warning.
- **Automatic safety backups:** created before **Clear all data** and **Load sample data**. A refused sample-data load does not create one.
- **Scheduled local backup:** Ledgerly checks on startup and every six hours; if the newest backup is older than 24 hours it creates a new one under `data/backups/`. Set `LEDGERLY_AUTO_BACKUP_HOURS=0` to disable, or another number of hours to change the interval.
- **CLI backup:** `npm run backup` creates a timestamped backup while the app can stay running.
- **Health check:** `GET /api/health` returns app version, uptime and SQLite status.
- **Security headers:** the server sends CSP, frame, referrer, permissions and MIME-sniffing protections; API responses are `no-store`. Inline scripts are not allowed.
- JSON export: `GET /api/admin/backup` downloads table data as JSON (attachment metadata only; use the full `.db` backup to preserve attachment bytes). It is for inspection/migration, not the primary recovery file.
- To move the ledger, copy the `data/` directory while the app is stopped.
- The data directory can be overridden with `LEDGERLY_DATA_DIR` (useful for tests or separate books). `npm run restore` follows the same variable, so it never assumes `data/` when you are working with another set of books.
- By default the server accepts only `localhost`, `127.0.0.1` and `[::1]` hosts. If you deliberately expose Ledgerly on a trusted LAN, add the exact host names to `LEDGERLY_ALLOWED_HOSTS` and origins to `LEDGERLY_ALLOWED_ORIGINS` (comma-separated). Keep the default local-only setup unless you really need remote access.
- Server request logging is quiet by default; slow requests (1.5s+) and 5xx responses are logged to the console. Unexpected promise rejections and uncaught exceptions are logged, and uncaught exceptions trigger a clean shutdown.

## Project structure

```
server/
  index.js            Express app and static hosting
  db.js               SQLite setup, chart seeding and migration runner
  schema.js           CREATE TABLE / index SQL
  default-accounts.js Default chart of accounts
  migrations.js       Lightweight column migrations and post-migration indexes
  accounting.js       Posting/reversal engine and status helpers
  services/           Business logic: bookings, visas, portals, advances, invoices, bills, credits, refunds, compliance, cheques, cash deposits, opening balances, reconciliation, statements, reports, demo data
  services/portals/   Portal lifecycle, money movements and supplier/wallet ledgers
  services/reports/   Financial statements, aging, daily sales and dashboard reports
  routes/             REST API endpoints
scripts/
  backup.js           CLI database backup
  check.js            Syntax-check all JavaScript files
  restore.js          Safe restore with integrity and WAL guards
public/
  index.html          SPA shell (theme bootstrap, fonts, favicon)
  js/                 Router, views, shared UI, line-item editor, attachments helper
  js/views/reports/   Individual report renderers
  js/views/compliance/ Compliance row/helpers and modal forms
  js/views/portal-detail/ Portal modals and action handlers
  js/views/portal-reconcile/ Statement parsing and matching helpers
  js/theme.js         Light/dark theme read, apply and sync
  css/styles.css      App and print styles
  css/theme.css       Light/dark theme layer (colours, type, polish)
  vendor/chart.umd.js Bundled Chart.js
data/                 SQLite database (created on first run)
```

## API overview

All endpoints are under `/api`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | App version, uptime and SQLite health |
| GET/POST/PUT/DELETE | `/bookings` | Travel bookings (with sale & cost items) |
| POST | `/bookings/:id/confirm`, `/bookings/:id/travel`, `/bookings/:id/cancel` | Booking lifecycle |
| GET/POST/PUT/DELETE | `/visas` | Visa applications (applicant details, sale & cost items, margin) |
| POST | `/visas/:id/submit`, `/visas/:id/approve`, `/visas/:id/issue`, `/visas/:id/reject`, `/visas/:id/cancel` | Visa lifecycle |
| GET/POST | `/advances` | Customer advances (optionally linked with `booking_id` or `visa_id`) |
| GET/POST/PUT/DELETE | `/portals` | Supplier portals / wallets |
| GET | `/portals/:id/ledger` | Per-portal supplier ledger: wallet movements with GL 1400 reconciliation for prepaid portals, or supplier bills, payments and refunds with an A/P running balance for credit accounts (optional `from`/`to`) |
| POST | `/portals/:id/reconcile` | Compare an imported portal statement (`rows`) against a prepaid portal's wallet ledger: matches, missing lines, balance check |
| POST | `/portals/:id/topups`, `/portals/:id/refund`, `/portals/settle-bill` | Top up, withdraw, or settle a bill from a wallet |
| POST | `/portals/topups/:id/void`, `/portals/refunds/:id/void`, `/portals/credits/:id/void` | Void a wallet top-up, refund or portal credit |
| POST | `/advances/:id/apply`, `/advances/:id/refund`, `/advances/:id/void` | Apply, refund or void an advance |
| GET/POST/PUT/DELETE | `/invoices`, `/bills` | Documents |
| POST | `/invoices/:id/finalize`, `/invoices/:id/void` | Post / void with cascade |
| POST/DELETE | `/invoices/:id/payments`, `/invoices/payments/:id` | Payments |
| GET/POST | `/credits` | Customer credit notes |
| GET | `/credits/:id` | Credit note with invoice applications |
| POST | `/credits/:id/apply`, `/credits/:id/void` | Apply credit to an invoice or void with application reversal |
| POST/DELETE | `/credits/applications/:id/void`, `/credits/applications/:id` | Reverse a credit application |
| GET/POST/DELETE | `/opening-balances` | Read, save or clear the single opening-balance journal entry |
| POST | `/opening-balances/void` | Void opening balances with a reversal |
| GET/POST | `/bank-reconciliations` | Reconciliation history and save a reconciliation |
| GET | `/bank-reconciliations/workspace` | Uncleared bank lines, cleared balance and ledger balance through a statement date |
| GET/DELETE | `/bank-reconciliations/:id` | Reconciliation detail or reopen the latest one |
| POST | `/bank-reconciliations/:id/void` | Void a reconciliation and release its lines |
| GET | `/customers/:id/statement`, `/vendors/:id/statement` | Printable customer/vendor statement (optional `from`/`to`) |
| GET/POST | `/attachments` | List or upload a local attachment (`entity_type`, `entity_id`, raw body, `filename`) |
| GET/DELETE | `/attachments/:id/download`, `/attachments/:id` | Download or remove an attachment |
| GET/POST | `/supplier-credits` | Supplier credit notes (`vendor_id`, optional `bill_id`, `booking_id`, `visa_id`, `credit_date`, `amount_cents` or `items`) |
| GET | `/supplier-credits/:id`, `/supplier-credits/reconciliation` | Credit detail or **1450** reconciliation |
| POST | `/supplier-credits/:id/apply`, `/supplier-credits/:id/refund`, `/supplier-credits/:id/void` | Apply to a bill, refund in cash, or void with cascade |
| POST/DELETE | `/supplier-credits/applications/:id/void`, `/supplier-credits/applications/:id` | Reverse a supplier credit application |
| GET | `/cancellations`, `/cancellations/:id` | Cancellation documents and their refunds, credits and supplier credits |
| POST | `/cancellations/:id/refund`, `/cancellations/:id/convert-to-credit` | Pay the remaining refund or convert it to customer credit |
| GET/POST | `/refunds` | Customer and supplier refunds (`refund_type`, payment or credit source, amount, date, account) |
| GET | `/refunds/sources?type=customer\|supplier` | Payments with a remaining refundable amount |
| GET | `/refunds/:id` | Refund voucher with its journal entry |
| POST | `/refunds/:id/void` | Reverse a refund and restore the source balance |
| GET/POST | `/compliance` | Compliance items (`kind`: `recurring_bill`, `filing` or `renewal`) |
| GET/PUT/DELETE | `/compliance/:id` | Compliance item, activity log, update or delete |
| POST | `/compliance/:id/generate`, `/compliance/:id/complete`, `/compliance/:id/skip` | Create a draft bill, mark complete, or skip one period |
| POST | `/compliance/run-due` | Generate draft bills for all due auto-create recurring items |
| GET/POST | `/cheques`, `/cheques/batch` | Post-dated cheque register and batch creation for a recurring compliance item |
| GET/PUT/DELETE | `/cheques/:id` | Cheque detail, edit/status changes or delete |
| POST | `/cheques/:id/void` | Void a cheque and record an audit entry |
| GET/POST | `/cash/deposits` | Cash deposit history and new cash-to-bank deposit |
| GET | `/cash/accounts` | Active cash/bank accounts with balances |
| POST | `/cash/deposits/:id/void` | Reverse a cash deposit |
| GET/POST/PUT | `/customers`, `/vendors`, `/accounts` | Master data |
| GET/POST/DELETE | `/journal-entries` | General journal |
| POST | `/journal-entries/:id/void` | Reverse a manual journal entry with remarks |
| GET | `/reports/dashboard`, `/income-statement`, `/balance-sheet`, `/trial-balance`, `/daily-sales`, `/bookings`, `/visas`, `/portals`, `/ar-aging`, `/ap-aging`, `/reconciliation` | Reports; `/reconciliation` checks 1400, 1450, 2450 and 2500 against their subledgers |
| GET | `/audit-logs`, `/audit-logs/:id` | Searchable void/audit history |
| GET/PUT | `/settings` | Company settings |
| GET | `/admin/backup` | JSON data export |
| GET | `/admin/backup/database` | Full SQLite database backup download |
| GET/POST | `/admin/backups`, `/admin/backup` | List or create local database backups |
| POST | `/admin/demo`, `/admin/reset` | Demo data / wipe (creates a safety backup first) |

## License

Private, local use.
