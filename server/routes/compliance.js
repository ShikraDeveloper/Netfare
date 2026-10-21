'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/compliance');

router.get('/', (req, res) => {
  res.json(service.listCompliance(db, req.query));
});

router.get('/:id', (req, res) => {
  res.json(service.getCompliance(db, Number(req.params.id)));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createCompliance(db, req.body || {}));
});

router.put('/:id', (req, res) => {
  res.json(service.updateCompliance(db, Number(req.params.id), req.body || {}));
});

router.delete('/:id', (req, res) => {
  res.json(service.deleteCompliance(db, Number(req.params.id)));
});

router.post('/run-due', (req, res) => {
  // Always use the server's date. A client-supplied date could generate many
  // future bills, or delay genuinely due ones.
  res.json(service.runDueBills(db));
});

router.post('/:id/generate', (req, res) => {
  res.status(201).json(service.generateBill(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/complete', (req, res) => {
  res.json(service.completeCompliance(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/skip', (req, res) => {
  res.json(service.skipCompliance(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
