'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-reports-privacy-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const visaService = require('../server/services/visas');
const invoiceService = require('../server/services/invoices');
const supplierCreditService = require('../server/services/supplier-credits');
const statements = require('../server/services/statements');
const dailySales = require('../server/services/reports/daily-sales');
const { maskPassport } = require('../server/util');

const FROM = '2026-05-01';
const TO = '2026-05-31';

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

function draftBooking(customerId, vendorId, extra = {}) {
  return bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: '2026-05-10',
    due_date: '2026-05-10',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 100_000, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: 80_000, account_id: account('5000').id, vendor_id: vendorId }],
    ...extra,
  });
}

function marginRow(bookingId) {
  return bookingService.bookingMarginReport(db, FROM, TO).rows.find((row) => row.id === bookingId);
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('M1: draft bookings and visas stay out of margin reports and dashboard margin', () => {
  const customerId = insertCustomer('Draft Report Customer');
  const vendorId = insertVendor('Draft Report Airline');
  const draft = draftBooking(customerId, vendorId);
  const confirmed = bookingService.confirmBooking(db, draftBooking(customerId, vendorId).id);

  assert.equal(marginRow(draft.id), undefined, 'draft booking is not in the margin report');
  assert.ok(marginRow(confirmed.id), 'confirmed booking is in the margin report');

  const stats = bookingService.bookingStats(db, FROM, TO);
  assert.equal(stats.sale_cents, 100_000, 'only the confirmed booking counts');
  assert.equal(stats.margin_cents, 20_000);
  assert.equal(stats.draft_count, 1, 'drafts are reported separately');

  const visaDraft = visaService.createVisa(db, {
    customer_id: customerId,
    application_date: '2026-05-12',
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 30_000, account_id: account('4320').id }],
  });
  assert.ok(!visaService.visaMarginReport(db, FROM, TO).rows.some((row) => row.id === visaDraft.id));
  assert.equal(visaService.visaStats(db, FROM, TO).sale_cents, 0);
  assert.equal(visaService.visaStats(db, FROM, TO).draft_count, 1);
});

test('M2: a booking cancelled before cancellation notes existed is excluded, like visas', () => {
  const booking = bookingService.confirmBooking(db, draftBooking(insertCustomer('Legacy Customer'), insertVendor('Legacy Airline')).id);
  // Older databases marked the booking cancelled and reversed every document.
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
  assert.equal(marginRow(booking.id), undefined);
  assert.ok(!bookingService.bookingMarginReport(db, FROM, TO).rows.some((row) => row.status === 'cancelled' && !row.is_cancelled));
});

test('M3: margin and DSR use posted bills less supplier credits, not the draft cost lines', () => {
  const customerId = insertCustomer('Actual Cost Customer');
  const vendorId = insertVendor('Actual Cost Airline');
  const booking = bookingService.confirmBooking(db, draftBooking(customerId, vendorId).id);
  const bill = booking.bills[0];

  // A credit raised only against the bill (no booking link) still belongs to the job.
  supplierCreditService.createSupplierCredit(db, {
    vendor_id: vendorId,
    bill_id: bill.id,
    credit_date: '2026-05-15',
    amount_cents: 15_000,
  });
  // A credit that names the booking but no bill also counts.
  supplierCreditService.createSupplierCredit(db, {
    vendor_id: vendorId,
    booking_id: booking.id,
    credit_date: '2026-05-16',
    items: [{ description: 'Goodwill', amount_cents: 5_000, account_id: account('5000').id }],
  });

  const row = marginRow(booking.id);
  assert.equal(row.planned_cost_total_cents, 80_000, 'the original cost lines are kept for reference');
  assert.equal(row.cost_total_cents, 60_000, '800 billed − 150 − 50 credited');
  assert.equal(row.margin_cents, 40_000);

  const dsrRow = dailySales.dailySales(db, FROM, TO).days
    .flatMap((day) => day.rows)
    .find((item) => item.id === booking.invoice_id);
  assert.equal(dsrRow.cost_cents, 60_000);
  assert.equal(dsrRow.margin_cents, 40_000);

  // Voiding a credit puts the cost back.
  const credit = db.prepare('SELECT id FROM supplier_credit_notes WHERE bill_id = ?').get(bill.id);
  supplierCreditService.voidSupplierCredit(db, credit.id, { remarks: 'Issued in error' });
  assert.equal(marginRow(booking.id).cost_total_cents, 75_000);
});

