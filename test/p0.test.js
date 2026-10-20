'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const Database = require('better-sqlite3');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-p0-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');
const refundService = require('../server/services/refunds');
const cashDepositService = require('../server/services/cash-deposits');
const backupService = require('../server/services/backup');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

function insertCustomer(name) {
  return Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
}

function insertVendor(name) {
  return Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(name).lastInsertRowid);
}

function assertBalanced() {
  const totals = db.prepare(`
    SELECT COALESCE(SUM(debit_cents), 0) AS debit, COALESCE(SUM(credit_cents), 0) AS credit
    FROM journal_lines
  `).get();
  assert.equal(totals.debit, totals.credit, 'journal debits must equal credits');
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('default chart loads and starts balanced', () => {
  assert.ok(account('1000'));
  assert.ok(account('3000'));
  assertBalanced();
});

test('cash invoice payment posts and is limited to cash/bank accounts', () => {
  const customerId = insertCustomer('P0 Customer');
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-10-20',
    due_date: '2026-10-20',
    tax_rate: 0,
    status: 'sent',
    items: [{ description: 'Test sale', quantity: 1, unit_price_cents: 100_000, account_id: account('4000').id }],
  });
  assert.equal(invoice.amount_paid_cents, 0);

  const paid = invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: 100_000,
    payment_date: '2026-10-20',
    method: 'Cash',
    deposit_account_id: account('1000').id,
  });
  assert.equal(paid.amount_paid_cents, 100_000);
  assert.equal(paid.payments[0].deposit_account_id, account('1000').id);
  assertBalanced();
});

test('invoice payment to a non-cash asset is rejected', () => {
  const customerId = insertCustomer('Bad Payment Customer');
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'sent',
    items: [{ description: 'Test sale', quantity: 1, unit_price_cents: 50_000, account_id: account('4000').id }],
  });
  assert.throws(
    () => invoiceService.recordInvoicePayment(db, invoice.id, {
      amount_cents: 50_000,
      payment_date: '2026-10-20',
      method: 'Bank transfer',
      deposit_account_id: account('1100').id,
    }),
    /cash or bank account/,
  );
  assertBalanced();
});

test('bill lines reject cash and receivable accounts', () => {
  const vendorId = insertVendor('P0 Vendor');
  const base = {
    vendor_id: vendorId,
    bill_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'draft',
    items: [{ description: 'Rent', quantity: 1, unit_price_cents: 50_000, account_id: account('1000').id }],
  };
  assert.throws(() => billService.createBill(db, base), /expense account or a valid non-cash asset/);
  assert.throws(
    () => billService.createBill(db, { ...base, items: [{ description: 'Rent', quantity: 1, unit_price_cents: 50_000, account_id: account('1100').id }] }),
    /expense account or a valid non-cash asset/,
  );
});

test('bill payment must use cash/bank and posts a balanced entry', () => {
  const vendorId = insertVendor('P0 Payable Vendor');
  const bill = billService.createBill(db, {
    vendor_id: vendorId,
    bill_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'received',
    items: [{ description: 'Rent', quantity: 1, unit_price_cents: 50_000, account_id: account('6000').id }],
  });
  assert.throws(
    () => billService.recordBillPayment(db, bill.id, {
      amount_cents: 50_000,
      payment_date: '2026-10-20',
      method: 'Bank transfer',
      payment_account_id: account('1100').id,
    }),
    /cash or bank account/,
  );
  const paid = billService.recordBillPayment(db, bill.id, {
    amount_cents: 50_000,
    payment_date: '2026-10-20',
    method: 'Bank transfer',
    payment_account_id: account('1010').id,
  });
  assert.equal(paid.balance_cents, 0);
  assertBalanced();
});

test('cash deposit moves cash to bank and can be voided', () => {
  const before = cashDepositService.cashBalances(db);
  assert.ok(before.cash_balance_cents >= 50_000, 'cash payment created a cash balance');
  const deposit = cashDepositService.createDeposit(db, {
    amount_cents: 40_000,
    deposit_date: '2026-10-20',
    from_account_id: account('1000').id,
    to_account_id: account('1010').id,
    reference: 'P0-SLIP',
  });
  assert.equal(deposit.status, 'posted');
  const deposited = cashDepositService.cashBalances(db);
  assert.equal(deposited.cash_balance_cents, before.cash_balance_cents - 40_000);
  assert.equal(deposited.bank_balance_cents, before.bank_balance_cents + 40_000);
  const voided = cashDepositService.voidDeposit(db, deposit.id, {});
  assert.equal(voided.status, 'void');
  const restored = cashDepositService.cashBalances(db);
  assert.equal(restored.cash_balance_cents, before.cash_balance_cents);
  assert.equal(restored.bank_balance_cents, before.bank_balance_cents);
  assertBalanced();
});

test('customer refund increases receivable and void restores payment balance', () => {
  const customerId = insertCustomer('Refund Customer');
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'sent',
    items: [{ description: 'Refundable sale', quantity: 1, unit_price_cents: 80_000, account_id: account('4000').id }],
  });
  const paid = invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: 80_000,
    payment_date: '2026-10-20',
    method: 'Cash',
    deposit_account_id: account('1000').id,
  });
  const refund = refundService.createRefund(db, {
    refund_type: 'customer',
    payment_id: paid.payments[0].id,
    amount_cents: 20_000,
    refund_date: '2026-10-20',
    method: 'Bank transfer',
    account_id: account('1010').id,
  });
  const afterRefund = invoiceService.getInvoice(db, invoice.id);
  assert.equal(afterRefund.amount_paid_cents, 60_000);
  const voided = refundService.voidRefund(db, refund.id, {});
  assert.equal(voided.status, 'void');
  const afterVoid = invoiceService.getInvoice(db, invoice.id);
  assert.equal(afterVoid.amount_paid_cents, 80_000);
  assertBalanced();
});

test('full database backup is a valid SQLite database', () => {
  const backup = backupService.createDatabaseBackup(db, 'p0-test');
  assert.ok(fs.existsSync(backup.path));
  const copy = new Database(backup.path, { readonly: true });
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  copy.close();
});

test('final ledger remains balanced', () => {
  assertBalanced();
});
