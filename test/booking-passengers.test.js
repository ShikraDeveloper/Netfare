'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-booking-passengers-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Khan Family')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Emirates')").run().lastInsertRowid);

function passengerItems(rows) {
  const sale = [];
  const cost = [];
  rows.forEach((row, index) => {
    const common = {
      description: row.name,
      passenger_name: row.passenger === false ? '' : row.name,
      line_group: index + 1,
      quantity: 1,
    };
    if (row.sale) sale.push({ ...common, unit_price_cents: row.sale, account_id: account(row.saleAccount || '4000').id });
    if (row.cost) {
      cost.push({
        ...common,
        unit_price_cents: row.cost,
        account_id: account('5000').id,
        vendor_id: vendorId,
        supplier_ref: row.ticket || '',
      });
    }
  });
  return { sale_items: sale, cost_items: cost };
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('passenger rows are stored with their name and pairing', () => {
  const booking = bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: '2026-09-01',
    destination: 'Dubai–London return · Emirates',
    pnr: 'EK7XYZ',
    ...passengerItems([
      { name: 'Ali Khan', sale: 250_000, cost: 200_000, ticket: '176-1234567890' },
      { name: 'Sara Khan', sale: 250_000, cost: 200_000 },
      { name: 'Service fee', passenger: false, sale: 10_000, saleAccount: '4300' },
    ]),
  });
  const ali = booking.items.filter((item) => item.passenger_name === 'Ali Khan');
  assert.deepEqual(ali.map((item) => [item.item_type, item.line_group]).sort(), [['cost', 1], ['sale', 1]]);
  assert.equal(ali.find((item) => item.item_type === 'cost').supplier_ref, '176-1234567890');
  assert.equal(booking.passenger_names, 'Ali Khan, Sara Khan');
  assert.equal(booking.sale_total_cents, 510_000);
  assert.equal(booking.cost_total_cents, 400_000);
});

test('the invoice and bill show each passenger with the destination', () => {
  const [booking] = bookingService.listBookings(db, { search: 'EK7XYZ' });
  const confirmed = bookingService.confirmBooking(db, booking.id);
  const invoice = invoiceService.getInvoice(db, confirmed.invoice_id);
  assert.deepEqual(invoice.items.map((item) => item.description), [
    'Dubai–London return · Emirates – Ali Khan',
    'Dubai–London return · Emirates – Sara Khan',
    'Service fee',
  ]);
  const bill = billService.getBill(db, confirmed.bills[0].id);
  assert.deepEqual(bill.items.map((item) => item.description), [
    'Dubai–London return · Emirates – Ali Khan',
    'Dubai–London return · Emirates – Sara Khan',
  ]);
  assert.equal(bill.total_cents, 400_000, 'one bill for the supplier');
});

test('bookings can be found by passenger name', () => {
  assert.deepEqual(bookingService.listBookings(db, { search: 'Sara Kh' }).map((row) => row.pnr), ['EK7XYZ']);
  assert.equal(bookingService.listBookings(db, { search: 'Nobody Here' }).length, 0);
});

test('lines without a passenger keep their own description', () => {
  const legacy = bookingService.confirmBooking(db, bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: '2026-09-02',
    destination: 'Singapore — hotel only',
    sale_items: [{ description: 'Hotel booking — 6 nights', quantity: 1, unit_price_cents: 240_000, account_id: account('4100').id }],
    cost_items: [{ description: 'Hotel booking — 6 nights', quantity: 1, unit_price_cents: 190_000, account_id: account('5100').id, vendor_id: vendorId }],
  }).id);
  assert.equal(invoiceService.getInvoice(db, legacy.invoice_id).items[0].description, 'Hotel booking — 6 nights');
  assert.equal(legacy.passenger_names, null);
});
