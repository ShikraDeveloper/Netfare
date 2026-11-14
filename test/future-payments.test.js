'use strict';

// A payment, receipt, credit or refund changes what is owed at once, while
// its ledger entry only counts from its date. One dated after today would
// show a different balance from the ledger until that date, so it is refused.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-future-payments-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const advances = require('../server/services/advances');
const credits = require('../server/services/credits');
const refunds = require('../server/services/refunds');
const { todayISO } = require('../server/util');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const today = todayISO();
const tomorrow = todayISO(new Date(Date.now() + 86_400_000));
const future = (fn) => assert.throws(fn, (error) => error.status === 400 && /cannot be in the future/.test(error.message));
const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Future Payer')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Future Supplier')").run().lastInsertRowid);

test('payments, receipts, credits and refunds dated after today are refused; today is fine', () => {
  const invoice = invoices.createInvoice(db, {
    customer_id: customerId, issue_date: today, due_date: today, status: 'sent',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 100_000, account_id: account('4300').id }],
  });
  const pay = (date) => invoices.recordInvoicePayment(db, invoice.id, { amount_cents: 10_000, payment_date: date, deposit_account_id: account('1010').id });
  future(() => pay(tomorrow));
  assert.equal(invoices.getInvoice(db, invoice.id).amount_paid_cents, 0, 'the invoice is not marked paid');
  const paidToday = pay(today).payments.at(-1);
  future(() => refunds.createRefund(db, {
    refund_type: 'customer', payment_id: paidToday.id, amount_cents: 1_000, refund_date: tomorrow, account_id: account('1010').id,
  }));
  assert.equal(invoices.getInvoice(db, invoice.id).amount_paid_cents, 10_000, 'a refund dated ahead does not reopen the invoice now');

  future(() => advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 5_000, receipt_date: tomorrow, deposit_account_id: account('1010').id, allocations: [],
  }));

  const credit = credits.createCredit(db, {
    customer_id: customerId, credit_date: today, amount_cents: 5_000, revenue_account_id: account('4300').id,
  });
  future(() => credits.applyCredit(db, credit.id, { invoice_id: invoice.id, amount_cents: 5_000, applied_date: tomorrow }));

  const bill = bills.createBill(db, {
    vendor_id: vendorId, bill_date: today, due_date: today, status: 'received',
    items: [{ description: 'Fare', quantity: 1, unit_price_cents: 5_000, account_id: account('5000').id }],
  });
  future(() => bills.recordBillPayment(db, bill.id, { amount_cents: 5_000, payment_date: tomorrow, payment_account_id: account('1010').id }));
  assert.equal(bills.getBill(db, bill.id).amount_paid_cents, 0);
});
