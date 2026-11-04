'use strict';

// "Created by": the signed-in name is stamped on new documents.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-created-by-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const { CREATED_BY_TABLES, markCreated } = require('../server/created-by');
const { runWithUser } = require('../server/request-context');
const { postEntry } = require('../server/accounting');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const entry = () => postEntry(db, {
  entry_date: '2026-11-02',
  memo: 'Created-by test',
  lines: [
    { account_id: account('1000'), debit_cents: 100, credit_cents: 0 },
    { account_id: account('3000'), debit_cents: 0, credit_cents: 100 },
  ],
});

test('every tracked table has a created_by column', () => {
  for (const table of CREATED_BY_TABLES) {
    const column = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, 'created_by');
    assert.ok(column, `${table}.created_by exists`);
  }
});

test('postings and documents carry the signed-in name; scripts and the demo leave it blank', () => {
  const signedIn = runWithUser({ full_name: 'Omar Siddiqui' }, entry);
  assert.equal(db.prepare('SELECT created_by FROM journal_entries WHERE id = ?').get(signedIn).created_by, 'Omar Siddiqui');
  const script = entry();
  assert.equal(db.prepare('SELECT created_by FROM journal_entries WHERE id = ?').get(script).created_by, '');
  assert.throws(() => markCreated(db, 'accounts', 1), /not tracked/, 'only tracked tables are stamped');
});
