'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const schema = require('./schema');
const defaultAccounts = require('./default-accounts');
const runMigrations = require('./migrations');
const { restrictDataDir } = require('./file-safety');
const { resolveDataDir } = require('./data-dir');

let dataDir;
try {
  dataDir = resolveDataDir();
} catch (error) {
  if (error.code !== 'NETFARE_DESKTOP_BOOKS') throw error;
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
fs.mkdirSync(dataDir, { recursive: true });
restrictDataDir(dataDir);

const db = new Database(path.join(dataDir, 'accounting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(schema);

const insertAccount = db.prepare(`
  INSERT OR IGNORE INTO accounts (code, name, type, subtype, normal_balance, is_cash, is_system)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
db.transaction(() => {
  for (const row of defaultAccounts) insertAccount.run(...row);
})();

const settingsCount = db.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
if (settingsCount === 0) {
  db.prepare(`INSERT INTO settings (id, company_name) VALUES (1, 'My Company')`).run();
}

runMigrations(db);

module.exports = db;
