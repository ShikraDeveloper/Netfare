'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/card-settlements');

router.get('/', (req, res) => {
  res.json(service.getCardSettlements(db));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createSettlement(db, req.body || {}));
});

router.post('/:id/void', (req, res) => {
  res.json(service.voidSettlement(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
