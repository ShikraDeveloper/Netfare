'use strict';

// Logins for the agency's staff. The first user is the admin; the admin adds
// the others. Passwords are stored as scrypt hashes, and a session keeps only
// a SHA-256 of the random token held in the browser cookie.

const crypto = require('crypto');
const { bad, notFound } = require('../util');
const audit = require('./audit');
const { AREAS, cleanPermissions, parsePermissions } = require('../permissions');
const { isLoopback } = require('../network');
const { runWithUser } = require('../request-context');

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 5;
const IDLE_HOURS = 12;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

// A hash can come from a restored backup, so its cost settings are capped:
// a huge one would stall every sign-in for that name.
const MAX_SCRYPT = { N: 2 ** 17, r: 16, p: 4 };

function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  if (!(Number(N) <= MAX_SCRYPT.N && Number(r) <= MAX_SCRYPT.r && Number(p) >= 1 && Number(p) <= MAX_SCRYPT.p)) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Unknown usernames still pay for one hash, so timing does not reveal which
// usernames exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function tokenId(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function cleanUsername(value) {
  const username = String(value ?? '').trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw bad('Username must be 3 to 32 characters: letters, numbers, dot, dash or underscore');
  }
  return username;
}

function cleanFullName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw bad('Enter the full name');
  if (name.length > 100) throw bad('Full name is too long');
  return name;
}

function cleanPassword(value, username = '') {
  const password = String(value ?? '');
  if (password.length < 8) throw bad('Password must be at least 8 characters');
  if (password.length > 200) throw bad('Password is too long');
  if (username && password.toLowerCase() === username.toLowerCase()) throw bad('Password cannot be the username');
  return password;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    is_admin: Boolean(user.is_admin),
    is_active: Boolean(user.is_active),
    must_change_password: Boolean(user.must_change_password),
    // The admin has no saved recovery key yet: the app shows one to save.
    recovery_key_needed: Boolean(user.is_admin && !user.recovery_key_confirmed),
    permissions: user.is_admin ? null : parsePermissions(user.permissions),
    last_login_at: user.last_login_at,
    created_at: user.created_at,
  };
}

function userById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

function setupNeeded(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`DELETE FROM sessions WHERE last_seen_at < datetime('now', ?)`).run(`-${IDLE_HOURS} hours`);
  db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(tokenId(token), userId);
  return token;
}

function setupAdmin(db, payload = {}) {
  const fullName = cleanFullName(payload.full_name);
  const username = cleanUsername(payload.username);
  const password = cleanPassword(payload.password, username);
  const hash = hashPassword(password);
  return db.transaction(() => {
    if (!setupNeeded(db)) throw bad('The admin account already exists. Sign in instead.');
    const info = db.prepare(`
      INSERT INTO users (username, full_name, password_hash, is_admin, last_login_at)
      VALUES (?, ?, ?, 1, datetime('now'))
    `).run(username, fullName, hash);
    const user = userById(db, info.lastInsertRowid);
    return { user: publicUser(user), token: createSession(db, user.id) };
  })();
}

// Wrong passwords are counted per computer and username. Someone on the office
// network who guesses wrong locks only their own attempts, never the admin
// signing in at the main computer. A computer that tries many usernames is
// locked as a whole.
//
// So that changing address does not escape the count, every loopback address
// (127.x, ::1) is one computer and an IPv6 address counts by its /64 network.
// On top of that each account has a cap across all other computers: after 20
// wrong passwords from elsewhere, sign-in for that account is refused from
// other computers for 15 minutes, while the main computer still gets in.
// Counts older than the lock time are forgotten.
const ANY_USER = '*';
const MAX_ATTEMPTS_ANY_USER = 20;
const MAX_REMOTE_ATTEMPTS_PER_ACCOUNT = 20;
const ACCOUNT_LOCK_MINUTES = 15;
const MAX_TRACKED = 5000;
const failures = new Map();
const accountFailures = new Map();

function expandIpv6(ip) {
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const middle = ip.includes('::') ? Array(Math.max(0, 8 - left.length - right.length)).fill('0') : [];
  return [...left, ...middle, ...right];
}

function sourceOf(address) {
  const ip = String(address || '').replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  if (!ip) return 'unknown';
  if (isLoopback(ip)) return 'loopback';
  if (ip.includes(':')) return `${expandIpv6(ip).slice(0, 4).map((part) => part.replace(/^0+(?=.)/, '')).join(':')}::/64`;
  return ip;
}

