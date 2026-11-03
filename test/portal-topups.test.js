'use strict';

// Portal top-ups: bank charges on the transfer, and top-ups on credit
// accounts, which pay the supplier's oldest open bills.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-portal-topups-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const billService = require('../server/services/bills');
const portalService = require('../server/services/portals');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

function balance(code) {
  return db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS net
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ?
  `).get(code).net;
}

function vendor(name) {
  return Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(name).lastInsertRowid);
}

function bill(vendorId, date, amount) {
  return billService.createBill(db, {
    vendor_id: vendorId,
    bill_date: date,
    due_date: date,
    status: 'received',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: amount, account_id: account('6000').id }],
  });
}

function billPaid(id) {
  return db.prepare('SELECT amount_paid_cents FROM bills WHERE id = ?').get(id).amount_paid_cents;
}

test('bank charges on a top-up go to 6700 and leave the bank; the wallet gets the full amount', () => {
  const portal = portalService.createPortal(db, { name: 'Charges Portal', portal_type: 'airline', settlement: 'prepaid', vendor_id: vendor('Charges Air') });
  const bankBefore = balance('1010');
  const chargesBefore = balance('6700');
  const saved = portalService.topUp(db, {
    portal_id: portal.id, topup_date: '2026-11-01', amount_cents: 1_000_000,
    bank_charges_cents: 2_500, method: 'Bank transfer', deposit_account_id: account('1010').id,
  });
  assert.equal(saved.balance_cents, 1_000_000);
  assert.deepEqual(saved.paid_bills, []);
  assert.equal(balance('1010') - bankBefore, -1_002_500);
  assert.equal(balance('6700') - chargesBefore, 2_500);
  const topup = db.prepare('SELECT * FROM portal_topups WHERE portal_id = ?').get(portal.id);
  assert.equal(topup.bank_charges_cents, 2_500);

  portalService.voidTopup(db, topup.id, { remarks: 'Wrong amount' });
  assert.equal(balance('1010'), bankBefore, 'the void gives the charges back too');
  assert.equal(balance('6700'), chargesBefore);
  assert.throws(() => portalService.topUp(db, {
    portal_id: portal.id, topup_date: '2026-11-01', amount_cents: 1_000, bank_charges_cents: -5, deposit_account_id: account('1010').id,
  }), /Bank charges/);
});

test('a credit account top-up pays the oldest open bills, and the rest pays the next bill', () => {
  const vendorId = vendor('Credit Air');
  const portal = portalService.createPortal(db, {
    name: 'Credit Portal', portal_type: 'consolidator', settlement: 'credit', vendor_id: vendorId, credit_limit_cents: 5_000_000,
  });
  const a = bill(vendorId, '2026-10-01', 400_000);
  const b = bill(vendorId, '2026-10-05', 600_000);
  const c = bill(vendorId, '2026-10-09', 200_000);
  const later = bill(vendorId, '2026-11-20', 50_000);
  assert.equal(portalService.getPortal(db, portal.id).outstanding_ap_cents, 1_250_000);

  const saved = portalService.topUp(db, {
    portal_id: portal.id, topup_date: '2026-11-01', amount_cents: 900_000, bank_charges_cents: 1_500,
    method: 'Bank transfer', deposit_account_id: account('1010').id,
  });
  assert.deepEqual(saved.paid_bills.map((row) => [row.bill_number, row.amount_cents]), [
    [a.number, 400_000],
    [b.number, 500_000],
  ]);
  assert.equal(billPaid(a.id), 400_000);
  assert.equal(billPaid(b.id), 500_000);
  assert.equal(billPaid(c.id), 0, 'nothing left for the third bill');
  assert.equal(billPaid(later.id), 0, 'a bill dated after the top-up waits');
  assert.equal(saved.balance_cents, 0);
  assert.equal(saved.outstanding_ap_cents, 350_000);
  assert.equal(saved.credit_available_cents, 4_650_000, 'the credit limit opens up again');

  const second = portalService.topUp(db, {
    portal_id: portal.id, topup_date: '2026-11-02', amount_cents: 500_000, deposit_account_id: account('1010').id,
  });
  assert.equal(billPaid(b.id), 600_000);
  assert.equal(billPaid(c.id), 200_000);
  assert.equal(second.balance_cents, 200_000, 'the rest waits as an advance');

  const settled = portalService.autoSettleBill(db, later.id, '2026-11-20');
  assert.equal(settled.settled_cents, 50_000, 'the next bill is paid from the advance');
  assert.equal(portalService.getPortal(db, portal.id).balance_cents, 150_000);

  const used = db.prepare('SELECT id FROM portal_topups WHERE portal_id = ? ORDER BY id LIMIT 1').get(portal.id);
  assert.throws(() => portalService.voidTopup(db, used.id, {}), /already paid bills/);

  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
});

test('a credit account with no advance leaves new bills on credit, quietly', () => {
  const vendorId = vendor('Quiet Credit Air');
  portalService.createPortal(db, { name: 'Quiet Credit', portal_type: 'airline', settlement: 'credit', vendor_id: vendorId });
  const fresh = bill(vendorId, '2026-11-03', 70_000);
  assert.equal(portalService.autoSettleBill(db, fresh.id, '2026-11-03'), null, 'no shortfall warning on credit');
  assert.equal(billPaid(fresh.id), 0);
});

test('money left on a credit account can be withdrawn', () => {
  const vendorId = vendor('Withdraw Credit Air');
  const portal = portalService.createPortal(db, { name: 'Withdraw Credit', portal_type: 'airline', settlement: 'credit', vendor_id: vendorId });
  portalService.topUp(db, { portal_id: portal.id, topup_date: '2026-11-01', amount_cents: 30_000, deposit_account_id: account('1010').id });
  const after = portalService.refundPortal(db, portal.id, { refund_date: '2026-11-02', amount_cents: 30_000, payment_account_id: account('1010').id });
  assert.equal(after.balance_cents, 0);
});
