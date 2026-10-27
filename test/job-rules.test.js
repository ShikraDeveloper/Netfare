'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-job-rules-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const visaService = require('../server/services/visas');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');
const auditChain = require('../server/services/audit-chain');
const { addDays, todayISO } = require('../server/util');

db.prepare('UPDATE settings SET payment_terms_days = 30 WHERE id = 1').run();

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

function insertCustomer(name) {
  return Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
}

function insertVendor(name) {
  return Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(name).lastInsertRowid);
}

function journalCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count;
}

const customerId = insertCustomer('Rules Customer');
const vendorId = insertVendor('Rules Airline');

function bookingPayload(extra = {}) {
  return {
    customer_id: customerId,
    booking_date: '2026-06-01',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 100_000, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: 80_000, account_id: account('5000').id, vendor_id: vendorId }],
    ...extra,
  };
}

function visaPayload(extra = {}) {
  return {
    customer_id: customerId,
    application_date: '2026-06-01',
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 30_000, account_id: account('4320').id }],
    ...extra,
  };
}

function assertBadRequest(fn, pattern) {
  assert.throws(fn, (error) => error.status === 400 && pattern.test(error.message));
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('due dates default to the company payment terms', () => {
  const booking = bookingService.createBooking(db, bookingPayload());
  assert.equal(booking.due_date, '2026-07-01', '30 days after the booking date');
  const visa = visaService.createVisa(db, visaPayload());
  assert.equal(visa.due_date, '2026-07-01');

  const explicit = bookingService.createBooking(db, bookingPayload({ due_date: '2026-06-05' }));
  assert.equal(explicit.due_date, '2026-06-05');
  // Editing without a due date keeps the one already set.
  const edited = bookingService.updateBooking(db, explicit.id, bookingPayload());
  assert.equal(edited.due_date, '2026-06-05');
});

test('the return date cannot be before the travel date', () => {
  assertBadRequest(
    () => bookingService.createBooking(db, bookingPayload({ travel_date: '2026-07-10', return_date: '2026-07-01' })),
    /Return date cannot be before the travel date/,
  );
  const sameDay = bookingService.createBooking(db, bookingPayload({ travel_date: '2026-07-10', return_date: '2026-07-10' }));
  assert.equal(sameDay.return_date, '2026-07-10');
});

test('a booking can only be marked travelled from its travel date', () => {
  const future = bookingService.confirmBooking(db, bookingService.createBooking(db, bookingPayload({
    travel_date: addDays(todayISO(), 30),
  })).id);
  assertBadRequest(() => bookingService.markTravelled(db, future.id), /Mark the booking as travelled on or after that date/);

  const past = bookingService.confirmBooking(db, bookingService.createBooking(db, bookingPayload({
    travel_date: addDays(todayISO(), -1),
  })).id);
  assert.equal(bookingService.markTravelled(db, past.id).status, 'travelled');

  const noDate = bookingService.confirmBooking(db, bookingService.createBooking(db, bookingPayload()).id);
  assert.equal(bookingService.markTravelled(db, noDate.id).status, 'travelled');
});

test('payments cannot be dated before their invoice or bill', () => {
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-06-10',
    items: [{ description: 'Service', quantity: 1, unit_price_cents: 5_000, account_id: account('4300').id }],
  });
  assertBadRequest(
    () => invoiceService.recordInvoicePayment(db, invoice.id, {
      amount_cents: 5_000, payment_date: '2026-06-01', deposit_account_id: account('1000').id,
    }),
    /cannot be before the invoice date \(2026-06-10\).*customer advance/,
  );
  assert.equal(invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: 5_000, payment_date: '2026-06-10', deposit_account_id: account('1000').id,
  }).status_display, 'paid');

  const bill = billService.createBill(db, {
    vendor_id: vendorId,
    bill_date: '2026-06-10',
    items: [{ description: 'Rent', quantity: 1, unit_price_cents: 7_000, account_id: account('6000').id }],
  });
  assertBadRequest(
    () => billService.recordBillPayment(db, bill.id, {
      amount_cents: 7_000, payment_date: '2026-06-09', payment_account_id: account('1010').id,
    }),
    /cannot be before the bill date/,
  );
});

