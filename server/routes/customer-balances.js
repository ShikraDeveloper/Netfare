'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/customer-balances');

router.get('/', (req, res) => {
  res.json(service.listCustomerBalances(db, req.query));
});

router.get('/:id', (req, res) => {
  res.json(service.getCustomerBalance(db, req.params.id));
});

module.exports = router;
