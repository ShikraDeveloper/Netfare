'use strict';

// Sign-in, first-run admin setup, sign-out, changing your own password and
// the admin's recovery key.

const router = require('express').Router();
const db = require('../db');
const auth = require('../services/auth');
const { isLoopback } = require('../network');
const { runWithUser } = require('../request-context');

// Cookies are shared by every port on a host, so the name carries the port:
// a test copy on another port never signs you out of the real one.
const COOKIE = `netfare_session_${Number(process.env.PORT) || 4173}`;
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function readToken(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return '';
}

function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

router.get('/status', (req, res) => {
  const user = auth.userForToken(db, readToken(req));
  res.json({ setup_needed: auth.setupNeeded(db), user: auth.publicUser(user) });
});

router.post('/setup', (req, res) => {
  const { user, token } = auth.setupAdmin(db, req.body);
  setCookie(res, token);
  res.status(201).json({ user });
});

router.post('/login', (req, res) => {
  const { user, token } = auth.login(db, req.body, { address: req.socket.remoteAddress });
  setCookie(res, token);
  res.json({ user });
});

router.post('/logout', (req, res) => {
  auth.logout(db, readToken(req));
  clearCookie(res);
  res.json({ ok: true });
});

router.post('/password', (req, res) => {
  const token = readToken(req);
  const user = auth.userForToken(db, token);
  if (!user) return res.status(401).json({ error: 'Sign in again' });
  res.json({ user: auth.changeOwnPassword(db, user.id, token, req.body) });
});

// The admin's recovery key. Reset works only at the main computer: the
// request must come from this computer itself, never the office network.
router.get('/recovery', (req, res) => {
  res.json({ main_computer: isLoopback(req.socket.remoteAddress) });
});

router.post('/recovery/reset', (req, res) => {
  if (!isLoopback(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'Reset the admin password at the main computer' });
  }
  const { user, token, recovery_key } = auth.resetWithRecoveryKey(db, req.body);
  setCookie(res, token);
  res.json({ user, recovery_key });
});

function signedInAdmin(req, res) {
  const user = auth.userForToken(db, readToken(req));
  if (!user) {
    res.status(401).json({ error: 'Sign in to continue', code: 'auth_required' });
    return null;
  }
  if (!user.is_admin || user.must_change_password) {
    res.status(403).json({ error: 'Only the admin can do this' });
    return null;
  }
  return user;
}

router.get('/recovery-key', (req, res) => {
  const user = signedInAdmin(req, res);
  if (user) res.json(auth.recoveryKeyStatus(db, user.id));
});

router.post('/recovery-key', (req, res) => {
  const user = signedInAdmin(req, res);
  if (user) res.json(auth.makeRecoveryKey(db, user.id, req.body));
});

router.post('/recovery-key/confirm', (req, res) => {
  const user = signedInAdmin(req, res);
  if (user) runWithUser(user, () => res.json({ user: auth.confirmRecoveryKey(db, user.id) }));
});

module.exports = { router, readToken };
