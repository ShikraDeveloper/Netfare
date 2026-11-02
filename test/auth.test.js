'use strict';

// Logins: password hashing, the one-time admin setup and restore sign-outs.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const Database = require('better-sqlite3');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-auth-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const auth = require('../server/services/auth');
const backupService = require('../server/services/backup');
const { restoreDatabase } = require('../scripts/restore');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('passwords are stored as salted scrypt hashes, never as text', () => {
  const first = auth.hashPassword('same-password');
  const second = auth.hashPassword('same-password');
  assert.match(first, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(first, second, 'each hash has its own salt');
  assert.equal(auth.verifyPassword('same-password', first), true);
  assert.equal(auth.verifyPassword('other-password', first), false);
  assert.equal(auth.verifyPassword('same-password', 'garbage'), false);
});

test('the first account is the admin, created once; usernames ignore case', () => {
  assert.equal(auth.setupNeeded(db), true);
  assert.throws(() => auth.setupAdmin(db, { full_name: 'A', username: 'ad', password: 'admin-pass' }), /Username must be/);
  assert.throws(() => auth.setupAdmin(db, { full_name: 'A', username: 'admin', password: 'admin' }), /at least 8/);
  assert.throws(() => auth.setupAdmin(db, { full_name: 'A', username: 'adminuser', password: 'AdminUser' }), /cannot be the username/);
  const { user, token } = auth.setupAdmin(db, { full_name: 'Agency Owner', username: 'Owner', password: 'owner-pass-1' });
  assert.equal(user.username, 'owner');
  assert.equal(user.is_admin, true);
  assert.equal(auth.userForToken(db, token).id, user.id);
  assert.throws(() => auth.setupAdmin(db, { full_name: 'B', username: 'other', password: 'other-pass-1' }), /already exists/);
  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id).password_hash;
  assert.ok(!stored.includes('owner-pass-1'));
  const session = db.prepare('SELECT id FROM sessions').get().id;
  assert.notEqual(session, token, 'only a hash of the browser token is stored');
});

test('sessions end after the idle limit', () => {
  const { token } = auth.login(db, { username: 'owner', password: 'owner-pass-1' });
  assert.ok(auth.userForToken(db, token));
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now', ?)").run(`-${auth.IDLE_HOURS + 1} hours`);
  assert.equal(auth.userForToken(db, token), null);
});

test('restoring a backup signs everyone out', async () => {
  auth.login(db, { username: 'owner', password: 'owner-pass-1' });
  const source = backupService.createDatabaseBackup(db, 'auth-restore');
  const copy = new Database(source.path, { readonly: true });
  assert.ok(copy.prepare('SELECT COUNT(*) AS c FROM sessions').get().c > 0, 'the backup holds a session');
  copy.close();
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-auth-restore-'));
  try {
    const result = await restoreDatabase({ source: source.path, dataDir: targetDir, checkServer: async () => false });
    const restored = new Database(result.dbPath, { readonly: true });
    assert.equal(restored.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
    assert.equal(restored.prepare('SELECT COUNT(*) AS c FROM users').get().c, 1, 'the users come back');
    restored.close();
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('the JSON export leaves out logins', () => {
  const adminRoute = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'admin.js'), 'utf8');
  assert.doesNotMatch(adminRoute, /'users'|'sessions'/);
});
