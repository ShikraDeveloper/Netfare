'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { restrictFile } = require('../server/file-safety');

const root = path.join(__dirname, '..');

function resolveDataDir() {
  return process.env.LEDGERLY_DATA_DIR
    ? path.resolve(process.env.LEDGERLY_DATA_DIR)
    : path.join(root, 'data');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function isServerRunning() {
  const port = process.env.PORT || 4173;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

function verifyDatabase(file, requiredTables) {
  const check = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = check.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`backup integrity check failed: ${integrity}`);
    const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of requiredTables) {
      if (!tables.has(table)) throw new Error(`backup is missing required table "${table}"`);
    }
    // Netfare never creates triggers or views. In a backup they would be
    // logic that keeps changing every later posting, so refuse them.
    const extra = check.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view') LIMIT 1").get();
    if (extra) throw new Error(`backup contains a ${extra.type} ("${extra.name}") that Netfare does not create`);
    // A users table that makes new accounts admins by default would turn
    // every staff user created after the restore into an admin.
    if (tables.has('users')) {
      const isAdmin = check.pragma('table_info(users)').find((column) => column.name === 'is_admin');
      if (isAdmin && isAdmin.dflt_value !== '0') throw new Error('backup has a changed users table (new users would become admins)');
    }
    const broken = check.pragma('foreign_key_check');
    if (broken.length) throw new Error(`backup has ${broken.length} broken link${broken.length === 1 ? '' : 's'} between records (first in "${broken[0].table}")`);
  } finally {
    check.close();
  }
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory) {
  try {
    const fd = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is not available on every platform.
  }
}

// VACUUM INTO is a consistent copy even when the source has an active WAL.
function writeConsistentCopy(source, destination) {
  const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
  try {
    sourceDb.prepare('VACUUM INTO ?').run(destination);
  } finally {
    sourceDb.close();
  }
}

// Browser sign-ins saved in a backup must not come back to life with it.
function signOutEveryone(file) {
  const copy = new Database(file, { fileMustExist: true });
  try {
    if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) {
      copy.prepare('DELETE FROM sessions').run();
    }
  } finally {
    copy.close();
  }
}

async function restoreDatabase({ source, dataDir = resolveDataDir(), force = false, checkServer = isServerRunning } = {}) {
  if (!source) throw new Error('choose a backup file to restore');
  const sourcePath = path.resolve(source);
  const targetDir = path.resolve(dataDir);
  const dbPath = path.join(targetDir, 'accounting.db');
  const backupDir = path.join(targetDir, 'backups');
  const tempPath = `${dbPath}.restore-tmp`;

  if (!fs.existsSync(sourcePath)) throw new Error(`backup not found at ${sourcePath}`);
  if (sourcePath === dbPath) throw new Error('the selected file is the live database');
  if (await checkServer()) {
    throw new Error('Netfare is running. Stop the app first, then run the restore again.');
  }
  if (!force && (fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`))) {
    throw new Error('SQLite WAL files are still present. Stop Netfare cleanly before restoring, or use --force only when you are sure.');
  }

  const header = Buffer.alloc(16);
  const fd = fs.openSync(sourcePath, 'r');
  try {
    fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.toString('utf8').startsWith('SQLite format 3')) throw new Error('this is not a SQLite database');

  const requiredTables = ['settings', 'accounts', 'invoices', 'bills', 'journal_entries', 'journal_lines'];
  verifyDatabase(sourcePath, requiredTables);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  let safety = null;
  if (fs.existsSync(dbPath)) {
    safety = path.join(backupDir, `netfare-${timestamp()}-pre-restore.db`);
    try {
      const current = new Database(dbPath);
      try {
        current.prepare('VACUUM INTO ?').run(safety);
        restrictFile(safety);
      } finally {
        current.close();
      }
    } catch (error) {
      throw new Error(`could not create a safety backup: ${error.message}`);
    }
  }

  try {
    fs.rmSync(tempPath, { force: true });
    writeConsistentCopy(sourcePath, tempPath);
    signOutEveryone(tempPath);
    // Verify the exact bytes that will become the live database.
    verifyDatabase(tempPath, requiredTables);
    restrictFile(tempPath);
    fsyncFile(tempPath);
    fs.renameSync(tempPath, dbPath);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* no WAL/SHM */ }
    }
    fsyncDirectory(targetDir);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* already removed */ }
    throw error;
  }

  return { dbPath, safety };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const sourceArg = args.find((arg) => !arg.startsWith('--'));
  if (!sourceArg) {
    console.log('\n  Usage: npm run restore -- path/to/netfare-backup.db [--force]\n');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await restoreDatabase({
      source: path.resolve(process.cwd(), sourceArg),
      dataDir: resolveDataDir(),
      force,
      checkServer: isServerRunning,
    });
    console.log('\n  Restore complete.');
    if (result.safety) console.log(`  Safety backup: ${result.safety}`);
    console.log('  Start Netfare again with: npm start');
    console.log('  Run a trial balance check after opening the app.\n');
  } catch (error) {
    console.error(`\n  Restore cancelled: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  resolveDataDir,
  isServerRunning,
  restoreDatabase,
  verifyDatabase,
};
