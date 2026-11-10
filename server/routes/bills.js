'use strict';

const router = require('express').Router();
const db = require('../db');
const corrections = require('../services/corrections');
const service = require('../services/bills');

router.get('/', (req, res) => {
  res.json(service.listBills(db, req.query));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createBill(db, req.body || {}));
});

router.post('/quick-expense', (req, res) => {
  res.status(201).json(service.createQuickExpense(db, req.body || {}));
});

router.get('/:id', (req, res) => {
  res.json(service.getBill(db, Number(req.params.id)));
});

router.put('/:id', (req, res) => {
  res.json(service.updateBill(db, Number(req.params.id), req.body || {}));
});

router.delete('/:id', (req, res) => {
  res.json(service.deleteBill(db, Number(req.params.id)));
});

router.post('/:id/finalize', (req, res) => {
  res.json(service.finalizeBill(db, Number(req.params.id)));
});

router.post('/:id/void', (req, res) => {
  res.json(service.voidBill(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/payments', (req, res) => {
  res.status(201).json(service.recordBillPayment(db, Number(req.params.id), req.body || {}));
});

// Admin only (permissions.js): void and re-post with corrected values.
router.post('/payments/:paymentId/correct', (req, res) => {
  res.json(corrections.correct(db, 'bill_payment', Number(req.params.paymentId), req.body || {}));
});

router.delete('/payments/:paymentId', (req, res) => {
  res.json(service.deleteBillPayment(db, Number(req.params.paymentId), req.body || {}));
});

module.exports = router;
