'use strict';

const router = require('express').Router();
const db = require('../db');
const { notFound, dateISO } = require('../util');
const { getEntryWithLines } = require('../accounting');
const journalService = require('../services/journal');
const corrections = require('../services/corrections');

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
  const entryId = db.transaction(() => journalService.createManualEntry(db, req.body || {}))();
  res.status(201).json(getEntryWithLines(db, entryId));
});

router.post('/:id/correct', (req, res) => {
  const result = corrections.correct(db, 'journal', req.params.id, req.body || {});
  res.json({ ...result, entry: getEntryWithLines(db, result.id) });
});

router.post('/:id/void', (req, res) => {
  res.json(journalService.voidManualEntry(db, req.params.id, req.body || {}));
});

router.delete('/:id', (req, res) => {
  res.json(journalService.deleteManualEntry(db, req.params.id, req.body || {}));
});

module.exports = router;
