'use strict';

// Which books folder the server and scripts open (server/data-dir.js). Pure
// checks only: nothing here opens a database or looks at the real folders.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { REPO_DATA_DIR, desktopDataDir, resolveDataDir } = require('../server/data-dir');

const home = '/Users/someone';
const macBooks = path.join(home, 'Library', 'Application Support', 'Netfare', 'data');

test('the desktop app keeps its books in the usual place on each system', () => {
  assert.equal(desktopDataDir({ platform: 'darwin', home, env: {} }), macBooks);
  assert.equal(desktopDataDir({ platform: 'win32', home, env: { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' } }),
    path.join('C:\\Users\\someone\\AppData\\Roaming', 'Netfare', 'data'));
  assert.equal(desktopDataDir({ platform: 'linux', home, env: {} }), path.join(home, '.config', 'Netfare', 'data'));
});

test('npm start refuses the old data/ folder once the desktop app holds the books', () => {
  const desktopHasBooks = (file) => file === path.join(macBooks, 'accounting.db');
  assert.throws(() => resolveDataDir({ env: {}, exists: desktopHasBooks, platform: 'darwin', home }), (error) => {
    assert.equal(error.code, 'NETFARE_DESKTOP_BOOKS');
    assert.match(error.message, /books are in the Netfare desktop app/);
    assert.ok(error.message.includes(macBooks) && error.message.includes(REPO_DATA_DIR));
    return true;
  });
  assert.equal(resolveDataDir({ env: { NETFARE_USE_REPO_DATA: '1' }, exists: desktopHasBooks, platform: 'darwin', home }), REPO_DATA_DIR, 'on purpose');
  assert.equal(resolveDataDir({ env: { LEDGERLY_DATA_DIR: '/tmp/books' }, exists: desktopHasBooks, platform: 'darwin', home }), path.resolve('/tmp/books'), 'a named folder always wins');
  assert.equal(resolveDataDir({ env: {}, exists: () => false, platform: 'darwin', home }), REPO_DATA_DIR, 'no desktop books: the old folder as before');
});
