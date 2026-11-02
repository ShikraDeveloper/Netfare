'use strict';

// Logins for the agency's staff. The first user is the admin; the admin adds
// the others. Passwords are stored as scrypt hashes, and a session keeps only
// a SHA-256 of the random token held in the browser cookie.

const crypto = require('crypto');
const { bad, notFound } = require('../util');
const audit = require('./audit');

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

function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
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

function login(db, payload = {}) {
  const username = String(payload.username ?? '').trim().toLowerCase();
  const password = String(payload.password ?? '');
  const user = username ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
  if (!user) {
    verifyPassword(password, DUMMY_HASH);
    throw bad('Wrong username or password');
  }
  const locked = db.prepare("SELECT ? > datetime('now') AS locked").get(user.locked_until || '').locked;
  if (locked) throw bad(`Too many wrong attempts. Try again in ${LOCK_MINUTES} minutes.`);
  if (!verifyPassword(password, user.password_hash)) {
    const attempts = user.failed_attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare(`UPDATE users SET failed_attempts = 0, locked_until = datetime('now', ?) WHERE id = ?`)
        .run(`+${LOCK_MINUTES} minutes`, user.id);
      throw bad(`Too many wrong attempts. Try again in ${LOCK_MINUTES} minutes.`);
    }
    db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, user.id);
    throw bad('Wrong username or password');
  }
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
    const info = db.prepare('INSERT INTO users (username, full_name, password_hash) VALUES (?, ?, ?)')
      .run(username, fullName, hashPassword(password));
    audit.record(db, { entity_type: 'user', entity_id: info.lastInsertRowid, entity_number: username, action: 'create', remarks: `Added ${fullName}` });
    return publicUser(userById(db, info.lastInsertRowid));
  })();
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
    db.prepare(`UPDATE users SET full_name = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(fullName, active, user.id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
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
  userForToken,
  logout,
  listUsers,
  createUser,
  updateUser,
  setUserPassword,
  changeOwnPassword,
  resetAdminPassword,
};
