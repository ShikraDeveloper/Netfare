'use strict';

// The closing date locks everything dated on or before it: no void, correct
// or delete. A real cancellation of an older sale, dated today, still works.
// Portal opening balances can be changed later too, within the wallet.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-closing-lock-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoices = require('../server/services/invoices');
const journal = require('../server/services/journal');
const partyOpening = require('../server/services/party-opening');
const portals = require('../server/services/portals');
const reconciliation = require('../server/services/reconciliation');
const { correct } = require('../server/services/corrections');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const party = (table, name, extra = {}) => {
  const id = Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);
  for (const [column, value] of Object.entries(extra)) db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, id);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
};
const close = (date) => db.prepare('UPDATE settings SET books_closed_through = ? WHERE id = 1').run(date);
function checksMatch() {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  assert.deepEqual(reconciliation.reconciliationSummary(db).checks.filter((check) => !check.matched).map((check) => check.key || check.label), []);
}

test('nothing dated in a closed period can be voided or corrected; later items still can', () => {
  const customer = party('customers', 'Closed Customer');
  const invoice = invoices.createInvoice(db, {
    customer_id: customer.id, issue_date: '2026-09-10', due_date: '2026-09-10', status: 'sent',
    items: [{ description: 'Service', quantity: 1, unit_price_cents: 10_000, account_id: account('4300') }],
  });
  invoices.recordInvoicePayment(db, invoice.id, { amount_cents: 4_000, payment_date: '2026-09-15', method: 'Cash', deposit_account_id: account('1000') });
  invoices.recordInvoicePayment(db, invoice.id, { amount_cents: 1_000, payment_date: '2026-10-05', method: 'Cash', deposit_account_id: account('1000') });
  const [septPayment, octPayment] = db.prepare('SELECT id FROM payments WHERE invoice_id = ? ORDER BY id').all(invoice.id);
  const manual = db.transaction(() => journal.createManualEntry(db, {
    entry_date: '2026-09-20', memo: 'Sept entry',
    lines: [{ account_id: account('1000'), debit_cents: 500, credit_cents: 0 }, { account_id: account('3000'), debit_cents: 0, credit_cents: 500 }],
  }))();
  close('2026-09-30');

  assert.throws(() => invoices.voidInvoice(db, invoice.id, { remarks: 'x' }), /Locked: .* dated 2026-09-1/);
  assert.throws(() => invoices.deleteInvoicePayment(db, septPayment.id, { remarks: 'x' }), /Locked/);
  assert.throws(() => correct(db, 'payment', septPayment.id, { remarks: 'x', values: { amount_cents: 3_000 } }), /Locked/);
  assert.throws(() => journal.voidManualEntry(db, manual, { remarks: 'x' }), /Locked/);
  invoices.deleteInvoicePayment(db, octPayment.id, { remarks: 'October is open' });
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(octPayment.id).status, 'void');

  close('');
  checksMatch();
});

test('cancelling an older sale still works after closing: it is a new event dated today', () => {
  const customer = party('customers', 'Cancel Later');
  const invoice = invoices.createInvoice(db, {
    customer_id: customer.id, issue_date: '2026-09-12', due_date: '2026-09-12', status: 'sent',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 20_000, account_id: account('4300') }],
  });
  close('2026-09-30');
  invoices.voidInvoiceForCancellation(db, invoice.id, { entryDate: '2026-11-11', memo: 'Cancelled by the customer' });
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoice.id).status, 'void');
  close('');
  checksMatch();
});

test('a portal opening balance is changed later, within what the wallet allows, and locks when closed', () => {
  const vendor = party('vendors', 'Wallet Owner');
  const portal = portals.createPortal(db, { name: 'Opening Wallet', portal_type: 'consolidator', settlement: 'prepaid', vendor_id: vendor.id });
  let status = partyOpening.setOpening(db, 'portal', portal.id, { opening: { direction: 'they_owe', amount_cents: 100_000, as_of: '2026-10-01' } });
  assert.deepEqual([status.opening.kind, status.opening.amount_cents], ['portal_topup', 100_000]);
  portals.refundPortal(db, portal.id, { refund_date: '2026-10-10', amount_cents: 60_000, method: 'Bank transfer', payment_account_id: account('1010') });

  assert.throws(() => partyOpening.setOpening(db, 'portal', portal.id, { remarks: 'x', opening: { direction: 'they_owe', amount_cents: 50_000, as_of: '2026-10-01' } }), /below zero on 2026-10-10/);
  status = partyOpening.setOpening(db, 'portal', portal.id, { remarks: 'Wallet showed 1,050', opening: { direction: 'they_owe', amount_cents: 105_000, as_of: '2026-10-01' } });
  assert.equal(status.opening.amount_cents, 105_000);
  assert.equal(portals.getPortal(db, portal.id).balance_cents, 45_000);

  close('2026-10-31');
  assert.equal(partyOpening.openingStatus(db, 'portal', portal.id).locked, true);
  assert.throws(() => partyOpening.setOpening(db, 'portal', portal.id, { remarks: 'x', opening: { direction: 'they_owe', amount_cents: 110_000, as_of: '2026-10-01' } }), /books are closed through 2026-10-31/);
  close('');
  checksMatch();
});
