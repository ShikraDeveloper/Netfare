'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-void-guard-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const visaService = require('../server/services/visas');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');
const cancellationService = require('../server/services/cancellations');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

function balance(code) {
  return db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ?
  `).get(code).total;
}

function journalCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count;
}

function insertCustomer(name) {
  return Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
}

function insertVendor(name) {
  return Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(name).lastInsertRowid);
}

function confirmedBooking(customerId, vendorId) {
  const draft = bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: '2026-09-01',
    due_date: '2026-09-01',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 100_000, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: 80_000, account_id: account('5000').id, vendor_id: vendorId }],
  });
  return bookingService.confirmBooking(db, draft.id);
}

function submittedVisa(customerId, vendorId) {
  const draft = visaService.createVisa(db, {
    customer_id: customerId,
    application_date: '2026-09-01',
    destination_country: 'France (Schengen)',
    sale_items: [{ description: 'Visa fee', quantity: 1, unit_price_cents: 40_000, account_id: account('4320').id }],
    cost_items: [{ description: 'Embassy fee', quantity: 1, unit_price_cents: 30_000, account_id: account('5120').id, vendor_id: vendorId }],
  });
  return visaService.submitVisa(db, draft.id);
}

function assertBadRequest(fn, pattern) {
  assert.throws(fn, (error) => error.status === 400 && pattern.test(error.message));
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a booking invoice cannot be voided directly, and nothing is reversed', () => {
  const booking = confirmedBooking(insertCustomer('Guard Booking Customer'), insertVendor('Guard Airline'));
  invoiceService.recordInvoicePayment(db, booking.invoice_id, {
    amount_cents: 100_000,
    payment_date: '2026-09-02',
    deposit_account_id: account('1010').id,
  });
  const bankBefore = balance('1010');
  const entriesBefore = journalCount();

  assertBadRequest(
    () => invoiceService.voidInvoice(db, booking.invoice_id, { remarks: 'Wrong price' }),
    /belongs to a booking.*Cancel the booking/,
  );

  const invoice = invoiceService.getInvoice(db, booking.invoice_id);
  assert.equal(invoice.status, 'sent');
  assert.equal(invoice.amount_paid_cents, 100_000);
  assert.ok(invoice.payments.every((payment) => payment.status === 'posted'), 'receipts stay posted');
  assert.equal(balance('1010'), bankBefore, 'bank is not touched');
  assert.equal(journalCount(), entriesBefore, 'no reversing entries were posted');
  assert.equal(bookingService.getBooking(db, booking.id).status, 'confirmed');
});

test('a visa invoice cannot be voided directly', () => {
  const visa = submittedVisa(insertCustomer('Guard Visa Customer'), insertVendor('Guard Embassy'));
  assertBadRequest(
    () => invoiceService.voidInvoice(db, visa.invoice_id, { remarks: 'Rejected by embassy' }),
    /belongs to a visa application.*Cancel the visa application/,
  );
  assert.equal(invoiceService.getInvoice(db, visa.invoice_id).status, 'sent');
});

test('a cancellation-charges invoice cannot be voided directly', () => {
  const booking = confirmedBooking(insertCustomer('Guard Charges Customer'), insertVendor('Guard Charges Airline'));
  bookingService.cancelBooking(db, booking.id, { cancellation_date: '2026-09-05', customer_charges_cents: 30_000 });
  const cancellation = cancellationService.getCancellationForSource(db, 'booking', booking.id);
  assert.ok(cancellation.cancellation_invoice_id, 'charges beyond the amount received are invoiced');
  const incomeBefore = balance('4330');

  assertBadRequest(
    () => invoiceService.voidInvoice(db, cancellation.cancellation_invoice_id, { remarks: 'Waive fee' }),
    /cancellation charges.*credit note/,
  );
  assert.equal(invoiceService.getInvoice(db, cancellation.cancellation_invoice_id).status, 'sent');
  assert.equal(balance('4330'), incomeBefore, 'cancellation income is kept');
});

test('booking and visa supplier bills cannot be voided directly', () => {
  const customerId = insertCustomer('Guard Bill Customer');
  const booking = confirmedBooking(customerId, insertVendor('Guard Bill Airline'));
  const visa = submittedVisa(customerId, insertVendor('Guard Bill Embassy'));
  const bookingBill = booking.bills[0];
  const visaBill = visa.bills[0];
  const entriesBefore = journalCount();

  assertBadRequest(
    () => billService.voidBill(db, bookingBill.id, { remarks: 'Ticket reissued' }),
    /belongs to a booking.*supplier credit/,
  );
  assertBadRequest(
    () => billService.voidBill(db, visaBill.id, { remarks: 'Embassy refund' }),
    /belongs to a visa application.*supplier credit/,
  );
  assert.equal(billService.getBill(db, bookingBill.id).status, 'received');
  assert.equal(billService.getBill(db, visaBill.id).status, 'received');
  assert.equal(journalCount(), entriesBefore);
});

test('standalone invoices and bills can still be voided', () => {
  const customerId = insertCustomer('Standalone Void Customer');
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-09-10',
    status: 'sent',
    items: [{ description: 'Service charge', quantity: 1, unit_price_cents: 5_000, account_id: account('4300').id }],
  });
  assert.equal(invoiceService.voidInvoice(db, invoice.id, { remarks: 'Duplicate' }).status, 'void');

  const bill = billService.createBill(db, {
    vendor_id: insertVendor('Standalone Void Vendor'),
    bill_date: '2026-09-10',
    status: 'received',
    items: [{ description: 'Office rent', quantity: 1, unit_price_cents: 7_000, account_id: account('6000').id }],
  });
  assert.equal(billService.voidBill(db, bill.id, { remarks: 'Entered twice' }).status, 'void');
});

test('a mistaken receipt on a booking invoice can still be corrected', () => {
  const booking = confirmedBooking(insertCustomer('Receipt Correction Customer'), insertVendor('Receipt Correction Airline'));
  const paid = invoiceService.recordInvoicePayment(db, booking.invoice_id, {
    amount_cents: 40_000,
    payment_date: '2026-09-02',
    deposit_account_id: account('1000').id,
  });
  const corrected = invoiceService.deleteInvoicePayment(db, paid.payments[0].id, { remarks: 'Recorded on the wrong account' });
  assert.equal(corrected.status, 'sent', 'the invoice itself stays open');
  assert.equal(corrected.amount_paid_cents, 0);
});
