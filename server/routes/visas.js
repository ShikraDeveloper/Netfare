'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/visas');
const jobRefunds = require('../services/job-refunds');
const { voidJob } = require('../services/job-void');
const { correctJob } = require('../services/job-correct');
const { updateJobDetails } = require('../services/job-details');

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

// Details that do not touch money (dates, PNR, notes, passengers): Edit rights.
router.post('/:id/details', (req, res) => {
  updateJobDetails(db, 'visa', Number(req.params.id), req.body || {});
  res.json(service.getVisa(db, Number(req.params.id)));
});

// Admin only (permissions.js): correct the lines of a posted visa application.
router.post('/:id/correct', (req, res) => {
  res.json(correctJob(db, 'visa', Number(req.params.id), req.body || {}));
});

// Admin only (permissions.js): undo a visa application entered by mistake.
router.post('/:id/void', (req, res) => {
  voidJob(db, 'visa', Number(req.params.id), req.body || {});
  res.json(service.getVisa(db, Number(req.params.id)));
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
