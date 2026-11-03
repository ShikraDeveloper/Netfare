'use strict';

// An opening balance for one customer, supplier or portal, entered by the
// admin when the record is created. Each becomes an ordinary document, so it
// shows on statements and aging and is paid or used the normal way. The other
// side is 3900 Opening Balance Equity, and opening invoices are not sales.
//
//   customer owes us              → invoice          Dr 1100 · Cr 3900
//   we owe the customer           → credit note      Dr 3900 · Cr 2450
//   we owe the supplier           → bill             Dr 3900 · Cr 2000
//   the supplier owes us          → supplier credit  Dr 1450 · Cr 3900
//   money held on a portal        → portal top-up    Dr 1400 · Cr 3900
//   we owe the portal's supplier  → bill             Dr 3900 · Cr 2000

const { bad, cents, dateISO, todayISO, optionalStr } = require('../util');
const { postEntry, systemAccount, SYSTEM_CODES } = require('../accounting');
const { markCreated } = require('../created-by');
const { allocateNumber } = require('./numbering');
const audit = require('./audit');

const DESCRIPTION = 'Opening balance';
const DIRECTIONS = ['they_owe', 'we_owe'];

// payload.opening = { direction: 'they_owe' | 'we_owe', amount_cents, as_of, notes }
// Returns null when no opening balance was entered.
function parseOpening(input) {
  if (!input || input.amount_cents == null || input.amount_cents === '' || Number(input.amount_cents) === 0) return null;
  if (!DIRECTIONS.includes(input.direction)) throw bad('Choose who owes the opening balance');
  return {
    direction: input.direction,
    amount: cents(input.amount_cents, 'Opening balance', { min: 1 }),
    date: dateISO(input.as_of || todayISO(), 'Opening balance date'),
    notes: optionalStr(input.notes, 'Opening balance notes', 500),
  };
}

function equity(db) {
  return systemAccount(db, SYSTEM_CODES.OPENING_BALANCE_EQUITY, 'Opening Balance Equity');
}

function record(db, entityType, id, number, remarks) {
  audit.record(db, { entity_type: entityType, entity_id: id, entity_number: number, action: 'create', remarks });
}

function openingInvoice(db, customer, { amount, date, notes }) {
  const number = allocateNumber(db, 'invoice', date);
  const info = db.prepare(`
    INSERT INTO invoices (number, customer_id, issue_date, due_date, status, notes, subtotal_cents, total_cents, is_opening)
    VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, 1)
  `).run(number, customer.id, date, date, notes || DESCRIPTION, amount, amount);
  const id = Number(info.lastInsertRowid);
  markCreated(db, 'invoices', id);
  db.prepare(`
    INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, amount_cents, account_id, sort_order)
    VALUES (?, ?, 1, ?, ?, ?, 0)
  `).run(id, DESCRIPTION, amount, amount, equity(db).id);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Opening balance ${number} — ${customer.name}`,
    reference: number,
    source_type: 'invoice',
    source_id: id,
    lines: [
      { account_id: systemAccount(db, SYSTEM_CODES.AR, 'Trade Receivables').id, debit_cents: amount, credit_cents: 0, description: `${DESCRIPTION} · ${customer.name}` },
      { account_id: equity(db).id, debit_cents: 0, credit_cents: amount, description: `${DESCRIPTION} · ${customer.name}` },
    ],
  });
  db.prepare('UPDATE invoices SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  record(db, 'invoice', id, number, `Opening balance: ${customer.name} owes this`);
  return { kind: 'invoice', id, number, amount_cents: amount };
}

function openingCredit(db, customer, { amount, date, notes }) {
  const number = allocateNumber(db, 'credit', date);
  const info = db.prepare(`
    INSERT INTO credit_notes (number, customer_id, credit_date, amount_cents, revenue_account_id, notes, is_opening)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(number, customer.id, date, amount, equity(db).id, notes || DESCRIPTION);
  const id = Number(info.lastInsertRowid);
  markCreated(db, 'credit_notes', id);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Opening balance ${number} — ${customer.name}`,
    reference: number,
    source_type: 'credit_note',
    source_id: id,
    lines: [
      { account_id: equity(db).id, debit_cents: amount, credit_cents: 0, description: `${DESCRIPTION} · ${customer.name}` },
      { account_id: systemAccount(db, '2450', 'Customer Credits').id, debit_cents: 0, credit_cents: amount, description: `${DESCRIPTION} · ${customer.name}` },
    ],
  });
  db.prepare('UPDATE credit_notes SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  record(db, 'credit_note', id, number, `Opening balance: owed to ${customer.name}`);
  return { kind: 'credit_note', id, number, amount_cents: amount };
}

function openingBill(db, vendor, { amount, date, notes }, portalId = null) {
  const number = allocateNumber(db, 'bill', date);
  const info = db.prepare(`
    INSERT INTO bills (number, vendor_id, bill_date, due_date, status, notes, subtotal_cents, total_cents, portal_id, is_opening)
    VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?, 1)
  `).run(number, vendor.id, date, date, notes || DESCRIPTION, amount, amount, portalId);
  const id = Number(info.lastInsertRowid);
  markCreated(db, 'bills', id);
  db.prepare(`
    INSERT INTO bill_items (bill_id, description, quantity, unit_price_cents, amount_cents, account_id, sort_order)
    VALUES (?, ?, 1, ?, ?, ?, 0)
  `).run(id, DESCRIPTION, amount, amount, equity(db).id);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Opening balance ${number} — ${vendor.name}`,
    reference: number,
    source_type: 'bill',
    source_id: id,
    lines: [
      { account_id: equity(db).id, debit_cents: amount, credit_cents: 0, description: `${DESCRIPTION} · ${vendor.name}` },
      { account_id: systemAccount(db, SYSTEM_CODES.AP, 'Trade Payables').id, debit_cents: 0, credit_cents: amount, description: `${DESCRIPTION} · ${vendor.name}` },
    ],
  });
  db.prepare('UPDATE bills SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  record(db, 'bill', id, number, `Opening balance: owed to ${vendor.name}`);
  return { kind: 'bill', id, number, amount_cents: amount };
}

