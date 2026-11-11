# Netfare

![Netfare — Invoicing & Books](public/brand/netfare-logo.svg)

*Invoicing & books for non-IATA travel agencies. A ShikraGroup brand.*

Netfare is a local-first invoicing and double-entry accounting app built for a **non-IATA travel agency** (Dubai / UAE, currency **AED**). It runs entirely on your machine — no cloud account, no external services, no telemetry. Data lives in a single SQLite file under `data/`.

## Features

- **Travel bookings** — every booking is a job with a customer, sale items (what the traveller pays), supplier cost items (what the airline/hotel/visa supplier charges you), and live profit margin. Confirming a booking automatically creates the customer invoice and the supplier bills and posts them to the ledger.
- **Visa applications** — a dedicated visa workflow beside bookings: applicant and passport details, destination, embassy reference, sale/cost lines and live margin. Submitting posts the customer invoice and supplier bills; approve and issue milestones track the application, while rejection or cancellation reverses the documents.
- **Supplier portals & wallets** — track the money you hold with airline logins, IATA agencies, consolidators, GDS accounts and visa agents. Top up a prepaid portal, spend it on bookings, or run a supplier on credit; every movement is posted to the ledger. Prepaid wallets reconcile against the supplier's own statement, while credit accounts show a full bills, payments and supplier-refund ledger and statement.
- **Booking lifecycle** — `draft → confirmed → travelled` (travelled only from the travel date; every status change is kept in a **Status history**), plus a cancellation workflow that reverses the sale, keeps every receipt and supplier payment, and records any cancellation charge, refund or credit.
- **Customer advances** — take a deposit before the trip, hold it as a liability, then apply it to the invoice or refund it (ideal for cancellations).
- **Invoicing & billing** — customers, invoices, line items, printable PDF-style documents, send/post, void, and payments. Ticket, package and visa sales are invoiced from a booking or visa, where the supplier cost is recorded with the sale. **New service invoice** asks for a description and amount per line (quantity and account behind **⋯**; due date, notes, terms and draft under **More details**) and is for income with no supplier cost (service charges, commission, other income or your own revenue accounts) and cannot use 4000 Ticket Sales, 4100 Tour & Package Sales or 4320 Visa & Documentation Revenue. The DSR labels these as service income with no supplier cost. Each invoice prints with a heading that matches where it came from: a **Ticket invoice** (booking with passengers) shows **Trip details** (route, PNR, travel dates) and each passenger's ticket number under their line; a **Booking invoice** is a booking with no passenger rows; a **Visa invoice** always shows **Visa details** (applicant, nationality, masked passport, visa type, country, duration, application and group number), also when the applicant is the customer; a **Cancellation invoice** carries cancellation charges; a service invoice prints as **Invoice**. Supplier cost and margin are never printed. Numbering stays `INV-YYYY-####` for all of them. Every invoice prints the total **in words** ("UAE Dirhams Seven Hundred Thirty Only"). **Share** on a sent invoice opens an editable message and sends it from your own email (`mailto:`) or WhatsApp (`wa.me`, local UAE numbers such as `050…` become `971…`); Netfare itself sends nothing, so attach the PDF with Print → Save as PDF. Each payment on an invoice has a print button for a **receipt voucher** (`#/receipts/<payment id>`): received from, amount in figures and words, invoice and booking/visa, method, cheque details, account received into, invoice balance now and signature lines. Like a visa, an invoice can be marked **for someone else** (a traveller, guest or family member): it stays billed to the paying customer, and the invoice and customer statement show a **Service for** section with the person's name, nationality and a masked passport number.
- **Refunds** — refund a customer payment, a cancellation balance, an advance, or a supplier credit. Refunds keep the original payment intact, post their own journal entry, track the remaining refundable amount, and can be voided without deleting history.
- **Void & audit trail** — every void asks for remarks, reverses the document and its linked payments, refunds, credits or journal entry, and keeps the original in history. A searchable **Audit log** under **System** records each void with its entity, amount, remarks, action and timestamp.
- **Credit notes & customer credits** — issue a credit note against a revenue account, post it to **2450 Customer Credits**, then apply it to one or more open invoices. Credit applications reduce the invoice balance without pretending cash was received, can be reversed, and are included on customer statements and A/R aging. A cancellation refund can also be converted into customer credit. Unapplied credit can be paid back in cash from the credit note (**Refund credit**): Dr 2450 Customer Credits / Cr bank or cash, without reducing revenue a second time.
- **Supplier credit notes** — record a credit from a supplier standalone or against a bill, optionally linked to a booking, visa or cancellation. Apply it to any open bill for the same supplier, refund the unused balance in cash, or move a prepaid-portal credit into the portal wallet. **1450 Supplier Credits** always equals the total unused supplier credit.
- **Closing date** — the admin sets **Books closed through** in Settings once a period's accounts or tax return are filed. Nothing dated on or before it can then be posted, voided, corrected or deleted, by anyone, until the admin moves it; opening balances and reconciliations dated then are locked too. Cancelling an older booking or visa still works, as a new event dated today.
- **Opening balances** — a guided balance-sheet page creates one balanced opening journal entry. Enter each account as a debit or credit; the difference posts automatically to **3900 Opening Balance Equity**. Replacing or clearing balances posts a reversal, so reconciled lines and audit history are never deleted.
- **Bank reconciliation** — reconcile any active cash or bank account against a statement closing balance. Tick cleared transactions, see the cleared balance and difference, keep a reconciliation history, and reopen the latest reconciliation when a correction is needed.
- **Customer & vendor statements** — printable statements with opening balance, invoices or bills, payments, refunds, applied credits and a running balance. A cancelled booking or visa keeps its invoice and payments on their own dates; the cancellation date adds **Booking or visa cancelled** (invoice reversed), **Cancellation charges**, and then the refund paid or **Refund kept as credit** (a credit note). Invoices voided as mistakes stay off the statement. Filter by period and print directly from the browser.
- **Expenses & bills** — vendors (consolidators, hotels, visa agents, DMCs), bills with expense/asset coding, receive/post, void, and bill payments. Bill payments can be recorded by **cheque** with cheque number, cheque date and bank; compliance items carry a default payment method so office rent can open directly as a cheque payment.
- **Compliance engine** — recurring overheads such as office rent, utilities, salaries and insurance can generate draft bills on schedule, while corporate tax, trade licence, lease, insurance and visa-quota deadlines sit in the same calendar with reminders and activity history.
- **Post-dated cheques** — schedule a batch of 12 monthly cheques (or any 1–60 cheques) from a recurring compliance item. Track cheque number, date, amount, bank and status; recording the matching cheque payment on the bill automatically marks the register cheque **Cleared**.
- **Banking & cash deposits** — at the end of the day, move cash sales from **1000 Cash** into a bank account with a dedicated deposit entry. The deposit posts Dr Bank / Cr Cash, tracks the slip reference and can be voided without deleting history.
- **Date filters & pagination** — bookings, visas, invoices, bills, refunds, credit notes, journal entries and cheques can be narrowed to a date range, with filtered totals and a one-click reset. The main list views — including customers, vendors, portals, bookings, visas, cheques and compliance — paginate in the browser with a selectable page size.
- **Grouped navigation** — Travel, Sales, Purchases, Treasury, Compliance and Accounting are separated in the sidebar so the daily workflow stays short and predictable.
- **Accessibility** — skip link, keyboard focus rings, keyboard-openable table rows, modal focus trapping/restore, labelled dialogs and busy-state announcements are built in. Every data table has a screen-reader caption and scoped column headers, and the browser suite runs an axe WCAG 2.1 AA audit across the main pages in both light and dark themes.
- **Attachments** — attach PDFs, images, spreadsheets, Word files or text documents to invoices, bills, bookings, visas, cancellations (airline or embassy proof), refunds (bank receipts), customer credit notes and supplier credits. Files are stored in the local SQLite database, so full database backups include them.
- **Double-entry ledger** — every document posts balanced journal entries automatically. A general journal supports manual accruals and adjustments.
- **Financial reports** — dashboard with charts, statement of profit or loss, statement of financial position, trial balance, daily sales (DSR), booking and visa gross profit, and A/R / A/P aging. Booking and visa gross profit (report and dashboard) count only confirmed or submitted jobs, with cost taken from posted supplier bills less supplier credits; drafts are listed separately.
- **Customer advances** — money received before an invoice, held in 2400. Record it on a booking or visa (Customer advances card), or for the customer in general from **Customer balances → customer → Record advance**. Confirming a booking or submitting a visa (alone or with **Submit all**) uses that job's open advances for the new invoice straight away, oldest first and never more than the invoice; the confirm preview lists them as *Paid from advance*. General advances are used for an invoice (**Use for invoice**) or refunded from the customer balance page. The customer statement has an **Advances held for you** section with its own balance (received, used for an invoice, refunded), apart from the amount due.
- **Quick expense (paid now)** — on **Bills & expenses**, a one-step form for a small expense already paid (taxi, tea, printer paper): what it was for, amount, date, expense account (default 6900), paid from (default 1000 Cash), method, optional supplier, receipt no. and receipt photo or PDF. It saves a bill and its payment on the same date (net effect Dr expense · Cr cash or bank; Trade Payables nets to zero), so it voids, reports and appears on statements like any bill. Without a supplier it is booked to *Sundry (cash expenses)*. For a supplier you will pay later, use **New bill**.
- **Reports home** — **Reports** opens a page of cards in three groups: *Daily work* (Daily sales, Who owes us, Visa deposits), *How the business is doing* (Profit or loss, Booking gross profit, Visa gross profit) and *For your accountant* (Financial position, Trial balance, What we owe suppliers, Portal wallets). Each report has one line explaining it, quick periods (Today, This month, Last month, This year) or quick dates (Today, End of last month), and an **All reports** button back.
- **IFRS wording** — reports and accounts follow IFRS (IAS 1, IFRS 15) terms. The **Statement of Profit or Loss** reads Revenue → Cost of sales (every expense account of type *Cost of sales*: air tickets, hotels & tours, visas) → **Gross profit** → Operating expenses → **Profit for the period**; the **Statement of Financial Position** shows assets, liabilities and equity with the unclosed profit as *Profit for the period*. Default accounts are named Trade Receivables (1100), Prepayments (1200), Advances to Suppliers (1400), Refundable Deposits Paid (1460), Trade Payables (2000), Contract Liabilities (Customer Advances) (2400), Refund Liabilities (2500), Refundable Security Deposits Held (2600), Service Fee Income (4300), Cancellation Fee Income (4330) and Cost of Sales – Air Tickets / Hotels & Tours / Visas (5000 / 5100 / 5120). Existing installs are renamed only where the old default name is unchanged. Statements of account use **Debit / Credit / Balance**; booking and visa screens show **Gross profit** and **Gross margin**; refunds print as a **Payment voucher**, refunds received as a **Receipt voucher**. Whether agency ticket sales are reported gross or as net commission (IFRS 15 principal vs agent) is an accounting policy for your accountant; Netfare records them gross.
- **Ledger checks** — a dashboard card compares the trial balance and each control account (1100 A/R, 2000 A/P, 2400 advances, 2500 refund payable, 2450 customer credits, 1450 supplier credits, 1400 supplier advances, 2600 visa deposits held, 1460 deposits with suppliers) with the open documents behind it. A difference means something was posted outside the normal document screens, for example an opening balance on A/R.
- **Audit chain** — from a booking, visa, invoice, bill, cancellation, refund, credit note or supplier credit, **Audit chain** shows every linked document, a dated timeline of journal postings, reversals and void remarks, and the net effect of the whole chain on each account. It is read-only and printable.
- **Simple navigation** — the sidebar shows everyday work first (Dashboard, Travel, Sales, Money back, Suppliers, Reports). Less frequent screens (banking, cheques, compliance, journal, opening balances, chart of accounts, audit log, settings) sit under **More**, which starts closed. Groups fold and the choice is remembered per browser. On phones a bottom tab bar holds Home, Bookings, Visas, Invoices and More, and the bookings, visas and invoices lists turn into cards.
- **Dashboard "Today" box** — overdue invoices, money to give back, visa deposits to refund, overdue bills, draft bookings and draft visas, each linking to where it is done. Ledger checks fold into one line (open by itself when something does not match).
- **Booking, visa and invoice pages** — a summary strip at the top (status, customer, total, paid, balance, margin or due date) and one main next step; Print, Audit chain, Cancel / Void and similar actions are in a **More** menu. Account codes on booking and visa documents are hidden unless switched on from More. Lists have **Today** and **This month** quick dates.
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

