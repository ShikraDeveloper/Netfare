'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/supplier-credits');

router.get('/reconciliation', (req, res) => {
  res.json(service.supplierCreditReconciliation(db));
});

router.get('/', (req, res) => {
  res.json(service.listSupplierCredits(db, req.query));
});

router.get('/:id', (req, res) => {
  res.json(service.getSupplierCredit(db, Number(req.params.id)));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createSupplierCredit(db, req.body || {}));
});

router.post('/:id/apply', (req, res) => {
  res.json(service.applySupplierCredit(db, Number(req.params.id), req.body || {}));
});

router.delete('/applications/:id', (req, res) => {
  res.json(service.deleteSupplierCreditApplication(db, Number(req.params.id)));
});

router.post('/:id/refund', (req, res) => {
  res.status(201).json(service.refundSupplierCredit(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/void', (req, res) => {
  res.json(service.voidSupplierCredit(db, Number(req.params.id)));
});

module.exports = router;
