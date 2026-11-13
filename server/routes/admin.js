'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, todayISO } = require('../util');
const { assertLedgerEmpty, loadDemo, resetAll } = require('../services/demo');
const { createDatabaseBackup, createTemporaryBackup, listBackups, dataDir } = require('../services/backup');
const backupMirror = require('../services/backup-mirror');
const network = require('../network');
const updates = require('../services/updates');
const audit = require('../services/audit');

function networkStatus() {
  return {
    ...network.readSettings(db),
    running_on_network: network.listensOnNetwork(),
    addresses: network.listensOnNetwork() ? network.connectAddresses(db) : [],
  };
}

// The second copy of backups: where it goes, and a Copy now button.
router.get('/backup-mirror', (req, res) => {
  res.json(backupMirror.status(db, dataDir));
});

router.put('/backup-mirror', (req, res) => {
  const before = backupMirror.status(db, dataDir).dir;
  const dir = backupMirror.setFolder(db, dataDir, (req.body || {}).dir);
  if (dir !== before) {
    audit.record(db, {
      entity_type: 'settings', entity_number: 'Backup copy', action: dir ? 'enable' : 'disable',
      remarks: dir ? `Backups are also copied to ${dir}` : 'Backups stay on this computer only',
    });
  }
  // Put the first copy there straight away.
  if (dir) createDatabaseBackup(db, 'manual');
  res.json(backupMirror.status(db, dataDir));
});

router.post('/backup-mirror/copy', (req, res) => {
  const backup = createDatabaseBackup(db, 'manual');
  if (backup.mirror && !backup.mirror.ok) throw bad(backup.mirror.error);
  res.json(backupMirror.status(db, dataDir));
});

// New versions: the admin's banner and the Updates card in Settings.
router.get('/updates', (req, res, next) => {
  updates.status(db, { force: req.query.force === '1' }).then((status) => res.json(status), next);
});

router.put('/updates', (req, res, next) => {
  const body = req.body || {};
  updates.setFeed(db, { enabled: body.enabled !== false, feed_url: body.feed_url });
  updates.status(db, { force: true }).then((status) => res.json(status), next);
});

// Office network mode. Turning it on or off takes effect after a restart.
router.get('/network', (req, res) => {
  res.json(networkStatus());
});

router.put('/network', (req, res) => {
  const body = req.body || {};
  const before = network.readSettings(db);
  const enabled = body.lan_enabled === undefined ? before.lan_enabled : Boolean(body.lan_enabled);
  const hosts = body.lan_hosts === undefined ? before.lan_hosts : network.cleanHostList(body.lan_hosts);
  if (hosts.length > 20) throw bad('Add at most 20 names');
  db.prepare("UPDATE settings SET lan_enabled = ?, lan_hosts = ?, updated_at = datetime('now') WHERE id = 1")
    .run(enabled ? 1 : 0, hosts.join(' '));
  if (enabled !== before.lan_enabled) {
    audit.record(db, {
      entity_type: 'settings', entity_number: 'Office network', action: enabled ? 'enable' : 'disable',
      remarks: enabled ? 'Other computers may open Netfare after a restart' : 'This computer only after a restart',
    });
  }
  res.json(networkStatus());
});

router.get('/backups/status', (req, res) => {
  res.json(require('../services/backup').backupStatus());
});

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
    version: updates.CURRENT_VERSION,
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