## Users & sign-in

- The first time Netfare opens, it asks you to create the **admin** account. Everyone, admin included, must sign in before seeing any data.
- The admin adds staff from **Settings → Users & logins**: full name, username and password. From there the admin can rename a user, set a new password or disable a user. Disabled users cannot sign in, and their past entries keep their name.
- **Rights:** for each staff user, the admin sets each area (Bookings, Visas, Invoices & payments, Suppliers & bills, Banking, Books, Reports and others) to No access, View or Edit. **Void, cancel & delete** is a separate tick.
  - The server checks every request.
  - The menu shows only allowed screens, and "New …" and void buttons hide without the right.
  - Bookings and visas also show their invoices, portals and journal postings.
- Users, backups, restore and Clear all data are always admin-only.
- Anyone can change their own password with the lock button at the bottom of the sidebar.
- Passwords are stored as salted scrypt hashes. A session ends after 12 hours without activity. Five wrong passwords lock that username for 5 minutes.
- The audit log shows who did each action.
- **Recovery key:** when the admin first signs in, Netfare shows a recovery key once (like `NF-7KQM-4XTA-9PMW-2HRC`). Copy or print it and keep it away from the computer. Only a hash of it is stored. **Settings → Recovery key** shows when it was made and makes a new one (this needs the admin password, and the old key stops working at once).
- **Forgot the admin password?** On the main computer, open the Netfare app and choose **Help → Reset admin password** (or **Forgot password?** on the sign-in screen). Enter the recovery key and a new password.
  - This works only on the main computer itself, never from the office network.
  - Five wrong keys lock the form for 15 minutes.
  - After a reset you get a new key, other sign-ins end, and the audit log records it.
  - Staff who forget their password ask the admin, who sets a new one in Settings → Users.
