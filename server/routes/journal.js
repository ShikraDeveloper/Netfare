'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, notFound, str, optionalStr, dateISO } = require('../util');
const { postEntry, getEntryWithLines } = require('../accounting');

router.get('/', (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.from) {
    clauses.push('e.entry_date >= ?');
    params.push(dateISO(req.query.from, 'From date'));
  }
  if (req.query.to) {
    clauses.push('e.entry_date <= ?');
    params.push(dateISO(req.query.to, 'To date'));
  }
  if (req.query.search) {
    clauses.push('(e.memo LIKE ? OR e.reference LIKE ?)');
    const term = `%${String(req.query.search).trim()}%`;
    params.push(term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT e.*,
      (SELECT COALESCE(SUM(l.debit_cents), 0) FROM journal_lines l WHERE l.entry_id = e.id) AS total_cents,
      (SELECT COUNT(*) FROM journal_lines l WHERE l.entry_id = e.id) AS line_count
    FROM journal_entries e
    ${where}
    ORDER BY e.entry_date DESC, e.id DESC
  `).all(...params);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const entry = getEntryWithLines(db, Number(req.params.id));
  if (!entry) throw notFound('Journal entry not found');
  res.json(entry);
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const memo = str(body.memo, 'Memo', { max: 500 });
  const entryId = db.transaction(() => postEntry(db, {
    entry_date: body.entry_date,
    memo,
    reference: optionalStr(body.reference, 'Reference', 100),
    source_type: 'manual',
    lines: Array.isArray(body.lines) ? body.lines : [],
  }))();
  res.status(201).json(getEntryWithLines(db, entryId));
});

router.delete('/:id', (req, res) => {
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(Number(req.params.id));
  if (!entry) throw notFound('Journal entry not found');
  if (entry.source_type !== 'manual') {
    throw bad('Only manual journal entries can be deleted. Void the source document instead.');
  }
  db.prepare('DELETE FROM journal_entries WHERE id = ?').run(entry.id);
  res.json({ deleted: true });
});

module.exports = router;
