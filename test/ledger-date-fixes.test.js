'use strict';

// Regression tests for the 2026-11-10 audit: past-date aging, money used
// before it existed, a voided supplier refund, and portal wallets below zero.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netfare-ledger-dates-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const refunds = require('../server/services/refunds');
const advances = require('../server/services/advances');
const credits = require('../server/services/credits');
const portals = require('../server/services/portals');
const deposits = require('../server/services/visa-deposits');
const { arAging } = require('../server/services/reports/aging');
const { balanceAsOf } = require('../server/services/portals/common');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const balance = (code, asOf = '9999-12-31') => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS net
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id
  WHERE a.code = ? AND e.entry_date <= ?
`).get(code, asOf).net;
let count = 0;
const customer = () => Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(`Dates customer ${++count}`).lastInsertRowid);
const vendor = () => Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(`Dates vendor ${++count}`).lastInsertRowid);
const visa = (customerId) => Number(db.prepare(
  "INSERT INTO visa_applications (number, customer_id, application_date, status) VALUES (?, ?, '2026-01-01', 'submitted')",
).run(`VDT-${++count}`, customerId).lastInsertRowid);
const invoice = (customerId, date, amount) => invoices.createInvoice(db, {
  customer_id: customerId, issue_date: date, status: 'sent',
  items: [{ description: 'Service fee', quantity: 1, unit_price_cents: amount, account_id: account('4300').id }],
});
const bill = (vendorId, date, amount) => bills.createBill(db, {
  vendor_id: vendorId, bill_date: date, status: 'received',
  items: [{ description: 'Ticket', quantity: 1, unit_price_cents: amount, account_id: account('6000').id }],
});
const wallet = () => {
  const vendorId = vendor();
  return { vendorId, portal: portals.createPortal(db, { name: `Wallet ${++count}`, portal_type: 'airline', settlement: 'prepaid', vendor_id: vendorId }) };
};
const topUp = (portal, date, amount) => portals.topUp(db, { portal_id: portal.id, topup_date: date, amount_cents: amount, deposit_account_id: account('1010').id });

test('aging as of a past date counts only what was owed on that date', () => {
  const customerId = customer();
  const name = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId).name;
  const paidLater = invoice(customerId, '2026-10-01', 1_000);
  invoices.recordInvoicePayment(db, paidLater.id, { amount_cents: 1_000, payment_date: '2026-11-05', deposit_account_id: account('1010').id });
  invoice(customerId, '2026-11-03', 700);
  const row = arAging(db, '2026-10-31').rows.find((party) => party.party_name === name);
  assert.equal(row.total_cents, 1_000, 'paid after the date: still owed then; issued after the date: not yet');
  assert.equal(row.invoices[0].days_overdue, 30);
  assert.equal(arAging(db).rows.find((party) => party.party_name === name).total_cents, 700, 'today is unchanged');
});

test('advances, credits and deposits cannot be used before they or the invoice exist', () => {
  const customerId = customer();
  const inv = invoice(customerId, '2026-04-10', 5_000);
  const advance = advances.createAdvance(db, { customer_id: customerId, amount_cents: 5_000, advance_date: '2026-04-20', deposit_account_id: account('1010').id });
  assert.throws(() => advances.applyAdvance(db, advance.id, { invoice_id: inv.id, payment_date: '2026-04-15' }), /before the advance was received/);
  assert.throws(() => advances.refundAdvance(db, advance.id, { refund_date: '2026-04-19', payment_account_id: account('1010').id }), /before the advance was received/);

  const early = advances.createAdvance(db, { customer_id: customerId, amount_cents: 1_000, advance_date: '2026-04-01', deposit_account_id: account('1010').id });
  assert.throws(() => advances.applyAdvance(db, early.id, { invoice_id: inv.id, payment_date: '2026-04-05' }), /before the invoice date/);

  const note = credits.createCredit(db, { customer_id: customerId, credit_date: '2026-04-20', amount_cents: 500, revenue_account_id: account('4300').id });
  assert.throws(() => credits.applyCredit(db, note.id, { invoice_id: inv.id, amount_cents: 500, applied_date: '2026-04-15' }), /before the credit note date/);

  const deposit = deposits.collectDeposit(db, { visa_id: visa(customerId), amount_cents: 500, deposit_date: '2026-04-01', account_id: account('1010').id });
  assert.throws(() => deposits.applyToInvoice(db, deposit.id, { invoice_id: inv.id, amount_cents: 500, event_date: '2026-04-05' }), /before the invoice date/);

  advances.applyAdvance(db, advance.id, { invoice_id: inv.id, payment_date: '2026-04-20' });
  assert.equal(balance('2400', '2026-04-15'), -1_000, 'on 15 Apr only the early advance is held');
});

test('voiding a supplier refund also voids the credit note it made', () => {
  const vendorId = vendor();
  const b = bill(vendorId, '2026-03-01', 10_000);
  const paid = bills.recordBillPayment(db, b.id, { amount_cents: 10_000, payment_date: '2026-03-01', payment_account_id: account('1010').id });
  const costBefore = balance('6000');
  const supplierCreditsBefore = balance('1450');
  const refund = refunds.createRefund(db, {
    refund_type: 'supplier', bill_payment_id: paid.payments[0].id, amount_cents: 4_000, refund_date: '2026-03-05', account_id: account('1010').id,
  });
  refunds.voidRefund(db, refund.id, { remarks: 'Never received' });
  assert.equal(balance('6000'), costBefore, 'cost is back to the full bill');
  assert.equal(balance('1450'), supplierCreditsBefore, 'no supplier credit is left behind');
  assert.equal(db.prepare('SELECT status FROM supplier_credit_notes WHERE id = ?').get(refund.supplier_credit_note_id).status, 'void');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM journal_entries WHERE reversal_of_id = ?').get(refund.journal_entry_id).c, 1, 'reversed once');
});
