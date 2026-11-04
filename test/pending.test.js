'use strict';

// The dashboard's "things pending" list: what is waiting, grouped, with the
// days each item has waited, and only the areas a staff user may see.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-pending-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const { pendingList } = require('../server/services/reports/pending');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const TODAY = '2026-11-04';

function account(code) {
  return db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
}

function customer(name) {
  return Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
}

function invoice(customerId, date, due, amount) {
  return invoiceService.createInvoice(db, {
    customer_id: customerId, issue_date: date, due_date: due, status: 'sent',
    items: [{ description: 'Visa service', quantity: 1, unit_price_cents: amount, account_id: account('4300').id }],
  });
}

function group(list, key) {
  return list.groups.find((row) => row.key === key);
}

test('nothing pending on empty books', () => {
  const list = pendingList(db, null, { today: TODAY });
  assert.equal(list.count, 0);
  assert.deepEqual(list.groups, []);
});

test('unpaid invoices: days overdue from the due date, oldest first, days left while not due', () => {
  const id = customer('Pending Customer');
  invoice(id, '2026-09-01', '2026-09-24', 42_000);
  invoice(id, '2026-11-01', '2026-11-14', 7_000);
  invoice(id, '2026-10-01', '2026-10-18', 13_500);
  const collect = group(pendingList(db, null, { today: TODAY }), 'collect');
  assert.equal(collect.count, 3);
  assert.equal(collect.cents, 62_500);
  assert.equal(collect.oldest_days, 41);
  assert.equal(collect.over_30, 1);
  assert.deepEqual(collect.items.map((item) => [item.days, item.due_in]), [[41, undefined], [17, undefined], [0, 10]]);
  assert.match(collect.items[0].href, /^#\/invoices\/\d+$/);
});

test('a card payment waits in 1030 until settled, counted from its date', () => {
  const id = customer('Card Customer');
  const inv = invoice(id, '2026-10-20', '2026-10-20', 10_000);
  invoiceService.recordInvoicePayment(db, inv.id, {
    amount_cents: 10_000, payment_date: '2026-10-26', method: 'Payment link', deposit_account_id: account('1030').id,
  });
  const card = group(pendingList(db, null, { today: TODAY }), 'card');
  assert.equal(card.count, 1);
  assert.equal(card.cents, 10_000);
  assert.equal(card.items[0].days, 9);
  assert.match(card.items[0].label, /Payment link · Card Customer/);
});

test('more than five items: five shown, the count and total cover all', () => {
  const id = customer('Many Invoices');
  for (let day = 1; day <= 6; day += 1) invoice(id, `2026-08-0${day}`, `2026-08-0${day}`, 1_000);
  const collect = group(pendingList(db, null, { today: TODAY }), 'collect');
  assert.equal(collect.items.length, 5);
  assert.equal(collect.count, 9);
});

test('staff see only the groups of areas they have a right to', () => {
  const salesOnly = { is_admin: 0, permissions: JSON.stringify({ sales: 'view' }) };
  assert.deepEqual(pendingList(db, salesOnly, { today: TODAY }).groups.map((row) => row.key), ['collect']);
  const nothing = { is_admin: 0, permissions: '{}' };
  assert.equal(pendingList(db, nothing, { today: TODAY }).count, 0);
  const admin = pendingList(db, { is_admin: 1 }, { today: TODAY });
  assert.ok(admin.groups.some((row) => row.key === 'card'));
  assert.equal(admin.count, admin.groups.reduce((sum, row) => sum + row.count, 0));
});
