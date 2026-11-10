'use strict';

// Correct (admin) for credit notes, supplier credits, refunds and manual
// journal entries: the original is voided on its own date and a new one
// posted; what used the original moves to the new one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-credit-corrections-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const credits = require('../server/services/credits');
const supplierCredits = require('../server/services/supplier-credits');
const journal = require('../server/services/journal');
const reconciliation = require('../server/services/reconciliation');
const { correct, correctCredit } = require('../server/services/corrections');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const balance = (code, date = '9999-12-31') => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS n
  FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
  WHERE a.code = ? AND e.entry_date <= ?
`).get(code, date).n;
const party = (table, name) => Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);

function checksMatch() {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  assert.deepEqual(reconciliation.reconciliationSummary(db).checks.filter((check) => !check.matched).map((check) => check.code || check.label), []);
}

test('a credit note: amount corrected, its application and refund move across', () => {
  const customer = party('customers', 'Credit Fix');
  const invoice = invoices.createInvoice(db, {
    customer_id: customer, issue_date: '2026-11-01', due_date: '2026-11-01', status: 'sent',
    items: [{ description: 'Service', quantity: 1, unit_price_cents: 30_000, account_id: account('4300') }],
  });
  const credit = credits.createCredit(db, { customer_id: customer, revenue_account_id: account('4300'), credit_date: '2026-11-02', amount_cents: 50_000 });
  credits.applyCredit(db, credit.id, { invoice_id: invoice.id, amount_cents: 30_000, applied_date: '2026-11-03' });
  credits.refundCredit(db, credit.id, { amount_cents: 10_000, refund_date: '2026-11-04', account_id: account('1000') });
  const revenue = balance('4300');

  assert.throws(() => correctCredit(db, 'credit_note', credit.id, { remarks: 'x', values: { amount_cents: 35_000 } }), /less than what was already used/);
  assert.throws(() => correctCredit(db, 'credit_note', credit.id, { remarks: 'x', values: { credit_date: '2026-11-05' } }), /cannot be after 2026-11-03/);
  const fixed = correctCredit(db, 'credit_note', credit.id, { remarks: 'Credit was 450', values: { amount_cents: 45_000 } });

  assert.equal(credits.getCredit(db, credit.id).status, 'void');
  assert.deepEqual([fixed.amount_cents, fixed.applied_cents, fixed.refunded_cents, fixed.credit_date], [45_000, 30_000, 10_000, '2026-11-02']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_applications WHERE credit_note_id = ?').get(fixed.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM refunds WHERE credit_note_id = ? AND status = 'paid'").get(fixed.id).n, 1);
  assert.equal(invoices.getInvoice(db, invoice.id).credit_applied_cents, 30_000);
  assert.equal(revenue - balance('4300'), 5_000, 'revenue up by the 50 no longer credited');
  assert.equal(balance('2450', '2026-11-02'), -45_000, 'on its own date only the corrected credit');
  checksMatch();
});

test('a supplier credit on a bill: amount corrected, its application moves across', () => {
  const vendor = party('vendors', 'Supplier Credit Fix');
  const bill = bills.createBill(db, {
    vendor_id: vendor, bill_date: '2026-11-01', due_date: '2026-11-01', status: 'received',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 80_000, account_id: account('5000') }],
  });
  const credit = supplierCredits.createSupplierCredit(db, { vendor_id: vendor, bill_id: bill.id, credit_date: '2026-11-02', amount_cents: 20_000 });
  supplierCredits.applySupplierCredit(db, credit.id, { bill_id: bill.id, amount_cents: 15_000, applied_date: '2026-11-02' });
  const cost = balance('5000');

  const fixed = correctCredit(db, 'supplier_credit', credit.id, { remarks: 'Supplier sent 250', values: { amount_cents: 25_000, notes: 'Fixed' } });
  assert.equal(supplierCredits.getSupplierCredit(db, credit.id).status, 'void');
  assert.deepEqual([fixed.amount_cents, fixed.applied_cents, fixed.bill_id, fixed.notes], [25_000, 15_000, bill.id, 'Fixed']);
  assert.equal(bills.getBill(db, bill.id).credit_applied_cents, 15_000);
  assert.equal(cost - balance('5000'), 5_000, 'cost down by 50 more');
  assert.throws(() => correctCredit(db, 'supplier_credit', fixed.id, { remarks: 'x', values: { amount_cents: 10_000 } }), /less than what was already used/);
  checksMatch();
});

test('a refund paid from a credit note: account and amount corrected', () => {
  const customer = party('customers', 'Refund Fix');
  const credit = credits.createCredit(db, { customer_id: customer, revenue_account_id: account('4300'), credit_date: '2026-11-02', amount_cents: 20_000 });
  credits.refundCredit(db, credit.id, { amount_cents: 20_000, refund_date: '2026-11-03', account_id: account('1000') });
  const refund = db.prepare('SELECT * FROM refunds WHERE credit_note_id = ?').get(credit.id);
  const cash = balance('1000');
  const bank = balance('1010');

  const result = correct(db, 'refund', refund.id, { remarks: 'Paid 150 by bank', values: { amount_cents: 15_000, account_id: account('1010'), method: 'Bank transfer' } });
  assert.equal(db.prepare('SELECT status FROM refunds WHERE id = ?').get(refund.id).status, 'void');
  const fresh = db.prepare('SELECT * FROM refunds WHERE id = ?').get(result.id);
  assert.deepEqual([fresh.amount_cents, fresh.refund_date, fresh.credit_note_id], [15_000, '2026-11-03', credit.id]);
  assert.equal(credits.getCredit(db, credit.id).refunded_cents, 15_000);
  assert.equal(balance('1000') - cash, 20_000, 'the cash refund is undone');
  assert.equal(bank - balance('1010'), 15_000, 'the bank paid 150');
  assert.equal(balance('1000', '2026-11-03') - balance('1000', '2026-11-02'), 0, 'on its own date the wrong cash refund is gone');
  checksMatch();
});

test('a manual journal entry: lines corrected; a document entry is refused', () => {
  const id = db.transaction(() => journal.createManualEntry(db, {
    entry_date: '2026-11-05', memo: 'Office rent', reference: 'J-1',
    lines: [
      { account_id: account('5000'), debit_cents: 40_000, credit_cents: 0 },
      { account_id: account('1010'), debit_cents: 0, credit_cents: 40_000 },
    ],
  }))();
  const bank = balance('1010');

  const kept = correct(db, 'journal', id, { remarks: 'Memo only', values: { memo: 'Office rent November' } });
  const keptLines = db.prepare('SELECT account_id, debit_cents, credit_cents FROM journal_lines WHERE entry_id = ? ORDER BY sort_order').all(kept.id);
  assert.deepEqual(keptLines.map((line) => line.debit_cents + line.credit_cents), [40_000, 40_000], 'unsent lines are kept');
  assert.equal(balance('1010'), bank);

  const fixed = correct(db, 'journal', kept.id, {
    remarks: 'Rent was 450 paid in cash',
    values: { lines: [
      { account_id: account('5000'), debit_cents: 45_000, credit_cents: 0 },
      { account_id: account('1000'), debit_cents: 0, credit_cents: 45_000 },
    ] },
  });
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(fixed.id);
  assert.deepEqual([entry.entry_date, entry.memo, entry.reference, entry.source_type], ['2026-11-05', 'Office rent November', 'J-1', 'manual']);
  assert.ok(db.prepare('SELECT voided_at FROM journal_entries WHERE id = ?').get(kept.id).voided_at);
  assert.equal(balance('1010') - bank, 40_000);
  const document = db.prepare("SELECT id FROM journal_entries WHERE source_type = 'invoice' LIMIT 1").get();
  assert.throws(() => correct(db, 'journal', document.id, { remarks: 'x' }), /posted by a document/);
  checksMatch();
});

test('a voided refund no longer holds back the credit date', () => {
  const customer = party('customers', 'Date Fix');
  const credit = credits.createCredit(db, { customer_id: customer, revenue_account_id: account('4300'), credit_date: '2026-11-02', amount_cents: 5_000 });
  credits.refundCredit(db, credit.id, { amount_cents: 1_000, refund_date: '2026-11-03', account_id: account('1000') });
  const refund = db.prepare('SELECT id FROM refunds WHERE credit_note_id = ?').get(credit.id);
  assert.throws(() => correctCredit(db, 'credit_note', credit.id, { remarks: 'x', values: { credit_date: '2026-11-05' } }), /cannot be after 2026-11-03/);
  require('../server/services/refunds').voidRefund(db, refund.id, { remarks: 'Entered by mistake' });
  const fixed = correctCredit(db, 'credit_note', credit.id, { remarks: 'Issued on the 5th', values: { credit_date: '2026-11-05' } });
  assert.equal(fixed.credit_date, '2026-11-05');
  checksMatch();
});

test('a payment into an archived account can still be voided; new ones are refused', () => {
  const oldBank = Number(db.prepare("INSERT INTO accounts (code, name, type, normal_balance, is_cash, is_active) VALUES ('1098', 'Closed bank', 'asset', 'debit', 1, 1)").run().lastInsertRowid);
  const customer = party('customers', 'Archived Bank');
  const invoice = invoices.createInvoice(db, {
    customer_id: customer, issue_date: '2026-11-01', due_date: '2026-11-01', status: 'sent',
    items: [{ description: 'Service', quantity: 1, unit_price_cents: 10_000, account_id: account('4300') }],
  });
  invoices.recordInvoicePayment(db, invoice.id, { amount_cents: 10_000, payment_date: '2026-11-02', method: 'Bank transfer', deposit_account_id: oldBank });
  const payment = db.prepare('SELECT id FROM payments WHERE invoice_id = ?').get(invoice.id);
  db.prepare('UPDATE accounts SET is_active = 0 WHERE id = ?').run(oldBank);

  invoices.deleteInvoicePayment(db, payment.id, { remarks: 'Paid into the wrong bank' });
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(payment.id).status, 'void');
  assert.equal(balance('1098'), 0);
  assert.throws(() => invoices.recordInvoicePayment(db, invoice.id, {
    amount_cents: 10_000, payment_date: '2026-11-03', method: 'Bank transfer', deposit_account_id: oldBank,
  }), /archived/);
  checksMatch();
});