- **Lost the key as well?** On a source install, run `npm run reset-admin` on the main computer. It prints a one-time password, and Netfare asks for a new password at the next sign-in.

## Office network (several computers)

- One computer is the **main computer**: it runs Netfare and keeps the books. Others open Netfare in their browser.
- The admin turns this on in **Settings → Office network** ("Allow other computers") and restarts Netfare. The card then lists the links to open on other computers, such as `http://192.168.1.10:4173`, the computer's `.local` name, or its Tailscale address.
- Only this computer, private office networks and Tailscale (100.64.0.0/10) can connect. Internet addresses are always refused, and other host names are refused (DNS rebinding protection).
- For staff working from home, install Tailscale on the main computer and on theirs. Tailscale encrypts the connection; plain office Wi-Fi does not. A Tailscale name can be added under "Extra names".
- The main computer must stay on and awake. The first time, macOS may ask to allow incoming connections for "node".
- If two people edit the same record, the second save is refused with "Someone else changed this record…", instead of overwriting the first person's change.

## Desktop app

The `desktop/` folder holds the Netfare desktop app (Electron 44.9.0, built with electron-builder 26.17.0). `npm run desktop:dist` makes `desktop/dist/Netfare-1.0.0-arm64.dmg`. The Mac app is ad-hoc signed (`identity: "-"`, no Apple Developer account) but not notarized, so the first time it is opened macOS asks for **System Settings → Privacy & Security → Open Anyway**. The whole bundle must stay signed: v1.0.0 carried only Electron's own signature on the main binary, which a browser-downloaded copy reports as "damaged".

- **First run** asks how this computer uses Netfare:
  - **This computer keeps the books:** starts new books, or starts from a `.db` backup. The server runs inside the app, and the books live in the app's folder (`~/Library/Application Support/Netfare/data` on a Mac).
  - **Connect to the office computer:** enter its address, such as `192.168.1.10` or `office-mac.local`. The app checks that Netfare answers there.
- The window only shows Netfare pages; other links open in the normal browser. Netfare menu → **Change setup…** asks again, and **Show books folder** opens the data folder.
- To build (if `~/.npm` has root-owned files, add `npm_config_cache=<some folder>`):
  1. `cd desktop && npm install`. This downloads Electron and electron-builder.
  2. `npm run desktop` opens the app from source.
  3. `npm run desktop:dist` makes `desktop/dist/Netfare-*.dmg`.
