'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.LEDGERLY_DATA_DIR
  ? path.resolve(process.env.LEDGERLY_DATA_DIR)
  : path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'accounting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL DEFAULT 'My Company',
  company_email TEXT NOT NULL DEFAULT '',
  company_phone TEXT NOT NULL DEFAULT '',
  company_address TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'AED',
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  bill_prefix TEXT NOT NULL DEFAULT 'BILL',
  next_invoice_number INTEGER NOT NULL DEFAULT 1,
  next_bill_number INTEGER NOT NULL DEFAULT 1,
  next_payment_number INTEGER NOT NULL DEFAULT 1,
  next_refund_number INTEGER NOT NULL DEFAULT 1,
  next_deposit_number INTEGER NOT NULL DEFAULT 1,
  next_credit_number INTEGER NOT NULL DEFAULT 1,
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  subtype TEXT NOT NULL DEFAULT '',
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  is_cash INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('draft', 'sent', 'void')),
  notes TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL DEFAULT '',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  credit_applied_cents INTEGER NOT NULL DEFAULT 0,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  payment_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'Bank transfer',
  reference TEXT NOT NULL DEFAULT '',
  cheque_number TEXT NOT NULL DEFAULT '',
  cheque_date TEXT,
  bank_name TEXT NOT NULL DEFAULT '',
  deposit_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  bill_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('draft', 'received', 'void')),
  notes TEXT NOT NULL DEFAULT '',
  default_payment_method TEXT NOT NULL DEFAULT 'Bank transfer',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  portal_id INTEGER,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bill_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bill_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  payment_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'Bank transfer',
  reference TEXT NOT NULL DEFAULT '',
  cheque_number TEXT NOT NULL DEFAULT '',
  cheque_date TEXT,
  bank_name TEXT NOT NULL DEFAULT '',
  payment_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  portal_id INTEGER,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  booking_date TEXT NOT NULL,
  due_date TEXT,
  travel_date TEXT,
  return_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'travelled', 'cancelled')),
  destination TEXT NOT NULL DEFAULT '',
  pnr TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  sale_total_cents INTEGER NOT NULL DEFAULT 0,
  cost_total_cents INTEGER NOT NULL DEFAULT 0,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS booking_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('sale', 'cost')),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  portal_id INTEGER,
  supplier_ref TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS visa_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  application_date TEXT NOT NULL,
  due_date TEXT,
  travel_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'issued', 'rejected', 'cancelled')),
  destination_country TEXT NOT NULL DEFAULT '',
  visa_type TEXT NOT NULL DEFAULT 'tourist',
  applicant_name TEXT NOT NULL DEFAULT '',
  nationality TEXT NOT NULL DEFAULT '',
  passport_number TEXT NOT NULL DEFAULT '',
  passport_expiry TEXT,
  date_of_birth TEXT,
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  sale_total_cents INTEGER NOT NULL DEFAULT 0,
  cost_total_cents INTEGER NOT NULL DEFAULT 0,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visa_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visa_id INTEGER NOT NULL REFERENCES visa_applications(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('sale', 'cost')),
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  supplier_ref TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  credit_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  amount_cents INTEGER NOT NULL,
  applied_cents INTEGER NOT NULL DEFAULT 0,
  revenue_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  notes TEXT NOT NULL DEFAULT '',
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credit_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_note_id INTEGER NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  applied_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer_advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  advance_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  applied_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'refunded')),
  method TEXT NOT NULL DEFAULT 'Bank transfer',
  reference TEXT NOT NULL DEFAULT '',
  deposit_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_portals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  portal_type TEXT NOT NULL DEFAULT 'other' CHECK (portal_type IN ('airline', 'iata_agency', 'consolidator', 'gds', 'other')),
  settlement TEXT NOT NULL DEFAULT 'prepaid' CHECK (settlement IN ('prepaid', 'credit')),
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  login_ref TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  credit_limit_cents INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portal_topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  portal_id INTEGER NOT NULL REFERENCES supplier_portals(id) ON DELETE RESTRICT,
  topup_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'Bank transfer',
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  deposit_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portal_refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_id INTEGER NOT NULL REFERENCES supplier_portals(id) ON DELETE RESTRICT,
  refund_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'Bank transfer',
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  payment_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  refund_type TEXT NOT NULL CHECK (refund_type IN ('customer', 'supplier')),
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'void')),
  party_id INTEGER NOT NULL,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL,
  bill_payment_id INTEGER REFERENCES bill_payments(id) ON DELETE SET NULL,
  refund_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'Bank transfer',
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS compliance_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recurring_bill', 'filing', 'renewal')),
  category TEXT NOT NULL DEFAULT 'other',
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  variable_amount INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'Bank transfer',
  frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly', 'once')),
  next_due_date TEXT NOT NULL,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  auto_create_bill INTEGER NOT NULL DEFAULT 0,
  reminder_days INTEGER NOT NULL DEFAULT 14,
  notes TEXT NOT NULL DEFAULT '',
  last_generated_date TEXT,
  last_completed_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS compliance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  event_date TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS post_dated_cheques (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compliance_item_id INTEGER REFERENCES compliance_items(id) ON DELETE SET NULL,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  cheque_number TEXT NOT NULL,
  cheque_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  bank_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'issued', 'cleared', 'bounced', 'cancelled')),
  bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL,
  bill_payment_id INTEGER REFERENCES bill_payments(id) ON DELETE SET NULL,
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  cleared_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cash_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  deposit_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice', 'bill', 'booking', 'visa')),
  entity_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_name TEXT NOT NULL UNIQUE,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  statement_date TEXT NOT NULL,
  statement_balance_cents INTEGER NOT NULL DEFAULT 0,
  cleared_balance_cents INTEGER NOT NULL DEFAULT 0,
  difference_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reconciled' CHECK (status IN ('reconciled', 'difference')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_reconciliation_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id INTEGER NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
  journal_line_id INTEGER NOT NULL UNIQUE REFERENCES journal_lines(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_entries_date ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_bills_vendor ON bills(vendor_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_bill ON bill_payments(bill_id);
CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items(booking_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_advances_customer ON customer_advances(customer_id);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_account ON bank_reconciliations(account_id, statement_date);
CREATE INDEX IF NOT EXISTS idx_bank_recon_lines_rec ON bank_reconciliation_lines(reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_customer ON credit_notes(customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_applications_note ON credit_applications(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_credit_applications_invoice ON credit_applications(invoice_id);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);
`);

const defaultAccounts = [
  // code, name, type, subtype, normal, is_cash, is_system
  ['1000', 'Cash', 'asset', 'current_asset', 'debit', 1, 0],
  ['1010', 'Bank Account', 'asset', 'current_asset', 'debit', 1, 0],
  ['1100', 'Accounts Receivable', 'asset', 'receivable', 'debit', 0, 1],
  ['1200', 'Prepaid Expenses', 'asset', 'current_asset', 'debit', 0, 0],
  ['1400', 'Supplier Advances', 'asset', 'current_asset', 'debit', 0, 0],
  ['1500', 'Equipment', 'asset', 'fixed_asset', 'debit', 0, 0],
  ['2000', 'Accounts Payable', 'liability', 'payable', 'credit', 0, 1],
  ['2100', 'Credit Card', 'liability', 'current_liability', 'credit', 0, 0],
  ['2400', 'Customer Advances', 'liability', 'current_liability', 'credit', 0, 1],
  ['2450', 'Customer Credits', 'liability', 'current_liability', 'credit', 0, 1],
  ['2500', 'Refund Payable', 'liability', 'current_liability', 'credit', 0, 1],
  ['3000', "Owner's Equity", 'equity', 'equity', 'credit', 0, 0],
  ['3100', 'Retained Earnings', 'equity', 'equity', 'credit', 0, 1],
  ['3900', 'Opening Balance Equity', 'equity', 'equity', 'credit', 0, 1],
  ['4000', 'Ticket Sales', 'revenue', 'operating_revenue', 'credit', 0, 1],
  ['4100', 'Tour & Package Sales', 'revenue', 'operating_revenue', 'credit', 0, 0],
  ['4200', 'Other Income', 'revenue', 'other_revenue', 'credit', 0, 0],
  ['4300', 'Service Charges & Markup', 'revenue', 'operating_revenue', 'credit', 0, 1],
  ['4310', 'Commission Income', 'revenue', 'other_revenue', 'credit', 0, 0],
  ['4320', 'Visa & Documentation Revenue', 'revenue', 'operating_revenue', 'credit', 0, 0],
  ['5000', 'Air Ticket Cost', 'expense', 'cogs', 'debit', 0, 0],
  ['5100', 'Hotel & Tour Cost', 'expense', 'cogs', 'debit', 0, 0],
  ['5120', 'Visa & Supplier Cost', 'expense', 'operating_expense', 'debit', 0, 0],
  ['6000', 'Rent Expense', 'expense', 'operating_expense', 'debit', 0, 0],
  ['6100', 'Utilities Expense', 'expense', 'operating_expense', 'debit', 0, 0],
  ['6200', 'Salaries & Wages', 'expense', 'operating_expense', 'debit', 0, 0],
  ['6300', 'Office Supplies', 'expense', 'operating_expense', 'debit', 0, 0],
  ['6400', 'Marketing', 'expense', 'operating_expense', 'debit', 0, 0],
  ['6500', 'Software & Subscriptions', 'expense', 'operating_expense', 'debit', 0, 0],
  ['6600', 'Travel & Meals', 'expense', 'operating_expense', 'debit', 0, 0],
  ['6900', 'Other Expenses', 'expense', 'other_expense', 'debit', 0, 0],
];

const insertAccount = db.prepare(`
  INSERT OR IGNORE INTO accounts (code, name, type, subtype, normal_balance, is_cash, is_system)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
db.transaction(() => {
  for (const row of defaultAccounts) insertAccount.run(...row);
})();

const settingsCount = db.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
if (settingsCount === 0) {
  db.prepare(`INSERT INTO settings (id, company_name) VALUES (1, 'My Company')`).run();
}

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

ensureColumn('settings', 'booking_prefix', "TEXT NOT NULL DEFAULT 'BK'");
ensureColumn('settings', 'next_booking_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'next_advance_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'topup_prefix', "TEXT NOT NULL DEFAULT 'TOP'");
ensureColumn('settings', 'next_topup_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'visa_prefix', "TEXT NOT NULL DEFAULT 'VIS'");
ensureColumn('settings', 'next_visa_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'next_refund_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'next_deposit_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'next_credit_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('settings', 'setup_version', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('invoices', 'booking_id', 'INTEGER');
ensureColumn('invoices', 'visa_id', 'INTEGER');
ensureColumn('invoices', 'credit_applied_cents', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('bills', 'booking_id', 'INTEGER');
ensureColumn('bills', 'visa_id', 'INTEGER');
ensureColumn('bills', 'portal_id', 'INTEGER');
ensureColumn('compliance_items', 'variable_amount', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('compliance_items', 'payment_method', "TEXT NOT NULL DEFAULT 'Bank transfer'");
ensureColumn('bills', 'default_payment_method', "TEXT NOT NULL DEFAULT 'Bank transfer'");
ensureColumn('attachments', 'data', 'BLOB');
ensureColumn('payments', 'advance_id', 'INTEGER');
ensureColumn('payments', 'cheque_number', "TEXT NOT NULL DEFAULT ''");
ensureColumn('payments', 'cheque_date', 'TEXT');
ensureColumn('payments', 'bank_name', "TEXT NOT NULL DEFAULT ''");
ensureColumn('bill_payments', 'portal_id', 'INTEGER');
ensureColumn('bill_payments', 'cheque_number', "TEXT NOT NULL DEFAULT ''");
ensureColumn('bill_payments', 'cheque_date', 'TEXT');
ensureColumn('bill_payments', 'bank_name', "TEXT NOT NULL DEFAULT ''");

// VAT/tax support was removed. Drop legacy columns on existing databases.
dropColumn('settings', 'tax_rate');
dropColumn('invoices', 'tax_rate');
dropColumn('invoices', 'tax_cents');
dropColumn('bills', 'tax_rate');
dropColumn('bills', 'tax_cents');
dropColumn('bookings', 'tax_rate');
dropColumn('visa_applications', 'tax_rate');
dropColumn('compliance_items', 'tax_rate');

for (const code of ['1300', '2200']) {
  const account = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  if (!account) continue;
  try {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
  } catch {
    db.prepare("UPDATE accounts SET is_active = 0, name = name || ' (archived)' WHERE id = ?").run(account.id);
  }
}
ensureColumn('booking_items', 'portal_id', 'INTEGER');
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
`);

// One-time travel-agency setup: AED currency and travel account labels.
const setup = db.prepare('SELECT setup_version FROM settings WHERE id = 1').get();
if (setup && Number(setup.setup_version || 0) < 1) {
  db.prepare("UPDATE settings SET currency = 'AED', setup_version = 1 WHERE id = 1").run();
}
db.prepare("UPDATE accounts SET name = 'Ticket Sales' WHERE code = '4000' AND name = 'Sales Revenue'").run();
db.prepare("UPDATE accounts SET name = 'Tour & Package Sales' WHERE code = '4100' AND name = 'Service Revenue'").run();
db.prepare("UPDATE accounts SET name = 'Air Ticket Cost' WHERE code = '5000' AND name = 'Cost of Goods Sold'").run();
db.prepare("UPDATE accounts SET is_system = 1 WHERE code = '1400' AND is_system = 0").run();

module.exports = db;
