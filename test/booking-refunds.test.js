'use strict';

// Refunds on a booking, from its page: a part refund to the customer (for
// example one passenger) and an airline refund that comes later, often after
// the booking was cancelled. Each is its own line in daily sales on its date.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-booking-refunds-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookings = require('../server/services/bookings');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const jobRefunds = require('../server/services/job-refunds');
const supplierCredits = require('../server/services/supplier-credits');
const reconciliation = require('../server/services/reconciliation');
const { dailySales } = require('../server/services/reports/daily-sales');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const balance = (code) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS n
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
`).get(code).n;

// Two tickets 500 each (sale 1,000), airline cost 800, paid in full; the bill is paid.
function paidBooking(name) {
  const customer = Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
  const vendor = Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(`Airline ${name}`).lastInsertRowid);
  const draft = bookings.createBooking(db, {
    customer_id: customer, booking_date: '2026-11-01', due_date: '2026-11-01',
    sale_items: [
      { description: 'Ticket A', quantity: 1, unit_price_cents: 50_000, account_id: account('4000') },
      { description: 'Ticket B', quantity: 1, unit_price_cents: 50_000, account_id: account('4000') },
    ],
    cost_items: [{ description: 'Fares', quantity: 1, unit_price_cents: 80_000, account_id: account('5000'), vendor_id: vendor }],
  });
  const booking = bookings.confirmBooking(db, draft.id);
  invoices.recordInvoicePayment(db, booking.invoice_id, {
    amount_cents: 100_000, payment_date: '2026-11-01', method: 'Cash', deposit_account_id: account('1000'),
  });
  const bill = booking.bills[0];
  bills.recordBillPayment(db, bill.id, {
    amount_cents: 80_000, payment_date: '2026-11-01', method: 'Bank transfer', payment_account_id: account('1010'),
  });
  return { booking, bill, vendor };
}

const lines = (from, to, bookingId) => dailySales(db, from, to).days.flatMap((day) => day.rows)
  .filter((row) => row.kind === 'booking' && row.reference_id === bookingId)
  .map((row) => [row.issue_date, row.is_refund ? row.particulars.split(' · ')[0] : 'Sale', row.sale_cents, row.cost_cents]);

test('one passenger refunded: credit note paid from the bank, airline refund held then received', () => {
  const { booking, bill, vendor } = paidBooking('One Pax');
  const cash = balance('1010');
  jobRefunds.refundCustomer(db, 'booking', booking.id, { amount_cents: 40_000, date: '2026-11-05', account_id: account('1010') });
  jobRefunds.supplierRefund(db, 'booking', booking.id, { bill_id: bill.id, amount_cents: 35_000, date: '2026-11-07' });
  assert.equal(cash - balance('1010'), 40_000, 'paid to the customer');
  const shown = bookings.getBooking(db, booking.id);
  assert.deepEqual(shown.result, { sale_cents: 60_000, cost_cents: 45_000, margin_cents: 15_000 });
  assert.equal(shown.supplier_refunds[0].held_cents, 35_000, 'held with the airline');
  assert.equal(bookings.listBookings(db, {}).find((row) => row.id === booking.id).margin_cents, 15_000);
  const report = bookings.bookingMarginReport(db, '2026-11-01', '2026-11-30').rows.find((row) => row.id === booking.id);
  assert.deepEqual([report.sale_total_cents, report.cost_total_cents, report.margin_cents], [60_000, 45_000, 15_000]);

  assert.deepEqual(lines('2026-11-01', '2026-11-01', booking.id), [['2026-11-01', 'Sale', 100_000, 80_000]]);
  assert.deepEqual(lines('2026-11-05', '2026-11-05', booking.id), [['2026-11-05', 'Refund to customer', -40_000, 0]]);
  assert.deepEqual(lines('2026-11-07', '2026-11-07', booking.id), [['2026-11-07', 'Refund from supplier', 0, -35_000]]);

  supplierCredits.receiveVendorRefund(db, vendor, { amount_cents: 35_000, date: '2026-11-10', account_id: account('1010'), bank_charges_cents: 1_000 });
  assert.equal(balance('1010') - cash, -40_000 + 34_000);
});

test('cancelled booking: the airline refund weeks later is a dated line; the sale day is unchanged', () => {
  const { booking, bill } = paidBooking('Cancelled Later');
  bookings.cancelBooking(db, booking.id, { cancellation_date: '2026-11-03', customer_charges_cents: 15_000 });
  const before = lines('2026-11-01', '2026-11-03', booking.id);
  const afterCancel = bookings.getBooking(db, booking.id);
  assert.equal(afterCancel.customer_refunds.length, 0);
  jobRefunds.supplierRefund(db, 'booking', booking.id, { bill_id: bill.id, amount_cents: 60_000, date: '2026-11-25' });
  assert.deepEqual(lines('2026-11-01', '2026-11-03', booking.id), before, 'earlier days read the same');
  assert.deepEqual(lines('2026-11-25', '2026-11-25', booking.id), [['2026-11-25', 'Refund from supplier', 0, -60_000]]);
  // Kept 150 in charges; cost 800 − 600 = 200; profit −50.
  const report = bookings.bookingMarginReport(db, '2026-11-01', '2026-11-30').rows.find((row) => row.id === booking.id);
  assert.deepEqual([report.sale_total_cents, report.cost_total_cents, report.margin_cents], [15_000, 20_000, -5_000]);
  assert.equal(bookings.getBooking(db, booking.id).margin_cents, -5_000);
  assert.throws(() => jobRefunds.refundCustomer(db, 'booking', booking.id, { amount_cents: 1_000 }), /no open invoice/);
});

test('the books balance and every ledger check matches', () => {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  const summary = reconciliation.reconciliationSummary(db);
  assert.deepEqual(summary.checks.filter((check) => !check.matched).map((check) => check.code || check.label), []);
});
