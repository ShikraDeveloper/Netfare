'use strict';

// Petty cash: 1020 float topped up from the bank, spent through quick
// expenses, counted with differences posted to 6900.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-petty-cash-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const pettyCash = require('../server/services/petty-cash');
const billService = require('../server/services/bills');
const cashDeposits = require('../server/services/cash-deposits');
const reconciliation = require('../server/services/reconciliation');

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const balance = (code) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
`).get(code).total;

// Money in the bank first.
db.prepare("INSERT INTO journal_entries (entry_date, memo, source_type) VALUES ('2026-10-01', 'Opening bank', 'opening_balance')").run();
const openingId = db.prepare('SELECT MAX(id) AS id FROM journal_entries').get().id;
db.prepare('INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents) VALUES (?, ?, 500000, 0), (?, ?, 0, 500000)')
  .run(openingId, account('1010').id, openingId, account('3900').id);

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('1020 Petty Cash is a cash account and is not counted as bank', () => {
  const row = account('1020');
  assert.equal(row.name, 'Petty Cash');
  assert.equal(row.is_cash, 1);
  assert.equal(cashDeposits.cashBalances(db).bank_balance_cents, 500_000);
});

test('top up, spend and see the float to top back up', () => {
  pettyCash.setFloat(db, { float_cents: 100_000 });
  assert.equal(pettyCash.getPettyCash(db).top_up_cents, 100_000);
  const topUp = pettyCash.topUp(db, { amount_cents: 100_000, date: '2026-10-02', from_account_id: account('1010').id });
  assert.match(topUp.journal_entry.memo, /^Petty cash top-up/);
  assert.equal(balance('1020'), 100_000);
  assert.equal(balance('1010'), 400_000);

  billService.createQuickExpense(db, {
    description: 'Taxi', amount_cents: 4_500, expense_date: '2026-10-03',
    account_id: account('6600').id, payment_account_id: account('1020').id,
  });
  const data = pettyCash.getPettyCash(db, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(data.balance_cents, 95_500);
  assert.equal(data.top_up_cents, 4_500);
  assert.equal(data.in_cents, 100_000);
  assert.equal(data.out_cents, 4_500);
  assert.deepEqual(data.lines.map((line) => line.balance_cents), [100_000, 95_500]);
  assert.equal(cashDeposits.cashBalances(db).petty_cash_balance_cents, 95_500);
});

test('a count posts a shortage or overage to 6900, and a void reverses it', () => {
  const short = pettyCash.recordCount(db, { counted_cents: 95_000, count_date: '2026-10-04', notes: 'Counted by Sara' });
  assert.equal(short.difference_cents, -500);
  assert.equal(balance('1020'), 95_000);
  assert.equal(balance('6900'), 500);
  const matched = pettyCash.recordCount(db, { counted_cents: 95_000, count_date: '2026-10-05' });
  assert.equal(matched.difference_cents, 0);
  assert.equal(matched.journal_entry_id, null, 'nothing posted when it matches');
  pettyCash.voidCount(db, short.id, { remarks: 'Miscounted' });
  assert.equal(balance('1020'), 95_500);
  assert.equal(balance('6900'), 0);
  // The void posts today, so count today to see it.
  const over = pettyCash.recordCount(db, { counted_cents: 96_000 });
  assert.equal(over.difference_cents, 500);
  assert.equal(balance('6900'), -500);
  assert.throws(() => pettyCash.recordCount(db, { counted_cents: 1, count_date: '2999-01-01' }), (error) => error.status === 400);
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);
});
