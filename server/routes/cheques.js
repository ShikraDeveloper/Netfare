'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/cheques');

router.get('/', (req, res) => {
  res.json(service.listCheques(db, req.query));
});

router.post('/batch', (req, res) => {
  res.status(201).json(service.createBatch(db, req.body || {}));
});

router.get('/:id', (req, res) => {
  res.json(service.getCheque(db, Number(req.params.id)));
});

router.put('/:id', (req, res) => {
  res.json(service.updateCheque(db, Number(req.params.id), req.body || {}));
});

router.post('/:id/void', (req, res) => {
  res.json(service.voidCheque(db, Number(req.params.id), req.body || {}));
});

router.delete('/:id', (req, res) => {
  res.json(service.deleteCheque(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