function failureKey(source, username) {
  return `${source}|${username}`;
}

function isLocked(map, key, now) {
  return (map.get(key)?.lockedUntil || 0) > now;
}

function noteFailure(map, key, { limit, lockMinutes = LOCK_MINUTES, now }) {
  let entry = map.get(key);
  if (!entry || (entry.lockedUntil <= now && now - entry.since > LOCK_MINUTES * 60 * 1000)) {
    entry = { count: 0, since: now, lockedUntil: 0 };
  }
  entry.count += 1;
  if (entry.count >= limit) {
    entry.count = 0;
    entry.since = now;
    entry.lockedUntil = now + lockMinutes * 60 * 1000;
  }
  map.delete(key);
  map.set(key, entry);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
  return entry.lockedUntil > now;
}

function login(db, payload = {}, { address = '', now = Date.now() } = {}) {
  const username = String(payload.username ?? '').trim().toLowerCase();
  const password = String(payload.password ?? '');
  const source = sourceOf(address);
  const fromElsewhere = source !== 'loopback';
  const key = failureKey(source, username);
  const anyKey = failureKey(source, ANY_USER);
  const lockedMessage = `Too many wrong attempts. Try again in ${LOCK_MINUTES} minutes.`;
  if (isLocked(failures, key, now) || isLocked(failures, anyKey, now)) throw bad(lockedMessage);
  if (fromElsewhere && isLocked(accountFailures, username, now)) {
    throw bad(`Too many wrong attempts for this user. Try again in ${ACCOUNT_LOCK_MINUTES} minutes, or sign in at the main computer.`);
  }
  const user = username ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
  const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    const lockedNow = noteFailure(failures, key, { limit: MAX_ATTEMPTS, now });
    const anyLocked = noteFailure(failures, anyKey, { limit: MAX_ATTEMPTS_ANY_USER, now });
    // Only real accounts are tracked here, so the map stays as small as the user list.
    if (user && fromElsewhere) {
      noteFailure(accountFailures, username, { limit: MAX_REMOTE_ATTEMPTS_PER_ACCOUNT, lockMinutes: ACCOUNT_LOCK_MINUTES, now });
    }
    throw bad(lockedNow || anyLocked ? lockedMessage : 'Wrong username or password');
  }
  failures.delete(key);
  if (!user.is_active) throw bad('This user is disabled. Ask the admin to enable it.');
  db.prepare(`
    UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?
  `).run(user.id);
  return { user: publicUser(userById(db, user.id)), token: createSession(db, user.id) };
}

// The user behind a browser token, or null when it is unknown, idle for
// longer than IDLE_HOURS, or the user was disabled.
function userForToken(db, token) {
  if (!token) return null;
  const id = tokenId(token);
  const row = db.prepare(`
    SELECT u.*, s.last_seen_at AS session_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.last_seen_at >= datetime('now', ?)
  `).get(id, `-${IDLE_HOURS} hours`);
  if (!row || !row.is_active) return null;
  db.prepare(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ? AND last_seen_at < datetime('now', '-1 minute')`).run(id);
  return row;
}

function logout(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenId(token));
}

function listUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY is_admin DESC, is_active DESC, full_name COLLATE NOCASE').all().map(publicUser);
}

function createUser(db, payload = {}) {
  const fullName = cleanFullName(payload.full_name);
  const username = cleanUsername(payload.username);
  const password = cleanPassword(payload.password, username);
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw bad(`The username "${username}" is already taken`);
    }
    const permissions = cleanPermissions(payload.permissions);
    // Every flag is set here rather than left to the table's defaults, which
    // a restored backup could have changed.
    const info = db.prepare(`
      INSERT INTO users (username, full_name, password_hash, permissions, is_admin, is_active, must_change_password)
      VALUES (?, ?, ?, ?, 0, 1, 0)
    `).run(username, fullName, hashPassword(password), JSON.stringify(permissions));
    audit.record(db, {
      entity_type: 'user', entity_id: info.lastInsertRowid, entity_number: username, action: 'create',
      remarks: `Added ${fullName} · ${rightsSummary(permissions)}`,
    });
    return publicUser(userById(db, info.lastInsertRowid));
  })();
}

function rightsSummary(permissions) {
  const parts = AREAS.filter((area) => permissions[area.key])
    .map((area) => `${area.label}: ${permissions[area.key] === 'edit' ? 'Edit' : 'View'}`);
  if (permissions.cancel) parts.push('Cancel & reject');
  return parts.length ? parts.join(', ') : 'No rights';
}

function editableUser(db, id) {
  const user = userById(db, id);
  if (!user) throw notFound('User not found');
  return user;
}

function updateUser(db, id, payload = {}) {
  return db.transaction(() => {
    const user = editableUser(db, id);
    const fullName = payload.full_name === undefined ? user.full_name : cleanFullName(payload.full_name);
    let active = user.is_active;
    if (payload.is_active !== undefined) {
      active = payload.is_active ? 1 : 0;
      if (user.is_admin && !active) throw bad('The admin account cannot be disabled');
    }
    let permissions = user.permissions;
    if (payload.permissions !== undefined) {
      if (user.is_admin) throw bad('The admin always has every right');
      permissions = JSON.stringify(cleanPermissions(payload.permissions));
    }
    db.prepare(`UPDATE users SET full_name = ?, is_active = ?, permissions = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(fullName, active, permissions, user.id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    if (permissions !== user.permissions) {
      audit.record(db, {
        entity_type: 'user', entity_id: user.id, entity_number: user.username, action: 'rights',
        remarks: rightsSummary(parsePermissions(permissions)),
      });
    }
    if (active !== user.is_active) {
      audit.record(db, { entity_type: 'user', entity_id: user.id, entity_number: user.username, action: active ? 'enable' : 'disable' });
    }
    return publicUser(userById(db, user.id));
  })();
}

