'use strict';

module.exports = `CREATE TABLE IF NOT EXISTS settings (
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
  supplier_credit_prefix TEXT NOT NULL DEFAULT 'SCN',
  next_supplier_credit_number INTEGER NOT NULL DEFAULT 1,
  cancellation_prefix TEXT NOT NULL DEFAULT 'CNC',
  next_cancellation_number INTEGER NOT NULL DEFAULT 1,
  portal_credit_prefix TEXT NOT NULL DEFAULT 'PCR',
  next_portal_credit_number INTEGER NOT NULL DEFAULT 1,
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
  reversal_of_id INTEGER,
  voided_at TEXT,
  void_entry_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  entity_number TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'void',
  remarks TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER,
  metadata TEXT NOT NULL DEFAULT '',
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
  cancellation_id INTEGER,
  beneficiary_is_customer INTEGER NOT NULL DEFAULT 1,
  beneficiary_name TEXT NOT NULL DEFAULT '',
  beneficiary_nationality TEXT NOT NULL DEFAULT '',
  beneficiary_passport TEXT NOT NULL DEFAULT '',
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
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  voided_at TEXT,
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
  credit_applied_cents INTEGER NOT NULL DEFAULT 0,
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
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  voided_at TEXT,
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
  invoice_notes TEXT NOT NULL DEFAULT '',
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
  passenger_name TEXT NOT NULL DEFAULT '',
  line_group INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Refundable security deposits taken for visas. Not a sale: the money is
-- held in 2600 until refunded, applied to an invoice or forfeited, and may be
-- passed to the visa supplier meanwhile (1460).
CREATE TABLE IF NOT EXISTS visa_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  visa_id INTEGER NOT NULL REFERENCES visa_applications(id) ON DELETE RESTRICT,
  deposit_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visa_deposit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deposit_id INTEGER NOT NULL REFERENCES visa_deposits(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('collect', 'to_supplier', 'supplier_return', 'refund', 'apply', 'forfeit')),
  event_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  deduction_cents INTEGER NOT NULL DEFAULT 0,
  forfeit_to TEXT CHECK (forfeit_to IN ('agency', 'supplier')),
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE RESTRICT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
  method TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  refund_id INTEGER REFERENCES refunds(id) ON DELETE SET NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  voided_at TEXT,
  void_remarks TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visa_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  duration_days INTEGER NOT NULL DEFAULT 0,
  applicant_name TEXT NOT NULL DEFAULT '',
  applicant_is_customer INTEGER NOT NULL DEFAULT 1,
  nationality TEXT NOT NULL DEFAULT '',
  passport_number TEXT NOT NULL DEFAULT '',
  passport_expiry TEXT,
  date_of_birth TEXT,
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  invoice_notes TEXT NOT NULL DEFAULT '',
  sale_total_cents INTEGER NOT NULL DEFAULT 0,
  cost_total_cents INTEGER NOT NULL DEFAULT 0,
  group_id INTEGER,
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
  passenger_name TEXT NOT NULL DEFAULT '',
  line_group INTEGER,
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
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  revenue_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  cancellation_id INTEGER,
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
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_portals (
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
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  voided_at TEXT,
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
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  voided_at TEXT,
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
  cancellation_id INTEGER,
  supplier_credit_note_id INTEGER,
  advance_id INTEGER,
  credit_note_id INTEGER,
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

CREATE TABLE IF NOT EXISTS cancellations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('booking', 'visa')),
  source_id INTEGER NOT NULL,
  cancellation_date TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  cancellation_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  customer_charges_cents INTEGER NOT NULL DEFAULT 0,
  received_cents INTEGER NOT NULL DEFAULT 0,
  supplier_credit_total_cents INTEGER NOT NULL DEFAULT 0,
  refund_due_cents INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  visa_id INTEGER REFERENCES visa_applications(id) ON DELETE SET NULL,
  cancellation_id INTEGER REFERENCES cancellations(id) ON DELETE SET NULL,
  credit_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  amount_cents INTEGER NOT NULL,
  applied_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  portal_settled_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supplier_credit_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_note_id INTEGER NOT NULL REFERENCES supplier_credit_notes(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS supplier_credit_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_note_id INTEGER NOT NULL REFERENCES supplier_credit_notes(id) ON DELETE CASCADE,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  applied_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS portal_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  portal_id INTEGER NOT NULL REFERENCES supplier_portals(id) ON DELETE RESTRICT,
  credit_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL,
  supplier_credit_note_id INTEGER REFERENCES supplier_credit_notes(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '',
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  voided_at TEXT,
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
  anchor_date TEXT,
  period_index INTEGER NOT NULL DEFAULT 0,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
  auto_create_bill INTEGER NOT NULL DEFAULT 0,
  auto_debit_account_id INTEGER REFERENCES accounts(id),
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
  anchor_date TEXT,
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

CREATE TABLE IF NOT EXISTS card_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  settlement_date TEXT NOT NULL,
  bank_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  gross_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS card_settlement_lines (
  settlement_id INTEGER NOT NULL REFERENCES card_settlements(id) ON DELETE CASCADE,
  journal_line_id INTEGER NOT NULL REFERENCES journal_lines(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (settlement_id, journal_line_id)
);

CREATE TABLE IF NOT EXISTS petty_cash_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  count_date TEXT NOT NULL,
  counted_cents INTEGER NOT NULL,
  book_cents INTEGER NOT NULL,
  difference_cents INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  void_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Logins. The first user is the admin, who manages the others. Passwords are
-- scrypt hashes; sessions store only a SHA-256 of the browser's token.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  permissions TEXT NOT NULL DEFAULT '{}',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  recovery_key_hash TEXT,
  recovery_key_created_at TEXT,
  recovery_key_confirmed INTEGER NOT NULL DEFAULT 0,
  recovery_key_uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS job_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('booking', 'visa')),
  source_id INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  event_date TEXT NOT NULL,
  remarks TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_status_history_job ON job_status_history(source_type, source_id);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice', 'bill', 'booking', 'visa', 'cancellation', 'refund', 'credit_note', 'supplier_credit', 'customer')),
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
  journal_line_id INTEGER NOT NULL UNIQUE REFERENCES journal_lines(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_lines_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_entries_date ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices(issue_date);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_bills_vendor ON bills(vendor_id);
CREATE INDEX IF NOT EXISTS idx_bills_bill_date ON bills(bill_date);
CREATE INDEX IF NOT EXISTS idx_bills_due_date ON bills(due_date);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_bill ON bill_payments(bill_id);
CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items(booking_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_advances_customer ON customer_advances(customer_id);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_account ON bank_reconciliations(account_id, statement_date);
CREATE INDEX IF NOT EXISTS idx_bank_recon_lines_rec ON bank_reconciliation_lines(reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_customer ON credit_notes(customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_date ON credit_notes(credit_date);
CREATE INDEX IF NOT EXISTS idx_credit_applications_note ON credit_applications(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_credit_applications_invoice ON credit_applications(invoice_id);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);
-- Indexes for columns added to existing tables belong in migrations.js, after
-- ALTER TABLE has added those columns. Creating them here breaks old databases.
CREATE INDEX IF NOT EXISTS idx_cancellations_source ON cancellations(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_cancellations_date ON cancellations(cancellation_date);
CREATE INDEX IF NOT EXISTS idx_supplier_credits_vendor ON supplier_credit_notes(vendor_id);
CREATE INDEX IF NOT EXISTS idx_supplier_credits_bill ON supplier_credit_notes(bill_id);
CREATE INDEX IF NOT EXISTS idx_supplier_credits_source ON supplier_credit_notes(booking_id, visa_id);
CREATE INDEX IF NOT EXISTS idx_supplier_credit_items_note ON supplier_credit_items(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_supplier_credit_apps_note ON supplier_credit_applications(credit_note_id);
CREATE INDEX IF NOT EXISTS idx_supplier_credit_apps_bill ON supplier_credit_applications(bill_id);
CREATE INDEX IF NOT EXISTS idx_portal_credits_portal ON portal_credits(portal_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;
