'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/audit-chain');

router.get('/:type/:id', (req, res) => {
  res.json(service.getAuditChain(db, { type: req.params.type, id: req.params.id }));
});

module.exports = router;
