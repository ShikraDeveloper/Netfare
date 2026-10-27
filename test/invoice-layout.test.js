'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-invoice-layout-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const bookingService = require('../server/services/bookings');
const visaService = require('../server/services/visas');
const cancellationService = require('../server/services/cancellations');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Layout Customer')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Layout Airline')").run().lastInsertRowid);

function passengerLine(name, group, { sale = 200_000, cost = 160_000, ticket = '' } = {}) {
  const common = { description: name, passenger_name: name, line_group: group, quantity: 1 };
  return {
    sale: { ...common, unit_price_cents: sale, account_id: account('4000').id },
    cost: { ...common, unit_price_cents: cost, account_id: account('5000').id, vendor_id: vendorId, supplier_ref: ticket },
  };
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a booking with passengers prints as a ticket invoice with trip details and ticket numbers', () => {
  const ali = passengerLine('Ali Khan', 1, { ticket: '176-1111111111' });
  const sara = passengerLine('Sara Khan', 2);
  const booking = bookingService.confirmBooking(db, bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: '2026-09-01',
    travel_date: '2026-09-20',
    return_date: '2026-09-30',
    destination: 'Dubai–London return',
    pnr: 'LAY001',
    sale_items: [ali.sale, sara.sale, { description: 'Service fee', quantity: 1, unit_price_cents: 5_000, account_id: account('4300').id }],
    cost_items: [ali.cost, sara.cost],
  }).id);
  const invoice = invoiceService.getInvoice(db, booking.invoice_id);
  assert.equal(invoice.document_kind, 'ticket');
  assert.equal(invoice.booking_number, booking.number);
  assert.equal(invoice.booking_pnr, 'LAY001');
  assert.equal(invoice.booking_destination, 'Dubai–London return');
  assert.equal(invoice.booking_travel_date, '2026-09-20');
  assert.equal(invoice.booking_return_date, '2026-09-30');
  assert.equal(invoice.booking_passenger_count, 2);
  assert.deepEqual(invoice.items.map((item) => [item.passenger_name, item.ticket_no]), [
    ['Ali Khan', '176-1111111111'],
    ['Sara Khan', ''],
    ['', ''],
  ]);
  assert.equal(invoice.booking_ticket_lookup, undefined, 'internal helper is not returned');
  assert.ok(!JSON.stringify(invoice).includes('160000'), 'supplier cost is not on the invoice');
});

test('a booking without passenger rows prints as a booking invoice', () => {
  const booking = bookingService.confirmBooking(db, bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: '2026-09-02',
    destination: 'Singapore — hotel only',
    sale_items: [{ description: 'Hotel 6 nights', quantity: 1, unit_price_cents: 240_000, account_id: account('4100').id }],
    cost_items: [{ description: 'Hotel 6 nights', quantity: 1, unit_price_cents: 190_000, account_id: account('5100').id, vendor_id: vendorId }],
  }).id);
  const invoice = invoiceService.getInvoice(db, booking.invoice_id);
  assert.equal(invoice.document_kind, 'booking');
  assert.equal(invoice.booking_passenger_count, 0);
});

test('a visa prints as a visa invoice with its application and group number', () => {
  const sale = (name) => ({
    applicant_is_customer: false,
    applicant_name: name,
    passport_number: 'AB9876543',
    sale_items: [{ description: 'Tourist visa', quantity: 1, unit_price_cents: 45_000, account_id: account('4320').id }],
  });
  const { group, applications } = visaService.createVisaGroup(db, {
    customer_id: customerId,
    application_date: '2026-09-03',
    destination_country: 'France',
    applicants: [sale('Visa One'), sale('Visa Two')],
  });
  visaService.submitVisaGroup(db, group.id);
  const invoice = invoiceService.getInvoice(db, visaService.getVisa(db, applications[0].id).invoice_id);
  assert.equal(invoice.document_kind, 'visa');
  assert.equal(invoice.visa_number, applications[0].number);
  assert.equal(invoice.visa_group_number, group.number);
  assert.equal(invoice.visa_passport_masked, '•••• 6543');
  assert.ok(!JSON.stringify(invoice).includes('AB9876543'));
});

test('cancellation charges and direct invoices keep their own kinds', () => {
  const ali = passengerLine('Cancel Pax', 1);
  const booking = bookingService.confirmBooking(db, bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: '2026-09-04',
    destination: 'Dubai–Cairo',
    sale_items: [ali.sale],
    cost_items: [ali.cost],
  }).id);
  bookingService.cancelBooking(db, booking.id, { cancellation_date: '2026-09-05', customer_charges_cents: 20_000 });
  const cancellation = cancellationService.getCancellationForSource(db, 'booking', booking.id);
  assert.equal(invoiceService.getInvoice(db, cancellation.cancellation_invoice_id).document_kind, 'cancellation');

  const direct = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-09-06',
    items: [{ description: 'Consultancy', quantity: 1, unit_price_cents: 10_000, account_id: account('4300').id }],
  });
  const fetched = invoiceService.getInvoice(db, direct.id);
  assert.equal(fetched.document_kind, 'service');
  assert.equal(fetched.booking_number, undefined);
});
