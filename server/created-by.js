'use strict';

// Who made each document: the signed-in user's name is stamped on the record
// when it is created (journal entries stamp themselves in postEntry). Records
// made before logins existed or by scripts stay blank; sample data takes the
// name of the admin who loaded it.

const { currentUser } = require('./request-context');

const CREATED_BY_TABLES = [
  'bookings', 'visa_applications', 'visa_groups', 'visa_deposits',
  'invoices', 'payments', 'customer_advances', 'credit_notes', 'refunds', 'cancellations',
  'bills', 'bill_payments', 'supplier_credit_notes',
  'portal_topups', 'portal_refunds', 'portal_credits',
  'cash_deposits', 'post_dated_cheques', 'card_settlements', 'petty_cash_counts',
  'journal_entries',
  'customers', 'vendors', 'supplier_portals', 'compliance_items',
];
const TRACKED = new Set(CREATED_BY_TABLES);

function creatorName() {
  return currentUser()?.full_name || '';
}

function markCreated(db, table, id) {
  if (!TRACKED.has(table)) throw new Error(`created_by is not tracked for ${table}`);
  const name = creatorName();
  if (name && id) db.prepare(`UPDATE ${table} SET created_by = ? WHERE id = ?`).run(name, Number(id));
  return id;
}

// Records edited from their form: who saved the last change, and when
// (routes/index.js stamps it on a successful PUT /:kind/:id).
const CHANGED_BY_TABLES = {
  accounts: 'accounts',
  bills: 'bills',
  bookings: 'bookings',
  cheques: 'post_dated_cheques',
  compliance: 'compliance_items',
  customers: 'customers',
  invoices: 'invoices',
  portals: 'supplier_portals',
  vendors: 'vendors',
  visas: 'visa_applications',
};

function markChanged(db, table, id) {
  const name = creatorName();
  if (name && id) db.prepare(`UPDATE ${table} SET changed_by = ?, changed_at = datetime('now') WHERE id = ?`).run(name, Number(id));
}

module.exports = { CREATED_BY_TABLES, CHANGED_BY_TABLES, creatorName, markCreated, markChanged };
