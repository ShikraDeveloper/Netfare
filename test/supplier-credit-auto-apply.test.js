'use strict';

// "Use it on this supplier's open bills now": a new supplier credit pays the
// supplier's open bills (the chosen bill first, then the oldest); the rest
// goes to a prepaid wallet, or stays open as credit when there is none.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-supplier-credit-auto-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bills = require('../server/services/bills');
const portals = require('../server/services/portals');
const credits = require('../server/services/supplier-credits');
const { todayISO } = require('../server/util');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const daysAgo = (days) => todayISO(new Date(Date.now() - days * 86_400_000));
const vendor = (name) => Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(name).lastInsertRowid);
const bill = (vendorId, date, cents) => bills.createBill(db, {
  vendor_id: vendorId, bill_date: date, due_date: date, status: 'received',
  items: [{ description: 'Fare', quantity: 1, unit_price_cents: cents, account_id: account('5000') }],
});
const credit = (vendorId, cents, extra = {}) => credits.createSupplierCredit(db, {
  vendor_id: vendorId, credit_date: todayISO(), items: [{ description: 'Old deposit', amount_cents: cents, account_id: account('1200') }], ...extra,
});
const balance = (id) => bills.getBill(db, id).balance_cents;

test('oldest bills first; the rest stays open as credit without a wallet', () => {
  const id = vendor('Credit Supplier');
  const newer = bill(id, daysAgo(2), 30_000);
  const older = bill(id, daysAgo(10), 45_000);
  const note = credit(id, 97_000, { auto_apply: true });
  assert.equal(balance(older.id), 0, 'the oldest bill is paid first');
  assert.equal(balance(newer.id), 0);
  assert.deepEqual([note.applied_cents, note.portal_settled_cents, note.remaining_cents], [75_000, 0, 22_000]);
});

test('the chosen bill first; the rest goes to the prepaid wallet', () => {
  const id = vendor('Wallet Supplier');
  const portal = portals.createPortal(db, { name: 'Wallet', portal_type: 'consolidator', settlement: 'prepaid', vendor_id: id });
  const older = bill(id, daysAgo(10), 20_000);
  const chosen = bill(id, daysAgo(1), 30_000);
  const note = credit(id, 25_000, { auto_apply: true, bill_id: chosen.id }); // a bill's credit is capped at its total
  assert.equal(balance(chosen.id), 5_000, 'the chosen bill is paid first');
  assert.equal(balance(older.id), 20_000, 'though another bill is older');
  assert.deepEqual([note.applied_cents, note.portal_settled_cents, note.remaining_cents], [25_000, 0, 0]);

  const extra = credit(id, 40_000, { auto_apply: true });
  assert.equal(balance(older.id), 0);
  assert.equal(balance(chosen.id), 0);
  assert.deepEqual([extra.applied_cents, extra.portal_settled_cents, extra.remaining_cents], [25_000, 15_000, 0]);
  assert.equal(portals.getPortal(db, portal.id).balance_cents, 15_000, 'the wallet holds the rest');
});

test('unticked, the credit stays open, as before', () => {
  const id = vendor('Manual Supplier');
  const open = bill(id, daysAgo(3), 10_000);
  const note = credit(id, 5_000);
  assert.equal(balance(open.id), 10_000);
  assert.equal(note.remaining_cents, 5_000);
});
