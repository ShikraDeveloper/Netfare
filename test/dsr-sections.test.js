'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-dsr-sections-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const visaService = require('../server/services/visas');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');
const advanceService = require('../server/services/advances');
const cancellationService = require('../server/services/cancellations');
const { dailySales } = require('../server/services/reports/daily-sales');
const { modeOf } = require('../server/services/reports/dsr-sections');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

const DAY = '2026-11-10';
const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Counter Customer')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Counter Airline')").run().lastInsertRowid);

function pay(invoiceId, cents, method, accountCode = method === 'Cash' ? '1000' : '1010', date = DAY) {
  return invoiceService.recordInvoicePayment(db, invoiceId, {
    amount_cents: cents, payment_date: date, deposit_account_id: account(accountCode).id, method,
  });
}

const pax = (name, group, extra) => ({ description: name, passenger_name: name, line_group: group, quantity: 1, ...extra });

// One ticket booking with two passengers and a service fee, paid in cash and by card.
const ticket = bookingService.confirmBooking(db, bookingService.createBooking(db, {
  customer_id: customerId,
  booking_date: DAY,
  due_date: DAY,
  destination: 'Dubai–London',
  pnr: 'CTR001',
  sale_items: [
    pax('Ali', 1, { unit_price_cents: 200_000, account_id: account('4000').id }),
    pax('Sara', 2, { unit_price_cents: 200_000, account_id: account('4000').id }),
    { description: 'Service fee', quantity: 1, unit_price_cents: 6_000, account_id: account('4300').id },
  ],
  cost_items: [
    pax('Ali', 1, { unit_price_cents: 180_000, account_id: account('5000').id, vendor_id: vendorId, supplier_ref: '176-1' }),
    pax('Sara', 2, { unit_price_cents: 180_000, account_id: account('5000').id, vendor_id: vendorId, supplier_ref: '176-2' }),
  ],
}).id);
pay(ticket.invoice_id, 300_000, 'Cash');
pay(ticket.invoice_id, 6_000, 'Credit card');

// A visa paid by bank transfer.
const visa = visaService.submitVisa(db, visaService.createVisa(db, {
  customer_id: customerId,
  application_date: DAY,
  destination_country: 'France',
  applicant_is_customer: false,
  applicant_name: 'Omar',
  sale_items: [
    { description: 'Schengen visa', quantity: 1, unit_price_cents: 40_000, account_id: account('4320').id },
    { description: 'Processing', quantity: 1, unit_price_cents: 5_000, account_id: account('4300').id },
  ],
}).id);
pay(visa.invoice_id, 45_000, 'Bank transfer');

// A service invoice left on credit.
const service = invoiceService.createInvoice(db, {
  customer_id: customerId,
  issue_date: DAY,
  items: [{ description: 'Meet and assist', quantity: 1, unit_price_cents: 15_000, account_id: account('4300').id }],
});

// An older invoice paid today, and an advance received today.
const older = invoiceService.createInvoice(db, {
  customer_id: customerId,
  issue_date: '2026-11-01',
  items: [{ description: 'Old service', quantity: 1, unit_price_cents: 20_000, account_id: account('4300').id }],
});
pay(older.id, 20_000, 'Cash');
advanceService.createAdvance(db, {
  customer_id: customerId, amount_cents: 50_000, advance_date: DAY, deposit_account_id: account('1010').id, method: 'Bank transfer',
});

// The airline is paid from the bank.
billService.recordBillPayment(db, ticket.bills[0].id, {
  amount_cents: 360_000, payment_date: DAY, payment_account_id: account('1010').id, method: 'Bank transfer',
});

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const report = () => dailySales(db, DAY, DAY).sections;

test('payment methods map to cash, card, bank and other', () => {
  assert.deepEqual(['Cash', 'Credit card', 'Bank transfer', 'Cheque', 'Other', ''].map(modeOf),
    ['cash', 'card', 'bank', 'bank', 'other', 'other']);
});