test('M4: internal notes stay internal; only the invoice note reaches the customer invoice', () => {
  const customerId = insertCustomer('Notes Customer');
  const vendorId = insertVendor('Notes Airline');
  const draft = draftBooking(customerId, vendorId, {
    notes: 'INTERNAL: difficult customer, charge extra',
    invoice_notes: 'Thank you for travelling with us.',
  });
  // Editing without sending the invoice note keeps it.
  const edited = bookingService.updateBooking(db, draft.id, {
    sale_items: draft.sale_items.map((item) => ({ ...item })),
    cost_items: draft.cost_items.map((item) => ({ ...item })),
    notes: 'INTERNAL: still difficult',
  });
  assert.equal(edited.invoice_notes, 'Thank you for travelling with us.');

  const confirmed = bookingService.confirmBooking(db, draft.id);
  const invoice = invoiceService.getInvoice(db, confirmed.invoice_id);
  assert.equal(invoice.notes, 'Thank you for travelling with us.');
  assert.ok(!invoice.notes.includes('INTERNAL'));

  const noNote = bookingService.confirmBooking(db, draftBooking(customerId, vendorId, { notes: 'INTERNAL only' }).id);
  assert.equal(invoiceService.getInvoice(db, noNote.invoice_id).notes, '', 'no invoice note means an empty invoice note');

  const visa = visaService.createVisa(db, {
    customer_id: customerId,
    application_date: '2026-05-12',
    notes: 'INTERNAL: embassy appointment 9am',
    invoice_notes: 'Processing takes 10 working days.',
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 30_000, account_id: account('4320').id }],
  });
  const submitted = visaService.submitVisa(db, visa.id);
  assert.equal(invoiceService.getInvoice(db, submitted.invoice_id).notes, 'Processing takes 10 working days.');
});

test('M5: invoices and customer statements mask the passport and omit the date of birth', () => {
  assert.equal(maskPassport('P1234567'), '•••• 4567');
  assert.equal(maskPassport('AB12'), '••••');
  assert.equal(maskPassport(''), '');
  assert.equal(maskPassport(null), '');

  const customerId = insertCustomer('Privacy Sponsor');
  const visa = visaService.createVisa(db, {
    customer_id: customerId,
    application_date: '2026-05-12',
    applicant_is_customer: false,
    applicant_name: 'Privacy Visitor',
    passport_number: 'Z9876543',
    passport_expiry: '2032-01-01',
    date_of_birth: '1988-08-08',
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 30_000, account_id: account('4320').id }],
  });
  const submitted = visaService.submitVisa(db, visa.id);

  const invoice = invoiceService.getInvoice(db, submitted.invoice_id);
  assert.equal(invoice.visa_passport_masked, '•••• 6543');
  assert.equal(invoice.visa_passport_expiry, '2032-01-01');
  const invoiceJson = JSON.stringify(invoice);
  assert.ok(!invoiceJson.includes('Z9876543'), 'the full passport number is not in the invoice response');
  assert.ok(!invoiceJson.includes('1988-08-08'), 'the date of birth is not in the invoice response');

  const statement = statements.customerStatement(db, customerId, {});
  const statementJson = JSON.stringify(statement);
  assert.ok(statementJson.includes('•••• 6543'));
  assert.ok(!statementJson.includes('Z9876543'));
  assert.ok(!statementJson.includes('1988-08-08'));

  // The visa application itself keeps the full details for staff.
  const full = visaService.getVisa(db, visa.id);
  assert.equal(full.passport_number, 'Z9876543');
  assert.equal(full.date_of_birth, '1988-08-08');
});
