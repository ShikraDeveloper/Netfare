'use strict';

const router = require('express').Router();
const db = require('../db');

router.get('/health', (req, res) => {
  let database = 'ok';
  try {
    db.prepare('SELECT 1').get();
  } catch {
    database = 'error';
  }
  res.status(database === 'ok' ? 200 : 503).json({
    ok: database === 'ok',
    app: 'Ledgerly',
    version: '1.0.0',
    database,
    uptime_seconds: Math.round(process.uptime()),
  });
});

router.use('/accounts', require('./accounts'));
router.use('/customers', require('./customers'));
router.use('/customer-balances', require('./customer-balances'));
router.use('/settlement-queue', require('./settlement-queue'));
router.use('/vendors', require('./vendors'));
router.use('/bookings', require('./bookings'));
router.use('/visas', require('./visas'));
router.use('/cancellations', require('./cancellations'));
router.use('/advances', require('./advances'));
router.use('/visa-deposits', require('./visa-deposits'));
router.use('/portals', require('./portals'));
router.use('/invoices', require('./invoices'));
router.use('/credits', require('./credits'));
router.use('/attachments', require('./attachments'));
router.use('/bills', require('./bills'));
router.use('/supplier-credits', require('./supplier-credits'));
router.use('/refunds', require('./refunds'));
router.use('/compliance', require('./compliance'));
router.use('/cheques', require('./cheques'));
router.use('/cash', require('./cash'));
router.use('/journal-entries', require('./journal'));
router.use('/opening-balances', require('./opening-balances'));
router.use('/bank-reconciliations', require('./bank-reconciliations'));
router.use('/reports', require('./reports'));
router.use('/settings', require('./settings'));
router.use('/audit-logs', require('./audit-logs'));
router.use('/audit-chain', require('./audit-chain'));
router.use('/admin', require('./admin'));

module.exports = router;
