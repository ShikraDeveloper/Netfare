'use strict';

// Customer advances: used for the job's invoice on confirm / submit, shown on
// the customer statement, and recordable without a job.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-advance-fixes-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const visaService = require('../server/services/visas');
const advanceService = require('../server/services/advances');
const invoiceService = require('../server/services/invoices');
const statements = require('../server/services/statements');
const reconciliation = require('../server/services/reconciliation');

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const customer = (name) => Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Advance Airline')").run().lastInsertRowid);

function draftBooking(customerId, date = '2026-10-10', sale = 100_000) {
  return bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: date,
    due_date: date,
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: sale, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: sale - 20_000, account_id: account('5000').id, vendor_id: vendorId }],
  });
}

function advance(customerId, amount, date, links = {}) {
  return advanceService.createAdvance(db, {
    customer_id: customerId, amount_cents: amount, advance_date: date, deposit_account_id: account('1010').id, ...links,
  });
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('confirming a booking uses its open advances for the new invoice, oldest first, up to the total', () => {
  const customerId = customer('Advance Booking');
  const booking = draftBooking(customerId, '2026-10-10', 100_000);
  const first = advance(customerId, 30_000, '2026-10-01', { booking_id: booking.id });
  const second = advance(customerId, 90_000, '2026-10-12', { booking_id: booking.id });
  const confirmed = bookingService.confirmBooking(db, booking.id, { apply_advances: true });
  assert.deepEqual(confirmed.applied_advances, [
    { number: first.number, amount_cents: 30_000 },
    { number: second.number, amount_cents: 70_000 },
  ]);
  const invoice = invoiceService.getInvoice(db, confirmed.invoice_id);
  assert.equal(invoice.status_display, 'paid');
  assert.deepEqual(invoice.payments.map((p) => [p.method, p.payment_date]), [
    ['Advance applied', '2026-10-10'],
    ['Advance applied', '2026-10-12'],
  ], 'dated the later of the invoice and the advance');
  assert.equal(advanceService.getAdvance(db, second.id).remaining_cents, 20_000, 'the rest stays as an advance');
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);
});

test('without the option, or for another job, nothing is applied', () => {
  const customerId = customer('Advance Untouched');
  const booking = draftBooking(customerId, '2026-10-11');
  const other = draftBooking(customerId, '2026-10-11');
  advance(customerId, 40_000, '2026-10-05', { booking_id: other.id });
  advance(customerId, 40_000, '2026-10-05', { booking_id: booking.id });
  const confirmed = bookingService.confirmBooking(db, booking.id);
  assert.equal(confirmed.applied_advances, undefined);
  assert.equal(invoiceService.getInvoice(db, confirmed.invoice_id).amount_paid_cents, 0);
  const otherConfirmed = bookingService.confirmBooking(db, other.id, { apply_advances: true });
  assert.equal(invoiceService.getInvoice(db, otherConfirmed.invoice_id).amount_paid_cents, 40_000, 'only its own advance');
});

test('submitting a visa, alone or as a group, uses its advances too', () => {
  const customerId = customer('Advance Visa');
  const visa = visaService.createVisa(db, {
    customer_id: customerId,
    application_date: '2026-10-15',
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 35_000, account_id: account('4320').id }],
  });
  advance(customerId, 10_000, '2026-10-14', { visa_id: visa.id });
  const submitted = visaService.submitVisa(db, visa.id, { apply_advances: true });
  assert.equal(invoiceService.getInvoice(db, submitted.invoice_id).amount_paid_cents, 10_000);

  const { group, applications } = visaService.createVisaGroup(db, {
    customer_id: customerId,
    application_date: '2026-10-16',
    applicants: [1, 2].map((n) => ({ applicant_name: `Group ${n}`, sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 20_000, account_id: account('4320').id }] })),
  });
  advance(customerId, 20_000, '2026-10-16', { visa_id: applications[1].id });
  visaService.submitVisaGroup(db, group.id, { apply_advances: true });
  const paid = applications.map((row) => invoiceService.getInvoice(db, visaService.getVisa(db, row.id).invoice_id).amount_paid_cents);
  assert.deepEqual(paid, [0, 20_000]);
});

test('the customer statement shows advances held as their own balance', () => {
  const customerId = customer('Advance Statement');
  const general = advance(customerId, 50_000, '2026-10-02');
  const voided = advance(customerId, 7_000, '2026-10-03');
  advanceService.voidAdvance(db, voided.id, { remarks: 'Wrong customer' });
  const booking = draftBooking(customerId, '2026-10-20', 30_000);
  const invoiceId = bookingService.confirmBooking(db, booking.id).invoice_id;
  advanceService.applyAdvance(db, general.id, { invoice_id: invoiceId, payment_date: '2026-10-20' });
  advanceService.refundAdvance(db, general.id, { amount_cents: 5_000, refund_date: '2026-10-22', payment_account_id: account('1010').id });

  const statement = statements.customerStatement(db, customerId, { to: '2026-12-31' });
  assert.deepEqual(
    statement.advances.transactions.map((row) => [row.event_type, row.credit_cents, row.debit_cents, row.balance_cents]),
    [['received', 50_000, 0, 50_000], ['applied', 0, 30_000, 20_000], ['refunded', 0, 5_000, 15_000]],
  );
  assert.equal(statement.advances.closing_held_cents, advanceService.getAdvance(db, general.id).remaining_cents);
  assert.equal(statement.closing_balance_cents, 0, 'the invoice is paid; advances are not part of the amount due');
  const later = statements.customerStatement(db, customerId, { from: '2026-10-21', to: '2026-12-31' });
  assert.equal(later.advances.opening_held_cents, 20_000);
});

test('an advance can be recorded for a customer without a booking or visa, and used or refunded', () => {
  const customerId = customer('Advance General');
  const general = advance(customerId, 25_000, '2026-10-05');
  assert.equal(general.booking_id, null);
  assert.equal(general.visa_id, null);
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId, issue_date: '2026-10-06',
    items: [{ description: 'Service', quantity: 1, unit_price_cents: 10_000, account_id: account('4300').id }],
  });
  const applied = advanceService.applyAdvance(db, general.id, { invoice_id: invoice.id, payment_date: '2026-10-06' });
  assert.equal(applied.applied_cents, 10_000);
  advanceService.refundAdvance(db, general.id, { refund_date: '2026-10-07', payment_account_id: account('1010').id });
  assert.equal(advanceService.getAdvance(db, general.id).remaining_cents, 0);
});
