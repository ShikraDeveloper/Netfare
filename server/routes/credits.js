'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/credits');

router.get('/', (req, res) => {
  res.json(service.listCredits(db, req.query));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createCredit(db, req.body || {}));
});

router.post('/applications/:applicationId/void', (req, res) => {
  res.json(service.deleteCreditApplication(db, Number(req.params.applicationId), req.body || {}));
});

router.delete('/applications/:applicationId', (req, res) => {
  res.json(service.deleteCreditApplication(db, Number(req.params.applicationId), req.body || {}));
});

router.get('/:id', (req, res) => {
  res.json(service.getCredit(db, Number(req.params.id)));
});

router.post('/:id/apply', (req, res) => {
  res.json(service.applyCredit(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/refund', (req, res) => {
  res.status(201).json(service.refundCredit(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/void', (req, res) => {
  res.json(service.voidCredit(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