- The build copies the server into `desktop/build/app-server` with its own production `node_modules`. better-sqlite3 13 ships Node-API prebuilds, which load in Electron without rebuilding.
- **Updates:** an unsigned app cannot replace itself, so Netfare tells the admin about new versions and they install them.
  - Netfare checks the `latest.json` of the newest [GitHub release](https://github.com/ShikraDeveloper/Netfare/releases) once a day. When a newer version exists, the admin sees a banner with What's new, Download and Later.
  - In **Settings → Updates**, the admin can turn checking off, or point it at another address.
  - Updating means downloading the new `.dmg` and dragging Netfare into Applications. The books are not inside the app, and Netfare backs them up before updating them.
- **Publishing a release:** the GitHub Actions workflow `.github/workflows/release.yml` does it.
  1. Raise `version` in `package.json` and commit.
  2. Tag with the release notes as the message lines: `git tag -a v1.1.0 -m "What changed" -m "Another change"`.
  3. Push the commit and the tag.
  4. GitHub builds `Netfare-mac-arm64.dmg`, `Netfare-mac-x64.dmg` and `Netfare-windows-x64.exe`, opens each packaged app once (smoke test), and publishes the release with `latest.json`.
  - The download links stay the same for every version: `https://github.com/ShikraDeveloper/Netfare/releases/latest/download/<file>`.
  - Running the workflow by hand (Actions → Release → Run workflow) only builds and tests.
  - Locally, `npm run desktop:dist` builds this computer's installers, and `node scripts/smoke-desktop.js` opens the built app once.
- **Website:** `website/` is the landing page.
  - It is plain HTML, CSS and a little JS, with no build step.
  - Its Download button picks this computer's installer, and it reads the latest version and notes from GitHub.
  - It is hosted on the ShikraGroup website at https://shikragroup.com/netfare/, not on GitHub Pages. `npm run website:zip` makes `netfare-website.zip` (git-ignored) for upload.
  - The share-preview tags (`og:url`, `og:image`, canonical) and the app's About card point at that address. If the site moves, change them too.
  - **Hosting checklist:**
    1. Upload the zip's contents (`index.html` and `assets/`) as they are to any folder (`…/netfare/`) or subdomain (`netfare.…`). All paths are relative; keep the names and folders.
    2. Serve it over https.
    3. If the host adds its own Content-Security-Policy header, allow `connect-src https://api.github.com`. Without it the page still works, but shows built-in text instead of the live version and notes.
    4. Once the address is known, set `og:image` in `index.html` to the full https address of `assets/brand/netfare-og-1200x630.png` for link previews.
    5. Downloads point at GitHub Releases, so a new Netfare release needs no website change. Re-upload only when the page itself changes.
  - To preview it, run `python3 -m http.server --directory website` and open the address it prints.
- For testing, `NETFARE_USER_DATA=<folder>` keeps a run's books and choice out of the real app folder, and `PORT` picks another port.

## Theme & appearance

Netfare uses the colours of its logo kit (navy `#0B1B2E`, sky blue `#4FB3E8`, blue `#2B8FCB`, slate `#55657A`) with a matching dark mode. The logo files live in `public/brand/` (sidebar, favicon, Apple touch icon, About card). Open **Settings → Appearance** and pick **Light** or **Dark**; the change applies immediately and is saved per browser/device, so a laptop can stay light while a phone stays dark.

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
2. **Set up your portals** under **Portals & wallets** — one per airline login, IATA agency or visa agent. Link each to the supplier you bill, and top up the prepaid ones. See [Supplier portals & wallets](#supplier-portals--wallets).
3. **Create a booking** under **Bookings** — add one row per passenger with the sale price, the supplier cost and the supplier. Use **Add other item** for a hotel, service fee or insurance. **⋯** on a row holds the ticket number, quantity and accounts. The editor shows the live margin as you type.
4. **Confirm the booking** — a preview first lists what will be posted (the customer invoice, one bill per supplier and which a prepaid wallet pays, with the wallet balance before and after, and the margin). Confirming posts the customer invoice (status `sent`) and one supplier bill per vendor (status `received`) in a single step, keeping the ledger balanced. Bills for suppliers linked to a prepaid portal are settled from that wallet automatically.
5. **Collect payment** on the invoice, or **record a customer advance** first and **apply** it to the invoice later.
6. **Pay suppliers** from the linked bills, from a portal wallet, or from the bank.
7. **Mark the booking travelled** when the trip is done, or **cancel** it to reverse everything.

### Booking fields

| Field | Purpose |
| --- | --- |
| Booking number | Auto-generated as `BK-YYYY-####` |
| Customer | Traveller / account being invoiced |
| Booking date / payment due | Drives invoice dates; payment due (under **More details**) defaults to the payment terms in Settings |
| Travel date / return date | Trip dates |
| Destination / description | Free text, e.g. `Dubai–London return · Emirates`; each passenger's invoice line reads `<destination> – <passenger>` |
| PNR | Airline record locator |
| Payment (list column) | Paid, partial, unpaid or overdue from the booking's invoice, with the amount still due; drafts show *Not invoiced*. Visas show the same column |
| Passengers | One row per passenger: name, sale price, cost and supplier; the ticket number sits behind **⋯**. Bookings can be searched by passenger name |
| Internal notes | Staff only: shown on screen, never printed or copied to the invoice |
| Note on invoice | Optional customer-facing note, printed on the booking confirmation and copied to the invoice |

### Visa applications

Visas live in their own **Visas** section (Travel group) because they carry applicant and passport details and have a different lifecycle from a flight.

| Field | Purpose |
| --- | --- |
| Visa number | Auto-generated as `VIS-YYYY-####` (prefix configurable in Settings) |
| Applicants | **New visa** takes a list of applicants (name, passport no., expiry, sale, cost, supplier; **⋯** for nationality, date of birth and accounts). Each applicant becomes its own application with its own invoice, linked as a group `VG-YYYY-####` when there is more than one |
| Customer | The traveller or corporate account being invoiced |
| Applicant name | The person on the application; defaults to the customer name |
| Nationality / passport no. / expiry / date of birth | Applicant details recorded with the application |
| Application date / travel date | Application date drives invoice dates; travel date is the planned trip |
| Visa type | Tourist, visit/family, business, transit, student, work, other |
| Duration | Stay length in days, e.g. `30` or `60`; leave blank if not fixed |
| Destination country | e.g. `Saudi Arabia`, `France (Schengen)` |
| Embassy / application reference | The reference on the embassy or visa-centre receipt |
| Sale items | Visa fee and service charge, coded to revenue (defaults to **4320 Visa & Documentation Revenue**) |
| Cost items | Embassy, typing-centre and agent fees, each with a supplier (defaults to **5120 Cost of Sales – Visas**) |
| Internal notes | Document checklist, appointment time, internal remarks; never printed or copied to the invoice |
| Note on invoice | Optional customer-facing note, printed on the application summary and copied to the invoice |

The lifecycle is **draft → submitted → approved → issued**, with **rejected** and **cancelled** as terminal states:

| Action | Effect |
| --- | --- |
| Submit & post | Creates the customer invoice and one supplier bill per vendor, exactly like confirming a booking. Prepaid portals settle their bill automatically; credit accounts stay payable. |
| Mark approved | Records that the visa was approved. No extra posting. |
| Mark issued | Records that the visa was issued/collected. No extra posting. |
| Reject | Reverses the invoice and supplier bills (available while submitted or approved). If the embassy keeps its fee, record it as an expense. |
| Cancel | Reverses the invoice and supplier bills for a customer cancellation, including payments and applied advances. |

A group shares the customer, visa type, country and dates, but each application keeps its own status, so one person can be rejected or cancelled without touching the others. The detail page lists the other applications in the group with a **Submit all** button that submits every remaining draft at once; the visa list shows a `VG-… · N` badge and can be searched by group number. Editing a draft changes one application at a time.

Draft applications can be edited or deleted; once submitted they are part of the ledger and can only be rejected or cancelled. When the applicant is someone other than the customer, the invoice is still billed to the paying customer and shows a separate **Visa applicant** section with the applicant’s name, nationality, a masked passport number (last four characters), passport expiry, duration and application details. Invoices and customer statements never show the full passport number or the date of birth; the visa application keeps them for staff. The detail page shows the invoice, supplier bills, customer advances and payments side by side, and prints as a clean A4 application summary. Advances recorded on a visa are linked to that application, held in **2400 Contract Liabilities (Customer Advances)**, and can be applied to its invoice or refunded in the same way as booking advances. **Reports → Visa margin** lists every submitted application in a period with its sale, cost and margin. Drafts are not included, cost is the posted supplier bills less any supplier credits, and cancelled or rejected applications show their cancellation charges and retained cost.

### Supplier portals & wallets

Most airlines, IATA agencies and visa agents work on a **deposit**: you top up a balance in their portal first, then issue tickets and services against it. Netfare models each portal as its own account so you always know how much money is sitting with each supplier.

Create portals under **Portals & wallets** (Travel group). Each portal has:

| Field | Purpose |
| --- | --- |
| Name | e.g. `Emirates Trade`, `Amadeus via XYZ` |
| Type | Airline / BSP, IATA agency, consolidator, GDS, visa agent, other |
| How you settle | **Prepaid wallet** (top up first) or **Credit account** (book now, pay later) |
| Linked supplier | The vendor whose bills this portal pays. For prepaid portals, confirming a booking then settles that supplier's bill from the wallet automatically. |
| Credit limit | Optional cap for credit accounts |
| Login / URL reference | Portal URL and username for your own reference — **never store passwords here** |

Prepaid portals use the wallet actions below. Credit accounts do not hold a deposit wallet; their bills stay in **Trade Payables** until you pay them from **Bills & expenses**.

| Action | Effect |
| --- | --- |
| Top up | Dr Advances to Suppliers · Cr bank/cash — money becomes an asset, not an expense |
| Spend on a booking | On confirmation the supplier's bill is created and settled from the wallet: Dr Trade Payables · Cr Advances to Suppliers |
| Settle an existing bill | Same posting, run manually from the portal or the bill |
| Withdraw / refund | Dr bank/cash · Cr Advances to Suppliers (limited to the available balance) |

A **prepaid** portal balance is always derived — top-ups minus withdrawals minus what bills have consumed — so it can never drift out of step with the ledger. Deleting a portal payment (or cancelling a booking with a portal-paid bill) returns the money to the wallet automatically. If a wallet runs short, the bill is settled up to the available balance and the remainder stays payable, with a warning shown after confirmation. When a wallet settles a bill linked to a visa, the portal statement and settled-bill list show the visa number and applicant’s name, nationality and passport number beside the movement.

A **prepaid** portal has a printable **wallet statement**. Choose a period (or use *This month*, *This year*, *All time*) and the statement shows an opening balance, each top-up, withdrawal and settlement with a running balance, totals in and out, and a closing balance. **Print / PDF** opens the browser print dialog with a clean A4 layout — use *Save as PDF* there to keep a copy. The period only affects the statement; the management cards below always show the full history.

A **credit account** portal uses a **supplier account statement** instead. It shows the opening payable, every posted supplier bill and supplier refund (*Billed / refunded*) and payment (*Paid*) with a running payable balance, totals billed/refunded and paid, and the closing payable. Supplier refunds increase the payable because they return cash to you while the bill remains due. It covers the linked supplier's bills, payments and refunds — there is no deposit wallet to report.

Each portal also has a **supplier ledger** (**Ledger** on the portal page). For a prepaid portal it lists every wallet movement — top-ups, withdrawals and bill settlements — with debit and credit columns, a running balance, and opening/closing totals for any period. A reconciliation card compares the total of all portal balances with account **1400 Advances to Suppliers**; a difference means something was posted to that account outside a portal. For a credit account it lists the supplier's bills, payments and supplier refunds against **2000 Trade Payables**, with the running balance being the amount owed. Open a row to see the double-entry lines that were posted for it (for example *Dr Trade Payables · Cr Advances to Suppliers* for a wallet settlement, or *Dr Cost of Sales – Hotels & Tours · Cr Trade Payables* for a bill). The ledger prints with the journal lines expanded.

Use **Reconcile** on a prepaid portal to check your books against the statement the supplier portal exports. Paste or load the file (CSV, TSV or rows copied from the portal), pick the date and amount columns, and compare. Netfare matches each statement line to a top-up, withdrawal or bill settlement by direction and amount within a configurable date window, preferring a matching reference. The result shows:

- **Matched lines** — with the statement date, your date and the day gap.
- **On the statement, missing in Netfare** — with a *Record top-up*, *Settle bill* or *Withdraw* shortcut that opens the normal form already filled with that line's date, amount and reference.
- **In Netfare, not on the statement** — movements to double-check on the portal.
- **Balance check** — if the file has a running balance column, the statement's opening and closing balances are compared with yours.

Nothing is written to the ledger by the comparison; it only reports differences until you record the missing items.

The **Portal wallets** report (and the dashboard card) show topped-up, used, balance and supplier payable for every portal.

### Customer advances

An advance is money received before the trip is settled. It is held in the **2400 Contract Liabilities (Customer Advances)** liability account and never touches revenue until it is applied.

| Action | Effect |
| --- | --- |
| Record advance | Dr deposit (bank/cash) · Cr Contract Liabilities (Customer Advances) |
| Apply to invoice | Dr Contract Liabilities (Customer Advances) · Cr Trade Receivables, and the invoice balance drops |
| Refund advance | Dr Contract Liabilities (Customer Advances) · Cr deposit (bank/cash), and a voidable refund document is created |

### Payment refunds

Use **Refunds** (or the refund action beside a payment on an invoice or bill) to send money back to a customer or record money returned by a supplier, in full or in part. Refunds keep the original payment row and post their own journal entry. Cancellation refunds and advance refunds are linked to their own source document, so the remaining balance and void action stay accurate.

| Action | Effect |
| --- | --- |
| Refund a customer payment | Dr Trade Receivables · Cr Bank/Cash account, and the invoice balance increases |
| Record a supplier refund | Dr Bank/Cash account · Cr **1450 Supplier Credits**, and a supplier credit note is created; the bill stays paid |
| Refund a cancellation balance | Dr **2500 Refund Liabilities** · Cr Bank/Cash account |
| Convert a cancellation balance to credit | Dr **2500 Refund Liabilities** · Cr **2450 Customer Credits** |
| Refund an unused supplier credit | Dr **1450 Supplier Credits** · Cr Bank/Cash account |
| Void a refund | Reverses the refund entry and restores the relevant invoice, bill, advance, cancellation or supplier-credit balance |

- Refund numbers use **REF-YYYY-####**.
- The engine refuses refunds larger than the source's remaining refundable amount. Voiding an invoice, bill, credit note, supplier credit or advance reverses its linked payments, refunds and credit applications first, so a document with activity can still be voided as one operation. A payment with an active refund still requires the refund to be voided first. A void is rejected if a linked portal movement can no longer be reversed safely (for example, a top-up that has already been spent).
- A customer payment funded by an advance must be refunded through **Advances**, not the payment refund engine. A bill payment made from a supplier wallet must be restored through the portal.
- Customer and supplier refunds have their own list and printable voucher under **Settlements → Refunds**.
- Supplier credits, not Trade Payables, are used for money returned by a supplier. **1450 Supplier Credits** must equal the total unused supplier credit on the supplier-credit list.
- **2500 Refund Liabilities** must equal the total unpaid cancellation refund. The reconciliation report checks both balances.

### Refunds & cancellations

Cancelling a booking or visa does **not** delete the invoice, a bill, a payment or a receipt. Netfare records a cancellation document and posts every cancellation entry on the cancellation date you choose:

1. Any applied customer credit notes are reversed back to their notes.
2. The sent invoice is voided with a reversing entry, while its receipts stay intact.
3. Money actually received (cash/bank payments less active refunds, plus applied advances) is moved from Trade Receivables to **2500 Refund Liabilities**.
4. Cancellation charges are recognised in **4330 Cancellation Fee Income**. If the charges are more than the amount held, a cancellation invoice is issued for the shortfall.
5. Supplier bills are retained at their original cost unless you enter a per-bill creditable amount. A supplier credit note is created for that amount and automatically applied to the bill's unpaid balance first; any remainder stays open in **1450 Supplier Credits**. A prepaid-portal credit is added to the portal wallet.

The cancellation screen shows the resulting customer refund, cancellation income and retained supplier cost. The remaining refund can be paid later from **2500 Refund Liabilities**, converted to customer credit, or left open. Unapplied customer advances stay in **2400 Contract Liabilities (Customer Advances)**. A printable cancellation note is available from the booking or visa.

A recorded cancellation **cannot be undone**. There is no undo button: the cancellation note, voided customer invoice and linked refunds or credits remain in the audit trail. If a cancellation was recorded by mistake, do not edit the database directly. Review the cancellation note and any refunds or credits it created; unused credits can be voided, and a refund can be voided only if the money has been recovered. Then create a new booking or invoice for the reinstated trip and ask your accountant to review adjusting entries.

### Compliance engine

**Accounting → Compliance** combines recurring overheads and a UAE compliance calendar.

- **Recurring bills** — office rent, utilities, salaries, internet, software, insurance, trade-licence instalments and similar costs. Set the vendor, expense account, amount, frequency, next due date and optional end date.
- **Variable amounts** — for Etihad WE, DEWA, phone or other bills that change every month, tick **Amount varies each period**. The stored amount becomes an estimate, auto-draft is disabled, and **Create bill** opens a form where you enter the actual amount, bill date and due date for that period.
- **Filings & renewals** — corporate tax, payroll, trade licence, lease, insurance, vehicle registration and visa quota. Set the frequency and reminder window; amounts are optional estimates.
- **Auto-create draft bills** — for fixed recurring costs only. When enabled, pressing **Run due bills** on Compliance (or `POST /compliance/run-due`) creates draft bills for every missed period up to today. Opening the list never writes data. Monthly schedules stay on the original anchor day (31 January → 28/29 February → 31 March). The draft bill is not posted to the ledger until you review it and receive it under **Bills**.
- **Payment method** — set a default method on each recurring item. Office rent can default to **Cheque**; the generated bill’s payment form then opens with Cheque selected and asks for cheque number, cheque date and bank. Cheque payments post through the normal Dr Trade Payables / Cr Bank entry.
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

### Visa security deposits

A refundable security deposit taken for a visa is **not a sale**. It is the customer's money, held until it is refunded, used for an invoice or forfeited. Each deposit gets a number (`SD-YYYY-####`; `DEP-` is the cash deposit series) and every step posts to the ledger:

| Step | Entry |
| --- | --- |
| **Take deposit** (on the visa page, or the **Sec. deposit** column when creating visas) | Dr cash / bank · Cr **2600 Refundable Security Deposits Held** |
| **Pay to supplier** (when the visa supplier or immigration holds it) | Dr **1460 Refundable Deposits Paid** · Cr cash / bank |
| **Supplier returned** (the visitor has left; any fine deducted) | Dr cash / bank (net) · Dr 2600 (deduction) · Cr 1460 (gross) |
| **Refund** | Dr 2600 · Cr cash / bank; also listed as a customer refund |
| **Use for invoice** | Dr 2600 · Cr 1100 (a payment marked *Deposit applied*) |
| **Forfeit** (absconded, overstay) | Dr 2600 · Cr **4340 Forfeited Deposit Income** when we keep it, or Cr 1460 when the supplier kept it; a reason is required |

- The visa page shows a **Security deposit** card: received, with supplier, refunded, used, forfeited or deducted, and **still held**, with the history and an action for each step. Money still with the supplier cannot be refunded or used until the supplier return is recorded.
- **Void** undoes the latest step only (with remarks); voiding the first step voids the whole deposit.
- **DSR:** visa rows show a **Sec. deposit** column and count the money received in cash / card / bank; deposits for visas not sold in the period appear under *Money collected*; deposit refunds, forfeits and supplier deductions appear in section E; the summary has a **Visa security deposits** box (received, refunded, forfeited / deducted, still held).
- **Customer statement:** a separate **Security deposits held for you** section with its own balance; deposits are never part of the amount due.
- **Reports → Visa deposits:** the deposit register (still held or all), with totals for 2600, 1460 and in hand, flagging deposits on cancelled or rejected visas (*refund due*) and deposits held over 90 days.
- **Ledger checks** compare 2600 with the deposits still held and 1460 with the deposits held by suppliers. Both accounts are control accounts: manual journals cannot post to them.

### Daily sales report (DSR)

**Reports → Daily sales** is laid out like a travel counter's daily report, for one day (**Today**) or any period. Amounts are in AED; it prints on A4 landscape.

- **B. Ticket & booking sales:** one row per booking invoice with the date and time, invoice and booking number, customer, each passenger with their ticket number, PNR and route, **Fare** (everything except service fees and commission), **Fee** (4300 / 4310 lines) and **Total**, then how it was settled by the end of the period: **Cash**, **Card**, **Bank** (bank transfer or cheque), **Other** (a customer advance or credit note) and **Credit** (still unpaid).
- **C. Visa sales:** applicant (and who paid), country and visa type, visa fee, service fee, total and the same settlement columns.
- **D. Service income:** service invoices with their description, total and settlement.
- **E. Cancellations & refunds:** each cancellation on its cancellation date (sale reversed, charges kept, supplier credit, net sale) and every refund paid to a customer (cancellation, advance, credit note or payment refund) with its method.
- **F. Money collected for older invoices & advances:** payments received in the period for invoices from earlier days, and customer advances received.
- **G. Money paid out:** cash and bank outflows from the ledger by type (supplier payments, refunds, portal top-ups, expenses and journal entries, transfers).
- **H. Summary:** sales by type and total; collected by mode (cash, card, bank, total received, advance or credit used, on credit, refunds paid); and **Cash** (1000) and **Bank** (1010) as opening + money in − money out = closing.
- **Show profit** adds cost and margin columns and the margin in the summary. It is off by default so a printed copy for staff carries no profit; the choice is remembered on this computer.
- **Sent** invoices count; drafts and invoices voided as mistakes are excluded.
- **A sale stays on the day it was made.** When a booking or visa is cancelled, its original sale stays on its own day, marked **Cancelled** with a link to the cancellation note. A separate red **cancellation line** on the cancellation date reverses the sale and any supplier credit and adds the charges the customer keeps paying. The two lines together give the net result (charges less retained cost), and a DSR printed for an earlier day does not change later.
- Cost is the supplier bills posted for the linked booking or visa; supplier credits raised by a cancellation appear on the cancellation line, other supplier credits reduce the cost. Service invoices are income with no supplier cost, so their full value shows as margin; they are labelled **Service income · no supplier cost**.
- Invoice numbers link to the invoice, the reference under each links to the booking or visa, cancellation numbers link to the cancellation note, and receipts in section F link to the receipt voucher.
- The API (`GET /api/reports/daily-sales`) still returns the day-by-day `days` and `totals`, plus the new `sections`.

## Accounting model

Netfare uses double-entry bookkeeping. Monetary values are stored as integer cents.

### Chart of accounts

The default chart includes these system accounts, which the posting engine depends on:

| Code | Account | Type |
| --- | --- | --- |
| 1100 | Trade Receivables | asset (receivable) |
| 1400 | Advances to Suppliers | asset |
| 1450 | Supplier Credits | asset |
| 2000 | Trade Payables | liability (payable) |
| 2400 | Contract Liabilities (Customer Advances) | liability |
| 2450 | Customer Credits | liability |
| 2500 | Refund Liabilities | liability |
| 3100 | Retained Earnings | equity |
| 3900 | Opening Balance Equity | equity |
| 4300 | Service Fee Income | revenue |
| 4330 | Cancellation Fee Income | revenue |

Travel-specific defaults also include revenue accounts **4000 Ticket Sales**, **4100 Tour & Package Sales**, **4310 Commission Income**, **4320 Visa & Documentation Revenue**, and cost accounts **5000 Cost of Sales – Air Tickets**, **5100 Cost of Sales – Hotels & Tours**, **5120 Cost of Sales – Visas**.

You can rename accounts and add your own under **Chart of accounts**. System accounts must keep their code; their display names can be customised. Don't archive them or posting will fail with a clear error. Manual journal entries cannot post to control accounts **1100, 1400, 1450, 1460, 2000, 2400, 2450, 2500 or 2600**; use the related invoice, bill, refund, advance, credit or cancellation screen. Opening balances remain exempt. Payment and deposit pickers accept only active **cash/bank** accounts. Bill, booking and visa cost lines accept expense accounts plus valid non-cash assets such as Prepayments and Equipment; they cannot be coded to cash, receivables, payables or system accounts.

### Automatic postings

| Event | Debit | Credit |
| --- | --- | --- |
| Send an invoice | Trade Receivables | Revenue accounts |
| Receive a customer payment | Bank/Cash account | Trade Receivables |
| Receive a bill | Expense/asset accounts | Trade Payables |
| Pay a bill | Trade Payables | Bank/Cash account |
| Confirm a booking | Posts the customer invoice and each supplier bill | (as above) |
| Submit a visa application | Posts the customer invoice and each supplier bill | (as above) |
| Record a customer advance | Bank/Cash account | Contract Liabilities (Customer Advances) |
| Apply an advance to an invoice | Contract Liabilities (Customer Advances) | Trade Receivables |
| Refund an advance | Contract Liabilities (Customer Advances) | Bank/Cash account |
| Refund a customer payment | Trade Receivables | Bank/Cash account |
| Issue a customer credit note | Revenue account | Customer Credits |
| Apply a customer credit to an invoice | Customer Credits | Trade Receivables |
| Refund unapplied customer credit in cash | Customer Credits | Bank/Cash account |
| Record a supplier refund | Bank/Cash account | **1450 Supplier Credits** |
| Issue a supplier credit note | **1450 Supplier Credits** | Bill cost accounts |
| Apply a supplier credit to a bill | Trade Payables | **1450 Supplier Credits** |
| Move a supplier credit to a prepaid portal | Advances to Suppliers | **1450 Supplier Credits** |
| Refund an unused supplier credit | **1450 Supplier Credits** | Bank/Cash account |
| Cancel an invoice and hold receipts | Trade Receivables | **2500 Refund Liabilities** |
| Recognise cancellation charges | **2500 Refund Liabilities** | **4330 Cancellation Fee Income** |
| Cancellation shortfall invoice | Trade Receivables | **4330 Cancellation Fee Income** |
| Refund a cancellation balance | **2500 Refund Liabilities** | Bank/Cash account |
| Convert a cancellation balance to credit | **2500 Refund Liabilities** | **2450 Customer Credits** |
| Deposit cash into the bank | Bank account | Cash account |
| Void a customer or supplier refund | Reverses the refund entry | Reverses the refund entry |
| Top up a supplier portal | Advances to Suppliers | Bank/Cash account |
| Spend a portal wallet on a booking | Trade Payables | Advances to Suppliers |
| Withdraw from a supplier portal | Bank/Cash account | Advances to Suppliers |
| Void a standalone invoice or bill | Reverses the original entry | Reverses the original entry |
| Remove a payment | Reverses the payment entry | Reverses the payment entry |
| Cancel a booking | Reverses its invoices and bills | Reverses its invoices and bills |
| Reject or cancel a visa | Reverses its invoices and bills | Reverses its invoices and bills |

Invoices and bills created by a booking or visa cannot be voided on their own: cancel the booking or visa (which handles charges, refunds and supplier credits), or record a supplier credit against the bill. A cancellation-charges invoice is waived with a customer credit note. A mistaken receipt or bill payment on these documents can still be voided.

Manual entries are created under **Journal** and must balance before they can be posted. Bills generated by the compliance engine are **drafts**; they post through the normal bill workflow when you receive them.

### Statuses

Document statuses (`draft`, `sent`/`received`, `void`) are stored. Display statuses such as `paid`, `partial`, and `overdue` are derived from the balance due and due date at read time. Bookings use `draft`, `confirmed`, `travelled` and `cancelled`; visa applications use `draft`, `submitted`, `approved`, `issued`, `rejected` and `cancelled`; refunds use `paid` and `void`; compliance items use `active`, `paused` and `done`; post-dated cheques use `planned`, `issued`, `cleared`, `bounced` and `cancelled`; cash deposits use `posted` and `void`.

## Data & backups

- Database: `data/accounting.db` (SQLite, WAL mode)
- **Full database backup:** `GET /api/admin/backup/database` downloads a consistent `.db` file from a temporary copy. The Settings page can also save a copy under `data/backups/`; the newest 30 manual backups are kept. Automatic backups are kept daily for 14 days, then one a week up to 90 days. Pre-reset and pre-restore safety backups are never removed by these retention rules.
- **Restore:** in the desktop app on the main computer, choose **Netfare → Restore from backup…**; Netfare restarts, saves the current books as a pre-restore backup and opens the chosen one. Without the desktop app, stop Netfare, then run `npm run restore -- data/backups/<file>.db`. The restore script validates the SQLite file, saves a safety backup of the current database, verifies a temporary copy, then atomically replaces the live file. It refuses to restore while Netfare is running, including with `--force`; `--force` only bypasses the leftover WAL warning.
- **Automatic safety backups:** created before **Clear all data** and **Load sample data**. A refused sample-data load does not create one.
- **Scheduled local backup:** Netfare checks on startup and every six hours; if the newest backup is older than 24 hours it creates a new one under `data/backups/`. Set `LEDGERLY_AUTO_BACKUP_HOURS=0` to disable (environment variable names keep the `LEDGERLY_` prefix so existing setups keep working), or another number of hours to change the interval.
- **CLI backup:** `npm run backup` creates a timestamped backup while the app can stay running.
- **Health check:** `GET /api/health` returns app version, uptime and SQLite status.
- **Security headers:** the server sends CSP, frame, referrer, permissions and MIME-sniffing protections; API responses are `no-store`. Inline scripts are not allowed.
- JSON export: `GET /api/admin/backup` downloads table data as JSON (attachment metadata only; use the full `.db` backup to preserve attachment bytes). It is for inspection/migration, not the primary recovery file.
- To move the ledger, copy the `data/` directory while the app is stopped.
- The data directory can be overridden with `LEDGERLY_DATA_DIR` (useful for tests or separate books). `npm run restore` follows the same variable, so it never assumes `data/` when you are working with another set of books.
- By default the server accepts only `localhost`, `127.0.0.1` and `[::1]` hosts. If you deliberately expose Netfare on a trusted LAN, add the exact host names to `LEDGERLY_ALLOWED_HOSTS` and origins to `LEDGERLY_ALLOWED_ORIGINS` (comma-separated). Keep the default local-only setup unless you really need remote access.
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
| GET | `/invoices/payments/:paymentId/receipt` | Data for a printable receipt voucher |
| GET/POST | `/visa-deposits` | Visa security deposits (list, take a deposit) |
| POST | `/visa-deposits/:id/to-supplier`, `/supplier-return`, `/refund`, `/apply`, `/forfeit`, `/void-last` | Deposit steps |
| GET | `/reports/visa-deposits` | Deposit register (`status=all` for settled ones too) |
| POST | `/visas/groups` | Create one application per applicant, linked as a group (one applicant creates a plain application) |
| POST | `/visas/groups/:groupId/submit` | Submit every draft application in a group at once |
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
| GET | `/reports/dashboard`, `/income-statement`, `/balance-sheet`, `/trial-balance`, `/daily-sales`, `/bookings`, `/visas`, `/portals`, `/ar-aging`, `/ap-aging`, `/reconciliation` | Reports; `/reconciliation` returns the dashboard ledger checks (trial balance, 1100, 2000, 2400, 2500, 2450, 1450, 1400, 2600 and 1460 against their documents) |
| GET | `/audit-logs`, `/audit-logs/:id` | Searchable void/audit history |
| GET | `/audit-chain/:type/:id` | Linked documents, journal timeline, reversals, void remarks and net account effect (`type`: booking, visa, invoice, bill, payment, advance, cancellation, refund, credit, supplier_credit and related applications) |
| GET/PUT | `/settings` | Company settings |
| GET | `/admin/backup` | JSON data export |
| GET | `/admin/backup/database` | Full SQLite database backup download |
| GET/POST | `/admin/backups`, `/admin/backup` | List or create local database backups |
| POST | `/admin/demo`, `/admin/reset` | Demo data / wipe (creates a safety backup first) |

## License

MIT, © 2026 ShikraGroup. See [LICENSE](LICENSE). Netfare is free and open source.
