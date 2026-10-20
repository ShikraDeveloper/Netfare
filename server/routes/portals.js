'use strict';

const router = require('express').Router();
const db = require('../db');
const service = require('../services/portals');
const reconcile = require('../services/reconcile');

router.get('/', (req, res) => {
  res.json(service.listPortals(db, req.query));
});

router.post('/', (req, res) => {
  res.status(201).json(service.createPortal(db, req.body || {}));
});

// Settle an existing bill using a portal balance.
router.post('/settle-bill', (req, res) => {
  res.json(service.settleBillFromPortal(db, req.body || {}));
});

router.delete('/topups/:id', (req, res) => {
  res.json(service.deleteTopup(db, Number(req.params.id)));
});

router.get('/:id', (req, res) => {
  res.json(service.getPortal(db, Number(req.params.id)));
});

// Running-balance supplier ledger for one portal, with journal lines. Prepaid
// portals reconcile against account 1400; credit accounts use A/P (2000).
router.get('/:id/ledger', (req, res) => {
  res.json(service.portalLedger(db, Number(req.params.id), req.query));
});

// Compare an imported statement with a prepaid portal's wallet ledger.
router.post('/:id/reconcile', (req, res) => {
  res.json(reconcile.reconcilePortal(db, Number(req.params.id), req.body || {}));
});

router.put('/:id', (req, res) => {
  res.json(service.updatePortal(db, Number(req.params.id), req.body || {}));
});

router.delete('/:id', (req, res) => {
  res.json(service.deletePortal(db, Number(req.params.id)));
});

router.post('/:id/topups', (req, res) => {
  res.status(201).json(service.topUp(db, { ...(req.body || {}), portal_id: Number(req.params.id) }));
});

router.post('/:id/refund', (req, res) => {
  res.json(service.refundPortal(db, Number(req.params.id), req.body || {}));
});

module.exports = router;
