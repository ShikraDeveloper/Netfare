'use strict';

const router = require('express').Router();
const db = require('../db');
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

router.post('/deposits/:id/void', (req, res) => {
  res.json(service.voidDeposit(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
