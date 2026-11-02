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
  assert.throws(() => updates.setFeedUrl(db, 'http://example.com/latest.json'), /https:\/\//);
  assert.throws(() => updates.setFeedUrl(db, 'https://user:pw@example.com/latest.json'), /user name or password/);
  assert.throws(() => updates.setFeedUrl(db, 'not a url'), /not a web address/);
  assert.equal(updates.setFeedUrl(db, 'http://127.0.0.1:9/latest.json'), 'http://127.0.0.1:9/latest.json');
  assert.equal(updates.setFeedUrl(db, ''), '');
});

test('status: off without an address, then available, up to date or a clear error', async () => {
  assert.deepEqual(
    { enabled: (await updates.status(db)).enabled, available: (await updates.status(db)).available },
    { enabled: false, available: false },
  );
  updates.setFeedUrl(db, 'https://updates.example.com/latest.json');
  const newer = await updates.status(db, { force: true, fetchImpl: feedResponse({ version: '99.0.0', notes: ['Big release'] }) });
  assert.equal(newer.available, true);
  assert.equal(newer.latest.version, '99.0.0');
  assert.equal(newer.current_version, require('../package.json').version);
  const cachedResult = await updates.status(db, { fetchImpl: () => { throw new Error('must not fetch again today'); } });
  assert.equal(cachedResult.available, true, 'checked at most once a day');
  const same = await updates.status(db, { force: true, fetchImpl: feedResponse({ version: updates.CURRENT_VERSION }) });
  assert.equal(same.available, false);
  const broken = await updates.status(db, { force: true, fetchImpl: feedResponse('<html>', 200) });
  assert.equal(broken.available, false);
  assert.match(broken.error, /not valid JSON/);
  const missing = await updates.status(db, { force: true, fetchImpl: feedResponse('', 404) });
  assert.match(missing.error, /answered 404/);
});

test('the release script writes a feed the app accepts', () => {
  const feed = buildFeed({ base: 'https://downloads.example.com/netfare', notes: ['Rights per user'], page: 'https://example.com/download' }, '2026-11-02');
  assert.deepEqual(feed, {
    version: require('../package.json').version,
    released: '2026-11-02',
    notes: ['Rights per user'],
    downloads: { 'mac-arm64': `https://downloads.example.com/netfare/Netfare-${require('../package.json').version}-arm64.dmg` },
    page: 'https://example.com/download',
  });
  assert.equal(updates.parseFeed(feed).version, feed.version);
  assert.throws(() => buildFeed({ base: 'http://insecure.example', notes: ['x'] }), /https/);
  assert.throws(() => buildFeed({ base: 'https://ok.example', notes: [] }), /--note/);
});