test('a ticket sale lists its passengers with ticket numbers, fare, fee and how it was paid', () => {
  const [row] = report().tickets;
  assert.equal(row.id, ticket.invoice_id);
  assert.equal(row.pnr, 'CTR001');
  assert.equal(row.route, 'Dubai–London');
  assert.deepEqual(row.passengers, [{ name: 'Ali', ticket_no: '176-1' }, { name: 'Sara', ticket_no: '176-2' }]);
  assert.deepEqual([row.fare_cents, row.fee_cents, row.total_cents], [400_000, 6_000, 406_000]);
  assert.deepEqual(row.split, { cash: 300_000, card: 6_000, bank: 0, other: 0, credit: 100_000 });
  assert.deepEqual([row.cost_cents, row.margin_cents], [360_000, 46_000]);
});

test('visa and service sales sit in their own sections', () => {
  const sections = report();
  assert.equal(sections.visas.length, 1);
  assert.deepEqual(
    [sections.visas[0].applicant_name, sections.visas[0].country, sections.visas[0].fare_cents, sections.visas[0].fee_cents],
    ['Omar', 'France', 40_000, 5_000],
  );
  assert.deepEqual(sections.visas[0].split, { cash: 0, card: 0, bank: 45_000, other: 0, credit: 0 });
  assert.equal(sections.services.length, 1);
  assert.equal(sections.services[0].id, service.id);
  assert.equal(sections.services[0].split.credit, 15_000);
});

test('money for older invoices and advances is listed separately', () => {
  const rows = report().collections;
  assert.deepEqual(rows.map((row) => [row.kind, row.mode, row.amount_cents]), [
    ['payment', 'cash', 20_000],
    ['advance', 'bank', 50_000],
  ]);
});

test('cash and bank reconcile: opening + in − out = closing, and receipts match the sections', () => {
  const sections = report();
  const { position, settlement, collected } = sections.summary;
  assert.equal(position.cash.in_cents, settlement.cash + collected.cash);
  assert.equal(position.bank.in_cents, settlement.bank + settlement.card + collected.bank, 'card receipts land in the bank account here');
  for (const key of ['cash', 'bank']) {
    const p = position[key];
    assert.equal(p.closing_cents, p.opening_cents + p.in_cents - p.out_cents);
  }
  assert.deepEqual(sections.cash_out.map((row) => [row.label, row.bank_out_cents]), [['Supplier payments', 360_000]]);
  assert.deepEqual(sections.summary.sales, {
    tickets_cents: 406_000, visas_cents: 45_000, services_cents: 15_000, cancellations_cents: 0, total_cents: 466_000,
  });
});

test('a cancellation and its refund appear in section E on the cancellation day', () => {
  const later = '2026-11-12';
  const cancellation = cancellationService.cancelSource(db, {
    sourceType: 'visa', sourceId: visa.id, finalStatus: 'cancelled',
    payload: { cancellation_date: later, customer_charges_cents: 5_000 },
  });
  cancellationService.refundCancellation(db, cancellation.id, {
    refund_date: later, method: 'Cash', account_id: account('1000').id,
  });
  const sections = dailySales(db, later, later).sections;
  assert.equal(sections.cancellations.length, 1);
  assert.deepEqual(
    [sections.cancellations[0].reversed_sale_cents, sections.cancellations[0].charges_cents, sections.cancellations[0].sale_cents],
    [45_000, 5_000, -40_000],
  );
  assert.deepEqual(sections.refunds.map((row) => [row.amount_cents, row.mode, row.against]), [[40_000, 'cash', `Cancellation ${cancellation.number}`]]);
  assert.equal(sections.summary.refunds_cents, 40_000);
  assert.ok(sections.cash_out.some((row) => row.cash_out_cents === 40_000));
  const saleDay = dailySales(db, DAY, DAY).sections.visas[0];
  assert.equal(saleDay.cancelled_by.number, cancellation.number, 'the visa stays on its sale day, marked cancelled');
  assert.equal(saleDay.split.credit, 0);
});
