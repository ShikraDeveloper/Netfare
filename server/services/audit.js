'use strict';

const { bad, optionalStr } = require('../util');

const MAX_REMARKS = 2000;

function cleanRemarks(value) {
  return optionalStr(value ?? '', 'Remarks', MAX_REMARKS);
}

function withRemarks(memo, remarks) {
  const note = String(remarks || '').trim();
  return note ? `${memo} — ${note}`.slice(0, 500) : memo;
}

function record(db, {
  entity_type,
  entity_id = null,
  entity_number = '',
  action = 'void',
  remarks = '',
  amount_cents = null,
  metadata = null,
} = {}) {
  const type = String(entity_type || '').trim();
  if (!type) throw bad('Audit entity type is required');
  const verb = String(action || 'void').trim();
  if (!verb) throw bad('Audit action is required');
  const id = entity_id == null || entity_id === '' ? null : Number(entity_id);
  if (id != null && !Number.isFinite(id)) throw bad('Audit entity id is invalid');
  const amount = amount_cents == null ? null : Number(amount_cents);
  if (amount != null && !Number.isFinite(amount)) throw bad('Audit amount is invalid');
  const info = db.prepare(`
    INSERT INTO audit_logs (
      entity_type, entity_id, entity_number, action, remarks, amount_cents, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    type,
    id,
    optionalStr(entity_number ?? '', 'Document number', 200),
    verb,
    cleanRemarks(remarks),
    amount,
    metadata ? JSON.stringify(metadata) : '',
  );
  return Number(info.lastInsertRowid);
}

function list(db, {
  search = '',
  entity_type = '',
  action = '',
  from = '',
  to = '',
  limit = 1000,
} = {}) {
  const clauses = [];
  const params = [];
  if (entity_type) {
    clauses.push('entity_type = ?');
    params.push(String(entity_type));
  }
  if (action) {
    clauses.push('action = ?');
    params.push(String(action));
  }
  if (from) {
    clauses.push('date(created_at) >= date(?)');
    params.push(String(from));
  }
  if (to) {
    clauses.push('date(created_at) <= date(?)');
    params.push(String(to));
  }
  if (search) {
    clauses.push('(entity_type LIKE ? OR entity_number LIKE ? OR remarks LIKE ? OR action LIKE ?)');
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${where}`).get(...params).c;
  const capped = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  const rows = db.prepare(`
    SELECT * FROM audit_logs
    ${where}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params, capped);
  return { rows, total };
}

module.exports = { record, list, cleanRemarks, withRemarks };
