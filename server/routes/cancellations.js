'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/cancellations');

router.get('/', (req, res) => {
  res.json(service.listCancellations(db, req.query));
});

router.get('/:id', (req, res) => {
  res.json(service.getCancellation(db, Number(req.params.id)));
});

router.post('/:id/refund', (req, res) => {
  res.status(201).json(service.refundCancellation(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/convert-to-credit', (req, res) => {
  res.status(201).json(service.convertCancellationToCredit(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
