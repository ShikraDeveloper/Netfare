'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const dbPath = path.join(dataDir, 'accounting.db');
const backupDir = path.join(dataDir, 'backups');

function fail(message) {
  console.error(`\n  Restore cancelled: ${message}\n`);
  process.exit(1);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function serverRunning() {
  const port = process.env.PORT || 4173;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const sourceArg = args.find((arg) => !arg.startsWith('--'));
  if (!sourceArg) {
    console.log('\n  Usage: npm run restore -- path/to/ledgerly-backup.db [--force]\n');
    process.exit(1);
  }
  const source = path.resolve(process.cwd(), sourceArg);
  if (!fs.existsSync(source)) fail(`backup not found at ${source}`);
  if (source === dbPath) fail('the selected file is the live database');
  if (await serverRunning() && !force) {
    fail('Ledgerly is running. Stop the app first, then run the restore again. Use --force only when you are sure.');
  }
  if (!force && (fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`))) {
    fail('SQLite WAL files are still present. Stop Ledgerly cleanly before restoring, or use --force only when you are sure.');
  }

  const header = Buffer.alloc(16);
  const fd = fs.openSync(source, 'r');
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  if (!header.toString('utf8').startsWith('SQLite format 3')) fail('this is not a SQLite database');

  const check = new Database(source, { readonly: true, fileMustExist: true });
  const integrity = check.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    check.close();
    fail(`backup integrity check failed: ${integrity}`);
  }
  const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const table of ['settings', 'accounts', 'invoices', 'bills', 'journal_entries', 'journal_lines']) {
    if (!tables.has(table)) {
      check.close();
      fail(`backup is missing required table "${table}"`);
    }
  }
  check.close();

  fs.mkdirSync(backupDir, { recursive: true });
  let safety = null;
  if (fs.existsSync(dbPath)) {
    safety = path.join(backupDir, `ledgerly-${timestamp()}-pre-restore.db`);
    try {
      const current = new Database(dbPath);
      current.prepare('VACUUM INTO ?').run(safety);
      current.close();
    } catch (error) {
      fail(`could not create a safety backup: ${error.message}`);
    }
  }

  fs.copyFileSync(source, dbPath);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch { /* no WAL/SHM */ }
  }

  console.log('\n  Restore complete.');
  if (safety) console.log(`  Safety backup: ${safety}`);
  console.log('  Start Ledgerly again with: npm start');
  console.log('  Run a trial balance check after opening the app.\n');
})().catch((error) => fail(error.message));
