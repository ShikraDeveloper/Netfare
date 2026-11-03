'use strict';

// Opening balances entered when a customer, supplier or portal is created.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-party-opening-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const partyOpening = require('../server/services/party-opening');
const portalService = require('../server/services/portals');
const invoiceService = require('../server/services/invoices');
const reconciliation = require('../server/services/reconciliation');
const { dailySales } = require('../server/services/reports/daily-sales');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function balance(code) {
  return db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS net
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
  `).get(code).net;
}

function party(table, name) {
  const id = Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

const asOf = '2026-11-01';

test('a customer who owes us gets an opening invoice that is paid the normal way, and is not a sale', () => {
  const customer = party('customers', 'Opening Owes');
  const result = partyOpening.forCustomer(db, customer, { direction: 'they_owe', amount_cents: 120_000, as_of: asOf });
  assert.equal(result.kind, 'invoice');
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(result.id);
  assert.deepEqual([invoice.status, invoice.total_cents, invoice.is_opening, invoice.issue_date], ['sent', 120_000, 1, asOf]);
  assert.equal(balance('1100'), 120_000);
  assert.equal(balance('3900'), -120_000);

  const bank = db.prepare("SELECT id FROM accounts WHERE code = '1010'").get().id;
  invoiceService.recordInvoicePayment(db, invoice.id, { amount_cents: 120_000, payment_date: asOf, method: 'Bank transfer', deposit_account_id: bank });
  assert.equal(db.prepare('SELECT amount_paid_cents FROM invoices WHERE id = ?').get(invoice.id).amount_paid_cents, 120_000);

  const sales = dailySales(db, asOf, asOf);
  const saleNumbers = sales.days.flatMap((day) => day.rows.map((row) => row.number));
  assert.ok(!saleNumbers.includes(invoice.number), 'opening invoices are not sales');
  assert.equal(sales.totals.sale_cents, 0);
});

test('we owe a customer: a customer credit; we owe a supplier: a bill; a supplier owes us: a supplier credit', () => {
  const customer = party('customers', 'Opening Credit');
  const credit = partyOpening.forCustomer(db, customer, { direction: 'we_owe', amount_cents: 30_000, as_of: asOf });
  assert.equal(credit.kind, 'credit_note');
  assert.equal(balance('2450'), -30_000);

  const vendor = party('vendors', 'Opening Supplier');
  const bill = partyOpening.forVendor(db, vendor, { direction: 'we_owe', amount_cents: 70_000, as_of: asOf });
  assert.equal(bill.kind, 'bill');
  assert.deepEqual({ ...db.prepare('SELECT status, total_cents, is_opening FROM bills WHERE id = ?').get(bill.id) }, { status: 'received', total_cents: 70_000, is_opening: 1 });
  assert.equal(balance('2000'), -70_000);

  const owesUs = party('vendors', 'Opening Supplier Owes');
  const supplierCredit = partyOpening.forVendor(db, owesUs, { direction: 'they_owe', amount_cents: 15_000, as_of: asOf });
  assert.equal(supplierCredit.kind, 'supplier_credit');
  assert.equal(balance('1450'), 15_000);
  assert.equal(partyOpening.forVendor(db, owesUs, { amount_cents: '' }), null, 'no amount, nothing is posted');
});

test('a portal balance becomes wallet money; a portal payable becomes a bill for its supplier', () => {
  const vendor = party('vendors', 'Opening Portal Supplier');
  const portal = portalService.createPortal(db, { name: 'Opening Portal', portal_type: 'airline', settlement: 'prepaid', vendor_id: vendor.id });
  const held = partyOpening.forPortal(db, portal, { direction: 'they_owe', amount_cents: 250_000, as_of: asOf });
  assert.equal(held.kind, 'portal_topup');
  assert.equal(portalService.getPortal(db, portal.id).balance_cents, 250_000);
  const owed = partyOpening.forPortal(db, portal, { direction: 'we_owe', amount_cents: 40_000, as_of: asOf });
  assert.equal(owed.kind, 'bill');
  assert.equal(db.prepare('SELECT portal_id FROM bills WHERE id = ?').get(owed.id).portal_id, portal.id);
  assert.throws(() => partyOpening.forPortal(db, portal, { direction: 'sideways', amount_cents: 1 }), /who owes/);
});

test('the books stay balanced and every ledger check still matches', () => {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  const summary = reconciliation.reconciliationSummary(db);
  assert.deepEqual(summary.checks.filter((check) => !check.matched).map((check) => check.code || check.label), []);
});
