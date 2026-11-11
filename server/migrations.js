'use strict';

module.exports = function runMigrations(db) {
// --- lightweight migrations -------------------------------------------------
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function ensureColumn(table, column, definition) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function dropColumn(table, column) {
  if (hasColumn(table, column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

function foreignKeyOnDelete(table, column) {
  const row = db.prepare(`PRAGMA foreign_key_list(${table})`).all().find((entry) => entry.from === column);
  return row ? String(row.on_delete || '').toUpperCase() : '';
}

// Older databases deleted reconciliation lines together with their journal line.
// Rebuild that table once so a reconciled line cannot silently disappear.
function protectReconciledLines() {
  if (foreignKeyOnDelete('bank_reconciliation_lines', 'journal_line_id') !== 'CASCADE') return;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS bank_reconciliation_lines_new;
        CREATE TABLE bank_reconciliation_lines_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reconciliation_id INTEGER NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
          journal_line_id INTEGER NOT NULL UNIQUE REFERENCES journal_lines(id) ON DELETE RESTRICT
        );
        INSERT INTO bank_reconciliation_lines_new (id, reconciliation_id, journal_line_id)
          SELECT id, reconciliation_id, journal_line_id FROM bank_reconciliation_lines;
        DROP TABLE bank_reconciliation_lines;
        ALTER TABLE bank_reconciliation_lines_new RENAME TO bank_reconciliation_lines;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// Supplier portals originally allowed only airline, IATA, consolidator, GDS
// and other. Rebuild the table once so visa agents can be recorded as well,
// preserving portal IDs and every wallet row that references them.
// Attachments started with invoices, bills, bookings and visas. Settlement
// documents (cancellation proof, refund receipts, credit notes) need them too,
// and so do customers (Emirates ID, passport). SQLite cannot widen a CHECK
// constraint in place, so rebuild the table when a type is missing.
function allowSettlementAttachments() {
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'",
  ).get();
  if (!table || String(table.sql).includes("'customer'")) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS attachments_new;
        CREATE TABLE attachments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice', 'bill', 'booking', 'visa', 'cancellation', 'refund', 'credit_note', 'supplier_credit', 'customer')),
          entity_id INTEGER NOT NULL,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          size_bytes INTEGER NOT NULL DEFAULT 0,
          storage_name TEXT NOT NULL UNIQUE,
          data BLOB,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO attachments_new (
          id, entity_type, entity_id, file_name, mime_type, size_bytes, storage_name, data, created_at
        )
          SELECT id, entity_type, entity_id, file_name, mime_type, size_bytes, storage_name, data, created_at
          FROM attachments;
        DROP TABLE attachments;
        ALTER TABLE attachments_new RENAME TO attachments;
        CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function allowVisaAgentPortals() {
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'supplier_portals'",
  ).get();
  if (!table || String(table.sql).includes("'visa_agent'")) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS supplier_portals_new;
        CREATE TABLE supplier_portals_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          portal_type TEXT NOT NULL DEFAULT 'other' CHECK (portal_type IN ('airline', 'iata_agency', 'consolidator', 'gds', 'visa_agent', 'other')),
          settlement TEXT NOT NULL DEFAULT 'prepaid' CHECK (settlement IN ('prepaid', 'credit')),
          vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
          login_ref TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          credit_limit_cents INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO supplier_portals_new (
          id, name, portal_type, settlement, vendor_id, login_ref, notes,
          credit_limit_cents, is_active, created_at, updated_at
        )
          SELECT
            id, name, portal_type, settlement, vendor_id, login_ref, notes,
            credit_limit_cents, is_active, created_at, updated_at
          FROM supplier_portals;
        DROP TABLE supplier_portals;
        ALTER TABLE supplier_portals_new RENAME TO supplier_portals;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

ensureColumn('settings', 'booking_prefix', "TEXT NOT NULL DEFAULT 'BK'");
ensureColumn('settings', 'next_booking_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'next_advance_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'topup_prefix', "TEXT NOT NULL DEFAULT 'TOP'");
ensureColumn('settings', 'next_topup_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'visa_prefix', "TEXT NOT NULL DEFAULT 'VIS'");
ensureColumn('settings', 'next_visa_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'next_visa_group_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'next_visa_deposit_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('refunds', 'deposit_id', 'INTEGER');
ensureColumn('payments', 'deposit_id', 'INTEGER');
ensureColumn('settings', 'next_refund_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'next_deposit_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'next_credit_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'supplier_credit_prefix', "TEXT NOT NULL DEFAULT 'SCN'");
ensureColumn('settings', 'next_supplier_credit_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'cancellation_prefix', "TEXT NOT NULL DEFAULT 'CNC'");
ensureColumn('settings', 'next_cancellation_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'portal_credit_prefix', "TEXT NOT NULL DEFAULT 'PCR'");
ensureColumn('settings', 'next_portal_credit_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'setup_version', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('invoices', 'booking_id', 'INTEGER');
ensureColumn('invoices', 'visa_id', 'INTEGER');
ensureColumn('invoices', 'credit_applied_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('invoices', 'cancellation_id', 'INTEGER');
// An invoice billed to the customer can be for someone else (a traveller,
// guest or family member). The ledger party stays the customer.
ensureColumn('invoices', 'beneficiary_is_customer', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('invoices', 'beneficiary_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('invoices', 'beneficiary_nationality', "TEXT NOT NULL DEFAULT ''");
ensureColumn('invoices', 'beneficiary_passport', "TEXT NOT NULL DEFAULT ''");
ensureColumn('bills', 'booking_id', 'INTEGER');
ensureColumn('bills', 'visa_id', 'INTEGER');
ensureColumn('bills', 'portal_id', 'INTEGER');
ensureColumn('bills', 'credit_applied_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('compliance_items', 'variable_amount', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('compliance_items', 'payment_method', "TEXT NOT NULL DEFAULT 'Bank transfer'");
ensureColumn('bills', 'default_payment_method', "TEXT NOT NULL DEFAULT 'Bank transfer'");
ensureColumn('attachments', 'data', 'BLOB');
ensureColumn('payments', 'advance_id', 'INTEGER');
ensureColumn('payments', 'cheque_number', "TEXT NOT NULL DEFAULT ''");
ensureColumn('payments', 'cheque_date', 'TEXT');
ensureColumn('payments', 'bank_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('payments', 'status', "TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void'))");
ensureColumn('payments', 'void_entry_id', 'INTEGER');
ensureColumn('payments', 'voided_at', 'TEXT');
ensureColumn('bill_payments', 'portal_id', 'INTEGER');
ensureColumn('bill_payments', 'cheque_number', "TEXT NOT NULL DEFAULT ''");
ensureColumn('bill_payments', 'cheque_date', 'TEXT');
ensureColumn('bill_payments', 'bank_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('bill_payments', 'status', "TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void'))");
ensureColumn('bill_payments', 'void_entry_id', 'INTEGER');
ensureColumn('bill_payments', 'voided_at', 'TEXT');
ensureColumn('credit_notes', 'cancellation_id', 'INTEGER');
ensureColumn('refunds', 'cancellation_id', 'INTEGER');
ensureColumn('refunds', 'supplier_credit_note_id', 'INTEGER');
ensureColumn('refunds', 'advance_id', 'INTEGER');
ensureColumn('refunds', 'credit_note_id', 'INTEGER');
ensureColumn('credit_notes', 'refunded_cents', 'INTEGER NOT NULL DEFAULT 0');
// A refund given to the customer on a visa or booking (job-refunds.js).
ensureColumn('credit_notes', 'visa_id', 'INTEGER');
ensureColumn('credit_notes', 'booking_id', 'INTEGER');
ensureColumn('compliance_items', 'anchor_date', 'TEXT');
ensureColumn('compliance_items', 'period_index', 'INTEGER NOT NULL DEFAULT 0');
// Set when the bank takes the amount itself (account charges): each period's
// bill is created already paid from this cash or bank account.
ensureColumn('compliance_items', 'auto_debit_account_id', 'INTEGER REFERENCES accounts(id)');
// Bank charges taken on the transfer, posted to 6700 in the payment's entry.
ensureColumn('payments', 'bank_charges_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('bill_payments', 'bank_charges_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('refunds', 'bank_charges_cents', 'INTEGER NOT NULL DEFAULT 0');
// The amount petty cash is topped back up to (imprest float).
ensureColumn('settings', 'petty_cash_float_cents', 'INTEGER NOT NULL DEFAULT 0');
// A visa deposit paid to the supplier from (or returned into) a prepaid
// portal wallet instead of the bank.
ensureColumn('visa_deposit_events', 'portal_id', 'INTEGER REFERENCES supplier_portals(id)');
ensureColumn('settings', 'next_card_settlement_number', 'INTEGER NOT NULL DEFAULT 1');
// A gateway's payment link for an invoice, shared with the invoice.
ensureColumn('invoices', 'payment_link', "TEXT NOT NULL DEFAULT ''");
ensureColumn('post_dated_cheques', 'anchor_date', 'TEXT');

// Void audit trail and void metadata. Rows are retained so the audit log can
// always point back to the original document.
// The edit time of customers, suppliers and accounts, so two people editing
// the same record do not overwrite each other (see routes/index.js).
ensureColumn('customers', 'updated_at', "TEXT NOT NULL DEFAULT ''");
ensureColumn('vendors', 'updated_at', "TEXT NOT NULL DEFAULT ''");
ensureColumn('accounts', 'updated_at', "TEXT NOT NULL DEFAULT ''");
// A second copy of every backup in another place (services/backup-mirror.js).
ensureColumn('settings', 'backup_mirror_dir', "TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'backup_mirror_at', "TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'backup_mirror_error', "TEXT NOT NULL DEFAULT ''");
// Where Netfare looks for news of a new version (services/updates.js).
ensureColumn('settings', 'update_feed', "TEXT NOT NULL DEFAULT ''");
// Office network mode (server/network.js): listen beyond this computer, and
// extra names such as a Tailscale name that browsers may use.
ensureColumn('settings', 'lan_enabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('settings', 'lan_hosts', "TEXT NOT NULL DEFAULT ''");
// Who created each document (server/created-by.js).
for (const table of require('./created-by').CREATED_BY_TABLES) {
  ensureColumn(table, 'created_by', "TEXT NOT NULL DEFAULT ''");
}
// Who saved the last change from a record's form, and when.
for (const table of Object.values(require('./created-by').CHANGED_BY_TABLES)) {
  ensureColumn(table, 'changed_by', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(table, 'changed_at', 'TEXT');
}
// "Prepared by" on printed invoices, receipts, credit notes and refunds.
ensureColumn('settings', 'print_prepared_by', 'INTEGER NOT NULL DEFAULT 1');
// Who uploaded each attachment.
ensureColumn('attachments', 'uploaded_by', "TEXT NOT NULL DEFAULT ''");
// Each staff user's rights, set by the admin (see server/permissions.js).
ensureColumn('users', 'permissions', "TEXT NOT NULL DEFAULT '{}'");
// The admin's recovery key (services/auth.js): a scrypt hash, never the key.
ensureColumn('users', 'recovery_key_hash', 'TEXT');
ensureColumn('users', 'recovery_key_created_at', 'TEXT');
ensureColumn('users', 'recovery_key_confirmed', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'recovery_key_uses', 'INTEGER NOT NULL DEFAULT 0');
// Who did it: the logged-in user's name on each audit entry.
ensureColumn('audit_logs', 'user_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('journal_entries', 'reversal_of_id', 'INTEGER');
// Opening balance reversals used to be linked only by source_id. Linking them
// as reversals too keeps an old opening 1030 line out of the open card items.
db.exec(`
  UPDATE journal_entries SET reversal_of_id = source_id
  WHERE source_type = 'opening_balance_reversal' AND reversal_of_id IS NULL AND source_id IS NOT NULL
`);
ensureColumn('journal_entries', 'voided_at', 'TEXT');
ensureColumn('journal_entries', 'void_entry_id', 'INTEGER');
ensureColumn('customer_advances', 'void_entry_id', 'INTEGER');
ensureColumn('customer_advances', 'voided_at', 'TEXT');
ensureColumn('portal_topups', 'status', "TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void'))");
ensureColumn('portal_topups', 'void_entry_id', 'INTEGER');
ensureColumn('portal_topups', 'voided_at', 'TEXT');
// Charges the bank took on a top-up transfer, posted to 6700 in the top-up's entry.
ensureColumn('portal_topups', 'bank_charges_cents', 'INTEGER NOT NULL DEFAULT 0');
// Opening balances entered when a customer, supplier or portal is created
// (services/party-opening.js). They are not sales or purchases.
ensureColumn('invoices', 'is_opening', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('bills', 'is_opening', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('credit_notes', 'is_opening', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('supplier_credit_notes', 'is_opening', 'INTEGER NOT NULL DEFAULT 0');
// A customer receipt is an advance shared out over invoices at once
// (receivePayment in services/advances.js); bank charges as on payments.
ensureColumn('customer_advances', 'is_receipt', 'INTEGER NOT NULL DEFAULT 0');
// A receipt's share of an invoice is a payment, not an advance used. Receipts
// made before this column existed shared out in the same moment they were saved.
if (!hasColumn('payments', 'from_receipt')) {
  ensureColumn('payments', 'from_receipt', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    UPDATE payments SET from_receipt = 1
    WHERE advance_id IN (SELECT id FROM customer_advances WHERE is_receipt = 1)
      AND EXISTS (
        SELECT 1 FROM customer_advances a WHERE a.id = payments.advance_id
          AND a.advance_date = payments.payment_date
          AND ABS(strftime('%s', a.created_at) - strftime('%s', payments.created_at)) <= 5
      )
  `);
}
// A customer's nationality, offered for visas and invoices made for them.
ensureColumn('customers', 'nationality', "TEXT NOT NULL DEFAULT ''");
ensureColumn('customer_advances', 'bank_charges_cents', 'INTEGER NOT NULL DEFAULT 0');
// Receipts get their own series (RCP-…) so they are not read as advances.
ensureColumn('settings', 'receipt_prefix', "TEXT NOT NULL DEFAULT 'RCP'");
ensureColumn('settings', 'next_receipt_number', 'INTEGER NOT NULL DEFAULT 1');
// The admin's closing date: nothing may be posted on or before it.
ensureColumn('settings', 'books_closed_through', "TEXT NOT NULL DEFAULT ''");
// Printed on invoices: the company logo (a small image as a data URL), the
// bank details for paying, and the terms under every invoice.
ensureColumn('settings', 'company_logo', "TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'bank_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'bank_account_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'bank_iban', "TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'invoice_terms', "TEXT NOT NULL DEFAULT ''");
// Ticket and visa invoices can carry their own terms; empty uses invoice_terms.
ensureColumn('settings', 'invoice_terms_ticket', "TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'invoice_terms_visa', "TEXT NOT NULL DEFAULT ''");
// The two colours of the brand line on every document; empty uses Netfare's.
ensureColumn('settings', 'doc_color_dark', "TEXT NOT NULL DEFAULT ''");
ensureColumn('settings', 'doc_color_light', "TEXT NOT NULL DEFAULT ''");
// A company customer's tax registration number, printed under Bill to.
ensureColumn('customers', 'trn', "TEXT NOT NULL DEFAULT ''");
ensureColumn('portal_refunds', 'status', "TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void'))");
ensureColumn('portal_refunds', 'void_entry_id', 'INTEGER');
ensureColumn('portal_refunds', 'voided_at', 'TEXT');
ensureColumn('portal_credits', 'status', "TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void'))");
ensureColumn('portal_credits', 'void_entry_id', 'INTEGER');
ensureColumn('portal_credits', 'voided_at', 'TEXT');

ensureColumn('visa_applications', 'duration_days', 'INTEGER NOT NULL DEFAULT 0');
// Notes are internal; the invoice note is the only text copied to the customer invoice.
ensureColumn('bookings', 'invoice_notes', "TEXT NOT NULL DEFAULT ''");
ensureColumn('visa_applications', 'invoice_notes', "TEXT NOT NULL DEFAULT ''");
// Visas for several people are separate applications linked by a group.
ensureColumn('visa_applications', 'group_id', 'INTEGER');

// Existing visa applications did not record whether the applicant was the
// customer or a visitor. Derive it once when the column is first added.
const hadVisaApplicantFlag = hasColumn('visa_applications', 'applicant_is_customer');
ensureColumn('visa_applications', 'applicant_is_customer', 'INTEGER NOT NULL DEFAULT 1');
if (!hadVisaApplicantFlag) {
  db.exec(`
    UPDATE visa_applications
    SET applicant_is_customer = 0
    WHERE applicant_name <> ''
      AND applicant_name <> COALESCE(
        (SELECT name FROM customers WHERE customers.id = visa_applications.customer_id),
        ''
      )
  `);
}

// VAT/tax support was removed. Drop legacy columns on existing databases.
dropColumn('settings', 'tax_rate');
dropColumn('invoices', 'tax_rate');
dropColumn('invoices', 'tax_cents');
dropColumn('bills', 'tax_rate');
dropColumn('bills', 'tax_cents');
dropColumn('bookings', 'tax_rate');
dropColumn('visa_applications', 'tax_rate');
dropColumn('compliance_items', 'tax_rate');
// Never written or read; cheques are ordered by date.
dropColumn('post_dated_cheques', 'batch_index');

protectReconciledLines();
allowVisaAgentPortals();
allowSettlementAttachments();

// Retire the old VAT accounts exactly once. A user-created account at 1300 or
// 2200 must never be renamed or deleted by later startups.
const setup = db.prepare('SELECT setup_version FROM settings WHERE id = 1').get();
const setupVersion = Number(setup?.setup_version || 0);
if (setupVersion < 2) {
  db.transaction(() => {
    const legacyAccounts = [
      ['1300', 'Tax Receivable'],
      ['2200', 'Sales Tax Payable'],
    ];
    for (const [code, name] of legacyAccounts) {
      const account = db.prepare('SELECT * FROM accounts WHERE code = ? AND name = ?').get(code, name);
      if (!account) continue;
      try {
        db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
      } catch {
        db.prepare("UPDATE accounts SET is_active = 0, name = name || ' (archived)' WHERE id = ?").run(account.id);
      }
    }
    db.prepare("UPDATE settings SET currency = 'AED', setup_version = 2 WHERE id = 1").run();
  })();
}
ensureColumn('booking_items', 'portal_id', 'INTEGER');
// A booking row is one passenger: its sale and cost lines share line_group,
// and passenger_name builds the invoice line ("destination – passenger").
ensureColumn('booking_items', 'passenger_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('booking_items', 'line_group', 'INTEGER');
ensureColumn('visa_items', 'passenger_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('visa_items', 'line_group', 'INTEGER');
ensureColumn('customer_advances', 'visa_id', 'INTEGER');

// Indexes that reference columns added by migrations must be created after them.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_portals_vendor ON supplier_portals(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_topups_portal ON portal_topups(portal_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_portal ON portal_refunds(portal_id);
  CREATE INDEX IF NOT EXISTS idx_bills_portal ON bills(portal_id);
  CREATE INDEX IF NOT EXISTS idx_bill_payments_portal ON bill_payments(portal_id);
  CREATE INDEX IF NOT EXISTS idx_visas_status ON visa_applications(status);
  CREATE INDEX IF NOT EXISTS idx_visa_items_visa ON visa_items(visa_id);
  CREATE INDEX IF NOT EXISTS idx_visas_group ON visa_applications(group_id);
  CREATE INDEX IF NOT EXISTS idx_advances_visa ON customer_advances(visa_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_invoice ON refunds(invoice_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_bill ON refunds(bill_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_bill_payment ON refunds(bill_payment_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_type_date ON refunds(refund_type, refund_date);
  CREATE INDEX IF NOT EXISTS idx_refunds_party ON refunds(party_id);
  CREATE INDEX IF NOT EXISTS idx_compliance_due ON compliance_items(status, next_due_date);
  CREATE INDEX IF NOT EXISTS idx_compliance_kind ON compliance_items(kind);
  CREATE INDEX IF NOT EXISTS idx_compliance_logs_item ON compliance_logs(item_id);
  CREATE INDEX IF NOT EXISTS idx_pdc_item ON post_dated_cheques(compliance_item_id);
  CREATE INDEX IF NOT EXISTS idx_pdc_vendor ON post_dated_cheques(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_pdc_status_date ON post_dated_cheques(status, cheque_date);
  CREATE INDEX IF NOT EXISTS idx_cash_deposits_date ON cash_deposits(deposit_date);
  CREATE INDEX IF NOT EXISTS idx_cash_deposits_status ON cash_deposits(status);
  CREATE INDEX IF NOT EXISTS idx_cancellations_source ON cancellations(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_cancellations_date ON cancellations(cancellation_date);
  CREATE INDEX IF NOT EXISTS idx_supplier_credits_vendor ON supplier_credit_notes(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_supplier_credits_bill ON supplier_credit_notes(bill_id);
  CREATE INDEX IF NOT EXISTS idx_supplier_credits_source ON supplier_credit_notes(booking_id, visa_id);
  CREATE INDEX IF NOT EXISTS idx_supplier_credit_items_note ON supplier_credit_items(credit_note_id);
  CREATE INDEX IF NOT EXISTS idx_supplier_credit_apps_note ON supplier_credit_applications(credit_note_id);
  CREATE INDEX IF NOT EXISTS idx_supplier_credit_apps_bill ON supplier_credit_applications(bill_id);
  CREATE INDEX IF NOT EXISTS idx_portal_credits_portal ON portal_credits(portal_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_cancellation ON refunds(cancellation_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_supplier_credit ON refunds(supplier_credit_note_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_advance ON refunds(advance_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_credit_note ON refunds(credit_note_id);
`);

// Keep the original day-of-month for schedules. Existing items start from
// their current due date; future periods are calculated from this anchor.
db.prepare('UPDATE compliance_items SET anchor_date = next_due_date WHERE anchor_date IS NULL').run();
db.prepare('UPDATE post_dated_cheques SET anchor_date = cheque_date WHERE anchor_date IS NULL').run();

// Required travel accounts are guarded by name only when they are first
// adopted. Once an account is a system account, its name may be customised;
// the stable code still identifies it. A user-created account already using
// this code is never renamed or adopted automatically.
function ensureRequiredAccount(code, name) {
  const account = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  if (!account) {
    throw new Error(`Required account ${code} ${name} is missing. Restore the default chart of accounts before starting.`);
  }
  if (!account.is_system && account.name !== name) {
    throw new Error(
      `Account code ${code} is already used by "${account.name}". Netfare requires ${code} to be "${name}". `
      + 'Rename the existing account code before starting; Netfare will never rename your accounts.',
    );
  }
  if (!account.is_system) db.prepare('UPDATE accounts SET is_system = 1 WHERE id = ?').run(account.id);
}

// IFRS account names (IAS 1 / IFRS 15). Only accounts still carrying the old
// default name are renamed; a name the user changed is left alone.
const IFRS_ACCOUNT_NAMES = [
  ['1100', 'Accounts Receivable', 'Trade Receivables'],
  ['1200', 'Prepaid Expenses', 'Prepayments'],
  ['1400', 'Supplier Advances', 'Advances to Suppliers'],
  ['1460', 'Deposits with Suppliers', 'Refundable Deposits Paid'],
  ['2000', 'Accounts Payable', 'Trade Payables'],
  ['2400', 'Customer Advances', 'Contract Liabilities (Customer Advances)'],
  ['2500', 'Refund Payable', 'Refund Liabilities'],
  ['2600', 'Visa Security Deposits Held', 'Refundable Security Deposits Held'],
  ['4300', 'Service Charges & Markup', 'Service Fee Income'],
  ['4330', 'Cancellation Charges Income', 'Cancellation Fee Income'],
  ['5000', 'Air Ticket Cost', 'Cost of Sales – Air Tickets'],
  ['5100', 'Hotel & Tour Cost', 'Cost of Sales – Hotels & Tours'],
  ['5120', 'Visa & Supplier Cost', 'Cost of Sales – Visas'],
];
for (const [code, oldName, newName] of IFRS_ACCOUNT_NAMES) {
  db.prepare('UPDATE accounts SET name = ? WHERE code = ? AND name = ?').run(newName, code, oldName);
}
// Visa supplier cost is cost of sales, like ticket and tour cost.
db.prepare("UPDATE accounts SET subtype = 'cogs' WHERE code = '5120' AND subtype = 'operating_expense'").run();

ensureRequiredAccount('1450', 'Supplier Credits');
ensureRequiredAccount('4330', 'Cancellation Fee Income');
ensureRequiredAccount('1460', 'Refundable Deposits Paid');
ensureRequiredAccount('2600', 'Refundable Security Deposits Held');
ensureRequiredAccount('4340', 'Forfeited Deposit Income');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_visa_deposits_visa ON visa_deposits(visa_id);
  CREATE INDEX IF NOT EXISTS idx_visa_deposits_customer ON visa_deposits(customer_id);
  CREATE INDEX IF NOT EXISTS idx_visa_deposit_events_deposit ON visa_deposit_events(deposit_id);
  CREATE INDEX IF NOT EXISTS idx_refunds_deposit ON refunds(deposit_id);
  CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
  CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);
  CREATE INDEX IF NOT EXISTS idx_invoices_booking ON invoices(booking_id);
  CREATE INDEX IF NOT EXISTS idx_invoices_visa ON invoices(visa_id);
  CREATE INDEX IF NOT EXISTS idx_bills_booking ON bills(booking_id);
  CREATE INDEX IF NOT EXISTS idx_bills_visa ON bills(visa_id);
`);

// Travel account labels are name-aware and safe to check on every start.
db.prepare("UPDATE accounts SET name = 'Ticket Sales' WHERE code = '4000' AND name = 'Sales Revenue'").run();
db.prepare("UPDATE accounts SET name = 'Tour & Package Sales' WHERE code = '4100' AND name = 'Service Revenue'").run();
db.prepare("UPDATE accounts SET name = 'Cost of Sales – Air Tickets' WHERE code = '5000' AND name IN ('Cost of Goods Sold', 'Air Ticket Cost')").run();
db.prepare("UPDATE accounts SET is_system = 1 WHERE code = '1400' AND is_system = 0").run();

// A booking, visa or cancellation note voided by the admin (job-void.js,
// cancellations.voidCancellation): when, and why. The record stays.
for (const table of ['bookings', 'visa_applications', 'cancellations']) {
  ensureColumn(table, 'voided_at', 'TEXT');
  ensureColumn(table, 'void_remarks', "TEXT NOT NULL DEFAULT ''");
}

// Customer and supplier numbers (CUS-0001, SUP-0001): see party-numbers.js.
for (const table of ['customers', 'vendors']) {
  ensureColumn(table, 'number', "TEXT NOT NULL DEFAULT ''");
  db.exec(`DROP TRIGGER IF EXISTS ${table}_number; CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_number ON ${table}(number) WHERE number <> '';`);
}
require('./party-numbers').numberMissing(db);

};
