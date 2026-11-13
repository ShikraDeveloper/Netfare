'use strict';

// A backup that fails or grows old must not go unnoticed: the admin's Today
// box says so, and Settings shows when the last backup was made.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-backup-status-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;
process.env.LEDGERLY_AUTO_BACKUP_HOURS = '24';

const db = require('../server/db');
const backup = require('../server/services/backup');
const { pendingList } = require('../server/services/reports/pending');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const admin = { is_admin: 1 };
const staff = { is_admin: 0, permissions: JSON.stringify({ sales: 'edit', banking: 'edit' }) };
const backupGroup = (user) => pendingList(db, user).groups.find((group) => group.key === 'backup');

test('no backup yet, a fresh one, and one more than two days old', () => {
  assert.match(backupGroup(admin).items[0].label, /No backup yet/);
  assert.equal(backupGroup(staff), undefined, 'staff cannot act on backups, so they are not told');

  const made = backup.createDatabaseBackup(db, 'manual');
  assert.equal(backupGroup(admin), undefined, 'a backup from today needs no warning');
  assert.equal(backup.backupStatus().latest_at, made.created_at);

  const old = (Date.now() - 3 * 86_400_000) / 1000;
  fs.utimesSync(made.path, old, old);
  const item = backupGroup(admin).items[0];
  assert.match(item.label, /Last backup 3 days ago/);
  assert.equal(item.href, '#/settings');
});

test('a failed automatic backup is shown until one works again', () => {
  const dir = backup.backupDir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'not a folder'); // the backup folder cannot be made
  const timer = backup.startAutoBackup(db, { hours: 24 });
  clearInterval(timer);
  const status = backup.backupStatus();
  assert.ok(status.failure, 'the failure is remembered');
  assert.match(backupGroup(admin).items[0].label, /Automatic backup failed/);

  fs.rmSync(dir, { force: true });
  const again = backup.startAutoBackup(db, { hours: 24 });
  clearInterval(again);
  assert.equal(backup.backupStatus().failure, null, 'a backup that works clears it');
  assert.equal(backupGroup(admin), undefined);
});
