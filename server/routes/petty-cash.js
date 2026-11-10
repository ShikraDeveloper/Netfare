'use strict';

const router = require('express').Router();
const db = require('../db');
const corrections = require('../services/corrections');
const service = require('../services/petty-cash');

router.get('/', (req, res) => {
  res.json(service.getPettyCash(db, req.query));
});

router.put('/float', (req, res) => {
  res.json(service.setFloat(db, req.body || {}));
});

router.post('/top-up', (req, res) => {
  res.status(201).json(service.topUp(db, req.body || {}));
});

router.post('/counts', (req, res) => {
  res.status(201).json(service.recordCount(db, req.body || {}));
});

router.post('/counts/:id/correct', (req, res) => {
  res.json(corrections.correct(db, 'petty_cash_count', req.params.id, req.body || {}));
});

router.post('/counts/:id/void', (req, res) => {
  res.json(service.voidCount(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
