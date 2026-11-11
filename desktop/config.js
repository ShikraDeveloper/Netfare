'use strict';

// Desktop app settings, kept apart from Electron so they can be tested with
// plain Node. The choice made on first run lives in desktop.json in the
// app's folder (~/Library/Application Support/Netfare on a Mac):
//   { "mode": "main" }                                  this computer keeps the books
//   { "mode": "connect", "office_url": "http://…:4173" } open the office computer

const fs = require('fs');
const net = require('net');
const path = require('path');

const DEFAULT_PORT = 4173;
const CONFIG_FILE = 'desktop.json';

function dataDir(userDataDir) {
  return path.join(userDataDir, 'data');
}

function readConfig(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, CONFIG_FILE), 'utf8'));
    if (parsed.mode === 'main') return { mode: 'main' };
    if (parsed.mode === 'connect') return { mode: 'connect', office_url: normalizeOfficeUrl(parsed.office_url) };
  } catch {
    // No choice yet, or an unreadable file: ask again.
  }
  return null;
}

function writeConfig(userDataDir, config) {
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const file = path.join(userDataDir, CONFIG_FILE);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// "Restore from backup…" restarts the app with --restore-from=<file>, so the
// books are replaced before the Netfare server opens them.
const RESTORE_FLAG = '--restore-from=';

function restoreSource(argv) {
  const arg = argv.find((value) => String(value).startsWith(RESTORE_FLAG));
  return arg ? arg.slice(RESTORE_FLAG.length) : null;
}

// The arguments for a restart: this run's, without an old restore request.
function relaunchArgs(argv, restoreFile = null) {
  const args = argv.slice(1).filter((value) => !String(value).startsWith(RESTORE_FLAG));
  return restoreFile ? [...args, `${RESTORE_FLAG}${restoreFile}`] : args;
}

function clearConfig(userDataDir) {
  fs.rmSync(path.join(userDataDir, CONFIG_FILE), { force: true });
}

// What staff type for the office computer: "192.168.1.10", "office-mac.local",
// "http://office-mac.tail1234.ts.net:4173". Returns the origin with the
// Netfare port, or throws with a message for the setup screen.
function normalizeOfficeUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw new Error('Enter the address of the office computer');
  if (!/^[a-z]+:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That is not a computer address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Use an http:// address');
  if (url.username || url.password) throw new Error('Leave out any user name or password');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || (!net.isIP(host) && !/^[a-z0-9.-]+$/i.test(host))) throw new Error('That is not a computer address');
  if (!url.port && url.protocol === 'http:') url.port = String(DEFAULT_PORT);
  return url.origin;
}

// The app window may only show pages from Netfare itself.
function isSameOrigin(target, origin) {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
}

// A document's PDF file name: "INV-2026-0014 · Netfare" → "INV-2026-0014.pdf".
function pdfName(title) {
  const base = String(title || '').split(' · ')[0].replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60);
  return `${base || 'Netfare'}.pdf`;
}

// The only addresses a share may open: a WhatsApp chat or a new email.
function isShareUrl(url) {
  return /^https:\/\/wa\.me\/\d*\?text=/.test(String(url || '')) || /^mailto:/.test(String(url || ''));
}

module.exports = {
  pdfName,
  isShareUrl,
  restoreSource,
  relaunchArgs,
  DEFAULT_PORT,
  dataDir,
  readConfig,
  writeConfig,
  clearConfig,
  normalizeOfficeUrl,
  isSameOrigin,
};
