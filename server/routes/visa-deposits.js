'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/visa-deposits');

router.get('/', (req, res) => {
  res.json(service.listDeposits(db, req.query));
});

router.post('/', (req, res) => {
  res.status(201).json(service.collectDeposit(db, req.body || {}));
});

router.get('/:id', (req, res) => {
  res.json(service.getDeposit(db, Number(req.params.id)));
});

const ACTIONS = {
  'to-supplier': service.payToSupplier,
  'supplier-return': service.supplierReturn,
  refund: service.refundDeposit,
  apply: service.applyToInvoice,
  forfeit: service.forfeitDeposit,
  'void-last': service.voidLastEvent,
};

for (const [path, action] of Object.entries(ACTIONS)) {
  router.post(`/:id/${path}`, (req, res) => {
    res.json(action(db, Number(req.params.id), req.body || {}));
  });
}

module.exports = router;
