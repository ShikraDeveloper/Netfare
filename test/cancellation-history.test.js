'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-cancellation-history-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const invoiceService = require('../server/services/invoices');
const cancellationService = require('../server/services/cancellations');
const creditService = require('../server/services/credits');
const statements = require('../server/services/statements');
const { dailySales } = require('../server/services/reports/daily-sales');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('History Airline')").run().lastInsertRowid);

function customer(name) {
  return Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
}

function soldAndPaid(customerId, { date = '2026-10-20', sale = 73_000, cost = 60_000, paid = sale } = {}) {
  const booking = bookingService.confirmBooking(db, bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: date,
    due_date: date,
    destination: 'Dubai–Muscat',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: sale, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: cost, account_id: account('5000').id, vendor_id: vendorId }],
  }).id);
  if (paid) {
    invoiceService.recordInvoicePayment(db, booking.invoice_id, {
      amount_cents: paid, payment_date: date, deposit_account_id: account('1000').id, method: 'Cash',
    });
  }
  return booking;
}

function cancel(booking, { date = '2026-10-25', charges = 10_000, supplierCredit = 55_000 } = {}) {
  return cancellationService.cancelSource(db, {
    sourceType: 'booking',
    sourceId: booking.id,
    payload: {
      cancellation_date: date,
      customer_charges_cents: charges,
      supplier_credits: supplierCredit ? [{ bill_id: booking.bills[0].id, amount_cents: supplierCredit }] : [],
    },
  });
}

function lines(customerId) {
  return statements.customerStatement(db, customerId, { to: '2026-12-31' }).transactions
    .map((row) => [row.date, row.kind, row.debit_cents, row.credit_cents, row.balance_cents]);
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the statement keeps the sale and payment, then shows the cancellation, charges and refund', () => {
  const customerId = customer('History Refund');
  const booking = soldAndPaid(customerId);
  const cancellation = cancel(booking);
  cancellationService.refundCancellation(db, cancellation.id, {
    refund_date: '2026-10-26', method: 'Cash', account_id: account('1000').id,
  });
  assert.deepEqual(lines(customerId), [
    ['2026-10-20', 'invoice', 73_000, 0, 73_000],
    ['2026-10-20', 'payment', 0, 73_000, 0],
    ['2026-10-25', 'cancellation', 0, 73_000, -73_000],
    ['2026-10-25', 'cancellation_charge', 10_000, 0, -63_000],
    ['2026-10-26', 'refund', 63_000, 0, 0],
  ]);
  const statement = statements.customerStatement(db, customerId, {});
  assert.match(statement.transactions[0].description, /cancelled by CXL|cancelled by/);
  assert.equal(statement.transactions[0].items.length, 1, 'the cancelled invoice keeps its items');
  assert.equal(statement.closing_balance_cents, 0);
});

test('a statement printed for the sale day does not change after a later cancellation', () => {
  const customerId = customer('History Period');
  const booking = soldAndPaid(customerId, { date: '2026-10-10', paid: 30_000 });
  const before = statements.customerStatement(db, customerId, { from: '2026-10-01', to: '2026-10-15' });
  cancel(booking, { date: '2026-10-25', charges: 5_000, supplierCredit: 0 });
  const afterwards = statements.customerStatement(db, customerId, { from: '2026-10-01', to: '2026-10-15' });
  assert.deepEqual(
    afterwards.transactions.map((row) => [row.kind, row.debit_cents, row.credit_cents]),
    before.transactions.map((row) => [row.kind, row.debit_cents, row.credit_cents]),
  );
  assert.equal(afterwards.closing_balance_cents, 43_000);
  const later = statements.customerStatement(db, customerId, { from: '2026-10-16' });
  assert.equal(later.opening_balance_cents, 43_000);
  assert.equal(later.closing_balance_cents, -25_000, 'paid 300, charged 50: 250 owed back');
});

test('money kept as a credit note leaves the balance and comes back when applied', () => {
  const customerId = customer('History Credit');
  const booking = soldAndPaid(customerId);
  const cancellation = cancel(booking);
  cancellationService.convertCancellationToCredit(db, cancellation.id, { credit_date: '2026-10-27' });
  const credit = db.prepare('SELECT * FROM credit_notes WHERE cancellation_id = ?').get(cancellation.id);
  const next = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-10-28',
    items: [{ description: 'Visa service', quantity: 1, unit_price_cents: 100_000, account_id: account('4300').id }],
  });
  creditService.applyCredit(db, credit.id, { invoice_id: next.id, amount_cents: 63_000, applied_date: '2026-10-28' });
  const rows = lines(customerId);
  assert.deepEqual(rows.slice(4), [
    ['2026-10-27', 'cancellation_credit', 63_000, 0, 0],
    ['2026-10-28', 'invoice', 100_000, 0, 100_000],
    ['2026-10-28', 'credit', 0, 63_000, 37_000],
  ]);
});

test('charges above what was paid come as a charges invoice on the cancellation date', () => {
  const customerId = customer('History Shortfall');
  const booking = soldAndPaid(customerId, { paid: 0 });
  cancel(booking, { charges: 15_000, supplierCredit: 0 });
  assert.deepEqual(lines(customerId), [
    ['2026-10-20', 'invoice', 73_000, 0, 73_000],
    ['2026-10-25', 'cancellation', 0, 73_000, 0],
    ['2026-10-25', 'invoice', 15_000, 0, 15_000],
  ]);
});

test('the DSR keeps the sale on its day and nets to the charges less retained cost', () => {
  const customerId = customer('History DSR');
  const booking = soldAndPaid(customerId, { date: '2026-11-01' });
  const cancellation = cancel(booking, { date: '2026-11-05' });
  const rows = dailySales(db, '2026-11-01', '2026-11-30').days.flatMap((day) => day.rows);
  const sale = rows.find((row) => !row.is_cancellation && row.id === booking.invoice_id);
  const reversal = rows.find((row) => row.is_cancellation && row.cancellation_id === cancellation.id);
  assert.equal(sale.issue_date, '2026-11-01');
  assert.deepEqual([sale.sale_cents, sale.cost_cents, sale.margin_cents, sale.paid_cents], [73_000, 60_000, 13_000, 73_000]);
  assert.equal(sale.status_display, 'cancelled');
  assert.equal(sale.cancelled_by.number, cancellation.number);
  assert.equal(reversal.issue_date, '2026-11-05');
  assert.equal(reversal.number, cancellation.number);
  assert.deepEqual(
    [reversal.sale_cents, reversal.cost_cents, reversal.margin_cents, reversal.paid_cents],
    [-63_000, -55_000, -8_000, -63_000],
  );
  const totals = dailySales(db, '2026-11-01', '2026-11-30').totals;
  assert.deepEqual([totals.sale_cents, totals.cost_cents, totals.margin_cents], [10_000, 5_000, 5_000]);
});

test('an invoice voided as a mistake stays out of the DSR and the statement', () => {
  const customerId = customer('History Mistake');
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-12-10',
    items: [{ description: 'Typed twice', quantity: 1, unit_price_cents: 20_000, account_id: account('4300').id }],
  });
  invoiceService.voidInvoice(db, invoice.id, { remarks: 'Duplicate' });
  assert.equal(dailySales(db, '2026-12-10', '2026-12-10').days.flatMap((day) => day.rows)
    .filter((row) => row.id === invoice.id && !row.is_cancellation).length, 0);
  assert.deepEqual(lines(customerId), []);
});
