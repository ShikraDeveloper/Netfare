'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const Database = require('better-sqlite3');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-phase3-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');
const creditService = require('../server/services/credits');
const cancellationService = require('../server/services/cancellations');
const refundService = require('../server/services/refunds');
const openingBalances = require('../server/services/opening-balances');
const reconciliation = require('../server/services/reconciliation');
const auditChain = require('../server/services/audit-chain');

const ROOT = path.join(__dirname, '..');
const extraDirs = [];

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

function confirmedBooking(customerId, vendorId, saleCents, costCents, bookingDate) {
  const draft = bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: bookingDate,
    due_date: bookingDate,
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: saleCents, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: costCents, account_id: account('5000').id, vendor_id: vendorId }],
  });
  return bookingService.confirmBooking(db, draft.id);
}

function check(summary, key) {
  const row = summary.checks.find((item) => item.key === key);
  assert.ok(row, `check ${key} exists`);
  return row;
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const dir of extraDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('ledger checks compare every control account with its documents', () => {
  const customerId = insertCustomer('Checks Customer');
  const vendorId = insertVendor('Checks Airline');
  const booking = confirmedBooking(customerId, vendorId, 50_000, 30_000, '2026-06-01');
  invoiceService.recordInvoicePayment(db, booking.invoice_id, {
    amount_cents: 20_000,
    payment_date: '2026-06-02',
    deposit_account_id: account('1010').id,
  });

  const summary = reconciliation.reconciliationSummary(db);
  assert.deepEqual(
    summary.checks.map((item) => item.key),
    ['trial_balance', 'receivables', 'payables', 'customer_advances', 'refund_payable', 'customer_credits', 'supplier_credits', 'supplier_advances', 'visa_deposits', 'deposits_with_suppliers'],
  );
  assert.equal(summary.all_matched, true);
  assert.equal(summary.difference_count, 0);
  assert.equal(check(summary, 'receivables').ledger_cents, 30_000);
  assert.equal(check(summary, 'receivables').documents_cents, 30_000);
  assert.equal(check(summary, 'payables').documents_cents, 30_000);
  for (const item of summary.checks) {
    assert.ok(item.href.startsWith('#/'), `${item.key} links to a screen`);
    assert.equal(typeof item.documents_label, 'string');
  }
});

test('an opening balance posted to receivables shows as a ledger check difference', () => {
  openingBalances.saveOpeningBalances(db, {
    entry_date: '2026-01-01',
    balances: [{ account_id: account('1100').id, debit_cents: 12_345 }],
  });
  const summary = reconciliation.reconciliationSummary(db);
  const receivables = check(summary, 'receivables');
  assert.equal(receivables.matched, false);
  assert.equal(receivables.difference_cents, 12_345, 'A/R carries more than the open invoices');
  assert.equal(summary.all_matched, false);
  assert.equal(summary.difference_count, 1);
  assert.equal(check(summary, 'trial_balance').matched, true, 'the ledger itself still balances');

  openingBalances.clearOpeningBalances(db);
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);
});

test('settlement documents accept attachments and other types are still rejected', () => {
  const insert = db.prepare(`
    INSERT INTO attachments (entity_type, entity_id, file_name, storage_name, data)
    VALUES (?, 1, 'proof.pdf', ?, x'25504446')
  `);
  for (const type of ['cancellation', 'refund', 'credit_note', 'supplier_credit']) {
    assert.doesNotThrow(() => insert.run(type, `phase3-${type}`), `${type} attachments are allowed`);
  }
  assert.throws(() => insert.run('journal_entry', 'phase3-bad'), /CHECK constraint failed/);
  db.prepare("DELETE FROM attachments WHERE storage_name LIKE 'phase3-%'").run();
});

