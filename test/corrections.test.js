'use strict';

// Correct (admin): the original is voided and a new one posted with the
// corrected values, all or nothing. Values not sent keep the original's.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-corrections-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const portals = require('../server/services/portals');
const advances = require('../server/services/advances');
const cashDeposits = require('../server/services/cash-deposits');
const reconciliation = require('../server/services/reconciliation');
const { correct, correctDocument } = require('../server/services/corrections');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const balance = (code) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS n
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
`).get(code).n;
const party = (table, name) => Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);

function sentInvoice(name, cents = 100_000) {
  return invoices.createInvoice(db, {
    customer_id: party('customers', name), issue_date: '2026-11-01', due_date: '2026-11-01', status: 'sent',
    items: [{ description: 'Service', quantity: 1, unit_price_cents: cents, account_id: account('4300') }],
  });
}

function checksMatch() {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  assert.deepEqual(reconciliation.reconciliationSummary(db).checks.filter((check) => !check.matched).map((check) => check.code || check.label), []);
}

test('a received payment: wrong amount and account corrected in one step', () => {
  const invoice = sentInvoice('Payer');
  invoices.recordInvoicePayment(db, invoice.id, { amount_cents: 60_000, payment_date: '2026-11-02', method: 'Cash', deposit_account_id: account('1000'), reference: 'R-1' });
  const payment = db.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(invoice.id);
  const cash = balance('1000');
  const bank = balance('1010');

  assert.throws(() => correct(db, 'payment', payment.id, { values: { amount_cents: 50_000 } }), /Reason is required/);
  const result = correct(db, 'payment', payment.id, {
    remarks: 'Paid 500 by transfer, not 600 cash',
    values: { amount_cents: 50_000, method: 'Bank transfer', deposit_account_id: account('1010') },
  });

  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status, 'void');
  const fresh = db.prepare('SELECT * FROM payments WHERE id = ?').get(result.id);
  assert.deepEqual([fresh.amount_cents, fresh.payment_date, fresh.reference, fresh.method], [50_000, '2026-11-02', 'R-1', 'Bank transfer'], 'unsent values are kept');
  assert.equal(invoices.getInvoice(db, invoice.id).amount_paid_cents, 50_000);
  assert.equal(cash - balance('1000'), 60_000);
  assert.equal(balance('1010') - bank, 50_000);
  const asOf = (code, date) => db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS n FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ? AND e.entry_date <= ?
  `).get(code, date).n;
  assert.equal(asOf('1000', '2026-11-02') - asOf('1000', '2026-11-01'), 0, 'on its own date the wrong cash payment is gone');
  assert.equal(asOf('1010', '2026-11-02') - asOf('1010', '2026-11-01'), 50_000, 'and the corrected transfer is there');
  const log = db.prepare("SELECT * FROM audit_logs WHERE action = 'correct' AND entity_id = ?").get(payment.id);
  assert.match(log.remarks, new RegExp(`${payment.number} → ${fresh.number} · Paid 500`));
  checksMatch();
});

test('all or nothing: if the new one cannot post, the original stays', () => {
  const invoice = sentInvoice('Too Much', 50_000);
  invoices.recordInvoicePayment(db, invoice.id, { amount_cents: 20_000, payment_date: '2026-11-02', method: 'Cash', deposit_account_id: account('1000') });
  const payment = db.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(invoice.id);
  assert.throws(() => correct(db, 'payment', payment.id, { remarks: 'x', values: { amount_cents: 60_000 } }), /exceeds the outstanding balance/);
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status, 'posted');
  assert.equal(invoices.getInvoice(db, invoice.id).amount_paid_cents, 20_000);
  assert.throws(() => correct(db, 'payment', 999_999, { remarks: 'x' }), /not found/);
});

test('a bill payment, a top-up and a withdrawal', () => {
  const vendor = party('vendors', 'Wallet Supplier');
  const bill = bills.createBill(db, {
    vendor_id: vendor, bill_date: '2026-11-01', due_date: '2026-11-01', status: 'received',
    items: [{ description: 'Cost', quantity: 1, unit_price_cents: 80_000, account_id: account('5000') }],
  });
  bills.recordBillPayment(db, bill.id, { amount_cents: 80_000, payment_date: '2026-11-02', method: 'Bank transfer', payment_account_id: account('1010') });
  const billPayment = db.prepare('SELECT * FROM bill_payments WHERE bill_id = ?').get(bill.id);
  const fixed = correct(db, 'bill_payment', billPayment.id, { remarks: 'Part paid', values: { amount_cents: 30_000 } });
  assert.equal(db.prepare('SELECT amount_cents FROM bill_payments WHERE id = ?').get(fixed.id).amount_cents, 30_000);
  assert.equal(bills.getBill(db, bill.id).amount_paid_cents, 30_000);

  const portal = portals.createPortal(db, { name: 'Wallet', portal_type: 'airline', settlement: 'prepaid', vendor_id: vendor });
  portals.topUp(db, { portal_id: portal.id, topup_date: '2026-11-03', amount_cents: 100_000, deposit_account_id: account('1010') });
  const topup = db.prepare('SELECT * FROM portal_topups WHERE portal_id = ?').get(portal.id);
  correct(db, 'topup', topup.id, { remarks: 'Top-up was 1,200', values: { amount_cents: 120_000 } });
  assert.equal(portals.getPortal(db, portal.id).balance_cents, 120_000);

  portals.refundPortal(db, portal.id, { refund_date: '2026-11-04', amount_cents: 20_000, payment_account_id: account('1010') });
  const withdrawal = db.prepare('SELECT * FROM portal_refunds WHERE portal_id = ?').get(portal.id);
  correct(db, 'portal_refund', withdrawal.id, { remarks: 'Withdrew 500', values: { amount_cents: 50_000 } });
  assert.equal(portals.getPortal(db, portal.id).balance_cents, 70_000);
  checksMatch();
});

