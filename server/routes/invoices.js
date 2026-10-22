'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/invoices');

router.get('/', (req, res) => {
  res.json(service.listInvoices(db, req.query));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createInvoice(db, req.body || {}));
});

router.get('/:id', (req, res) => {
  res.json(service.getInvoice(db, Number(req.params.id)));
});

router.put('/:id', (req, res) => {
  res.json(service.updateInvoice(db, Number(req.params.id), req.body || {}));
});

router.delete('/:id', (req, res) => {
  res.json(service.deleteInvoice(db, Number(req.params.id)));
});

router.post('/:id/finalize', (req, res) => {
  res.json(service.finalizeInvoice(db, Number(req.params.id)));
});

router.post('/:id/void', (req, res) => {
  res.json(service.voidInvoice(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/payments', (req, res) => {
  res.status(201).json(service.recordInvoicePayment(db, Number(req.params.id), req.body || {}));
});

router.delete('/payments/:paymentId', (req, res) => {
  res.json(service.deleteInvoicePayment(db, Number(req.params.paymentId), req.body || {}));
});

module.exports = router;