test('an older database is migrated once to allow settlement attachments without losing files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-phase3-migrate-'));
  extraDirs.push(dir);
  const env = { ...process.env, LEDGERLY_DATA_DIR: dir };
  const boot = `require(${JSON.stringify(path.join(ROOT, 'server', 'db'))}).close()`;
  execFileSync(process.execPath, ['-e', boot], { env, stdio: 'pipe' });

  // Recreate the original, narrower table with an existing file in it.
  const legacy = new Database(path.join(dir, 'accounting.db'));
  legacy.exec(`
    DROP TABLE attachments;
    CREATE TABLE attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('invoice', 'bill', 'booking', 'visa')),
      entity_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      storage_name TEXT NOT NULL UNIQUE,
      data BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO attachments (entity_type, entity_id, file_name, size_bytes, storage_name, data)
    VALUES ('invoice', 7, 'ticket.pdf', 4, 'legacy-ticket', x'25504446');
  `);
  legacy.close();

  execFileSync(process.execPath, ['-e', boot], { env, stdio: 'pipe' });
  execFileSync(process.execPath, ['-e', boot], { env, stdio: 'pipe' });

  const migrated = new Database(path.join(dir, 'accounting.db'), { readonly: true });
  const sql = migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'").get().sql;
  assert.match(sql, /'supplier_credit'/);
  const row = migrated.prepare("SELECT * FROM attachments WHERE storage_name = 'legacy-ticket'").get();
  assert.equal(row.file_name, 'ticket.pdf');
  assert.equal(row.entity_id, 7);
  assert.equal(Buffer.from(row.data).toString('latin1'), '%PDF');
  const index = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_attachments_entity'").get();
  assert.ok(index, 'the lookup index is recreated');
  migrated.close();
});

test('the audit chain follows a cancelled booking through refunds, credits and voids', () => {
  const customerId = insertCustomer('Chain Customer');
  const vendorId = insertVendor('Chain Airline');
  const booking = confirmedBooking(customerId, vendorId, 250_000, 200_000, '2026-07-01');
  invoiceService.recordInvoicePayment(db, booking.invoice_id, {
    amount_cents: 250_000,
    payment_date: '2026-07-02',
    deposit_account_id: account('1010').id,
  });
  const bill = db.prepare('SELECT * FROM bills WHERE booking_id = ?').get(booking.id);
  billService.recordBillPayment(db, bill.id, {
    amount_cents: 200_000,
    payment_date: '2026-07-02',
    payment_account_id: account('1010').id,
  });
  bookingService.cancelBooking(db, booking.id, {
    cancellation_date: '2026-07-05',
    customer_charges_cents: 50_000,
    supplier_credits: [{ bill_id: bill.id, amount_cents: 150_000 }],
  });
  const cancellation = cancellationService.getCancellationForSource(db, 'booking', booking.id);
  cancellationService.refundCancellation(db, cancellation.id, {
    amount_cents: 100_000,
    refund_date: '2026-07-06',
    account_id: account('1010').id,
  });
  cancellationService.convertCancellationToCredit(db, cancellation.id, { credit_date: '2026-07-06' });
  const credit = db.prepare('SELECT * FROM credit_notes WHERE cancellation_id = ?').get(cancellation.id);
  const creditRefund = creditService.refundCredit(db, credit.id, {
    amount_cents: 40_000,
    refund_date: '2026-07-07',
    account_id: account('1010').id,
  });
  refundService.voidRefund(db, creditRefund.refunds[0].id, { void_date: '2026-07-08', remarks: 'Paid to the wrong account' });

  const chain = auditChain.getAuditChain(db, { type: 'booking', id: booking.id });
  assert.equal(chain.root.type, 'booking');
  const types = new Set(chain.documents.map((doc) => doc.type));
  for (const type of ['booking', 'invoice', 'payment', 'cancellation', 'refund', 'credit', 'bill', 'bill_payment', 'supplier_credit']) {
    assert.ok(types.has(type), `chain includes ${type}`);
  }
  assert.equal(chain.totals.balanced, true);
  assert.equal(chain.totals.debit_cents, chain.totals.credit_cents);
  assert.ok(chain.totals.reversal_count >= 2, 'invoice void and refund void are reversals');

  // Every posting in the chain is accounted for once.
  const ownerKeys = new Set(chain.documents.map((doc) => doc.key));
  assert.ok(chain.journal_entries.every((entry) => ownerKeys.has(entry.owner_key)), 'each entry belongs to a document in the chain');
  assert.equal(new Set(chain.journal_entries.map((entry) => entry.id)).size, chain.journal_entries.length);

  // Net effect: customer paid 2,500, was charged 500, got 1,000 back and holds
  // 1,000 as credit; the supplier keeps 500 and owes 1,500 as credit.
  const net = Object.fromEntries(chain.account_effect.map((row) => [row.account_code, row.net_cents]));
  assert.equal(net['1100'] || 0, 0, 'no receivable left');
  assert.equal(net['4330'], -50_000, 'cancellation income');
  assert.equal(net['5000'], 50_000, 'retained supplier cost');
  assert.equal(net['1450'], 150_000, 'supplier credit still open');
  assert.equal(net['2450'], -100_000, 'customer credit (2,000 due − 1,000 paid) still open after the voided refund');
  assert.equal(net['1010'], 250_000 - 200_000 - 100_000, 'bank: receipt, supplier payment, cancellation refund');

  const voidEvent = chain.timeline.find((item) => item.kind === 'audit' && item.remarks === 'Paid to the wrong account');
  assert.ok(voidEvent, 'void remarks appear in the timeline');
  assert.match(voidEvent.title, /^Voided /);
  const dates = chain.timeline.map((item) => item.date);
  assert.deepEqual(dates, [...dates].sort(), 'timeline is in date order');

  // Opening the chain from a refund reaches the same booking.
  const fromRefund = auditChain.getAuditChain(db, { type: 'refund', id: creditRefund.refunds[0].id });
  assert.ok(fromRefund.documents.some((doc) => doc.key === `booking-${booking.id}`));
});

