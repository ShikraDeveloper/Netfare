'use strict';

const router = require('express').Router();
const db = require('../db');
const corrections = require('../services/corrections');
const service = require('../services/refunds');

router.get('/', (req, res) => {
  res.json(service.listRefunds(db, req.query));
});

router.get('/sources', (req, res) => {
  res.json(service.getRefundSources(db, String(req.query.type || '').toLowerCase()));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createRefund(db, req.body || {}));
});

router.get('/:id', (req, res) => {
  res.json(service.getRefund(db, Number(req.params.id)));
});

router.post('/:id/correct', (req, res) => {
  res.json(corrections.correct(db, 'refund', req.params.id, req.body || {}));
});

router.post('/:id/void', (req, res) => {
  res.json(service.voidRefund(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
