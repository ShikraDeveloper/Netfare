'use strict';

// IFRS wording: account names, cost of sales and the statement of profit or loss.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-ifrs-terms-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const runMigrations = require('../server/migrations');
const reports = require('../server/services/reports');
const bookingService = require('../server/services/bookings');
const billService = require('../server/services/bills');

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('accounts carry IFRS names and travel costs are cost of sales', () => {
  const names = Object.fromEntries(['1100', '1200', '1400', '1460', '2000', '2400', '2500', '2600', '4300', '4330', '5000', '5100', '5120']
    .map((code) => [code, account(code).name]));
  assert.deepEqual(names, {
    1100: 'Trade Receivables',
    1200: 'Prepayments',
    1400: 'Advances to Suppliers',
    1460: 'Refundable Deposits Paid',
    2000: 'Trade Payables',
    2400: 'Contract Liabilities (Customer Advances)',
    2500: 'Refund Liabilities',
    2600: 'Refundable Security Deposits Held',
    4300: 'Service Fee Income',
    4330: 'Cancellation Fee Income',
    5000: 'Cost of Sales – Air Tickets',
    5100: 'Cost of Sales – Hotels & Tours',
    5120: 'Cost of Sales – Visas',
  });
  for (const code of ['5000', '5100', '5120']) assert.equal(account(code).subtype, 'cogs', `${code} is cost of sales`);
});

test('old default names are renamed on start; names the user chose are kept', () => {
  db.prepare("UPDATE accounts SET name = 'Accounts Receivable' WHERE code = '1100'").run();
  db.prepare("UPDATE accounts SET name = 'Our prepaid costs' WHERE code = '1200'").run();
  db.prepare("UPDATE accounts SET subtype = 'operating_expense' WHERE code = '5120'").run();
  runMigrations(db);
  assert.equal(account('1100').name, 'Trade Receivables');
  assert.equal(account('1200').name, 'Our prepaid costs');
  assert.equal(account('5120').subtype, 'cogs');
});

test('the statement of profit or loss shows cost of sales, gross profit and profit for the period', () => {
  const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('IFRS Customer')").run().lastInsertRowid);
  const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('IFRS Airline')").run().lastInsertRowid);
  bookingService.confirmBooking(db, bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: '2026-09-10',
    due_date: '2026-09-10',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 100_000, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: 80_000, account_id: account('5000').id, vendor_id: vendorId }],
  }).id);
  billService.createBill(db, {
    vendor_id: vendorId,
    bill_date: '2026-09-12',
    status: 'received',
    items: [{ description: 'Office rent', quantity: 1, unit_price_cents: 5_000, account_id: account('6000').id }],
  });
  const pl = reports.incomeStatement(db, '2026-09-01', '2026-09-30');
  assert.equal(pl.revenue_total_cents, 100_000);
  assert.equal(pl.cost_of_sales_total_cents, 80_000);
  assert.equal(pl.gross_profit_cents, 20_000);
  assert.equal(pl.operating_expenses_total_cents, 5_000);
  assert.equal(pl.profit_cents, 15_000);
  assert.deepEqual(pl.cost_of_sales.map((row) => row.code), ['5000']);
  assert.deepEqual(pl.operating_expenses.map((row) => row.code), ['6000']);
  const sfp = reports.balanceSheet(db, '2026-09-30');
  assert.match(sfp.equity.find((row) => row.is_current_earnings).name, /^Profit for the period/);
});
