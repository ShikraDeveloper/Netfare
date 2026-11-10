'use strict';

const router = require('express').Router();
const db = require('../db');
const corrections = require('../services/corrections');
const service = require('../services/cash-deposits');

router.get('/accounts', (req, res) => {
  res.json(service.listCashAccounts(db));
});

router.get('/deposits', (req, res) => {
  res.json(service.listDeposits(db, req.query));
});

router.post('/deposits', (req, res) => {
  res.status(201).json(service.createDeposit(db, req.body || {}));
});

router.get('/deposits/:id', (req, res) => {
  res.json(service.getDeposit(db, Number(req.params.id)));
});

// Admin only (permissions.js): void and re-post with corrected values.
router.post('/deposits/:id/correct', (req, res) => {
  res.json(corrections.correct(db, 'cash_deposit', Number(req.params.id), req.body || {}));
});

router.post('/deposits/:id/void', (req, res) => {
  res.json(service.voidDeposit(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
