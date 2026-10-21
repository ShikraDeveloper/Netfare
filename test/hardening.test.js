'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const Database = require('better-sqlite3');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-hardening-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const runMigrations = require('../server/migrations');
const openingBalances = require('../server/services/opening-balances');
const bankReconciliations = require('../server/services/bank-reconciliations');
const journalService = require('../server/services/journal');
const backupService = require('../server/services/backup');
const { postEntry } = require('../server/accounting');
const { resolveDataDir, restoreDatabase } = require('../scripts/restore');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
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

test('legacy VAT account cleanup is one-time and leaves user accounts alone', () => {
  const insertAccount = db.prepare(`
    INSERT INTO accounts (code, name, type, subtype, normal_balance, is_system)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertAccount.run('1300', 'Tax Receivable', 'asset', 'tax', 'debit', 1);
  insertAccount.run('2200', 'Sales Tax Payable', 'liability', 'tax', 'credit', 1);
  db.prepare('UPDATE settings SET setup_version = 1 WHERE id = 1').run();

  runMigrations(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE code IN ('1300', '2200')").get().count, 0);
  assert.equal(db.prepare('SELECT setup_version FROM settings WHERE id = 1').get().setup_version, 2);

  insertAccount.run('1300', 'User Prepaid Rent', 'asset', 'current_asset', 'debit', 0);
  insertAccount.run('2200', 'User Loan', 'liability', 'current_liability', 'credit', 0);
  runMigrations(db);
  runMigrations(db);

  for (const [code, name] of [['1300', 'User Prepaid Rent'], ['2200', 'User Loan']]) {
    const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
    assert.equal(row.name, name);
    assert.equal(row.is_active, 1);
  }

  // Simulate an older database and verify the reconciliation foreign key is rebuilt.
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP TABLE bank_reconciliation_lines;
    CREATE TABLE bank_reconciliation_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
      journal_line_id INTEGER NOT NULL UNIQUE REFERENCES journal_lines(id) ON DELETE CASCADE
    );
  `);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const foreignKey = db.prepare('PRAGMA foreign_key_list(bank_reconciliation_lines)').all()
    .find((row) => row.from === 'journal_line_id');
  assert.equal(foreignKey.on_delete, 'RESTRICT');
  assertBalanced();
});

test('renaming an adopted system account does not block startup', () => {
  assert.equal(account('1450').is_system, 1);
  db.prepare("UPDATE accounts SET name = 'Supplier Credits - Airlines' WHERE code = '1450'").run();

  runMigrations(db);

  assert.equal(account('1450').name, 'Supplier Credits - Airlines');
  assert.equal(account('1450').is_system, 1);
  db.prepare("UPDATE accounts SET name = 'Supplier Credits' WHERE code = '1450'").run();
});

test('a user account occupying a required account code still blocks startup', () => {
  db.prepare("UPDATE accounts SET name = 'My Supplier Credits', is_system = 0 WHERE code = '1450'").run();
  try {
    assert.throws(() => runMigrations(db), /already used/);
  } finally {
    db.prepare("UPDATE accounts SET name = 'Supplier Credits', is_system = 1 WHERE code = '1450'").run();
  }
  runMigrations(db);
  assert.equal(account('1450').is_system, 1);
});