test('a zero-cost line is refused with its line number, also on older drafts', () => {
  assertBadRequest(
    () => bookingService.createBooking(db, bookingPayload({
      cost_items: [
        { description: 'Fare', quantity: 1, unit_price_cents: 80_000, account_id: account('5000').id, vendor_id: vendorId },
        { description: 'Free seat', quantity: 1, unit_price_cents: 0, account_id: account('5000').id, vendor_id: vendorId },
      ],
    })),
    /Cost line 2: enter a cost greater than zero/,
  );
  assertBadRequest(
    () => visaService.createVisa(db, visaPayload({
      cost_items: [{ description: 'Embassy', quantity: 1, unit_price_cents: 0, account_id: account('5120').id, vendor_id: vendorId }],
    })),
    /Cost line 1: enter a cost greater than zero/,
  );

  // A draft saved before this rule may still hold a zero line.
  const draft = bookingService.createBooking(db, bookingPayload());
  db.prepare("UPDATE booking_items SET unit_price_cents = 0, amount_cents = 0 WHERE booking_id = ? AND item_type = 'cost'").run(draft.id);
  const before = journalCount();
  assertBadRequest(() => bookingService.confirmBooking(db, draft.id), /Cost line 1 \("Fare"\) has no cost/);
  assert.equal(journalCount(), before, 'nothing is posted');
  assert.equal(bookingService.getBooking(db, draft.id).status, 'draft');
});

test('visa passport validity raises a warning, not an error', () => {
  const expired = visaService.createVisa(db, visaPayload({ travel_date: '2026-08-01', passport_expiry: '2026-07-01' }));
  assert.match(expired.passport_warning, /expired on 2026-07-01, before the travel date/);

  const short = visaService.createVisa(db, visaPayload({ travel_date: '2026-08-01', passport_expiry: '2026-12-31' }));
  assert.match(short.passport_warning, /less than 6 months after the travel date/);

  const fine = visaService.createVisa(db, visaPayload({ travel_date: '2026-08-01', passport_expiry: '2027-03-01' }));
  assert.equal(fine.passport_warning, null);

  const submitted = visaService.submitVisa(db, short.id);
  assert.equal(submitted.status, 'submitted', 'the warning does not block submission');
  assert.ok(submitted.warnings.some((warning) => /6 months/.test(warning)));
});

test('status history records every change for bookings and visas', () => {
  const booking = bookingService.createBooking(db, bookingPayload({ travel_date: addDays(todayISO(), -2) }));
  bookingService.confirmBooking(db, booking.id);
  bookingService.markTravelled(db, booking.id);
  const bookingHistory = bookingService.getBooking(db, booking.id).status_history;
  assert.deepEqual(
    bookingHistory.map((row) => [row.from_status, row.to_status]),
    [[null, 'draft'], ['draft', 'confirmed'], ['confirmed', 'travelled']],
  );
  assert.match(bookingHistory[1].remarks, /^Invoice INV-/);

  const visa = visaService.createVisa(db, visaPayload());
  visaService.submitVisa(db, visa.id);
  visaService.approveVisa(db, visa.id);
  visaService.issueVisa(db, visa.id);
  assert.deepEqual(
    visaService.getVisa(db, visa.id).status_history.map((row) => row.to_status),
    ['draft', 'submitted', 'approved', 'issued'],
  );

  const cancelled = bookingService.confirmBooking(db, bookingService.createBooking(db, bookingPayload()).id);
  bookingService.cancelBooking(db, cancelled.id, { cancellation_date: '2026-06-20', reason: 'Customer changed plans' });
  const last = bookingService.getBooking(db, cancelled.id).status_history.at(-1);
  assert.equal(last.to_status, 'cancelled');
  assert.equal(last.event_date, '2026-06-20');
  assert.match(last.remarks, /^Cancellation CNC-.* · Customer changed plans$/);

  const rejected = visaService.submitVisa(db, visaService.createVisa(db, visaPayload()).id);
  visaService.rejectVisa(db, rejected.id, { cancellation_date: '2026-06-21', reason: 'Embassy refused' });
  assert.equal(visaService.getVisa(db, rejected.id).status_history.at(-1).to_status, 'rejected');

  // Deleting a draft removes its history; the chain shows status changes.
  const draft = bookingService.createBooking(db, bookingPayload());
  bookingService.deleteBooking(db, draft.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM job_status_history WHERE source_type = 'booking' AND source_id = ?").get(draft.id).c, 0);
  const chain = auditChain.getAuditChain(db, { type: 'booking', id: booking.id });
  assert.deepEqual(
    chain.timeline.filter((item) => item.kind === 'status').map((item) => item.title),
    ['Created as draft', 'Status draft → confirmed', 'Status confirmed → travelled'],
  );
});
