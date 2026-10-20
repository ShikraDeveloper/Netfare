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


};
