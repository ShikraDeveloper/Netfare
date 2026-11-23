'use strict';

// Pay supplier: one transfer for several bills is one entry (the bank shows
// it once, with its bank charges), each bill gets its share, the supplier
// statement shows one line with the bills under it, and voids put back
// exactly what they should.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-supplier-payments-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bills = require('../server/services/bills');
const statements = require('../server/services/statements');
const corrections = require('../server/services/corrections');
const { paySupplier, voidSupplierPayment } = require('../server/services/supplier-payments');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const ledger = (code) => db.prepare(`SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS b
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?`).get(code).b;
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Visa Supplier')").run().lastInsertRowid);
const bill = (date, cents) => bills.createBill(db, {
  vendor_id: vendorId, bill_date: date, due_date: date, status: 'received',
  items: [{ description: 'Visa', quantity: 1, unit_price_cents: cents, account_id: account('5000') }],
});
const paid = (id) => db.prepare('SELECT amount_paid_cents FROM bills WHERE id = ?').get(id).amount_paid_cents;
const pay = (extra = {}) => paySupplier(db, {
  vendor_id: vendorId, payment_date: '2026-11-23', amount_cents: 140_000, payment_account_id: account('1010'),
  method: 'Bank transfer', reference: 'FT2611230045', bank_charges_cents: 1_050, ...extra,
});

const first = bill('2026-11-20', 70_000);
const second = bill('2026-11-21', 70_000);
const third = bill('2026-11-22', 95_000);

test('the amount must all go on bills, never more than a bill owes, and no cheques', () => {
  assert.throws(() => pay({ allocations: [{ bill_id: first.id, amount_cents: 70_000 }] }), /700\.00 is not on any bill/);
  assert.throws(() => pay({ allocations: [{ bill_id: first.id, amount_cents: 140_000 }] }), /More than the 700\.00 due/);
  assert.throws(() => pay({ method: 'Cheque' }), /cheque on each bill/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM supplier_payments').get().c, 0, 'nothing saved');
});

test('one transfer of 1,400 pays two bills, oldest first, in one entry with its bank charges', () => {
  const bankBefore = ledger('1010');
  const apBefore = ledger('2000');
  const payment = pay();
  assert.match(payment.number, /^SPAY-2026-\d{4}$/);
  assert.deepEqual(payment.bills.map((row) => [row.bill_number, row.amount_cents]), [[first.number, 70_000], [second.number, 70_000]]);
  assert.deepEqual([paid(first.id), paid(second.id), paid(third.id)], [70_000, 70_000, 0]);
  assert.equal(ledger('1010') - bankBefore, -141_050, 'the bank pays 1,400 and 10.50 charges');
  assert.equal(ledger('2000') - apBefore, 140_000);
  assert.equal(ledger('6700'), 1_050);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT journal_entry_id) AS c FROM bill_payments WHERE supplier_payment_id = ?').get(payment.id).c, 1, 'one entry');

  const lines = statements.vendorStatement(db, vendorId, { from: '2026-01-01' }).transactions;
  assert.equal(lines.filter((row) => row.kind === 'payment').length, 0, 'no line per bill');
  const line = lines.find((row) => row.kind === 'supplier_payment');
  assert.equal(line.debit_cents, 140_000);
  assert.equal(line.related, 'FT2611230045');
  assert.deepEqual(line.paid.map((use) => [use.number, use.amount_cents, use.part]), [[first.number, 70_000, false], [second.number, 70_000, false]]);
  assert.throws(() => corrections.correct(db, 'bill_payment', payment.bills[0].payment_id, { amount_cents: 60_000, reason: 'Typo' }), /part of one payment/);
});

test('one share voided on its bill gives back only that share; voiding the payment gives back the rest and the charges', () => {
  const payment = db.prepare('SELECT * FROM supplier_payments ORDER BY id DESC LIMIT 1').get();
  const [one] = db.prepare('SELECT id FROM bill_payments WHERE supplier_payment_id = ? ORDER BY id').all(payment.id);
  const bankBefore = ledger('1010');
  bills.deleteBillPayment(db, one.id, { remarks: 'Wrong bill' });
  assert.equal(ledger('1010') - bankBefore, 70_000);
  assert.equal(paid(first.id), 0);
  const line = statements.vendorStatement(db, vendorId, { from: '2026-01-01' }).transactions.find((row) => row.kind === 'supplier_payment');
  assert.equal(line.debit_cents, 70_000, 'the line shows what is still paid');

  voidSupplierPayment(db, payment.id, { remarks: 'Sent twice' });
  assert.equal(ledger('1010') - bankBefore, 141_050, 'everything back, charges too');
  assert.equal(ledger('6700'), 0);
  assert.equal(paid(second.id), 0);
  assert.ok(!statements.vendorStatement(db, vendorId, { from: '2026-01-01' }).transactions.some((row) => row.kind === 'supplier_payment'));
  assert.throws(() => voidSupplierPayment(db, payment.id, {}), /already void/);
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  // The statement still ties to the ledger.
  assert.equal(statements.vendorStatement(db, vendorId, { from: '2000-01-01' }).closing_balance_cents, -ledger('2000'));
});
