'use strict';

const router = require('express').Router();
const db = require('../db');
const corrections = require('../services/corrections');
const service = require('../services/advances');

router.get('/', (req, res) => {
  res.json(service.listAdvances(db, req.query));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createAdvance(db, req.body || {}));
});

// One customer payment shared over several invoices (services/advances.js).
router.post('/receipts', (req, res) => {
  res.status(201).json(service.receivePayment(db, req.body || {}));
});

router.get('/:id/receipt', (req, res) => {
  res.json(service.getReceipt(db, Number(req.params.id)));
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

// Admin only (permissions.js): void and re-post with corrected values.
router.post('/:id/correct', (req, res) => {
  res.json(corrections.correct(db, 'advance', Number(req.params.id), req.body || {}));
});

router.post('/:id/void', (req, res) => {
  res.json(service.voidAdvance(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
