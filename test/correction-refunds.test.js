'use strict';

// Correct on a refund posts it again from where it came. One refund of each
// kind is corrected here, and the bank must then show the new amount only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netfare-correction-refunds-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const bookings = require('../server/services/bookings');
const cancellations = require('../server/services/cancellations');
const refunds = require('../server/services/refunds');
const advances = require('../server/services/advances');
const credits = require('../server/services/credits');
const supplierCredits = require('../server/services/supplier-credits');
const deposits = require('../server/services/visa-deposits');
const { correct, correctDocument } = require('../server/services/corrections');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const bank = () => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS net FROM journal_lines l WHERE l.account_id = ?
`).get(account('1010').id).net;
const lastRefund = () => db.prepare('SELECT * FROM refunds ORDER BY id DESC LIMIT 1').get();
let count = 0;
const customer = () => Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(`Refund customer ${++count}`).lastInsertRowid);
const vendor = () => Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(`Refund vendor ${++count}`).lastInsertRowid);
const serviceInvoice = (customerId, amount) => invoices.createInvoice(db, {
  customer_id: customerId, issue_date: '2026-10-01', status: 'sent',
  items: [{ description: 'Service fee', quantity: 1, unit_price_cents: amount, account_id: account('4300').id }],
});
const paid = (date = '2026-10-05') => ({ refund_date: date, account_id: account('1010').id });

// Corrects the latest refund to `amount` and checks the bank moved by the new amount only.
function correctLatest(direction, bankBefore, amount, extra = {}) {
  const original = lastRefund();
  const result = correct(db, 'refund', original.id, { remarks: 'Wrong amount', values: { amount_cents: amount, ...extra } });
  assert.equal(db.prepare('SELECT status FROM refunds WHERE id = ?').get(original.id).status, 'void');
  const fresh = db.prepare('SELECT * FROM refunds WHERE id = ?').get(result.id);
  assert.equal(fresh.amount_cents, amount);
  assert.equal(fresh.status, 'paid');
  assert.equal(bank() - bankBefore, direction * amount, 'the bank shows the corrected refund only');
  assert.equal(db.prepare('SELECT SUM(debit_cents) - SUM(credit_cents) AS diff FROM journal_lines').get().diff, 0);
  return fresh;
}

test('a refund of a customer payment', () => {
  const inv = serviceInvoice(customer(), 5_000);
  invoices.recordInvoicePayment(db, inv.id, { amount_cents: 5_000, payment_date: '2026-10-01', deposit_account_id: account('1010').id });
  const before = bank();
  const payment = db.prepare('SELECT id FROM payments WHERE invoice_id = ?').get(inv.id);
  refunds.createRefund(db, { refund_type: 'customer', payment_id: payment.id, amount_cents: 1_000, ...paid() });
  correctLatest(-1, before, 1_500);
});

test('a refund of a cancellation note', () => {
  const customerId = customer();
  const draft = bookings.createBooking(db, {
    customer_id: customerId, booking_date: '2026-10-01', due_date: '2026-10-01',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 8_000, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: 6_000, account_id: account('5000').id, vendor_id: vendor() }],
  });
  const booking = bookings.confirmBooking(db, draft.id);
  invoices.recordInvoicePayment(db, booking.invoice_id, { amount_cents: 8_000, payment_date: '2026-10-01', deposit_account_id: account('1010').id });
  const note = cancellations.cancelSource(db, { sourceType: 'booking', sourceId: booking.id, payload: { cancellation_date: '2026-10-03' } });
  const before = bank();
  cancellations.refundCancellation(db, note.id, { amount_cents: 2_000, ...paid() });
  correctLatest(-1, before, 3_000);
  assert.throws(() => correct(db, 'refund', lastRefund().id, { remarks: 'x', values: { bank_charges_cents: 50 } }), /not recorded on advance or cancellation refunds/);
});

test('a refund of a customer credit note', () => {
  const note = credits.createCredit(db, { customer_id: customer(), credit_date: '2026-10-01', amount_cents: 4_000, revenue_account_id: account('4300').id });
  const before = bank();
  credits.refundCredit(db, note.id, { amount_cents: 1_000, ...paid() });
  correctLatest(-1, before, 2_500);
});

test('a refund of a customer advance', () => {
  const advance = advances.createAdvance(db, { customer_id: customer(), amount_cents: 5_000, advance_date: '2026-10-01', deposit_account_id: account('1010').id });
  const before = bank();
  advances.refundAdvance(db, advance.id, { amount_cents: 1_000, refund_date: '2026-10-05', payment_account_id: account('1010').id });
  correctLatest(-1, before, 1_200);
  assert.throws(() => correct(db, 'refund', lastRefund().id, { remarks: 'x', values: { bank_charges_cents: 50 } }), /not recorded on advance or cancellation refunds/);
});

test('a refund of a supplier credit', () => {
  const note = supplierCredits.createSupplierCredit(db, {
    vendor_id: vendor(), credit_date: '2026-10-01',
    items: [{ description: 'Fare difference', amount_cents: 4_000, account_id: account('6000').id }],
  });
  const before = bank();
  supplierCredits.refundSupplierCredit(db, note.id, { amount_cents: 1_000, ...paid() });
  correctLatest(1, before, 2_000);
});

test('a supplier refund on a bill payment', () => {
  const bill = bills.createBill(db, {
    vendor_id: vendor(), bill_date: '2026-10-01', status: 'received',
    items: [{ description: 'Hotel', quantity: 1, unit_price_cents: 10_000, account_id: account('6000').id }],
  });
  const result = bills.recordBillPayment(db, bill.id, { amount_cents: 10_000, payment_date: '2026-10-01', payment_account_id: account('1010').id });
  const before = bank();
  refunds.createRefund(db, { refund_type: 'supplier', bill_payment_id: result.payments[0].id, amount_cents: 4_000, ...paid() });
  correctLatest(1, before, 3_000);
  const live = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM supplier_credit_notes WHERE bill_id = ? AND status = 'issued'").get(bill.id).total;
  assert.equal(live, 3_000, 'only the corrected credit note is left');
});
