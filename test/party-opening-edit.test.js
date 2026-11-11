'use strict';

// Changing a customer's or supplier's opening balance after the record
// exists (admin): undone on its own date and posted again, payments moved
// across, and locked by the books' closing date.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-party-opening-edit-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const partyOpening = require('../server/services/party-opening');
const bills = require('../server/services/bills');
const reconciliation = require('../server/services/reconciliation');

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
function party(table, name) {
  const id = Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}
function checksMatch() {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  assert.deepEqual(reconciliation.reconciliationSummary(db).checks.filter((check) => !check.matched).map((check) => check.key || check.label), []);
}

test('a supplier opening bill is changed after a payment: the payment moves, the old month shows only the new amount', () => {
  db.transaction(() => require('../server/services/journal').createManualEntry(db, {
    entry_date: '2026-10-01', memo: 'Owner money',
    lines: [{ account_id: account('1010'), debit_cents: 500_000, credit_cents: 0 }, { account_id: account('3000'), debit_cents: 0, credit_cents: 500_000 }],
  }))();
  const vendor = party('vendors', 'Opening Supplier');
  const first = partyOpening.forVendor(db, vendor, { direction: 'we_owe', amount_cents: 100_000, as_of: '2026-10-31' });
  bills.recordBillPayment(db, first.id, { amount_cents: 40_000, payment_date: '2026-11-02', method: 'Bank transfer', payment_account_id: account('1010') });

  assert.throws(() => partyOpening.setOpening(db, 'vendor', vendor.id, { opening: { direction: 'we_owe', amount_cents: 120_000, as_of: '2026-10-31' } }), /Reason is required/);
  assert.throws(() => partyOpening.setOpening(db, 'vendor', vendor.id, { remarks: 'x', opening: { direction: 'we_owe', amount_cents: 30_000, as_of: '2026-10-31' } }), /less than what was already paid/);
  assert.throws(() => partyOpening.setOpening(db, 'vendor', vendor.id, { remarks: 'x', opening: { direction: 'they_owe', amount_cents: 30_000, as_of: '2026-10-31' } }), /Void them before/);
  assert.throws(() => partyOpening.setOpening(db, 'vendor', vendor.id, { remarks: 'x', opening: null }), /Void them before/);

  const status = partyOpening.setOpening(db, 'vendor', vendor.id, { remarks: 'Statement says 1,200', opening: { direction: 'we_owe', amount_cents: 120_000, as_of: '2026-10-31' } });
  assert.deepEqual([status.opening.amount_cents, status.opening.used_cents, status.opening.as_of, status.locked], [120_000, 40_000, '2026-10-31', false]);
  assert.equal(db.prepare('SELECT status FROM bills WHERE id = ?').get(first.id).status, 'void');
  const fresh = bills.getBill(db, status.opening.id);
  assert.deepEqual([fresh.is_opening, fresh.amount_paid_cents, fresh.payments.filter((p) => p.status === 'posted').length], [1, 40_000, 1]);
  assert.equal(balance('2000', '2026-10-31'), -120_000, 'October shows only the corrected opening');
  assert.equal(balance('2000'), -80_000);
  checksMatch();
});

test('a customer opening is added, switched sides while unused, and removed', () => {
  const customer = party('customers', 'Opening Customer');
  assert.equal(partyOpening.openingStatus(db, 'customer', customer.id).opening, null);
  let status = partyOpening.setOpening(db, 'customer', customer.id, { opening: { direction: 'they_owe', amount_cents: 50_000, as_of: '2026-11-01' } });
  assert.equal(status.opening.kind, 'invoice');
  status = partyOpening.setOpening(db, 'customer', customer.id, { remarks: 'We owe them', opening: { direction: 'we_owe', amount_cents: 20_000, as_of: '2026-11-01' } });
  assert.deepEqual([status.opening.kind, status.opening.amount_cents], ['credit_note', 20_000]);
  status = partyOpening.setOpening(db, 'customer', customer.id, { remarks: 'No opening after all', opening: null });
  assert.equal(status.opening, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ? AND status <> 'void'").get(customer.id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_notes WHERE customer_id = ? AND status <> 'void'").get(customer.id).n, 0);
  checksMatch();
});

test('the closing date locks an opening balance dated on or before it', () => {
  const vendor = party('vendors', 'Locked Supplier');
  partyOpening.forVendor(db, vendor, { direction: 'we_owe', amount_cents: 10_000, as_of: '2026-09-30' });
  db.prepare("UPDATE settings SET books_closed_through = '2026-09-30' WHERE id = 1").run();
  try {
    assert.equal(partyOpening.openingStatus(db, 'vendor', vendor.id).locked, true);
    assert.throws(() => partyOpening.setOpening(db, 'vendor', vendor.id, { remarks: 'x', opening: { direction: 'we_owe', amount_cents: 12_000, as_of: '2026-10-05' } }), /books are closed through 2026-09-30/);
    const other = party('vendors', 'New After Close');
    assert.throws(() => partyOpening.setOpening(db, 'vendor', other.id, { opening: { direction: 'we_owe', amount_cents: 5_000, as_of: '2026-09-15' } }), /books are closed/);
  } finally {
    db.prepare("UPDATE settings SET books_closed_through = '' WHERE id = 1").run();
  }
  checksMatch();
});

test('a portal opening "we owe the supplier" (a bill on the portal) is changed; its payment moves; the supplier\'s own opening is untouched', () => {
  const portals = require('../server/services/portals');
  const vendor = party('vendors', 'Portal Owner');
  partyOpening.forVendor(db, vendor, { direction: 'we_owe', amount_cents: 7_000, as_of: '2026-10-01' });
  const portal = portals.createPortal(db, { name: 'Credit Portal', portal_type: 'consolidator', settlement: 'credit', vendor_id: vendor.id });
  let status = partyOpening.setOpening(db, 'portal', portal.id, { opening: { direction: 'we_owe', amount_cents: 30_000, as_of: '2026-10-01' } });
  assert.equal(status.opening.kind, 'bill');
  const first = status.opening.id;
  bills.recordBillPayment(db, first, { amount_cents: 10_000, payment_date: '2026-10-05', method: 'Bank transfer', payment_account_id: account('1010') });

  status = partyOpening.setOpening(db, 'portal', portal.id, { remarks: 'Statement says 350', opening: { direction: 'we_owe', amount_cents: 35_000, as_of: '2026-10-01' } });
  assert.deepEqual([status.opening.amount_cents, status.opening.used_cents], [35_000, 10_000]);
  assert.equal(bills.getBill(db, status.opening.id).portal_id, portal.id);
  assert.equal(bills.getBill(db, first).status, 'void');
  const own = partyOpening.openingStatus(db, 'vendor', vendor.id).opening;
  assert.deepEqual([own.kind, own.amount_cents], ['bill', 7_000], "the supplier's own opening bill is a separate one and stays");
  checksMatch();
});
