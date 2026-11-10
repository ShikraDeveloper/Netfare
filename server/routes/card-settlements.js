'use strict';

const router = require('express').Router();
const db = require('../db');
const corrections = require('../services/corrections');
const service = require('../services/card-settlements');

router.get('/', (req, res) => {
  res.json(service.getCardSettlements(db));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createSettlement(db, req.body || {}));
});

router.post('/:id/correct', (req, res) => {
  res.json(corrections.correct(db, 'card_settlement', req.params.id, req.body || {}));
});

router.post('/:id/void', (req, res) => {
  res.json(service.voidSettlement(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
