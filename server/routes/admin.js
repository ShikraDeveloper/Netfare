'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, todayISO } = require('../util');
const { loadDemo, resetAll } = require('../services/demo');
const { createDatabaseBackup, listBackups } = require('../services/backup');

router.get('/backups', (req, res) => {
  res.json(listBackups());
});

router.post('/backup', (req, res) => {
  res.status(201).json(createDatabaseBackup(db, 'manual'));
});

router.get('/backup/database', (req, res, next) => {
  const backup = createDatabaseBackup(db, 'download');
  res.download(backup.path, backup.name, (error) => {
    if (error && !res.headersSent) next(error);
  });
});

router.get('/backup', (req, res) => {
  const tables = [
    'settings', 'accounts', 'customers', 'vendors', 'invoices', 'invoice_items', 'payments',
    'bills', 'bill_items', 'bill_payments', 'bookings', 'booking_items', 'visa_applications', 'visa_items', 'customer_advances',
    'supplier_portals', 'portal_topups', 'portal_refunds', 'refunds',
    'compliance_items', 'compliance_logs', 'post_dated_cheques', 'cash_deposits',
    'journal_entries', 'journal_lines',
  ];
  const data = {
    app: 'Ledgerly',
    version: '1.0.0',
    exported_at: new Date().toISOString(),
    tables: {},
  };
  for (const table of tables) {
    data.tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  res.setHeader('Content-Disposition', `attachment; filename="ledgerly-backup-${todayISO()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data, null, 2));
});

router.post('/demo', (req, res) => {
  const backup = createDatabaseBackup(db, 'pre-demo');
  res.status(201).json({ ...loadDemo(db), backup });
});

router.post('/reset', (req, res) => {
  const body = req.body || {};
  if (body.confirm !== 'RESET') throw bad('Type RESET to confirm clearing all data');
  const backup = createDatabaseBackup(db, 'pre-reset');
  res.json({ ...resetAll(db), backup });
});

module.exports = router;