test('an unused advance and a cash deposit; a used advance is voided instead', () => {
  const customer = party('customers', 'Advance Customer');
  advances.createAdvance(db, { customer_id: customer, advance_date: '2026-11-01', amount_cents: 40_000, method: 'Cash', deposit_account_id: account('1000') });
  const advance = db.prepare('SELECT * FROM customer_advances WHERE customer_id = ?').get(customer);
  const fixed = correct(db, 'advance', advance.id, { remarks: 'It was 450', values: { amount_cents: 45_000 } });
  const fresh = db.prepare('SELECT * FROM customer_advances WHERE id = ?').get(fixed.id);
  assert.deepEqual([fresh.amount_cents, fresh.customer_id, fresh.advance_date], [45_000, customer, '2026-11-01']);
  assert.ok(db.prepare('SELECT voided_at FROM customer_advances WHERE id = ?').get(advance.id).voided_at);

  const invoice = invoices.createInvoice(db, {
    customer_id: customer, issue_date: '2026-11-02', due_date: '2026-11-02', status: 'sent',
    items: [{ description: 'Service', quantity: 1, unit_price_cents: 10_000, account_id: account('4300') }],
  });
  advances.applyAdvance(db, fresh.id, { invoice_id: invoice.id, amount_cents: 10_000, applied_date: '2026-11-02' });
  assert.throws(() => correct(db, 'advance', fresh.id, { remarks: 'x' }), /used or refunded/);
  const fromAdvance = db.prepare('SELECT id FROM payments WHERE advance_id = ?').get(fresh.id);
  assert.throws(() => correct(db, 'payment', fromAdvance.id, { remarks: 'x' }), /came from a customer advance/);

  cashDeposits.createDeposit(db, { deposit_date: '2026-11-03', amount_cents: 20_000, from_account_id: account('1000'), to_account_id: account('1010') });
  const deposit = db.prepare('SELECT * FROM cash_deposits ORDER BY id DESC LIMIT 1').get();
  const movedBank = balance('1010');
  correct(db, 'cash_deposit', deposit.id, { remarks: 'Deposited 150', values: { amount_cents: 15_000 } });
  assert.equal(movedBank - balance('1010'), 5_000);
  checksMatch();
});

test('an invoice: lines corrected, payments and credits move across with the same numbers', () => {
  const invoice = sentInvoice('Invoice Fix', 100_000);
  invoices.recordInvoicePayment(db, invoice.id, { amount_cents: 40_000, payment_date: '2026-11-02', method: 'Cash', deposit_account_id: account('1000') });
  const payment = db.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(invoice.id);
  const sales = balance('4300');
  const cash = balance('1000');

  assert.throws(() => correctDocument(db, 'invoice', invoice.id, {
    remarks: 'x', values: { items: [{ description: 'Service', quantity: 1, unit_price_cents: 30_000, account_id: account('4300') }] },
  }), /less than what was paid/);
  assert.equal(invoices.getInvoice(db, invoice.id).status, 'sent', 'nothing changed');

  const fixed = correctDocument(db, 'invoice', invoice.id, {
    remarks: 'Price was 900',
    values: { items: [{ description: 'Service', quantity: 1, unit_price_cents: 90_000, account_id: account('4300') }] },
  });
  assert.equal(fixed.total_cents, 90_000);
  assert.equal(fixed.issue_date, '2026-11-01', 'same date by default');
  assert.equal(fixed.amount_paid_cents, 40_000);
  assert.deepEqual(fixed.payments.map((row) => row.number), [payment.number], 'the receipt keeps its number');
  assert.equal(invoices.getInvoice(db, invoice.id).status, 'void');
  assert.equal(sales - balance('4300'), -10_000, 'sales down by 100');
  assert.equal(balance('1000'), cash, 'cash untouched');
  assert.throws(() => correctDocument(db, 'invoice', invoice.id, { remarks: 'x' }), /Only a posted invoice/);
  checksMatch();
});

test('a bill: corrected, its payment moves across; a job bill is refused', () => {
  const vendor = party('vendors', 'Bill Fix');
  const bill = bills.createBill(db, {
    vendor_id: vendor, bill_date: '2026-11-01', due_date: '2026-11-01', status: 'received',
    items: [{ description: 'Rent', quantity: 1, unit_price_cents: 50_000, account_id: account('5000') }],
  });
  bills.recordBillPayment(db, bill.id, { amount_cents: 20_000, payment_date: '2026-11-02', method: 'Bank transfer', payment_account_id: account('1010') });
  const fixed = correctDocument(db, 'bill', bill.id, {
    remarks: 'Rent is 550', values: { items: [{ description: 'Rent', quantity: 1, unit_price_cents: 55_000, account_id: account('5000') }] },
  });
  assert.equal(fixed.total_cents, 55_000);
  assert.equal(fixed.amount_paid_cents, 20_000);
  assert.equal(bills.getBill(db, bill.id).status, 'void');
  checksMatch();
});
