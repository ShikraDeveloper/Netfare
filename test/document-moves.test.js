'use strict';

// Every table that points at an invoice, bill or credit must either follow
// the document when it is replaced (server/services/document-moves.js) or be
// left out on purpose here. A new link that is forgotten fails this test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-document-moves-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const { MOVES } = require('../server/services/document-moves');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Why each of these stays where it is.
const LEFT_OUT = {
  invoice_id: [
    'invoice_items', // the document's own lines
    'bookings', 'visa_applications', // the job is pointed at its new invoice by job-correct
    'cancellations', // invoices of a cancellation are never corrected
  ],
  bill_id: [
    'bill_items', // the document's own lines
    'compliance_logs', // history: which bill a compliance item generated
  ],
  credit_note_id: [
    'supplier_credit_items', // a supplier credit's own lines
  ],
  supplier_credit_note_id: [],
};

test('every link to an invoice, bill or credit moves with it or is left out on purpose', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  for (const [column, leftOut] of Object.entries(LEFT_OUT)) {
    const linking = tables.filter((table) => db.prepare(`PRAGMA table_info(${table})`).all().some((info) => info.name === column));
    const moved = Object.values(MOVES).flat().filter((move) => move.column === column).map((move) => move.table);
    const missing = linking.filter((table) => !moved.includes(table) && !leftOut.includes(table));
    assert.deepEqual(missing, [], `${column}: add these to document-moves.js or to LEFT_OUT with a reason`);
  }
});
