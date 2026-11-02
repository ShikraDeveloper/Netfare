'use strict';

// Sign-in, first-run admin setup, sign-out and changing your own password.

const router = require('express').Router();
const db = require('../db');
const auth = require('../services/auth');

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
  const { user, token } = auth.login(db, req.body);
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

module.exports = { router, readToken };
