'use strict';

const router = require('express').Router();
const db = require('../db');
const corrections = require('../services/corrections');
const service = require('../services/portals');
const reconcile = require('../services/reconcile');
const partyOpening = require('../services/party-opening');
const { bad } = require('../util');

router.get('/', (req, res) => {
  res.json(service.listPortals(db, req.query));
});

// Only the admin may give a new portal an opening balance.
router.post('/', (req, res) => {
  const body = req.body || {};
  if (body.opening && !req.user?.is_admin) throw bad('Only the admin can enter an opening balance');
  const created = db.transaction(() => {
    const portal = service.createPortal(db, body);
    const opening = partyOpening.forPortal(db, portal, body.opening);
    return { ...(opening ? service.getPortal(db, portal.id) : portal), opening };
  })();
  res.status(201).json(created);
});

// Settle an existing bill using a portal balance.
router.post('/settle-bill', (req, res) => {
  res.json(service.settleBillFromPortal(db, req.body || {}));
});

// Admin only (permissions.js): void and re-post with corrected values.
router.post('/topups/:id/correct', (req, res) => {
  res.json(corrections.correct(db, 'topup', Number(req.params.id), req.body || {}));
});

// Admin only (permissions.js): void and re-post with corrected values.
router.post('/refunds/:id/correct', (req, res) => {
  res.json(corrections.correct(db, 'portal_refund', Number(req.params.id), req.body || {}));
});

router.post('/topups/:id/void', (req, res) => {
  res.json(service.voidTopup(db, Number(req.params.id), req.body || {}));
});

router.post('/refunds/:id/void', (req, res) => {
  res.json(service.voidPortalRefund(db, Number(req.params.id), req.body || {}));
});

router.post('/credits/:id/correct', (req, res) => {
  res.json(corrections.correct(db, 'portal_credit', req.params.id, req.body || {}));
});

router.post('/credits/:id/void', (req, res) => {
  res.json(service.voidPortalCredit(db, Number(req.params.id), req.body || {}));
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
