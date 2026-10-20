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

module.exports = {
  backupDir,
  createDatabaseBackup,
  listBackups,
};
