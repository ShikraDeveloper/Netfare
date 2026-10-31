'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, todayISO } = require('../util');
const { assertLedgerEmpty, loadDemo, resetAll } = require('../services/demo');
const { createDatabaseBackup, createTemporaryBackup, listBackups } = require('../services/backup');

router.get('/backups', (req, res) => {
  res.json(listBackups());
});

router.post('/backup', (req, res) => {
  res.status(201).json(createDatabaseBackup(db, 'manual'));
});

router.get('/backup/database', (req, res, next) => {
  const backup = createTemporaryBackup(db, 'download');
  res.download(backup.path, backup.name, (error) => {
    backup.cleanup();
    if (error && !res.headersSent) next(error);
  });
});

router.get('/backup', (req, res) => {
  const tables = [
    'settings', 'accounts', 'customers', 'vendors', 'invoices', 'invoice_items', 'payments',
    'bills', 'bill_items', 'bill_payments', 'bookings', 'booking_items', 'visa_applications', 'visa_items', 'visa_groups', 'visa_deposits', 'visa_deposit_events', 'customer_advances',
    'cancellations', 'supplier_credit_notes', 'supplier_credit_items', 'supplier_credit_applications',
    'supplier_portals', 'portal_topups', 'portal_refunds', 'portal_credits', 'refunds',
    'compliance_items', 'compliance_logs', 'post_dated_cheques', 'cash_deposits',
    'credit_notes', 'credit_applications', 'bank_reconciliations', 'bank_reconciliation_lines', 'attachments', 'job_status_history',
    'journal_entries', 'journal_lines', 'audit_logs',
  ];
  const data = {
    app: 'Netfare',
    version: '1.0.0',
    exported_at: new Date().toISOString(),
    tables: {},
  };
  for (const table of tables) {
    const select = table === 'attachments'
      ? 'id, entity_type, entity_id, file_name, mime_type, size_bytes, created_at'
      : '*';
    data.tables[table] = db.prepare(`SELECT ${select} FROM ${table}`).all();
  }
  res.setHeader('Content-Disposition', `attachment; filename="netfare-backup-${todayISO()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(data, null, 2));
});

router.post('/demo', (req, res) => {
  assertLedgerEmpty(db);
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
