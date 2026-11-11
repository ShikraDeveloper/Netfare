'use strict';

const router = require('express').Router();
const db = require('../db');
const corrections = require('../services/corrections');
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

router.put('/:id/payment-link', (req, res) => {
  res.json(service.setPaymentLink(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/finalize', (req, res) => {
  res.json(service.finalizeInvoice(db, Number(req.params.id)));
});

// Admin only (permissions.js): reverse and re-post with corrected lines.
router.post('/:id/correct', (req, res) => {
  res.json(corrections.correctDocument(db, 'invoice', Number(req.params.id), req.body || {}));
});

router.post('/:id/void', (req, res) => {
  res.json(service.voidInvoice(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/payments', (req, res) => {
  res.status(201).json(service.recordInvoicePayment(db, Number(req.params.id), req.body || {}));
});

router.get('/payments/:paymentId/receipt', (req, res) => {
  res.json(service.getPaymentReceipt(db, Number(req.params.paymentId)));
});

// Admin only (permissions.js): void and re-post with corrected values.
router.post('/payments/:paymentId/correct', (req, res) => {
  res.json(corrections.correct(db, 'payment', Number(req.params.paymentId), req.body || {}));
});

// Only the reason comes from the request; the other options are for server code.
router.delete('/payments/:paymentId', (req, res) => {
  res.json(service.deleteInvoicePayment(db, Number(req.params.paymentId), { remarks: req.body?.remarks ?? req.body?.reason }));
});

module.exports = router;
