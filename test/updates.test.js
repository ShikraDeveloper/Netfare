'use strict';

// New-version notice: comparing versions, reading latest.json and the
// update address the admin sets.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-updates-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;
delete process.env.NETFARE_UPDATE_FEED;

const db = require('../server/db');
const updates = require('../server/services/updates');
const { buildFeed } = require('../scripts/release-feed');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const feedResponse = (body, status = 200) => async () => ({ ok: status === 200, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('versions compare by number, not by text', () => {
  assert.equal(updates.isNewer('1.0.1', '1.0.0'), true);
  assert.equal(updates.isNewer('1.10.0', '1.9.9'), true);
  assert.equal(updates.isNewer('2.0.0', '10.0.0'), false);
  assert.equal(updates.isNewer('1.0.0', '1.0.0'), false);
  assert.equal(updates.isNewer('v1.2', '1.0.0'), false, 'a malformed version never counts as newer');
});

test('latest.json is checked; bad links and odd fields are dropped', () => {
  const feed = updates.parseFeed({
    version: '1.2.0',
    released: '2026-12-01',
    notes: ['  Rights per user  ', '', 42, 'x'.repeat(400)],
    downloads: { [`mac-${os.arch()}`]: 'https://example.com/Netfare-1.2.0.dmg', 'mac-x64': 'http://evil.example/a.dmg', 'BAD KEY': 'https://example.com/b' },
    page: 'javascript:alert(1)',
  });
  assert.equal(feed.version, '1.2.0');
  assert.deepEqual(feed.notes.map((note) => note.length), [15, 300]);
  if (process.platform === 'darwin') assert.equal(feed.download_url, 'https://example.com/Netfare-1.2.0.dmg');
  assert.equal(feed.page, '', 'a script link is never kept');
  assert.throws(() => updates.parseFeed({ version: 'soon' }), /no valid version/);
});

test('the update address must be https (or this computer for testing)', () => {
  assert.throws(() => updates.setFeed(db, { feed_url: 'http://example.com/latest.json' }), /https:\/\//);
  assert.throws(() => updates.setFeed(db, { feed_url: 'https://user:pw@example.com/latest.json' }), /user name or password/);
  assert.throws(() => updates.setFeed(db, { feed_url: 'not a url' }), /not a web address/);
  assert.equal(updates.setFeed(db, { feed_url: 'http://127.0.0.1:9/latest.json' }), 'http://127.0.0.1:9/latest.json');
  assert.equal(updates.setFeed(db, { feed_url: '' }), '', 'blank means Netfare on GitHub');
  assert.equal(updates.feedUrl(db), updates.DEFAULT_FEED);
  assert.match(updates.DEFAULT_FEED, /^https:\/\/github\.com\/ShikraDeveloper\/Netfare\/releases\/latest\/download\/latest\.json$/);
  assert.equal(updates.setFeed(db, { enabled: false }), 'off');
  assert.equal(updates.feedUrl(db), '', 'off means no checks');
});

test('status: off, then available, up to date or a clear error', async () => {
  updates.setFeed(db, { enabled: false });
  assert.deepEqual(
    { enabled: (await updates.status(db)).enabled, available: (await updates.status(db)).available },
    { enabled: false, available: false },
  );
  updates.setFeed(db, { feed_url: 'https://updates.example.com/latest.json' });
  const newer = await updates.status(db, { force: true, fetchImpl: feedResponse({ version: '99.0.0', notes: ['Big release'] }) });
  assert.equal(newer.available, true);
  assert.equal(newer.latest.version, '99.0.0');
  assert.equal(newer.current_version, require('../package.json').version);
  const cachedResult = await updates.status(db, { fetchImpl: () => { throw new Error('must not fetch again yet'); } });
  assert.equal(cachedResult.available, true, 'not fetched again within a few hours');
  const same = await updates.status(db, { force: true, fetchImpl: feedResponse({ version: updates.CURRENT_VERSION }) });
  assert.equal(same.available, false);
  const broken = await updates.status(db, { force: true, fetchImpl: feedResponse('<html>', 200) });
  assert.equal(broken.available, false);
  assert.match(broken.error, /not valid JSON/);
  const missing = await updates.status(db, { force: true, fetchImpl: feedResponse('', 404) });
  assert.match(missing.error, /answered 404/);
});

test('an open app sees a new release within hours, and a failed check is retried soon', async () => {
  updates.setFeed(db, { feed_url: 'https://updates.example.com/latest.json' });
  const hour = 60 * 60 * 1000;
  const start = Date.now();
  const before = await updates.status(db, { now: start, fetchImpl: feedResponse({ version: updates.CURRENT_VERSION }) });
  assert.equal(before.available, false);
  const released = feedResponse({ version: '99.0.0' });
  const soon = await updates.status(db, { now: start + hour, fetchImpl: released });
  assert.equal(soon.available, false, 'kept for a while');
  const later = await updates.status(db, { now: start + 3 * hour, fetchImpl: released });
  assert.equal(later.available, true, 'a release published while the app was open shows up');

  updates.setFeed(db, { feed_url: 'https://other.example.com/latest.json' });
  const offline = await updates.status(db, { now: start, fetchImpl: () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  assert.match(offline.error, /ENOTFOUND/);
  const back = await updates.status(db, { now: start + 16 * 60 * 1000, fetchImpl: released });
  assert.equal(back.available, true, 'a failed check does not stick for hours');
});

test('the release script writes a feed the app accepts', () => {
  const { version } = require('../package.json');
  const feed = buildFeed({ notes: ['Rights per user'] }, '2026-11-02');
  assert.deepEqual(feed, {
    version,
    released: '2026-11-02',
    notes: ['Rights per user'],
    downloads: {
      'mac-arm64': `https://github.com/ShikraDeveloper/Netfare/releases/download/v${version}/Netfare-mac-arm64.dmg`,
      'mac-x64': `https://github.com/ShikraDeveloper/Netfare/releases/download/v${version}/Netfare-mac-x64.dmg`,
      'windows-x64': `https://github.com/ShikraDeveloper/Netfare/releases/download/v${version}/Netfare-windows-x64.exe`,
    },
    page: `https://github.com/ShikraDeveloper/Netfare/releases/tag/v${version}`,
  });
  assert.equal(updates.parseFeed(feed).version, version);
  const elsewhere = buildFeed({ base: 'https://downloads.example.com/netfare', notes: ['x'] });
  assert.equal(elsewhere.downloads['windows-x64'], 'https://downloads.example.com/netfare/Netfare-windows-x64.exe');
  assert.throws(() => buildFeed({ base: 'http://insecure.example', notes: ['x'] }), /https/);
  assert.throws(() => buildFeed({ notes: [] }), /--note/);
});

test('GitHub redirects are followed only on https, and an unpublished release is explained', async () => {
  updates.setFeed(db, { feed_url: '' });
  const calls = [];
  const github = async (url) => {
    calls.push(url);
    if (url === updates.DEFAULT_FEED) return { status: 302, ok: false, headers: new Headers({ location: 'https://objects.githubusercontent.com/feed' }) };
    return { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify({ version: '99.2.0', notes: ['x'] }) };
  };
  const followed = await updates.status(db, { force: true, fetchImpl: github });
  assert.equal(followed.latest.version, '99.2.0');
  assert.deepEqual(calls, [updates.DEFAULT_FEED, 'https://objects.githubusercontent.com/feed']);

  const downgrade = async () => ({ status: 302, ok: false, headers: new Headers({ location: 'http://evil.example/feed' }) });
  assert.match((await updates.status(db, { force: true, fetchImpl: downgrade })).error, /away from https/);
  const unpublished = async () => ({ status: 404, ok: false, headers: new Headers(), text: async () => '' });
  assert.match((await updates.status(db, { force: true, fetchImpl: unpublished })).error, /No Netfare release has been published yet/);
});
