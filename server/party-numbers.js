'use strict';

// Customer and supplier numbers (CUS-0001, SUP-0001). New ones get the next
// number when they are created; on start any without one are numbered in the
// order they were added. (No database trigger: restore refuses backups that
// carry triggers.)

const PREFIX = { customers: 'CUS', vendors: 'SUP' };

function nextNumber(db, table) {
  const prefix = PREFIX[table];
  const last = db.prepare(`
    SELECT COALESCE(MAX(CAST(substr(number, ${prefix.length + 2}) AS INTEGER)), 0) AS n
    FROM ${table} WHERE number LIKE '${prefix}-%'
  `).get().n;
  return `${prefix}-${String(last + 1).padStart(4, '0')}`;
}

function assignPartyNumber(db, table, id) {
  if (!PREFIX[table]) throw new Error(`No numbers for ${table}`);
  const row = db.prepare(`SELECT number FROM ${table} WHERE id = ?`).get(Number(id));
  if (row && !row.number) db.prepare(`UPDATE ${table} SET number = ? WHERE id = ?`).run(nextNumber(db, table), Number(id));
  return id;
}

function numberMissing(db) {
  for (const table of Object.keys(PREFIX)) {
    const missing = db.prepare(`SELECT id FROM ${table} WHERE number = '' ORDER BY id`).all();
    if (missing.length) db.transaction(() => missing.forEach((row) => assignPartyNumber(db, table, row.id)))();
  }
}

module.exports = { assignPartyNumber, numberMissing };
