'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-p1-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const openingBalances = require('../server/services/opening-balances');
const statements = require('../server/services/statements');
const bankReconciliations = require('../server/services/bank-reconciliations');
const creditService = require('../server/services/credits');
const reports = require('../server/services/reports');
const demoService = require('../server/services/demo');
const backupService = require('../server/services/backup');
const { postEntry } = require('../server/accounting');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');

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
  assert.equal(totals.debit, totals.credit);
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('opening balances replace the previous entry with a reversal', () => {
  const empty = openingBalances.getOpeningBalances(db);
  assert.equal(empty.entry_id, null);
  assert.ok(empty.equity_account);

  const first = openingBalances.saveOpeningBalances(db, {
    entry_date: '2026-01-01',
    balances: [
      { account_id: account('1000').id, debit_cents: 100_000, credit_cents: 0 },
      { account_id: account('1010').id, debit_cents: 250_000, credit_cents: 0 },
      { account_id: account('2000').id, debit_cents: 0, credit_cents: 50_000 },
    ],
  });
  assert.ok(first.entry_id);
  assert.equal(first.total_debit_cents, 350_000);
  assert.equal(first.total_credit_cents, 50_000);
  assert.equal(first.equity_cents, 300_000);
  const equityLine = db.prepare(`
    SELECT l.* FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.entry_id = ? AND a.code = '3900'
  `).get(first.entry_id);
  assert.equal(equityLine.credit_cents, 300_000);

  const second = openingBalances.saveOpeningBalances(db, {
    entry_date: '2026-01-02',
    balances: [{ account_id: account('1000').id, debit_cents: 75_000, credit_cents: 0 }],
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM journal_entries WHERE source_type = 'opening_balance'").get().count, 2);
  assert.ok(db.prepare("SELECT id FROM journal_entries WHERE source_type = 'opening_balance_reversal' AND source_id = ?").get(first.entry_id));
  assert.equal(second.total_debit_cents, 75_000);
  assert.equal(second.equity_cents, 75_000);

  openingBalances.clearOpeningBalances(db);
  assert.equal(openingBalances.getOpeningBalances(db).entry_id, null);
  assertBalanced();
});

test('bank reconciliation clears lines, tracks differences and reopens the latest', () => {
  const bankId = Number(db.prepare(`
    INSERT INTO accounts (code, name, type, subtype, normal_balance, is_cash)
    VALUES ('1099', 'Reconciliation Test Bank', 'asset', 'current_asset', 'debit', 1)
  `).run().lastInsertRowid);

  postEntry(db, {
    entry_date: '2026-01-05',
    memo: 'Opening bank deposit',
    lines: [
      { account_id: bankId, debit_cents: 100_000, credit_cents: 0 },
      { account_id: account('3000').id, debit_cents: 0, credit_cents: 100_000 },
    ],
  });

  const firstWorkspace = bankReconciliations.getWorkspace(db, { account_id: bankId, statement_date: '2026-01-31' });
  assert.equal(firstWorkspace.ledger_balance_cents, 100_000);
  assert.equal(firstWorkspace.lines.length, 1);
  const firstLineId = firstWorkspace.lines[0].id;

  const first = bankReconciliations.createReconciliation(db, {
    account_id: bankId,
    statement_date: '2026-01-31',
    statement_balance_cents: 100_000,
    line_ids: [firstLineId],
  });
  assert.equal(first.status, 'reconciled');
  assert.equal(first.difference_cents, 0);
  assert.equal(first.cleared_balance_cents, 100_000);

  postEntry(db, {
    entry_date: '2026-02-05',
    memo: 'February bank deposit',
    lines: [
      { account_id: bankId, debit_cents: 25_000, credit_cents: 0 },
      { account_id: account('4000').id, debit_cents: 0, credit_cents: 25_000 },
    ],
  });

  const secondWorkspace = bankReconciliations.getWorkspace(db, { account_id: bankId, statement_date: '2026-02-28' });
  assert.equal(secondWorkspace.cleared_before_cents, 100_000);
  assert.equal(secondWorkspace.ledger_balance_cents, 125_000);
  assert.equal(secondWorkspace.lines.length, 1);

  const second = bankReconciliations.createReconciliation(db, {
    account_id: bankId,
    statement_date: '2026-02-28',
    statement_balance_cents: 100_000,
    line_ids: [secondWorkspace.lines[0].id],
  });
  assert.equal(second.status, 'difference');
  assert.equal(second.difference_cents, -25_000);

  assert.throws(() => bankReconciliations.deleteReconciliation(db, first.id), /later reconciliation/i);
  bankReconciliations.deleteReconciliation(db, second.id);
  const reopened = bankReconciliations.getWorkspace(db, { account_id: bankId, statement_date: '2026-02-28' });
  assert.equal(reopened.lines.length, 1);
  assert.equal(reopened.lines[0].amount_cents, 25_000);
  assertBalanced();
});

test('credit notes issue, apply, reverse and void without overtaxing the invoice', () => {
  const customerId = insertCustomer('Credit Customer');
  const credit = creditService.createCredit(db, {
    customer_id: customerId,
    credit_date: '2026-03-01',
    amount_cents: 50_000,
    revenue_account_id: account('4000').id,
    notes: 'Service recovery',
  });
  assert.ok(credit.number.startsWith('CR-'));
  assert.equal(credit.remaining_cents, 50_000);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM journal_lines WHERE entry_id = ?').get(credit.journal_entry_id).count, 2);

  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-03-02',
    due_date: '2026-03-02',
    status: 'sent',
    items: [{ description: 'March sale', quantity: 1, unit_price_cents: 120_000, account_id: account('4000').id }],
  });
  const applied = creditService.applyCredit(db, credit.id, {
    invoice_id: invoice.id,
    amount_cents: 30_000,
    applied_date: '2026-03-03',
  });
  assert.equal(applied.applied_cents, 30_000);
  assert.equal(applied.remaining_cents, 20_000);
  const afterApply = invoiceService.getInvoice(db, invoice.id);
  assert.equal(afterApply.credit_applied_cents, 30_000);
  assert.equal(afterApply.balance_cents, 90_000);
  assert.equal(afterApply.credits.length, 1);
  assert.throws(() => creditService.applyCredit(db, credit.id, {
    invoice_id: invoice.id,
    amount_cents: 25_000,
    applied_date: '2026-03-03',
  }), /remaining balance/i);
  assert.throws(() => invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: 100_000,
    payment_date: '2026-03-03',
    method: 'Bank transfer',
    deposit_account_id: account('1010').id,
  }), /outstanding balance/i);

  const application = applied.applications[0];
  const reversed = creditService.deleteCreditApplication(db, application.id);
  assert.equal(reversed.remaining_cents, 50_000);
  const restored = invoiceService.getInvoice(db, invoice.id);
  assert.equal(restored.credit_applied_cents, 0);
  assert.equal(restored.balance_cents, 120_000);

  const smallInvoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-03-04',
    due_date: '2026-03-04',
    status: 'sent',
    items: [{ description: 'Small sale', quantity: 1, unit_price_cents: 40_000, account_id: account('4000').id }],
  });
  const fullyApplied = creditService.applyCredit(db, credit.id, {
    invoice_id: smallInvoice.id,
    amount_cents: 40_000,
    applied_date: '2026-03-04',
  });
  const paidByCredit = invoiceService.getInvoice(db, smallInvoice.id);
  assert.equal(paidByCredit.balance_cents, 0);
  assert.equal(paidByCredit.status_display, 'paid');
  assert.equal(fullyApplied.remaining_cents, 10_000);
  creditService.deleteCreditApplication(db, fullyApplied.applications[0].id);

  const voided = creditService.voidCredit(db, credit.id);
  assert.equal(voided.status, 'void');
  assert.equal(voided.remaining_cents, 0);
  assertBalanced();
});

