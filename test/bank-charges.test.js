'use strict';

// Bank charges taken on a transfer: posted to 6700 Bank Charges in the same
// entry as the payment or refund, so the document settles in full and a
// void reverses both.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-bank-charges-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');
const refundService = require('../server/services/refunds');
const reconciliation = require('../server/services/reconciliation');

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const balance = (code) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
`).get(code).total;
const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Charges Customer')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Charges Airline')").run().lastInsertRowid);

function sentInvoice(amount = 100_000) {
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId, issue_date: '2026-10-01', status: 'sent',
    items: [{ description: 'Service', quantity: 1, unit_price_cents: amount, account_id: account('4300').id }],
  });
  return invoice.status === 'sent' ? invoice : invoiceService.finalizeInvoice(db, invoice.id);
}

function receivedBill(amount = 50_000) {
  return billService.createBill(db, {
    vendor_id: vendorId, bill_date: '2026-10-01', due_date: '2026-10-01', status: 'received',
    items: [{ description: 'Fare', quantity: 1, unit_price_cents: amount, account_id: account('5000').id }],
  });
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a customer transfer with bank charges settles the invoice in full; the bank gets the net', () => {
  const invoice = sentInvoice(100_000);
  const bankBefore = balance('1010');
  const paid = invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: 100_000, payment_date: '2026-10-02', deposit_account_id: account('1010').id, bank_charges_cents: 1_500,
  });
  assert.equal(paid.status_display, 'paid');
  assert.equal(paid.payments[0].bank_charges_cents, 1_500);
  assert.equal(balance('1010') - bankBefore, 98_500, 'what actually arrived');
  assert.equal(balance('6700'), 1_500);
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);

  invoiceService.deleteInvoicePayment(db, paid.payments[0].id, { remarks: 'Bounced' });
  assert.equal(balance('1010'), bankBefore, 'the void reverses the charge too');
  assert.equal(balance('6700'), 0);
});

test('a supplier payment with bank charges: supplier paid in full, the charge on top', () => {
  const bill = receivedBill(50_000);
  const bankBefore = balance('1010');
  const paid = billService.recordBillPayment(db, bill.id, {
    amount_cents: 50_000, payment_date: '2026-10-03', payment_account_id: account('1010').id, bank_charges_cents: 1_050,
  });
  assert.equal(paid.status_display, 'paid');
  assert.equal(bankBefore - balance('1010'), 51_050);
  assert.equal(balance('6700'), 1_050);
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);
});

test('refunds carry bank charges both ways, and the amount limits apply', () => {
  const invoice = sentInvoice(20_000);
  const paid = invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: 20_000, payment_date: '2026-10-04', deposit_account_id: account('1010').id,
  });
  const before6700 = balance('6700');
  const refund = refundService.createRefund(db, {
    refund_type: 'customer', payment_id: paid.payments[0].id, amount_cents: 5_000,
    refund_date: '2026-10-05', account_id: account('1010').id, bank_charges_cents: 500,
  });
  assert.equal(refund.bank_charges_cents, 500);
  assert.equal(balance('6700') - before6700, 500);

  const bill = receivedBill(30_000);
  const billPaid = billService.recordBillPayment(db, bill.id, {
    amount_cents: 30_000, payment_date: '2026-10-04', payment_account_id: account('1010').id,
  });
  assert.throws(
    () => refundService.createRefund(db, {
      refund_type: 'supplier', bill_payment_id: billPaid.payments[0].id, amount_cents: 1_000,
      refund_date: '2026-10-06', account_id: account('1010').id, bank_charges_cents: 1_001,
    }),
    (error) => error.status === 400 && /more than the amount/.test(error.message),
  );
  assert.throws(
    () => invoiceService.recordInvoicePayment(db, sentInvoice(1_000).id, {
      amount_cents: 1_000, payment_date: '2026-10-02', deposit_account_id: account('1010').id, bank_charges_cents: -1,
    }),
    (error) => error.status === 400,
  );
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);
});

test('a bank charge added during bank reconciliation is a paid 6700 expense on the account, ready to tick', () => {
  const bankRecs = require('../server/services/bank-reconciliations');
  const before6700 = balance('6700');
  const { bill, entry_id: entryId } = bankRecs.recordBankCharge(db, {
    account_id: account('1010').id, amount_cents: 2_625, charge_date: '2026-10-31', description: 'Account maintenance Oct',
  });
  assert.equal(bill.status_display, 'paid');
  assert.equal(bill.vendor_name, 'Bank Account (bank debits)');
  assert.equal(bill.payments[0].method, 'Bank debit');
  assert.equal(balance('6700') - before6700, 2_625);
  const workspace = bankRecs.getWorkspace(db, { account_id: account('1010').id, statement_date: '2026-10-31' });
  const line = workspace.lines.find((row) => row.entry_id === entryId);
  assert.equal(line.amount_cents, -2_625, 'the charge shows as a bank line to clear');
  assert.throws(
    () => bankRecs.recordBankCharge(db, { account_id: account('6700').id, amount_cents: 100 }),
    (error) => error.status === 400,
  );
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);
});
