'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { restrictFile } = require('../file-safety');
const mirror = require('./backup-mirror');
const { resolveDataDir } = require('../data-dir');

const dataDir = resolveDataDir();
const backupDir = path.join(dataDir, 'backups');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeLabel(label) {
  return String(label || 'manual').replace(/[^a-z0-9-]/gi, '-').slice(0, 40) || 'manual';
}

const AUTO_BACKUP_MAX_AGE_DAYS = 90;
// Every automatic backup of the last 14 days is kept; older ones thin out to
// one per week, so 90 days cost about 20 files, not 90.
const AUTO_BACKUP_DAILY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function pruneBackups(keep = 30, { autoMaxAgeDays = AUTO_BACKUP_MAX_AGE_DAYS } = {}) {
  try {
    const files = fs.readdirSync(backupDir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => ({ name, time: fs.statSync(path.join(backupDir, name)).mtimeMs }));
    const isAutomatic = (file) => /-auto\.db$/.test(file.name);
    // Safety and automatic backups are never deleted by the manual-backup count.
    const manual = files
      .filter((file) => !/-(?:pre-reset|pre-restore|auto)\.db$/.test(file.name))
      .sort((a, b) => b.time - a.time);
    for (const file of manual.slice(keep)) {
      fs.unlinkSync(path.join(backupDir, file.name));
    }

    const now = Date.now();
    const weeksSeen = new Set();
    // Newest first, so the copy kept for a week is its latest one.
    for (const file of files.filter(isAutomatic).sort((a, b) => b.time - a.time)) {
      const age = now - file.time;
      const week = Math.floor(file.time / (7 * DAY_MS));
      const thinned = age >= AUTO_BACKUP_DAILY_DAYS * DAY_MS && weeksSeen.has(week);
      if (age >= AUTO_BACKUP_DAILY_DAYS * DAY_MS) weeksSeen.add(week);
      if (age > autoMaxAgeDays * DAY_MS || thinned) fs.unlinkSync(path.join(backupDir, file.name));
    }
  } catch {
    // Backup retention must never block the backup itself.
  }
}

function createDatabaseBackup(db, label = 'manual') {
  fs.mkdirSync(backupDir, { recursive: true });
  const name = `netfare-${stamp()}-${safeLabel(label)}.db`;
  const file = path.join(backupDir, name);
  db.prepare('VACUUM INTO ?').run(file);
  restrictFile(file);
  const stat = fs.statSync(file);
  pruneBackups();
  const backup = {
    name,
    path: file,
    size: stat.size,
    created_at: new Date(stat.mtimeMs).toISOString(),
  };
  // The second copy elsewhere, if the admin chose a place; never blocks.
  backup.mirror = mirror.copyBackup(db, backup);
  return backup;
}

// Downloads must not consume the permanent backup allowance.
function createTemporaryBackup(db, label = 'download') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netfare-download-'));
  const name = `netfare-${stamp()}-${safeLabel(label)}.db`;
  const file = path.join(dir, name);
  const cleanup = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already removed */ }
  };
  try {
    db.prepare('VACUUM INTO ?').run(file);
    restrictFile(file);
    const stat = fs.statSync(file);
    return {
      name,
      path: file,
      size: stat.size,
      created_at: new Date(stat.mtimeMs).toISOString(),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
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

// The last automatic backup that failed, kept until one works again, so the
// admin is told (Today box, Settings) instead of only the server log.
let lastFailure = null;

function backupStatus() {
  let latest = null;
  try { latest = listBackups()[0] || null; } catch { /* no backup folder */ }
  return {
    enabled: Number(process.env.LEDGERLY_AUTO_BACKUP_HOURS ?? 24) > 0,
    latest_at: latest?.created_at || null,
    latest_name: latest?.name || null,
    failure: lastFailure,
  };
}

function startAutoBackup(db, options = {}) {
  const hours = Number(options.hours ?? process.env.LEDGERLY_AUTO_BACKUP_HOURS ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const check = () => {
    try {
      const backup = runAutoBackup(db, { hours });
      if (backup) console.log(`  Automatic backup saved: ${backup.name}`);
      else mirror.catchUp(db, listBackups()[0]);
      lastFailure = null;
    } catch (error) {
      lastFailure = { at: new Date().toISOString(), message: error.message };
      console.error(`  Automatic backup failed: ${error.message}`);
    }
  };
  check();
  const timer = setInterval(check, Math.min(hours * 60 * 60 * 1000, 6 * 60 * 60 * 1000));
  timer.unref();
  return timer;
}

module.exports = {
  backupStatus,
  dataDir,
  backupDir,
  createDatabaseBackup,
  createTemporaryBackup,
  listBackups,
  pruneBackups,
  runAutoBackup,
  startAutoBackup,
};