test('A/R aging and dashboard subtract applied customer credits', () => {
  const customerId = insertCustomer('Aging Credit Customer');
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-03-01',
    due_date: '2026-03-01',
    status: 'sent',
    items: [{ description: 'Aging sale', quantity: 1, unit_price_cents: 100_000, account_id: account('4000').id }],
  });
  const credit = creditService.createCredit(db, {
    customer_id: customerId,
    credit_date: '2026-03-01',
    amount_cents: 40_000,
    revenue_account_id: account('4000').id,
  });
  creditService.applyCredit(db, credit.id, {
    invoice_id: invoice.id,
    amount_cents: 40_000,
    applied_date: '2026-03-01',
  });

  const aging = reports.arAging(db, '2026-03-31');
  const party = aging.rows.find((row) => row.party_name === 'Aging Credit Customer');
  assert.equal(party.total_cents, 60_000);
  const dashboard = reports.dashboard(db);
  assert.equal(dashboard.ar_outstanding_cents, db.prepare(`
    SELECT COALESCE(SUM(total_cents - amount_paid_cents - credit_applied_cents), 0) AS total
    FROM invoices WHERE status = 'sent' AND total_cents > amount_paid_cents + credit_applied_cents
  `).get().total);
  assertBalanced();
});

test('customer and vendor statements carry opening and running balances', () => {
  const customerId = insertCustomer('Statement Customer');
  const invoiceA = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-01-10',
    due_date: '2026-01-10',
    status: 'sent',
    items: [{ description: 'January sale', quantity: 1, unit_price_cents: 100_000, account_id: account('4000').id }],
  });
  invoiceService.recordInvoicePayment(db, invoiceA.id, {
    amount_cents: 40_000,
    payment_date: '2026-01-15',
    method: 'Bank transfer',
    deposit_account_id: account('1010').id,
  });
  const invoiceB = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-02-01',
    due_date: '2026-02-01',
    status: 'sent',
    items: [{ description: 'February sale', quantity: 1, unit_price_cents: 50_000, account_id: account('4000').id }],
  });
  const credit = creditService.createCredit(db, {
    customer_id: customerId,
    credit_date: '2026-02-02',
    amount_cents: 20_000,
    revenue_account_id: account('4000').id,
  });
  creditService.applyCredit(db, credit.id, {
    invoice_id: invoiceB.id,
    amount_cents: 20_000,
    applied_date: '2026-02-02',
  });

  const customer = statements.customerStatement(db, customerId, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(customer.opening_balance_cents, 60_000);
  assert.equal(customer.closing_balance_cents, 90_000);
  assert.equal(customer.transactions.length, 2);
  assert.equal(customer.transactions[0].debit_cents, 50_000);
  assert.equal(customer.transactions[1].credit_cents, 20_000);

  const vendorId = insertVendor('Statement Vendor');
  const bill = billService.createBill(db, {
    vendor_id: vendorId,
    bill_date: '2026-01-10',
    due_date: '2026-01-10',
    status: 'received',
    items: [{ description: 'Supplier cost', quantity: 1, unit_price_cents: 80_000, account_id: account('5000').id }],
  });
  billService.recordBillPayment(db, bill.id, {
    amount_cents: 30_000,
    payment_date: '2026-01-15',
    method: 'Bank transfer',
    payment_account_id: account('1010').id,
  });
  billService.createBill(db, {
    vendor_id: vendorId,
    bill_date: '2026-02-01',
    due_date: '2026-02-01',
    status: 'received',
    items: [{ description: 'February cost', quantity: 1, unit_price_cents: 20_000, account_id: account('5000').id }],
  });

  const vendor = statements.vendorStatement(db, vendorId, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(vendor.opening_balance_cents, 50_000);
  assert.equal(vendor.closing_balance_cents, 70_000);
  assert.equal(vendor.transactions.length, 1);
  assert.equal(vendor.transactions[0].credit_cents, 20_000);
  assertBalanced();
});

test('clear all data also clears P1 tables and resets credit numbering', () => {
  demoService.resetAll(db);
  for (const table of [
    'credit_notes', 'credit_applications', 'bank_reconciliations', 'bank_reconciliation_lines',
    'attachments', 'invoices', 'bills', 'customers', 'vendors', 'journal_entries', 'journal_lines',
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} cleared`);
  }
  assert.equal(db.prepare('SELECT next_credit_number FROM settings WHERE id = 1').get().next_credit_number, 1);
  assertBalanced();
});

test('automatic backup runs once per configured interval', () => {
  const first = backupService.runAutoBackup(db, { hours: 24 });
  assert.ok(first);
  assert.ok(fs.existsSync(first.path));
  const second = backupService.runAutoBackup(db, { hours: 24 });
  assert.equal(second, null);
  assert.equal(backupService.runAutoBackup(db, { hours: 0 }), null);
});
