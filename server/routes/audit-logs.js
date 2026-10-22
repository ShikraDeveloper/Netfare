'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/audit');

router.get('/', (req, res) => {
  res.json(service.list(db, req.query));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Audit log not found' });
    return;
  }
  res.json(row);
});

module.exports = router;
