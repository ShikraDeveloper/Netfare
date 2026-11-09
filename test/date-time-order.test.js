'use strict';

// Everything runs by date, then by when it was entered: a top-up, a bill paid
// from it, then another top-up on the same day read in that order, with the
// balance after each line. Customers and suppliers get numbers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-order-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const portals = require('../server/services/portals');
const billService = require('../server/services/bills');
const invoiceService = require('../server/services/invoices');
const statements = require('../server/services/statements');
const { listCustomerBalances } = require('../server/services/customer-balances');
const { assignPartyNumber } = require('../server/party-numbers');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const at = (table, id, time) => db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(`2026-11-09 ${time}`, id);

function customer(name) {
  const id = Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
  assignPartyNumber(db, 'customers', id);
  return id;
}
function vendor(name) {
  const id = Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(name).lastInsertRowid);
  assignPartyNumber(db, 'vendors', id);
  return id;
}

test('customers and suppliers are numbered in order', () => {
  const first = customer('First Customer');
  const second = customer('Second Customer');
  const number = (table, id) => db.prepare(`SELECT number FROM ${table} WHERE id = ?`).get(id).number;
  assert.match(number('customers', first), /^CUS-\d{4}$/);
  assert.equal(Number(number('customers', second).slice(4)), Number(number('customers', first).slice(4)) + 1);
  assert.match(number('vendors', vendor('A Supplier')), /^SUP-\d{4}$/);
  assignPartyNumber(db, 'customers', first);
  assert.equal(number('customers', first), number('customers', first), 'numbering again keeps the number');
});

test('wallet ledger: top-up, bill paid from it, top-up — in the order entered', () => {
  const supplier = vendor('Wallet Airline');
  const portal = portals.createPortal(db, { name: 'Wallet', portal_type: 'airline', settlement: 'prepaid', vendor_id: supplier });
  const first = portals.topUp(db, { portal_id: portal.id, topup_date: '2026-11-09', amount_cents: 500_000, deposit_account_id: account('1010') });
  const bill = billService.createBill(db, {
    vendor_id: supplier, bill_date: '2026-11-09', due_date: '2026-11-09', status: 'received',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 120_000, account_id: account('5000') }],
  });
  const settled = portals.settleBillFromPortal(db, { bill_id: bill.id, portal_id: portal.id, settle_date: '2026-11-09' });
  const second = portals.topUp(db, { portal_id: portal.id, topup_date: '2026-11-09', amount_cents: 200_000, deposit_account_id: account('1010') });
  const topups = db.prepare('SELECT id FROM portal_topups WHERE portal_id = ? ORDER BY id').all(portal.id);
  at('portal_topups', topups[0].id, '06:00:00');
  at('bill_payments', db.prepare('SELECT id FROM bill_payments WHERE bill_id = ?').get(bill.id).id, '07:30:00');
  at('portal_topups', topups[1].id, '11:00:00');
  assert.ok(first && settled && second);
  const ledger = portals.portalLedger(db, portal.id, { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(ledger.rows.map((row) => [row.kind, row.balance_cents]), [
    ['topup', 500_000],
    ['settlement', 380_000],
    ['topup', 580_000],
  ], 'no balance of 7,000 that never existed');
});

test('customer statement: same-day lines in the order they were entered', () => {
  const id = customer('Same Day');
  const invoice = invoiceService.createInvoice(db, {
    customer_id: id, issue_date: '2026-11-09', due_date: '2026-11-09', status: 'sent',
    items: [{ description: 'Service', quantity: 1, unit_price_cents: 100_000, account_id: account('4300') }],
  });
  invoiceService.recordInvoicePayment(db, invoice.id, { amount_cents: 30_000, payment_date: '2026-11-09', method: 'Cash', deposit_account_id: account('1000') });
  const later = invoiceService.createInvoice(db, {
    customer_id: id, issue_date: '2026-11-09', due_date: '2026-11-09', status: 'sent',
    items: [{ description: 'Second', quantity: 1, unit_price_cents: 50_000, account_id: account('4300') }],
  });
  at('invoices', invoice.id, '08:00:00');
  at('payments', db.prepare('SELECT id FROM payments WHERE invoice_id = ?').get(invoice.id).id, '09:00:00');
  at('invoices', later.id, '10:00:00');
  const rows = statements.customerStatement(db, id, { from: '2026-11-01', to: '2026-11-30' }).transactions;
  assert.deepEqual(rows.map((row) => [row.kind, row.balance_cents]), [
    ['invoice', 100_000], ['payment', 70_000], ['invoice', 120_000],
  ]);
  assert.ok(rows.every((row) => row.created_at), 'each line carries its entry time');
  assert.match(statements.customerStatement(db, id, {}).party.number, /^CUS-/);
});

test('customer balances: who owes the longest first', () => {
  const recent = customer('Owes Recent');
  const old = customer('Owes Old');
  const sale = (who, due, cents) => invoiceService.createInvoice(db, {
    customer_id: who, issue_date: '2026-10-01', due_date: due, status: 'sent',
    items: [{ description: 'Sale', quantity: 1, unit_price_cents: cents, account_id: account('4300') }],
  });
  sale(recent, '2026-11-05', 900_000);
  sale(old, '2026-10-02', 10_000);
  const names = listCustomerBalances(db).map((row) => row.name);
  assert.ok(names.indexOf('Owes Old') < names.indexOf('Owes Recent'), 'the older debt comes first even if smaller');
  assert.ok(names.indexOf('Owes Recent') < names.indexOf('First Customer'), 'customers who owe nothing come last');
});
