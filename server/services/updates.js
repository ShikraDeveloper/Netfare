'use strict';

// "A new version is available" for the admin. Netfare reads a small
// latest.json, by default from its GitHub releases (DEFAULT_FEED), or from
// another address the admin sets in Settings; the admin can also turn it off:
//   { "version": "1.1.0", "released": "2026-12-01",
//     "notes": ["What changed", "…"],
//     "downloads": { "mac-arm64": "https://…/Netfare-1.1.0-arm64.dmg" },
//     "page": "https://…/download" }
// The app is not code-signed, so it cannot replace itself: the admin downloads
// the new version and replaces the app. The books are not inside the app.

const os = require('os');
const { bad } = require('../util');
const { version: CURRENT_VERSION } = require('../../package.json');

const OFF = 'off';
// NETFARE_UPDATE_FEED replaces the default; tests set it to "off" so they
// never reach the internet.
const DEFAULT_FEED = process.env.NETFARE_UPDATE_FEED
  || 'https://github.com/ShikraDeveloper/Netfare/releases/latest/download/latest.json';
const MAX_REDIRECTS = 5;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_FEED_BYTES = 64 * 1024;
let cached = null;

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(candidate, current = CURRENT_VERSION) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function isLoopbackHost(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
}

// https only; plain http is accepted for this computer (testing a feed).
function cleanUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw bad(`${label} is not a web address`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw bad(`${label} must start with https://`);
  }
  if (url.username || url.password) throw bad(`${label} cannot contain a user name or password`);
  return url.href;
}

// settings.update_feed: '' = Netfare's GitHub releases, 'off' = no checks,
// anything else = the admin's own address.
function storedFeed(db) {
  return db.prepare('SELECT update_feed FROM settings WHERE id = 1').get()?.update_feed || '';
}

function feedUrl(db) {
  const stored = storedFeed(db);
  if (stored === OFF) return '';
  return stored || (DEFAULT_FEED === OFF ? '' : DEFAULT_FEED);
}

function setFeed(db, { enabled = true, feed_url: address = '' } = {}) {
  const text = String(address || '').trim();
  const value = !enabled ? OFF : (text ? cleanUrl(text, 'The update address') : '');
  db.prepare("UPDATE settings SET update_feed = ?, updated_at = datetime('now') WHERE id = 1").run(value);
  cached = null;
  return value;
}

function platformKey() {
  if (process.platform === 'darwin') return `mac-${os.arch()}`;
  if (process.platform === 'win32') return `windows-${os.arch()}`;
  return `${process.platform}-${os.arch()}`;
}

// Reads and checks latest.json. Anything odd in it is refused, never shown.
function parseFeed(data) {
  if (!data || typeof data !== 'object') throw new Error('The update file is not valid');
  if (!parseVersion(data.version)) throw new Error('The update file has no valid version');
  const notes = (Array.isArray(data.notes) ? data.notes : [data.notes])
    .filter((note) => typeof note === 'string' && note.trim())
    .slice(0, 30)
    .map((note) => note.trim().slice(0, 300));
  const downloads = {};
  for (const [key, url] of Object.entries(data.downloads || {})) {
    if (/^[a-z0-9-]{1,30}$/.test(key)) {
      try { downloads[key] = cleanUrl(url, 'A download'); } catch { /* skip a bad link */ }
    }
  }
  let page = '';
  try { page = data.page ? cleanUrl(data.page, 'The download page') : ''; } catch { page = ''; }
  return {
    version: data.version.trim(),
    released: /^\d{4}-\d{2}-\d{2}$/.test(String(data.released || '')) ? data.released : '',
    notes,
    download_url: downloads[platformKey()] || page,
    page,
  };
}

// GitHub's "latest" link redirects to its file servers; every hop must
// stay on https.
async function fetchFeed(url, fetchImpl = fetch) {
  let target = url;
  let response;
  for (let hop = 0; ; hop += 1) {
    response = await fetchImpl(target, { signal: AbortSignal.timeout(8000), redirect: 'manual', headers: { Accept: 'application/json' } });
    const location = response.status >= 300 && response.status < 400 ? response.headers?.get('location') : null;
    if (!location) break;
    if (hop >= MAX_REDIRECTS) throw new Error('The update address redirects too many times');
    target = new URL(location, target).href;
    if (!target.startsWith('https://')) throw new Error('The update address redirected away from https');
  }
  if (response.status === 404 && url === DEFAULT_FEED) throw new Error('No Netfare release has been published yet');
  if (!response.ok) throw new Error(`The update address answered ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) throw new Error('The update file is too large');
  try {
    return parseFeed(JSON.parse(text));
  } catch (error) {
    throw new Error(error instanceof SyntaxError ? 'The update file is not valid JSON' : error.message);
  }
}

// The admin's update status, checked at most once a day unless `force`.
async function status(db, { force = false, fetchImpl } = {}) {
  const url = feedUrl(db);
  const stored = storedFeed(db);
  const base = {
    current_version: CURRENT_VERSION,
    feed_url: stored === OFF ? '' : stored,
    default_feed: DEFAULT_FEED,
    platform: platformKey(),
  };
  if (!url) return { ...base, enabled: false, available: false };
  const fresh = cached && cached.url === url && Date.now() - cached.at < CHECK_EVERY_MS;
  if (!fresh || force) {
    try {
      const latest = await fetchFeed(url, fetchImpl);
      cached = { url, at: Date.now(), latest, error: '' };
    } catch (error) {
      cached = { url, at: Date.now(), latest: null, error: error.message || 'The update check failed' };
    }
  }
  const { latest, error } = cached;
  return {
    ...base,
    enabled: true,
    checked_at: new Date(cached.at).toISOString(),
    error,
    available: Boolean(latest && isNewer(latest.version)),
    latest,
  };
}

module.exports = {
  CURRENT_VERSION,
  DEFAULT_FEED,
  isNewer,
  parseFeed,
  feedUrl,
  setFeed,
  status,
};
