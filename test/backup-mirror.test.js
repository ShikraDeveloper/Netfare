'use strict';

// The second copy of backups in another folder (cloud drive or USB).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-mirror-test-'));
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-mirror-place-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const backup = require('../server/services/backup');
const mirror = require('../server/services/backup-mirror');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

const copies = () => fs.readdirSync(path.join(elsewhere, mirror.SUBFOLDER)).filter((name) => name.endsWith('.db'));

test('the second place must be an existing, writable folder outside Netfare', () => {
  assert.throws(() => mirror.setFolder(db, tempDir, 'relative/folder'), /full folder path/);
  assert.throws(() => mirror.setFolder(db, tempDir, path.join(elsewhere, 'missing')), /does not exist/);
  assert.throws(() => mirror.setFolder(db, tempDir, tempDir), /outside Netfare/);
  assert.throws(() => mirror.setFolder(db, tempDir, path.join(tempDir, 'inner')), /does not exist|outside Netfare/);
  // A neighbour whose name merely starts the same is a different folder.
  const neighbour = `${tempDir}-copy`;
  fs.mkdirSync(neighbour);
  try {
    assert.equal(mirror.setFolder(db, tempDir, neighbour), neighbour);
    mirror.setFolder(db, tempDir, '');
  } finally {
    fs.rmSync(neighbour, { recursive: true, force: true });
  }
  assert.equal(mirror.setFolder(db, tempDir, elsewhere), elsewhere);
  assert.equal(mirror.status(db, tempDir).dir, elsewhere);
  assert.ok(Array.isArray(mirror.status(db, tempDir).suggestions));
});

test('every backup is copied there, and only the newest are kept', () => {
  const made = backup.createDatabaseBackup(db, 'manual');
  assert.equal(made.mirror.ok, true);
  assert.ok(copies().includes(made.name));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(elsewhere, mirror.SUBFOLDER, made.name)).mode & 0o077, 0, 'owner-only copy');
  }
  const target = path.join(elsewhere, mirror.SUBFOLDER);
  for (let i = 0; i < mirror.KEEP + 5; i += 1) {
    const file = path.join(target, `netfare-2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z-auto.db`);
    fs.writeFileSync(file, 'old');
    fs.utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1, 0, 0, i));
  }
  const next = backup.createDatabaseBackup(db, 'manual');
  assert.equal(copies().length, mirror.KEEP);
  assert.ok(copies().includes(next.name), 'the newest is kept');
  const status = mirror.status(db, tempDir);
  assert.equal(status.last_error, '');
  assert.ok(status.last_copied_at);
});

test('an unplugged drive never stops the backup, and the copy catches up later', () => {
  fs.rmSync(elsewhere, { recursive: true, force: true });
  const made = backup.createDatabaseBackup(db, 'manual');
  assert.ok(fs.existsSync(made.path), 'the backup itself is made');
  assert.equal(made.mirror.ok, false);
  assert.match(mirror.status(db, tempDir).last_error, /not reachable/);

  fs.mkdirSync(elsewhere);
  const caught = mirror.catchUp(db, backup.listBackups()[0]);
  assert.equal(caught.ok, true);
  assert.ok(copies().includes(backup.listBackups()[0].name));
  assert.equal(mirror.status(db, tempDir).last_error, '');
  assert.equal(mirror.catchUp(db, backup.listBackups()[0]), null, 'nothing to do when it is already there');

  assert.equal(mirror.setFolder(db, tempDir, ''), '');
  assert.equal(backup.createDatabaseBackup(db, 'manual').mirror, null, 'turned off: no copy');
});
