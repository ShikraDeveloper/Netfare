'use strict';

const fs = require('fs');
const path = require('path');

const dataDir = process.env.LEDGERLY_DATA_DIR
  ? path.resolve(process.env.LEDGERLY_DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');
const backupDir = path.join(dataDir, 'backups');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeLabel(label) {
  return String(label || 'manual').replace(/[^a-z0-9-]/gi, '-').slice(0, 40) || 'manual';
}

function pruneBackups(keep = 30) {
  try {
    const files = fs.readdirSync(backupDir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => ({ name, time: fs.statSync(path.join(backupDir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const file of files.slice(keep)) {
      fs.unlinkSync(path.join(backupDir, file.name));
    }
  } catch {
    // Backup retention must never block the backup itself.
  }
}

function createDatabaseBackup(db, label = 'manual') {
  fs.mkdirSync(backupDir, { recursive: true });
  const name = `ledgerly-${stamp()}-${safeLabel(label)}.db`;
  const file = path.join(backupDir, name);
  db.prepare('VACUUM INTO ?').run(file);
  const stat = fs.statSync(file);
  pruneBackups();
  return {
    name,
    path: file,
    size: stat.size,
    created_at: new Date(stat.mtimeMs).toISOString(),
  };
}

function listBackups() {
  fs.mkdirSync(backupDir, { recursive: true });
  return fs.readdirSync(backupDir)
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const file = path.join(backupDir, name);
      const stat = fs.statSync(file);
      return {
        name,
        path: file,
        size: stat.size,
        created_at: new Date(stat.mtimeMs).toISOString(),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function runAutoBackup(db, { hours = Number(process.env.LEDGERLY_AUTO_BACKUP_HOURS || 24) } = {}) {
  const interval = Number(hours);
  if (!Number.isFinite(interval) || interval <= 0) return null;
  const latest = listBackups()[0];
  if (latest && Date.now() - Date.parse(latest.created_at) < interval * 60 * 60 * 1000) return null;
  return createDatabaseBackup(db, 'auto');
}

function startAutoBackup(db, options = {}) {
  const hours = Number(options.hours ?? process.env.LEDGERLY_AUTO_BACKUP_HOURS ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const check = () => {
    try {
      const backup = runAutoBackup(db, { hours });
      if (backup) console.log(`  Automatic backup saved: ${backup.name}`);
    } catch (error) {
      console.error(`  Automatic backup failed: ${error.message}`);
    }
  };
  check();
  const timer = setInterval(check, Math.min(hours * 60 * 60 * 1000, 6 * 60 * 60 * 1000));
  timer.unref();
  return timer;
}

module.exports = {
  backupDir,
  createDatabaseBackup,
  listBackups,
  runAutoBackup,
  startAutoBackup,
};
