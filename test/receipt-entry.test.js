'use strict';

// A customer receipt is a payment, not an advance: one entry with the bank
// debited, Trade Receivables credited for each invoice share, and Customer
// Advances (2400) credited only for what is left over.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-receipt-entry-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const advances = require('../server/services/advances');
const statements = require('../server/services/statements');
const { dailySales } = require('../server/services/reports/daily-sales');
const reconciliation = require('../server/services/reconciliation');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const balance = (code) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS net
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
`).get(code).net;
// Everything that ever moved through 2400 (debits plus credits).
const advanceTraffic = () => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents + l.credit_cents), 0) AS n
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '2400'
`).get().n;
const customer = (name) => Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
const invoice = (customerId, date, amount) => invoiceService.createInvoice(db, {
  customer_id: customerId, issue_date: date, due_date: date, status: 'sent',
  items: [{ description: 'Visa service', quantity: 1, unit_price_cents: amount, account_id: account('4300').id }],
});
const paid = (id) => db.prepare('SELECT amount_paid_cents FROM invoices WHERE id = ?').get(id).amount_paid_cents;
const entryLines = (entryId) => db.prepare(`
  SELECT a.code, l.debit_cents AS d, l.credit_cents AS c FROM journal_lines l JOIN accounts a ON a.id = l.account_id
  WHERE l.entry_id = ? ORDER BY l.id
`).all(entryId).map((line) => [line.code, line.d, line.c]);

function checksMatch() {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  assert.deepEqual(reconciliation.reconciliationSummary(db).checks.filter((check) => !check.matched).map((check) => check.key || check.label), []);
}

test('1,000 for invoices of 600 and 200: one entry, receivables credited, only 200 kept as an advance', () => {
  const customerId = customer('Receipt Payer');
  const first = invoice(customerId, '2026-11-01', 60_000);
  const second = invoice(customerId, '2026-11-01', 20_000);
  const trafficBefore = advanceTraffic();

  const receipt = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 100_000, receipt_date: '2026-11-02',
    method: 'Bank transfer', deposit_account_id: account('1010').id,
  });
  assert.deepEqual(entryLines(receipt.journal_entry_id), [
    ['1010', 100_000, 0],
    ['1100', 0, 60_000],
    ['1100', 0, 20_000],
    ['2400', 0, 20_000],
  ], 'one entry: bank in, both invoices paid, the rest as an advance');
  assert.equal(advanceTraffic() - trafficBefore, 20_000, 'only the leftover goes through Customer Advances');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type = 'advance_apply' AND reference IN (?, ?)").get(first.number, second.number).n, 0);
  assert.deepEqual([paid(first.id), paid(second.id), receipt.remaining_cents], [60_000, 20_000, 20_000]);
  assert.deepEqual(db.prepare('SELECT from_receipt FROM payments WHERE advance_id = ?').all(receipt.id).map((row) => row.from_receipt), [1, 1]);

  // The statement shows the receipt as payments; only 200 is an advance received.
  const held = statements.customerStatement(db, customerId).advances;
  assert.deepEqual(held.transactions.map((row) => [row.event_type, row.credit_cents || row.debit_cents]), [['received', 20_000]]);

  // The DSR counts the shares as paid by bank, and lists no advance for them.
  const dsr = dailySales(db, '2026-11-01', '2026-11-02');
  const row = dsr.sections.services.find((item) => item.number === first.number);
  assert.deepEqual([row.split.bank, row.split.other], [60_000, 0]);
  checksMatch();
});

test('voiding one share keeps the money as the customer advance; voiding the receipt then undoes everything', () => {
  const customerId = customer('Share Void');
  const first = invoice(customerId, '2026-11-01', 30_000);
  const second = invoice(customerId, '2026-11-01', 10_000);
  const before = { bank: balance('1010'), ar: balance('1100'), adv: balance('2400'), charges: balance('6700') };

  const receipt = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 40_000, receipt_date: '2026-11-03',
    deposit_account_id: account('1010').id, bank_charges_cents: 500,
  });
  const share = db.prepare('SELECT id FROM payments WHERE advance_id = ? AND invoice_id = ?').get(receipt.id, second.id);
  invoiceService.deleteInvoicePayment(db, share.id, { remarks: 'Wrong invoice' });
  assert.equal(paid(second.id), 0);
  assert.equal(advances.getAdvance(db, receipt.id).remaining_cents, 10_000, 'the money stays received, as an advance');
  assert.equal(balance('2400') - before.adv, -10_000);
  checksMatch();

  advances.voidAdvance(db, receipt.id, { remarks: 'Wrong customer' });
  assert.deepEqual([paid(first.id), paid(second.id)], [0, 0]);
  assert.deepEqual(
    { bank: balance('1010'), ar: balance('1100'), adv: balance('2400'), charges: balance('6700') },
    before,
    'bank, receivables, advances and charges are back where they were',
  );
  checksMatch();
});

test('money left from a receipt and used later reads as an advance applied, not a bank payment', () => {
  const customerId = customer('Leftover Later');
  const receipt = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 25_000, receipt_date: '2026-11-02', method: 'Bank transfer',
    deposit_account_id: account('1010').id, allocations: [],
  });
  const later = invoice(customerId, '2026-11-12', 25_000);
  advances.applyAdvance(db, receipt.id, { invoice_id: later.id, payment_date: '2026-11-12' });
  assert.equal(invoiceService.getInvoice(db, later.id).payments[0].method, 'Advance applied');
  checksMatch();
});
