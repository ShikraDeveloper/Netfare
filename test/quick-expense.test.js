'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-quick-expense-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const billService = require('../server/services/bills');
const reconciliation = require('../server/services/reconciliation');

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const balance = (code) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
`).get(code).total;

function assertBadRequest(fn, pattern) {
  assert.throws(fn, (error) => error.status === 400 && pattern.test(error.message));
}

// Some cash in the drawer first.
db.prepare("INSERT INTO journal_entries (entry_date, memo, source_type) VALUES ('2026-10-01', 'Opening cash', 'opening_balance')").run();
const openingId = db.prepare('SELECT MAX(id) AS id FROM journal_entries').get().id;
db.prepare('INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?, ?, 100000, 0), (?, ?, 0, 100000)')
  .run(openingId, account('1000').id, openingId, account('3900').id);

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a quick expense without a supplier is a paid bill: expense up, cash down, nothing owed', () => {
  const bill = billService.createQuickExpense(db, {
    description: 'Taxi to embassy',
    amount_cents: 4_500,
    expense_date: '2026-10-20',
    account_id: account('6600').id,
    payment_account_id: account('1000').id,
    method: 'Cash',
    reference: 'RCPT-77',
  });
  assert.equal(bill.status_display, 'paid');
  assert.equal(bill.vendor_name, billService.SUNDRY_VENDOR);
  assert.equal(bill.bill_date, '2026-10-20');
  assert.match(bill.notes, /Quick expense · paid now/);
  assert.equal(bill.payments.length, 1);
  assert.equal(bill.payments[0].method, 'Cash');
  assert.equal(balance('6600'), 4_500);
  assert.equal(balance('1000'), 100_000 - 4_500);
  assert.equal(balance('2000'), 0, 'Trade payables nets to zero');
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);

  const second = billService.createQuickExpense(db, {
    description: 'Office tea', amount_cents: 1_200, account_id: account('6900').id, payment_account_id: account('1000').id,
  });
  assert.equal(second.vendor_id, bill.vendor_id, 'the sundry supplier is reused');
});

test('a quick expense can name a supplier and be voided like any bill', () => {
  const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Stationery Mart')").run().lastInsertRowid);
  const before = balance('1000');
  const bill = billService.createQuickExpense(db, {
    description: 'Printer paper', amount_cents: 8_000, expense_date: '2026-10-21',
    account_id: account('6300').id, payment_account_id: account('1000').id, vendor_id: vendorId,
  });
  assert.equal(bill.vendor_name, 'Stationery Mart');
  billService.voidBill(db, bill.id, { remarks: 'Entered twice' });
  assert.equal(balance('1000'), before, 'cash comes back');
  assert.equal(billService.getBill(db, bill.id).status, 'void');
});

test('a quick expense needs a description, an amount, an expense account and a cash or bank account', () => {
  const base = { description: 'X', amount_cents: 100, account_id: account('6900').id, payment_account_id: account('1000').id };
  assertBadRequest(() => billService.createQuickExpense(db, { ...base, description: '' }), /What it was for/);
  assertBadRequest(() => billService.createQuickExpense(db, { ...base, amount_cents: 0 }), /Amount/);
  assertBadRequest(() => billService.createQuickExpense(db, { ...base, account_id: account('1000').id }), /expense account/);
  assertBadRequest(() => billService.createQuickExpense(db, { ...base, payment_account_id: account('6900').id }), /cash or bank/);
  const count = db.prepare("SELECT COUNT(*) AS n FROM bills WHERE notes LIKE 'Quick expense%'").get().n;
  assertBadRequest(() => billService.createQuickExpense(db, { ...base, method: 'Cheque' }), /cheque number/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bills WHERE notes LIKE 'Quick expense%'").get().n, count, 'nothing half-saved');
});
