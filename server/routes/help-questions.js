'use strict';

const router = require('express').Router();
const db = require('../db');
const { str } = require('../util');

// Help-panel questions that found no answer. Anyone signed in may send one;
// only the admin reads and clears them.
router.post('/', (req, res) => {
  const body = req.body || {};
  const question = str(body.question, 'Question', { max: 300 });
  const page = str(body.page, 'Page', { required: false, max: 120 });
  const row = db.prepare('INSERT INTO help_questions (question, page, asked_by) VALUES (?, ?, ?) RETURNING id')
    .get(question, page, req.user.full_name || req.user.username);
  res.status(201).json(row);
});

router.use((req, res, next) => (req.user.is_admin ? next() : res.status(403).json({ error: 'Only the admin can do this' })));

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM help_questions ORDER BY id DESC LIMIT 200').all());
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM help_questions WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
