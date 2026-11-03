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

test('wrong passwords lock only the computer that typed them', () => {
  const now = Date.now();
  const office = { address: '192.168.1.50', now };
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.throws(() => auth.login(db, { username: 'owner', password: 'wrong-pass' }, office), /Wrong username or password/);
  }
  assert.throws(() => auth.login(db, { username: 'owner', password: 'wrong-pass' }, office), /Too many wrong attempts/);
  assert.throws(() => auth.login(db, { username: 'owner', password: 'owner-pass-1' }, office), /Too many wrong attempts/, 'that computer waits');
  assert.ok(auth.login(db, { username: 'owner', password: 'owner-pass-1' }, { address: '127.0.0.1', now }).token, 'the admin at the main computer still signs in');
  assert.ok(auth.login(db, { username: 'owner', password: 'owner-pass-1' }, { address: '192.168.1.50', now: now + 6 * 60 * 1000 }).token, 'and the lock ends');

  const scanner = { address: '192.168.1.66', now };
  for (let attempt = 1; attempt < 20; attempt += 1) {
    assert.throws(() => auth.login(db, { username: `guess${attempt}`, password: 'x-password' }, scanner), /Wrong username or password/);
  }
  assert.throws(() => auth.login(db, { username: 'guess20', password: 'x-password' }, scanner), /Too many wrong attempts/, 'many usernames from one computer');
  assert.throws(() => auth.login(db, { username: 'owner', password: 'owner-pass-1' }, scanner), /Too many wrong attempts/);
});

test('a stored hash with an extreme cost is refused, not computed', () => {
  const [kind, , r, , salt, key] = auth.hashPassword('cost-pass-1').split('$');
  assert.equal(auth.verifyPassword('cost-pass-1', [kind, 2 ** 20, r, 1, salt, key].join('$')), false);
  assert.equal(auth.verifyPassword('cost-pass-1', [kind, 16384, r, 64, salt, key].join('$')), false);
});

test('new staff are never admins, even if the table default says so', () => {
  const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql;
  const adminByDefault = usersSql
    .replace(/CREATE TABLE (IF NOT EXISTS )?"?users"?/, 'CREATE TABLE users_new')
    .replace(/is_admin INTEGER NOT NULL DEFAULT 0/, 'is_admin INTEGER NOT NULL DEFAULT 1');
  const rebuildUsers = (sql) => {
    db.pragma('foreign_keys = OFF');
    db.exec(`${sql}; INSERT INTO users_new SELECT * FROM users; DROP TABLE users; ALTER TABLE users_new RENAME TO users;`);
    db.pragma('foreign_keys = ON');
  };
  rebuildUsers(adminByDefault);
  try {
    const staff = auth.createUser(db, { full_name: 'Desk', username: 'desk.one', password: 'desk-pass-1', permissions: { sales: 'view' } });
    assert.equal(staff.is_admin, false);
    const row = db.prepare('SELECT is_admin, is_active, must_change_password FROM users WHERE id = ?').get(staff.id);
    assert.deepEqual({ ...row }, { is_admin: 0, is_active: 1, must_change_password: 0 });
  } finally {
    db.prepare("DELETE FROM users WHERE username = 'desk.one'").run();
    rebuildUsers(usersSql.replace(/CREATE TABLE (IF NOT EXISTS )?"?users"?/, 'CREATE TABLE users_new'));
  }
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