test('opening balances reverse instead of deleting reconciled journal lines', () => {
  const bank = account('1010');
  const first = openingBalances.saveOpeningBalances(db, {
    entry_date: '2026-01-01',
    balances: [{ account_id: bank.id, debit_cents: 500_000, credit_cents: 0 }],
  });
  const workspace = bankReconciliations.getWorkspace(db, { account_id: bank.id, statement_date: '2026-01-31' });
  const openingLine = workspace.lines.find((line) => line.entry_id === first.entry_id);
  assert.ok(openingLine);

  const reconciliation = bankReconciliations.createReconciliation(db, {
    account_id: bank.id,
    statement_date: '2026-01-31',
    statement_balance_cents: 500_000,
    line_ids: [openingLine.id],
  });
  assert.equal(reconciliation.status, 'reconciled');

  const second = openingBalances.saveOpeningBalances(db, {
    entry_date: '2026-02-01',
    balances: [{ account_id: bank.id, debit_cents: 500_000, credit_cents: 0 }],
  });
  assert.notEqual(second.entry_id, first.entry_id);
  assert.ok(db.prepare("SELECT * FROM journal_entries WHERE source_type = 'opening_balance_reversal' AND source_id = ?").get(first.entry_id));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM journal_entries WHERE id = ?').get(first.entry_id).count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM bank_reconciliation_lines rl
    JOIN journal_lines l ON l.id = rl.journal_line_id
    WHERE l.entry_id = ?
  `).get(first.entry_id).count, 1);

  const nextWorkspace = bankReconciliations.getWorkspace(db, { account_id: bank.id, statement_date: '2026-02-28' });
  assert.equal(nextWorkspace.cleared_before_cents, 500_000);
  assert.equal(nextWorkspace.ledger_balance_cents, 500_000);

  openingBalances.clearOpeningBalances(db);
  assert.equal(openingBalances.getOpeningBalances(db).entry_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bank_reconciliation_lines').get().count, 1);
  assertBalanced();
});

test('manual journal entries in a reconciliation cannot be deleted', () => {
  const bankId = Number(db.prepare(`
    INSERT INTO accounts (code, name, type, subtype, normal_balance, is_cash)
    VALUES ('1098', 'Journal Protection Bank', 'asset', 'current_asset', 'debit', 1)
  `).run().lastInsertRowid);

  const entryId = postEntry(db, {
    entry_date: '2026-03-01',
    memo: 'Reconciled manual entry',
    source_type: 'manual',
    lines: [
      { account_id: bankId, debit_cents: 100_000, credit_cents: 0 },
      { account_id: account('3000').id, debit_cents: 0, credit_cents: 100_000 },
    ],
  });

  const workspace = bankReconciliations.getWorkspace(db, { account_id: bankId, statement_date: '2026-03-31' });
  const line = workspace.lines.find((item) => item.entry_id === entryId);
  assert.ok(line);
  const reconciliation = bankReconciliations.createReconciliation(db, {
    account_id: bankId,
    statement_date: '2026-03-31',
    statement_balance_cents: 100_000,
    line_ids: [line.id],
  });

  assert.throws(
    () => journalService.deleteManualEntry(db, entryId),
    /bank reconciliation/i,
  );
  assert.ok(db.prepare('SELECT id FROM journal_entries WHERE id = ?').get(entryId));

  bankReconciliations.deleteReconciliation(db, reconciliation.id);
  assert.deepEqual(journalService.deleteManualEntry(db, entryId), { deleted: true });
  assertBalanced();
});

test('backup retention protects safety and automatic backups and downloads are temporary', () => {
  const backupDir = backupService.backupDir;
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(backupDir, { recursive: true });
  for (let index = 0; index < 35; index += 1) {
    fs.writeFileSync(path.join(backupDir, `ledgerly-2026-01-01T00-00-00-000Z-manual-${index}.db`), 'test');
  }
  for (const label of ['auto', 'pre-reset', 'pre-restore']) {
    fs.writeFileSync(path.join(backupDir, `ledgerly-2026-01-01T00-00-00-000Z-${label}.db`), 'test');
  }
  const oldAutomatic = path.join(backupDir, 'ledgerly-2025-01-01T00-00-00-000Z-auto.db');
  fs.writeFileSync(oldAutomatic, 'test');
  const oldTime = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldAutomatic, oldTime, oldTime);

  backupService.pruneBackups(30);
  const names = fs.readdirSync(backupDir);
  assert.equal(names.filter((name) => name.includes('-manual-')).length, 30);
  for (const label of ['auto', 'pre-reset', 'pre-restore']) {
    assert.ok(names.includes(`ledgerly-2026-01-01T00-00-00-000Z-${label}.db`), `${label} backup survives pruning`);
  }
  assert.equal(names.includes(path.basename(oldAutomatic)), false, 'automatic backups older than 90 days are removed');

  const before = backupService.listBackups().length;
  const temporary = backupService.createTemporaryBackup(db, 'download');
  assert.ok(fs.existsSync(temporary.path));
  assert.ok(!temporary.path.startsWith(backupDir));
  temporary.cleanup();
  assert.equal(fs.existsSync(temporary.path), false);
  assert.equal(backupService.listBackups().length, before);
});

test('restore honours the data directory, checks the copy and writes atomically', async () => {
  assert.equal(resolveDataDir(), path.resolve(tempDir));
  const source = backupService.createDatabaseBackup(db, 'restore-source');
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-restore-target-'));
  const targetDb = path.join(targetDir, 'accounting.db');

  try {
    fs.copyFileSync(source.path, targetDb);
    await assert.rejects(
      restoreDatabase({ source: source.path, dataDir: targetDir, checkServer: async () => true }),
      /Ledgerly is running/i,
    );

    const result = await restoreDatabase({ source: source.path, dataDir: targetDir, checkServer: async () => false });
    assert.equal(result.dbPath, targetDb);
    assert.ok(fs.existsSync(result.safety), 'a pre-restore safety backup is created');
    assert.equal(fs.existsSync(`${targetDb}.restore-tmp`), false);

    const copy = new Database(targetDb, { readonly: true });
    try {
      assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
      assert.ok(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_entries'").get());
    } finally {
      copy.close();
    }
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});
