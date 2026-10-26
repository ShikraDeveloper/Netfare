'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/settlement-queue');

router.get('/', (req, res) => {
  res.json(service.listSettlementQueue(db, req.query));
});

module.exports = router;
