'use strict';

// The admin voids a booking, a visa or a cancellation note entered by
// mistake. Everything it posted is reversed, so every account returns to
// exactly where it was before, and the record stays marked void.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-admin-void-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookings = require('../server/services/bookings');
const visas = require('../server/services/visas');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const cancellations = require('../server/services/cancellations');
const jobRefunds = require('../server/services/job-refunds');
const visaDeposits = require('../server/services/visa-deposits');
const reconciliation = require('../server/services/reconciliation');
const { voidJob } = require('../server/services/job-void');
const { dailySales } = require('../server/services/reports/daily-sales');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
// Every account's balance, to compare before and after.
const balances = () => Object.fromEntries(db.prepare(`
  SELECT a.code, COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS n
  FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id GROUP BY a.code
`).all().map((row) => [row.code, row.n]));

function party(table, name) {
  return Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);
}

// Sale 1,000 (two tickets), airline cost 800; customer paid 600, bill paid.
function paidBooking(name) {
  const customer = party('customers', name);
  const vendor = party('vendors', `Airline ${name}`);
  const draft = bookings.createBooking(db, {
    customer_id: customer, booking_date: '2026-11-01', due_date: '2026-11-01',
    sale_items: [{ description: 'Tickets', quantity: 1, unit_price_cents: 100_000, account_id: account('4000') }],
    cost_items: [{ description: 'Fares', quantity: 1, unit_price_cents: 80_000, account_id: account('5000'), vendor_id: vendor }],
  });
  const booking = bookings.confirmBooking(db, draft.id);
  invoices.recordInvoicePayment(db, booking.invoice_id, { amount_cents: 60_000, payment_date: '2026-11-01', method: 'Cash', deposit_account_id: account('1000') });
  bills.recordBillPayment(db, booking.bills[0].id, { amount_cents: 80_000, payment_date: '2026-11-01', method: 'Bank transfer', payment_account_id: account('1010') });
  return { booking, bill: booking.bills[0] };
}

function checksMatch() {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c, 'the books balance');
  assert.deepEqual(reconciliation.reconciliationSummary(db).checks.filter((check) => !check.matched).map((check) => check.code || check.label), []);
}

test('voiding a booking reverses everything it posted, refunds included', () => {
  const before = balances();
  const { booking, bill } = paidBooking('Mistake');
  jobRefunds.refundCustomer(db, 'booking', booking.id, { amount_cents: 10_000, date: '2026-11-02', account_id: account('1000') });
  jobRefunds.supplierRefund(db, 'booking', booking.id, { bill_id: bill.id, amount_cents: 20_000, date: '2026-11-03' });
  assert.notDeepEqual(balances(), before);

  assert.throws(() => voidJob(db, 'booking', booking.id, {}), /Reason is required/);
  voidJob(db, 'booking', booking.id, { remarks: 'Entered for the wrong customer' });
  assert.deepEqual(balances(), before, 'every account is back where it was');

  const voided = bookings.getBooking(db, booking.id);
  assert.equal(voided.status, 'cancelled');
  assert.equal(voided.status_display, 'void');
  assert.equal(voided.void_remarks, 'Entered for the wrong customer');
  assert.equal(voided.invoice.status, 'void');
  assert.ok(voided.bills.every((row) => row.status === 'void'));
  assert.equal(voided.customer_refunds.length, 0);
  assert.equal(voided.supplier_refunds.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cancellations WHERE source_id = ? AND source_type = ?').get(booking.id, 'booking').n, 0, 'no cancellation note');
  assert.ok(!bookings.bookingMarginReport(db, '2026-11-01', '2026-11-30').rows.some((row) => row.id === booking.id), 'out of the profit report');
  assert.ok(!dailySales(db, '2026-11-01', '2026-11-30').days.flatMap((day) => day.rows).some((row) => row.reference_id === booking.id && row.kind === 'booking'), 'out of daily sales');
  assert.throws(() => voidJob(db, 'booking', booking.id, { remarks: 'again' }), /already void/);
  checksMatch();
});

test('a visa can be voided, but not with a security deposit, and a draft is deleted instead', () => {
  const before = balances();
  const customer = party('customers', 'Visa Mistake');
  const vendor = party('vendors', 'Immigration Mistake');
  const draft = visas.createVisa(db, {
    customer_id: customer, application_date: '2026-11-01', destination_country: 'UAE', visa_type: 'tourist', applicant_is_customer: true,
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 50_000, account_id: account('4320') }],
    cost_items: [{ description: 'Fee', quantity: 1, unit_price_cents: 35_000, account_id: account('5120'), vendor_id: vendor }],
  });
  assert.throws(() => voidJob(db, 'visa', draft.id, { remarks: 'x' }), /delete it instead/);
  const visa = visas.submitVisa(db, draft.id);
  invoices.recordInvoicePayment(db, visa.invoice_id, { amount_cents: 50_000, payment_date: '2026-11-01', method: 'Cash', deposit_account_id: account('1000') });
  const deposit = visaDeposits.collectDeposit(db, { visa_id: visa.id, amount_cents: 100_000, deposit_date: '2026-11-01', account_id: account('1000') });
  visas.rejectVisa(db, visa.id, { rejection_date: '2026-11-04' });
  assert.throws(() => voidJob(db, 'visa', visa.id, { remarks: 'x' }), /Security deposit .* Settle or void it first/);
  visaDeposits.voidLastEvent(db, deposit.id, { remarks: 'Entered by mistake' });

  voidJob(db, 'visa', visa.id, { remarks: 'Duplicate application' });
  assert.deepEqual(balances(), before);
  assert.equal(visas.getVisa(db, visa.id).status_display, 'void');
  checksMatch();
});

