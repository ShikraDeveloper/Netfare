'use strict';

// One customer payment for several invoices (two visas paid together).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-customer-receipts-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const advances = require('../server/services/advances');
const reconciliation = require('../server/services/reconciliation');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function account(code) {
  return db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
}

function balance(code) {
  return db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS net
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
  `).get(code).net;
}

function customer(name) {
  return Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
}

function invoice(customerId, date, amount) {
  return invoiceService.createInvoice(db, {
    customer_id: customerId, issue_date: date, due_date: date, status: 'sent',
    items: [{ description: 'Visa service', quantity: 1, unit_price_cents: amount, account_id: account('4300').id }],
  });
}

function paid(id) {
  return db.prepare('SELECT amount_paid_cents FROM invoices WHERE id = ?').get(id).amount_paid_cents;
}

function bankLines(entryId) {
  return db.prepare(`
    SELECT l.debit_cents, l.credit_cents FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.entry_id = ? AND a.code = '1010'
  `).all(entryId);
}

test('700 for two visa invoices of 350: one receipt, one bank entry, both invoices paid', () => {
  const customerId = customer('Two Visas');
  const first = invoice(customerId, '2026-11-01', 35_000);
  const second = invoice(customerId, '2026-11-02', 35_000);
  const bankBefore = balance('1010');

  const receipt = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 70_000, receipt_date: '2026-11-03',
    method: 'Bank transfer', reference: 'TT 123', deposit_account_id: account('1010').id,
  });
  assert.equal(receipt.is_receipt, 1);
  assert.match(receipt.number, /^RCP-2026-\d{4}$/, 'receipts have their own series');
  const advance = advances.createAdvance(db, { customer_id: customerId, amount_cents: 1_000, advance_date: '2026-11-03', deposit_account_id: account('1010').id });
  assert.match(advance.number, /^ADV-2026-\d{4}$/, 'plain advances keep ADV');
  db.prepare("UPDATE settings SET receipt_prefix = 'RV' WHERE id = 1").run();
  const renamed = advances.receivePayment(db, { customer_id: customerId, amount_cents: 500, receipt_date: '2026-11-03', deposit_account_id: account('1010').id, allocations: [] });
  assert.match(renamed.number, /^RV-2026-\d{4}$/, 'the prefix comes from Settings');
  db.prepare("UPDATE settings SET receipt_prefix = 'RCP' WHERE id = 1").run();
  advances.voidAdvance(db, advance.id, {});
  advances.voidAdvance(db, renamed.id, {});
  assert.deepEqual(receipt.invoices.map((row) => [row.invoice_number, row.amount_cents, row.balance_cents]), [
    [first.number, 35_000, 0],
    [second.number, 35_000, 0],
  ]);
  assert.equal(receipt.remaining_cents, 0);
  assert.equal(paid(first.id), 35_000);
  assert.equal(paid(second.id), 35_000);
  assert.equal(balance('1010') - bankBefore, 70_000);
  assert.deepEqual(bankLines(receipt.journal_entry_id).map((line) => line.debit_cents), [70_000], 'one bank line for the whole payment');
  const shares = db.prepare('SELECT method, reference FROM payments WHERE advance_id = ?').all(receipt.id);
  assert.deepEqual(shares.map((row) => [row.method, row.reference]), [['Bank transfer', receipt.number], ['Bank transfer', receipt.number]]);
});

test('chosen shares, the rest kept as an advance, bank charges, and a void undoes it all', () => {
  const customerId = customer('Chosen Shares');
  const a = invoice(customerId, '2026-11-01', 40_000);
  const b = invoice(customerId, '2026-11-01', 50_000);
  const later = invoice(customerId, '2026-11-10', 10_000);
  const bankBefore = balance('1010');
  const chargesBefore = balance('6700');

  const receipt = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 100_000, receipt_date: '2026-11-05', deposit_account_id: account('1010').id,
    bank_charges_cents: 1_000,
    allocations: [{ invoice_id: b.id, amount_cents: 50_000 }, { invoice_id: a.id, amount_cents: 20_000 }],
  });
  assert.equal(paid(b.id), 50_000);
  assert.equal(paid(a.id), 20_000);
  assert.equal(receipt.remaining_cents, 30_000, 'kept as the customer advance');
  assert.equal(balance('1010') - bankBefore, 99_000, 'the bank kept its charges');
  assert.equal(balance('6700') - chargesBefore, 1_000);

  assert.throws(() => advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 5_000, receipt_date: '2026-11-05', deposit_account_id: account('1010').id,
    allocations: [{ invoice_id: later.id, amount_cents: 5_000 }],
  }), /dated on or before/);
  assert.throws(() => advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 5_000, receipt_date: '2026-11-05', deposit_account_id: account('1010').id,
    allocations: [{ invoice_id: a.id, amount_cents: 6_000 }],
  }), /more than the amount received/);
  assert.throws(() => advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 90_000, receipt_date: '2026-11-05', deposit_account_id: account('1010').id,
    allocations: [{ invoice_id: a.id, amount_cents: 30_000 }],
  }), /More than the 200.00 due/);

  advances.voidAdvance(db, receipt.id, { remarks: 'Wrong customer' });
  assert.equal(paid(a.id), 0);
  assert.equal(paid(b.id), 0);
  assert.equal(balance('1010'), bankBefore);
  assert.equal(balance('6700'), chargesBefore);
  assert.equal(advances.getReceipt(db, receipt.id).invoices.length, 0);
});

test('the books balance and every ledger check matches', () => {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  const summary = reconciliation.reconciliationSummary(db);
  assert.deepEqual(summary.checks.filter((check) => !check.matched).map((check) => check.code || check.label), []);
});

test('the customer page lists receipts: newest first, the invoices each paid, what is left, voided ones left out', () => {
  const customerId = customer('Receipts List');
  const a = invoice(customerId, '2026-11-01', 30_000);
  const b = invoice(customerId, '2026-11-01', 20_000);
  const first = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 60_000, receipt_date: '2026-11-02', method: 'Bank transfer', deposit_account_id: account('1010').id,
  });
  const wrong = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 5_000, receipt_date: '2026-11-03', deposit_account_id: account('1010').id, allocations: [],
  });
  const later = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 1_000, receipt_date: '2026-11-04', method: 'Cash', deposit_account_id: account('1000').id, allocations: [],
  });
  advances.voidAdvance(db, wrong.id, { remarks: 'Entered twice' });

  const page = require('../server/services/customer-balances').getCustomerBalance(db, customerId);
  assert.deepEqual(page.receipts.map((row) => [row.number, row.amount_cents, row.remaining_cents, row.invoice_numbers]), [
    [later.number, 1_000, 1_000, null],
    [first.number, 60_000, 10_000, `${a.number}, ${b.number}`],
  ]);
});
