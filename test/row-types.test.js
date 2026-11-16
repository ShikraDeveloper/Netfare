'use strict';

// The row types that type checking uses (InvoiceRow, BillRow) list exactly
// the table's columns. A column added to the schema without its type fails here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-row-types-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;
const db = require('../server/db');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

for (const [table, file, type] of [['invoices', 'invoices.js', 'InvoiceRow'], ['bills', 'bills.js', 'BillRow']]) {
  test(`${type} lists every column of ${table}`, () => {
    const source = fs.readFileSync(path.join(__dirname, '../server/services', file), 'utf8');
    const block = source.match(new RegExp(`@typedef \\{object\\} ${type}\\n([\\s\\S]*?)\\*/`))[1];
    const typed = [...block.matchAll(/@property \{[^}]+\} (\w+)/g)].map((match) => match[1]).sort();
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name).sort();
    assert.deepEqual(typed, columns);
  });
}