function openingSupplierCredit(db, vendor, { amount, date, notes }) {
  const number = allocateNumber(db, 'supplier_credit', date);
  const info = db.prepare(`
    INSERT INTO supplier_credit_notes (number, vendor_id, credit_date, amount_cents, notes, is_opening)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(number, vendor.id, date, amount, notes || DESCRIPTION);
  const id = Number(info.lastInsertRowid);
  markCreated(db, 'supplier_credit_notes', id);
  db.prepare(`
    INSERT INTO supplier_credit_items (credit_note_id, description, amount_cents, account_id, sort_order)
    VALUES (?, ?, ?, ?, 0)
  `).run(id, DESCRIPTION, amount, equity(db).id);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Opening balance ${number} — ${vendor.name}`,
    reference: number,
    source_type: 'supplier_credit',
    source_id: id,
    lines: [
      { account_id: systemAccount(db, '1450', 'Supplier Credits').id, debit_cents: amount, credit_cents: 0, description: `${DESCRIPTION} · ${vendor.name}` },
      { account_id: equity(db).id, debit_cents: 0, credit_cents: amount, description: `${DESCRIPTION} · ${vendor.name}` },
    ],
  });
  db.prepare('UPDATE supplier_credit_notes SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  record(db, 'supplier_credit', id, number, `Opening balance: ${vendor.name} owes this`);
  return { kind: 'supplier_credit', id, number, amount_cents: amount };
}

function openingTopup(db, portal, { amount, date, notes }) {
  const number = allocateNumber(db, 'topup', date);
  const equityAccount = equity(db);
  const info = db.prepare(`
    INSERT INTO portal_topups (number, portal_id, topup_date, amount_cents, method, reference, notes, deposit_account_id)
    VALUES (?, ?, ?, ?, ?, '', ?, ?)
  `).run(number, portal.id, date, amount, DESCRIPTION, notes, equityAccount.id);
  const id = Number(info.lastInsertRowid);
  markCreated(db, 'portal_topups', id);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Opening balance ${number} — ${portal.name}`,
    reference: number,
    source_type: 'portal_topup',
    source_id: id,
    lines: [
      { account_id: systemAccount(db, SYSTEM_CODES.SUPPLIER_ADVANCES, 'Advances to Suppliers').id, debit_cents: amount, credit_cents: 0, description: `${DESCRIPTION} · ${portal.name}` },
      { account_id: equityAccount.id, debit_cents: 0, credit_cents: amount, description: `${DESCRIPTION} · ${portal.name}` },
    ],
  });
  db.prepare('UPDATE portal_topups SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  record(db, 'portal_topup', id, number, `Opening balance held on ${portal.name}`);
  return { kind: 'portal_topup', id, number, amount_cents: amount };
}

function forCustomer(db, customer, input) {
  const opening = parseOpening(input);
  if (!opening) return null;
  return opening.direction === 'they_owe' ? openingInvoice(db, customer, opening) : openingCredit(db, customer, opening);
}

function forVendor(db, vendor, input) {
  const opening = parseOpening(input);
  if (!opening) return null;
  return opening.direction === 'we_owe' ? openingBill(db, vendor, opening) : openingSupplierCredit(db, vendor, opening);
}

function forPortal(db, portal, input) {
  const opening = parseOpening(input);
  if (!opening) return null;
  if (!portal.vendor_id) throw bad('Link the portal to a supplier to give it an opening balance');
  if (opening.direction === 'they_owe') return openingTopup(db, portal, opening);
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(portal.vendor_id);
  return openingBill(db, vendor, opening, portal.id);
}

module.exports = { parseOpening, forCustomer, forVendor, forPortal };
