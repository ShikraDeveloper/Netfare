'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// Entries are stored in UTC; the dates users type are local (Dubai, UTC+4).
process.env.TZ = 'Asia/Dubai';
process.env.LEDGERLY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'netfare-audit-dates-'));

const db = require('../server/db');
const audit = require('../server/services/audit');

test('the audit log date filter uses the local day, not the UTC day', () => {
  // 01:30 on 5 Nov in Dubai is 21:30 on 4 Nov in UTC.
  const id = audit.record(db, { entity_type: 'settings', entity_number: 'Date check', action: 'update' });
  db.prepare("UPDATE audit_logs SET created_at = '2026-11-04 21:30:00' WHERE id = ?").run(id);
  const ids = (query) => audit.list(db, query).rows.map((row) => row.id);
  assert.ok(ids({ from: '2026-11-05', to: '2026-11-05' }).includes(id), 'found on its local day');
  assert.ok(!ids({ from: '2026-11-04', to: '2026-11-04' }).includes(id), 'not on the previous UTC day');
});
