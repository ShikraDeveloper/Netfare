'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/advances');

router.get('/', (req, res) => {
  res.json(service.listAdvances(db, req.query));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createAdvance(db, req.body || {}));
});

router.get('/:id', (req, res) => {
  res.json(service.getAdvance(db, Number(req.params.id)));
});

router.post('/:id/apply', (req, res) => {
  res.json(service.applyAdvance(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/refund', (req, res) => {
  res.json(service.refundAdvance(db, Number(req.params.id), req.body || {}));
});

router.delete('/:id', (req, res) => {
  res.json(service.deleteAdvance(db, Number(req.params.id)));
});

module.exports = router;
