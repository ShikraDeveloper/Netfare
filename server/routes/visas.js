'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/visas');
const jobRefunds = require('../services/job-refunds');

router.get('/', (req, res) => {
  res.json(service.listVisas(db, req.query));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createVisa(db, req.body || {}));
});

router.post('/groups', (req, res) => {
  res.status(201).json(service.createVisaGroup(db, req.body || {}));
});

router.post('/groups/:groupId/submit', (req, res) => {
  res.json(service.submitVisaGroup(db, Number(req.params.groupId), req.body || {}));
});

router.get('/:id', (req, res) => {
  res.json(service.getVisa(db, Number(req.params.id)));
});

router.put('/:id', (req, res) => {
  res.json(service.updateVisa(db, Number(req.params.id), req.body || {}));
});

router.delete('/:id', (req, res) => {
  res.json(service.deleteVisa(db, Number(req.params.id)));
});

router.post('/:id/submit', (req, res) => {
  res.json(service.submitVisa(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/approve', (req, res) => {
  res.json(service.approveVisa(db, Number(req.params.id)));
});

router.post('/:id/issue', (req, res) => {
  res.json(service.issueVisa(db, Number(req.params.id)));
});

router.post('/:id/reject', (req, res) => {
  res.json(service.rejectVisa(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/refund-customer', (req, res) => {
  res.status(201).json(jobRefunds.refundCustomer(db, 'visa', Number(req.params.id), req.body || {}));
});

router.post('/:id/supplier-refund', (req, res) => {
  res.status(201).json(jobRefunds.supplierRefund(db, 'visa', Number(req.params.id), req.body || {}));
});

router.post('/:id/cancel', (req, res) => {
  res.json(service.cancelVisa(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
