'use strict';

// Correct (admin) for card settlements, petty cash counts and portal credits:
// the original is reversed on its own date and the corrected one posted.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-more-corrections-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoices = require('../server/services/invoices');
const cards = require('../server/services/card-settlements');
const pettyCash = require('../server/services/petty-cash');
const portals = require('../server/services/portals');
const supplierCredits = require('../server/services/supplier-credits');
const journal = require('../server/services/journal');
const reconciliation = require('../server/services/reconciliation');
const { correct } = require('../server/services/corrections');

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
  assert.deepEqual(reconciliation.reconciliationSummary(db).checks.filter((check) => !check.matched), []);
}

test('a card settlement: the amount that reached the bank corrected, on its own date', () => {
  const customer = party('customers', 'Card Payer');
  const invoice = invoices.createInvoice(db, {
    customer_id: customer, issue_date: '2026-10-01', due_date: '2026-10-01', status: 'sent',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 10_000, account_id: account('4300') }],
  });
  invoices.recordInvoicePayment(db, invoice.id, { amount_cents: 10_000, payment_date: '2026-10-10', method: 'Credit card', deposit_account_id: account('1030') });
  const items = cards.getCardSettlements(db).items.map((item) => item.id);
  const settlement = cards.createSettlement(db, { line_ids: items, net_cents: 9_750, settlement_date: '2026-10-20', bank_account_id: account('1010') });

  const result = correct(db, 'card_settlement', settlement.id, { remarks: 'Bank received 97.00', values: { net_cents: 9_700 } });
  assert.equal(db.prepare('SELECT status FROM card_settlements WHERE id = ?').get(settlement.id).status, 'void');
  const fresh = db.prepare('SELECT * FROM card_settlements WHERE id = ?').get(result.id);
  assert.deepEqual([fresh.gross_cents, fresh.net_cents, fresh.fee_cents, fresh.settlement_date], [10_000, 9_700, 300, '2026-10-20']);
  assert.equal(balance('1010', '2026-10-31'), 9_700, 'October shows only the corrected amount');
  assert.equal(balance('1030'), 0, 'the items are settled again');
  checksMatch();
});

test('a petty cash count: the counted amount corrected; an older count is refused', () => {
  db.transaction(() => journal.createManualEntry(db, {
    entry_date: '2026-10-01', memo: 'Owner put money in',
    lines: [{ account_id: account('1010'), debit_cents: 100_000, credit_cents: 0 }, { account_id: account('3000'), debit_cents: 0, credit_cents: 100_000 }],
  }))();
  pettyCash.topUp(db, { amount_cents: 100_000, date: '2026-10-02', from_account_id: account('1010') });
  const first = pettyCash.recordCount(db, { counted_cents: 95_000, count_date: '2026-10-04' });
  assert.equal(first.difference_cents, -5_000);

  const result = correct(db, 'petty_cash_count', first.id, { remarks: 'Counted 98,000', values: { counted_cents: 98_000 } });
  const fresh = db.prepare('SELECT * FROM petty_cash_counts WHERE id = ?').get(result.id);
  assert.deepEqual([fresh.count_date, fresh.book_cents, fresh.difference_cents], ['2026-10-04', 100_000, -2_000]);
  assert.equal(balance('1020'), 98_000);

  pettyCash.recordCount(db, { counted_cents: 98_000, count_date: '2026-10-06' });
  assert.throws(() => correct(db, 'petty_cash_count', fresh.id, { remarks: 'x', values: { counted_cents: 97_000 } }), /later count/);
  checksMatch();
});

test('a portal credit already spent can be corrected while the wallet stays above zero', () => {
  const vendor = party('vendors', 'Wallet Supplier');
  const portal = portals.createPortal(db, { name: 'Wallet', portal_type: 'consolidator', settlement: 'prepaid', vendor_id: vendor });
  // As the app makes them: a supplier credit moved into the wallet.
  const note = supplierCredits.createSupplierCredit(db, {
    vendor_id: vendor, credit_date: '2026-10-20', items: [{ description: 'Fare difference', amount_cents: 50_000, account_id: account('5000') }],
  });
  const credit = portals.recordPortalCredit(db, { portal_id: portal.id, credit_date: '2026-10-21', amount_cents: 50_000, supplier_credit_note_id: note.id });
  portals.refundPortal(db, portal.id, { refund_date: '2026-10-22', amount_cents: 40_000, method: 'Bank transfer', payment_account_id: account('1010') });

  assert.throws(() => correct(db, 'portal_credit', credit.id, { remarks: 'x', values: { amount_cents: 30_000 } }), /below zero on 2026-10-22/);
  assert.equal(db.prepare('SELECT status FROM portal_credits WHERE id = ?').get(credit.id).status, 'posted', 'nothing changed');

  const result = correct(db, 'portal_credit', credit.id, { remarks: 'Supplier credited 450', values: { amount_cents: 45_000 } });
  const fresh = db.prepare('SELECT * FROM portal_credits WHERE id = ?').get(result.id);
  assert.deepEqual([fresh.amount_cents, fresh.credit_date, fresh.status], [45_000, '2026-10-21', 'posted']);
  assert.equal(portals.getPortal(db, portal.id).balance_cents, 5_000);
  assert.equal(supplierCredits.getSupplierCredit(db, note.id).portal_settled_cents, 45_000, 'the supplier credit follows');
  checksMatch();
});
