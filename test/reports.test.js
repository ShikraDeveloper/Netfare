'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-reports-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const { postEntry } = require('../server/accounting');
const { trialBalance } = require('../server/services/reports/financials');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('trial balance shows net account balances, not gross activity', () => {
  const bank = account('1010');
  const openingEquity = account('3900');

  postEntry(db, {
    entry_date: '2026-10-01',
    memo: 'Opening bank balance',
    lines: [
      { account_id: bank.id, debit_cents: 100_000 },
      { account_id: openingEquity.id, credit_cents: 100_000 },
    ],
  });
  postEntry(db, {
    entry_date: '2026-10-02',
    memo: 'Part reversal of opening balance',
    lines: [
      { account_id: bank.id, credit_cents: 30_000 },
      { account_id: openingEquity.id, debit_cents: 30_000 },
    ],
  });

  const report = trialBalance(db, '2026-10-31');
  const bankRow = report.rows.find((row) => row.code === '1010');
  const equityRow = report.rows.find((row) => row.code === '3900');

  assert.equal(bankRow.debit_cents, 70_000, 'bank shows its net debit balance');
  assert.equal(bankRow.credit_cents, 0, 'bank does not show a credit balance');
  assert.equal(bankRow.gross_debit_cents, 100_000);
  assert.equal(bankRow.gross_credit_cents, 30_000);
  assert.equal(equityRow.debit_cents, 0);
  assert.equal(equityRow.credit_cents, 70_000, 'opening equity shows its net credit balance');

  assert.equal(report.totals.debit_cents, 70_000);
  assert.equal(report.totals.credit_cents, 70_000);
  assert.equal(report.balanced, true);

  postEntry(db, {
    entry_date: '2026-11-01',
    memo: 'Later bank receipt',
    lines: [
      { account_id: bank.id, debit_cents: 20_000 },
      { account_id: openingEquity.id, credit_cents: 20_000 },
    ],
  });

  const later = trialBalance(db, '2026-10-31');
  assert.equal(later.rows.find((row) => row.code === '1010').debit_cents, 70_000, 'as-of date excludes later entries');
});