test('a shared credit note only fans out to other jobs when the chain starts from it', () => {
  const customerId = insertCustomer('Shared Credit Customer');
  const vendorId = insertVendor('Shared Credit Airline');
  const first = confirmedBooking(customerId, vendorId, 10_000, 5_000, '2026-08-01');
  const second = confirmedBooking(customerId, vendorId, 12_000, 6_000, '2026-08-02');
  const credit = creditService.createCredit(db, {
    customer_id: customerId,
    revenue_account_id: account('4000').id,
    amount_cents: 6_000,
    credit_date: '2026-08-03',
  });
  creditService.applyCredit(db, credit.id, { invoice_id: first.invoice_id, amount_cents: 3_000, applied_date: '2026-08-03' });
  creditService.applyCredit(db, credit.id, { invoice_id: second.invoice_id, amount_cents: 3_000, applied_date: '2026-08-03' });

  const fromFirst = auditChain.getAuditChain(db, { type: 'booking', id: first.id });
  const firstKeys = new Set(fromFirst.documents.map((doc) => doc.key));
  assert.ok(firstKeys.has(`credit-${credit.id}`), 'the credit applied to this job is shown');
  assert.ok(!firstKeys.has(`booking-${second.id}`), 'the other job is not pulled in');

  const fromCredit = auditChain.getAuditChain(db, { type: 'credit', id: credit.id });
  const creditKeys = new Set(fromCredit.documents.map((doc) => doc.key));
  assert.ok(creditKeys.has(`invoice-${first.invoice_id}`));
  assert.ok(creditKeys.has(`invoice-${second.invoice_id}`));
  assert.equal(fromCredit.totals.balanced, true);
});

test('audit chain rejects unknown types and missing documents', () => {
  assert.throws(() => auditChain.getAuditChain(db, { type: 'journal', id: 1 }), (error) => error.status === 400);
  assert.throws(() => auditChain.getAuditChain(db, { type: 'booking', id: 'abc' }), (error) => error.status === 400);
  assert.throws(() => auditChain.getAuditChain(db, { type: 'booking', id: 999_999 }), (error) => error.status === 404);
});
