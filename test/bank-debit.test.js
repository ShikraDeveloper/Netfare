'use strict';

// Bank charges: the 6700 account and Compliance recurring bills the bank
// debits itself, recorded as already paid.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-bank-debit-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const compliance = require('../server/services/compliance');
const billService = require('../server/services/bills');
const reconciliation = require('../server/services/reconciliation');

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const balance = (code) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
`).get(code).total;
const bankId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Emirates Bank')").run().lastInsertRowid);

function bankCharges(extra = {}) {
  return compliance.createCompliance(db, {
    kind: 'recurring_bill',
    name: 'Account maintenance charges',
    category: 'Bank charges',
    vendor_id: bankId,
    account_id: account('6700').id,
    amount_cents: 2_625,
    frequency: 'monthly',
    next_due_date: '2026-08-25',
    auto_debit_account_id: account('1010').id,
    ...extra,
  });
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the chart of accounts has 6700 Bank Charges as an operating expense', () => {
  const row = account('6700');
  assert.equal(row.name, 'Bank Charges');
  assert.equal(row.type, 'expense');
  assert.equal(row.subtype, 'operating_expense');
});

test('a fixed bank debit is recorded as a paid bill on each due date, with no draft', () => {
  const item = bankCharges();
  const { dashboard } = require('../server/services/reports/dashboard');
  assert.equal(dashboard(db).todo.recurring_due.count, 1, 'the Today box reminds to run due bills');
  assert.equal(item.auto_create_bill, true, 'a fixed bank debit runs by itself');
  assert.equal(item.auto_debit_account_code, '1010');

  const { generated, errors } = compliance.runDueBills(db, { today: '2026-10-26' });
  assert.deepEqual(errors, []);
  assert.deepEqual(generated.map((row) => row.bill_date), ['2026-08-25', '2026-09-25', '2026-10-25']);
  for (const row of generated) {
    const bill = billService.getBill(db, row.bill_id);
    assert.equal(bill.status_display, 'paid');
    assert.equal(bill.payments.length, 1);
    assert.equal(bill.payments[0].payment_date, row.bill_date, 'paid on the day the bank took it');
    assert.equal(bill.payments[0].method, 'Bank debit');
  }
  assert.equal(balance('6700'), 3 * 2_625);
  assert.equal(balance('2000'), 0, 'nothing left owing');
  assert.equal(compliance.getCompliance(db, item.id).next_due_date, '2026-11-25');
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);
});

test('a variable bank debit waits for the amount, then is recorded paid', () => {
  const item = bankCharges({ name: 'Transfer charges', variable_amount: true, amount_cents: 0, next_due_date: '2026-10-31' });
  assert.equal(item.auto_create_bill, false);
  assert.equal(compliance.runDueBills(db, { today: '2026-11-02' }).generated.some((row) => row.item_id === item.id), false);
  const before = balance('1010');
  const { bill } = compliance.generateBill(db, item.id, { amount_cents: 1_890, bill_date: '2026-10-31' });
  assert.equal(bill.status_display, 'paid');
  assert.equal(balance('1010'), before - 1_890);
});

test('a bank debit needs no supplier: it is kept under the bank account\'s own name', () => {
  const item = bankCharges({ name: 'No supplier charges', vendor_id: null, next_due_date: '2027-01-05' });
  assert.equal(item.vendor_name, 'Bank Account (bank debits)');
  const again = bankCharges({ name: 'Second charge', vendor_id: undefined, next_due_date: '2027-01-06' });
  assert.equal(again.vendor_id, item.vendor_id, 'the same supplier record is reused');
  const { bill } = compliance.generateBill(db, item.id);
  assert.equal(bill.status_display, 'paid');
  assert.throws(
    () => compliance.createCompliance(db, {
      kind: 'recurring_bill', name: 'Rent', account_id: account('6000').id, amount_cents: 100, next_due_date: '2027-01-01',
    }),
    (error) => error.status === 400 && /Choose a vendor/.test(error.message),
    'a normal recurring bill still needs a supplier',
  );
});

test('switching the bank debit off brings back draft bills; the account must be cash or bank', () => {
  const item = bankCharges({ name: 'Card fee', next_due_date: '2026-12-01' });
  const plain = compliance.updateCompliance(db, item.id, { auto_debit_account_id: null, auto_create_bill: false });
  assert.equal(plain.auto_debit_account_id, null);
  const { bill } = compliance.generateBill(db, item.id);
  assert.equal(bill.status, 'draft');
  assert.throws(
    () => compliance.updateCompliance(db, item.id, { auto_debit_account_id: account('6700').id }),
    (error) => error.status === 400 && /cash or bank/.test(error.message),
  );
});
