'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/bank-reconciliations');

router.get('/', (req, res) => {
  res.json(service.listReconciliations(db, req.query));
});

router.get('/workspace', (req, res) => {
  res.json(service.getWorkspace(db, req.query));
});

router.get('/:id', (req, res) => {
  res.json(service.getReconciliation(db, Number(req.params.id)));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createReconciliation(db, req.body || {}));
});

router.delete('/:id', (req, res) => {
  res.json(service.deleteReconciliation(db, Number(req.params.id)));
});

module.exports = router;
