'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/opening-balances');

router.get('/', (req, res) => {
  res.json(service.getOpeningBalances(db));
});

router.post('/', (req, res) => {
  res.json(service.saveOpeningBalances(db, req.body || {}));
});

router.delete('/', (req, res) => {
  res.json(service.clearOpeningBalances(db));
});

module.exports = router;