test('voiding a cancellation note undoes it and puts the booking back', () => {
  const { booking } = paidBooking('Cancelled By Mistake');
  const atConfirm = balances();
  const note = bookings.cancelBooking(db, booking.id, { cancellation_date: '2026-11-05', customer_charges_cents: 15_000 }).cancellation
    || cancellations.getCancellationForSource(db, 'booking', booking.id);
  // Some of the refund paid, some kept as credit.
  cancellations.refundCancellation(db, note.id, { amount_cents: 20_000, refund_date: '2026-11-06', account_id: account('1000') });
  cancellations.convertCancellationToCredit(db, note.id, { amount_cents: 5_000, credit_date: '2026-11-06' });
  assert.throws(() => voidJob(db, 'booking', booking.id, { remarks: 'x' }), /Void cancellation note .* first/);

  const voided = cancellations.voidCancellation(db, note.id, { remarks: 'Customer did not cancel' });
  assert.deepEqual(balances(), atConfirm, 'every account is back to the confirmed booking');
  assert.ok(voided.voided_at);
  assert.equal(voided.refund_due_cents, 0);
  const back = bookings.getBooking(db, booking.id);
  assert.equal(back.status, 'confirmed');
  assert.equal(back.invoice.status, 'sent');
  assert.equal(back.invoice.amount_paid_cents, 60_000, 'the payment is on the invoice again');
  assert.equal(back.cancellation, null);
  assert.throws(() => cancellations.voidCancellation(db, note.id, { remarks: 'again' }), /already void/);

  // It can be cancelled again, or voided.
  bookings.cancelBooking(db, booking.id, { cancellation_date: '2026-11-07', customer_charges_cents: 0 });
  const second = cancellations.getCancellationForSource(db, 'booking', booking.id);
  assert.notEqual(second.id, note.id);
  checksMatch();
});

test('a cancellation with a charges invoice and supplier credits is undone too', () => {
  const customer = party('customers', 'Unpaid Cancel');
  const vendor = party('vendors', 'Airline Unpaid Cancel');
  const draft = bookings.createBooking(db, {
    customer_id: customer, booking_date: '2026-11-01', due_date: '2026-11-01',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 100_000, account_id: account('4000') }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: 80_000, account_id: account('5000'), vendor_id: vendor }],
  });
  const booking = bookings.confirmBooking(db, draft.id);
  const atConfirm = balances();
  bookings.cancelBooking(db, booking.id, {
    cancellation_date: '2026-11-05', customer_charges_cents: 20_000,
    supplier_credits: [{ bill_id: booking.bills[0].id, amount_cents: 50_000 }],
  });
  const note = cancellations.getCancellationForSource(db, 'booking', booking.id);
  assert.ok(note.cancellation_invoice_id, 'unpaid: charges invoice raised');
  invoices.recordInvoicePayment(db, note.cancellation_invoice_id, { amount_cents: 20_000, payment_date: '2026-11-06', method: 'Cash', deposit_account_id: account('1000') });

  cancellations.voidCancellation(db, note.id, { remarks: 'Wrong booking cancelled' });
  assert.deepEqual(balances(), atConfirm);
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(note.cancellation_invoice_id).status, 'void');
  assert.equal(bookings.getBooking(db, booking.id).status, 'confirmed');
  checksMatch();
});
