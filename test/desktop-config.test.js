'use strict';

// Desktop app settings (desktop/config.js): the first-run choice and the
// office computer address.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const config = require('../desktop/config');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'netfare-desktop-test-'));

after(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

test('the books live in a data folder inside the app folder', () => {
  assert.equal(config.dataDir('/Users/x/Library/Application Support/Netfare'), '/Users/x/Library/Application Support/Netfare/data');
});

test('the first-run choice is saved, read back and can be cleared', () => {
  assert.equal(config.readConfig(userData), null, 'nothing chosen yet');
  config.writeConfig(userData, { mode: 'main' });
  assert.deepEqual(config.readConfig(userData), { mode: 'main' });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(userData, 'desktop.json')).mode & 0o077, 0, 'owner-only file');
  }
  config.writeConfig(userData, { mode: 'connect', office_url: '192.168.1.10' });
  assert.deepEqual(config.readConfig(userData), { mode: 'connect', office_url: 'http://192.168.1.10:4173' });
  fs.writeFileSync(path.join(userData, 'desktop.json'), '{ broken');
  assert.equal(config.readConfig(userData), null, 'a broken file asks again');
  config.clearConfig(userData);
  assert.equal(config.readConfig(userData), null);
});

test('office addresses are cleaned to an origin with the Netfare port', () => {
  assert.equal(config.normalizeOfficeUrl('192.168.1.10'), 'http://192.168.1.10:4173');
  assert.equal(config.normalizeOfficeUrl(' office-mac.local '), 'http://office-mac.local:4173');
  assert.equal(config.normalizeOfficeUrl('http://office-mac.tail1234.ts.net:4173/#/invoices'), 'http://office-mac.tail1234.ts.net:4173');
  assert.equal(config.normalizeOfficeUrl('100.70.1.2:5000'), 'http://100.70.1.2:5000');
  assert.equal(config.normalizeOfficeUrl('https://books.example.test'), 'https://books.example.test');
  for (const bad of ['', 'ftp://office', 'http://user:pass@office:4173', 'file:///etc/passwd', 'not a host!']) {
    assert.throws(() => config.normalizeOfficeUrl(bad), Error, bad);
  }
});

test('the window stays on Netfare pages', () => {
  assert.equal(config.isSameOrigin('http://127.0.0.1:4173/#/bills', 'http://127.0.0.1:4173'), true);
  assert.equal(config.isSameOrigin('http://127.0.0.1:4174/', 'http://127.0.0.1:4173'), false);
  assert.equal(config.isSameOrigin('https://evil.example/', 'http://127.0.0.1:4173'), false);
  assert.equal(config.isSameOrigin('nonsense', 'http://127.0.0.1:4173'), false);
});

test('a restore request rides on the restart and is dropped from the next one', () => {
  const argv = ['/Applications/Netfare.app/Contents/MacOS/Netfare', '--inspect=0'];
  assert.equal(config.restoreSource(argv), null);
  const restart = config.relaunchArgs(argv, '/Users/x/backups/netfare-1.db');
  assert.deepEqual(restart, ['--inspect=0', '--restore-from=/Users/x/backups/netfare-1.db']);
  assert.equal(config.restoreSource(['exe', ...restart]), '/Users/x/backups/netfare-1.db');
  assert.deepEqual(config.relaunchArgs(['exe', ...restart]), ['--inspect=0'], 'Change setup does not restore again');
});

test('a document PDF is named after the page, and a share opens only WhatsApp or email', () => {
  assert.equal(config.pdfName('INV-2026-0014 · Netfare'), 'INV-2026-0014.pdf');
  assert.equal(config.pdfName('../../etc/passwd'), 'etc-passwd.pdf', 'no folders in the name');
  assert.equal(config.pdfName(''), 'Netfare.pdf');
  assert.equal(config.isShareUrl('https://wa.me/971501234567?text=Hello'), true);
  assert.equal(config.isShareUrl('https://wa.me/?text=Hello'), true);
  assert.equal(config.isShareUrl('mailto:a@b.ae?subject=x'), true);
  for (const url of ['https://evil.example/?text=', 'file:///etc/passwd', 'javascript:alert(1)', 'https://wa.me.evil.example/1?text=']) {
    assert.equal(config.isShareUrl(url), false, url);
  }
});