// The admin sets a new password for a staff user; their open sessions end.
function setUserPassword(db, id, payload = {}) {
  return db.transaction(() => {
    const user = editableUser(db, id);
    if (user.is_admin) throw bad('Change the admin password from your own account');
    const password = cleanPassword(payload.password, user.username);
    db.prepare(`
      UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(hashPassword(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    audit.record(db, { entity_type: 'user', entity_id: user.id, entity_number: user.username, action: 'password_reset' });
    return publicUser(userById(db, user.id));
  })();
}

// A user changes their own password. Other browsers signed in as them are
// signed out; this one stays.
function changeOwnPassword(db, userId, token, payload = {}) {
  const user = editableUser(db, userId);
  if (!verifyPassword(String(payload.current_password ?? ''), user.password_hash)) {
    throw bad('Current password is wrong');
  }
  const password = cleanPassword(payload.new_password, user.username);
  if (verifyPassword(password, user.password_hash)) throw bad('Choose a password different from the current one');
  db.transaction(() => {
    db.prepare(`
      UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?
    `).run(hashPassword(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(user.id, tokenId(token));
  })();
  return publicUser(userById(db, user.id));
}

// The admin's recovery key resets a forgotten admin password, only at the
// main computer (the route checks the address). It looks like
// NF-7KQM-4XTA-9PLW-2HRC: 16 characters from Crockford's base 32, 80 random
// bits. Only a scrypt hash is kept. A new key is "unconfirmed" until the
// admin ticks that they saved it; until then the app keeps offering a fresh
// one, but the stored key already works.
const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_CHARS = 16;
const MAX_KEY_ATTEMPTS = 5;
const KEY_LOCK_MINUTES = 15;
const keyFailures = new Map();

function newRecoveryKey() {
  const chars = [...crypto.randomBytes(KEY_CHARS)].map((byte) => KEY_ALPHABET[byte & 31]).join('');
  return `NF-${chars.match(/.{4}/g).join('-')}`;
}

// What the admin typed, as the 16 characters the hash was made from. Case,
// dashes and spaces do not matter, and O, I and L read as 0, 1 and 1.
function normalizeRecoveryKey(value) {
  let chars = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (chars.length === KEY_CHARS + 2 && chars.startsWith('NF')) chars = chars.slice(2);
  chars = chars.replace(/O/g, '0').replace(/[IL]/g, '1');
  return chars.length === KEY_CHARS && [...chars].every((char) => KEY_ALPHABET.includes(char)) ? chars : '';
}

function adminUser(db) {
  return db.prepare('SELECT * FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
}

function storeRecoveryKey(db, userId) {
  const key = newRecoveryKey();
  db.prepare(`
    UPDATE users SET recovery_key_hash = ?, recovery_key_created_at = datetime('now'), recovery_key_confirmed = 0 WHERE id = ?
  `).run(hashPassword(normalizeRecoveryKey(key)), userId);
  return key;
}

function recoveryKeyStatus(db, userId) {
  const user = editableUser(db, userId);
  return {
    exists: Boolean(user.recovery_key_hash && user.recovery_key_confirmed),
    created_at: user.recovery_key_confirmed ? user.recovery_key_created_at : null,
    uses: user.recovery_key_uses || 0,
  };
}

// A new key for the signed-in admin. Replacing a saved key needs the
// admin's password, so a session left open cannot be used to take one.
function makeRecoveryKey(db, userId, payload = {}) {
  const user = editableUser(db, userId);
  if (!user.is_admin) throw bad('Only the admin has a recovery key');
  if (user.recovery_key_hash && user.recovery_key_confirmed
    && !verifyPassword(String(payload.current_password ?? ''), user.password_hash)) {
    throw bad('Your password is wrong');
  }
  return { recovery_key: storeRecoveryKey(db, user.id) };
}

function confirmRecoveryKey(db, userId) {
  return db.transaction(() => {
    const user = editableUser(db, userId);
    if (!user.is_admin || !user.recovery_key_hash) throw bad('There is no recovery key to save');
    if (!user.recovery_key_confirmed) {
      db.prepare('UPDATE users SET recovery_key_confirmed = 1 WHERE id = ?').run(user.id);
      audit.record(db, { entity_type: 'user', entity_id: user.id, entity_number: user.username, action: 'recovery_key', remarks: 'New recovery key saved' });
    }
    return publicUser(userById(db, user.id));
  })();
}

// Help → Reset admin password at the main computer. Five wrong keys lock the
// form for 15 minutes. On success the admin is signed in, other sessions
// end, and the old key is replaced by a new one to save.
function resetWithRecoveryKey(db, payload = {}, { now = Date.now() } = {}) {
  if (isLocked(keyFailures, 'key', now)) throw bad(`Too many wrong keys. Try again in ${KEY_LOCK_MINUTES} minutes.`);
  const admin = adminUser(db);
  const typed = normalizeRecoveryKey(payload.recovery_key);
  const keyOk = verifyPassword(typed || 'none', admin?.recovery_key_hash || DUMMY_HASH);
  if (!admin || !admin.recovery_key_hash || !typed || !keyOk) {
    const locked = noteFailure(keyFailures, 'key', { limit: MAX_KEY_ATTEMPTS, lockMinutes: KEY_LOCK_MINUTES, now });
    if (locked) throw bad(`Too many wrong keys. Try again in ${KEY_LOCK_MINUTES} minutes.`);
    const left = MAX_KEY_ATTEMPTS - keyFailures.get('key').count;
    throw bad(`That recovery key doesn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
  }
  const password = cleanPassword(payload.new_password, admin.username);
  keyFailures.delete('key');
  return db.transaction(() => {
    db.prepare(`
      UPDATE users SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL, is_active = 1,
        recovery_key_uses = recovery_key_uses + 1, last_login_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(hashPassword(password), admin.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id);
    for (const key of [...failures.keys()]) if (key.endsWith(`|${admin.username}`)) failures.delete(key);
    accountFailures.delete(admin.username);
    const recoveryKey = storeRecoveryKey(db, admin.id);
    // No one is signed in yet, so the entry is recorded as the admin.
    runWithUser(admin, () => audit.record(db, {
      entity_type: 'user', entity_id: admin.id, entity_number: admin.username, action: 'password_reset',
      remarks: 'Admin password reset with the recovery key at the main computer',
    }));
    return { user: publicUser(userById(db, admin.id)), token: createSession(db, admin.id), recovery_key: recoveryKey };
  })();
}

// For `npm run reset-admin` on the main computer: a one-time password the
// admin must change at the next sign-in.
function resetAdminPassword(db) {
  const admin = db.prepare('SELECT * FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
  if (!admin) return null;
  const password = crypto.randomBytes(9).toString('base64url');
  db.transaction(() => {
    db.prepare(`
      UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL,
        is_active = 1, updated_at = datetime('now') WHERE id = ?
    `).run(hashPassword(password), admin.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id);
  })();
  return { username: admin.username, password };
}

module.exports = {
  IDLE_HOURS,
  hashPassword,
  verifyPassword,
  publicUser,
  setupNeeded,
  setupAdmin,
  login,
  sourceOf,
  userForToken,
  logout,
  listUsers,
  createUser,
  updateUser,
  setUserPassword,
  changeOwnPassword,
  resetAdminPassword,
  normalizeRecoveryKey,
  recoveryKeyStatus,
  makeRecoveryKey,
  confirmRecoveryKey,
  resetWithRecoveryKey,
};
