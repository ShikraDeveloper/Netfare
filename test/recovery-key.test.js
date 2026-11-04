'use strict';

// The admin's recovery key: made once, kept only as a hash, and the only way
// to reset a forgotten admin password from inside the app.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-recovery-key-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const auth = require('../server/services/auth');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const KEY_PATTERN = /^NF-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
const { user: admin } = auth.setupAdmin(db, { full_name: 'Key Admin', username: 'keyadmin', password: 'first-password' });

function row() {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(admin.id);
}

test('typed keys are read loosely: case, dashes, spaces and look-alike letters', () => {
  assert.equal(auth.normalizeRecoveryKey('NF-7KQM-4XTA-9PMW-2HRC'), '7KQM4XTA9PMW2HRC');
  assert.equal(auth.normalizeRecoveryKey(' nf 7kqm 4xta 9pmw 2hrc '), '7KQM4XTA9PMW2HRC');
  assert.equal(auth.normalizeRecoveryKey('7KQM4XTA9PMW2HRC'), '7KQM4XTA9PMW2HRC');
  assert.equal(auth.normalizeRecoveryKey('NF-OIL0-0000-0000-0000'), '0110000000000000');
  assert.equal(auth.normalizeRecoveryKey('NF-7KQM-4XTA-9PMW'), '', 'too short');
  assert.equal(auth.normalizeRecoveryKey('NF-7KQM-4XTA-9PMW-2HR!'), '', 'not in the alphabet');
});

test('a new admin is asked to save a key; only the hash is stored', () => {
  assert.equal(admin.recovery_key_needed, true);
  assert.deepEqual(auth.recoveryKeyStatus(db, admin.id), { exists: false, created_at: null, uses: 0 });
  const { recovery_key: key } = auth.makeRecoveryKey(db, admin.id, {});
  assert.match(key, KEY_PATTERN);
  assert.match(row().recovery_key_hash, /^scrypt\$/);
  assert.ok(!JSON.stringify(row()).includes(key.slice(3, 7) + key.slice(8, 12)), 'the key itself is not stored');
  const user = auth.confirmRecoveryKey(db, admin.id);
  assert.equal(user.recovery_key_needed, false);
  assert.equal(auth.recoveryKeyStatus(db, admin.id).exists, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'recovery_key'").get().c, 1);
});

test('replacing a saved key needs the admin password, and staff have no key', () => {
  assert.throws(() => auth.makeRecoveryKey(db, admin.id, {}), /password is wrong/);
  assert.throws(() => auth.makeRecoveryKey(db, admin.id, { current_password: 'nope-nope' }), /password is wrong/);
  const staff = auth.createUser(db, { full_name: 'Staff One', username: 'staffone', password: 'staff-password' });
  assert.equal(staff.recovery_key_needed, false);
  assert.throws(() => auth.makeRecoveryKey(db, staff.id, {}), /Only the admin/);
});

test('reset: wrong keys count down and lock; the right key sets the password and swaps the key', () => {
  const { recovery_key: key } = auth.makeRecoveryKey(db, admin.id, { current_password: 'first-password' });
  auth.confirmRecoveryKey(db, admin.id);
  const session = auth.login(db, { username: 'keyadmin', password: 'first-password' }, { address: '127.0.0.1' });
  const start = Date.now();

  assert.throws(() => auth.resetWithRecoveryKey(db, { recovery_key: 'NF-0000-0000-0000-0000', new_password: 'second-password' }, { now: start }),
    /doesn't match\. 4 tries left/);
  for (let i = 0; i < 3; i += 1) {
    assert.throws(() => auth.resetWithRecoveryKey(db, { recovery_key: 'garbage', new_password: 'second-password' }, { now: start }), /doesn't match/);
  }
  assert.throws(() => auth.resetWithRecoveryKey(db, { recovery_key: 'garbage', new_password: 'second-password' }, { now: start }), /Too many wrong keys/);
  assert.throws(() => auth.resetWithRecoveryKey(db, { recovery_key: key, new_password: 'second-password' }, { now: start + 60_000 }),
    /Too many wrong keys/, 'even the right key waits out the lock');

  const later = start + 16 * 60_000;
  assert.throws(() => auth.resetWithRecoveryKey(db, { recovery_key: key, new_password: 'short' }, { now: later }), /at least 8/);
  const result = auth.resetWithRecoveryKey(db, { recovery_key: key.toLowerCase(), new_password: 'second-password' }, { now: later });
  assert.equal(result.user.username, 'keyadmin');
  assert.ok(result.token);
  assert.match(result.recovery_key, KEY_PATTERN);
  assert.notEqual(result.recovery_key, key);
  assert.equal(result.user.recovery_key_needed, true, 'the new key still has to be saved');
  assert.equal(auth.userForToken(db, session.token), null, 'older sessions end');
  assert.ok(auth.userForToken(db, result.token), 'the reset signs the admin in');
  assert.equal(row().recovery_key_uses, 1);
  assert.ok(auth.verifyPassword('second-password', row().password_hash));
  const entry = db.prepare("SELECT * FROM audit_logs WHERE action = 'password_reset' ORDER BY id DESC").get();
  assert.match(entry.remarks, /recovery key/);
  assert.equal(entry.user_name, 'Key Admin');

  assert.throws(() => auth.resetWithRecoveryKey(db, { recovery_key: key, new_password: 'third-password' }, { now: later }),
    /doesn't match/, 'the old key no longer works');
  auth.resetWithRecoveryKey(db, { recovery_key: result.recovery_key, new_password: 'third-password' }, { now: later });
  assert.ok(auth.verifyPassword('third-password', row().password_hash), 'an unsaved new key already works');
});
