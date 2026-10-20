'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createDatabaseBackup } = require('../server/services/backup');

const dataDir = process.env.LEDGERLY_DATA_DIR
  ? path.resolve(process.env.LEDGERLY_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'accounting.db');

if (!fs.existsSync(dbPath)) {
  console.error(`\n  No database found at ${dbPath}\n`);
  process.exit(1);
}

let db;
try {
  db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  const backup = createDatabaseBackup(db, 'cli');
  console.log(`\n  Backup complete: ${backup.path}`);
  console.log(`  Size: ${(backup.size / 1024).toFixed(1)} KB\n`);
} catch (error) {
  console.error(`\n  Backup failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
}
