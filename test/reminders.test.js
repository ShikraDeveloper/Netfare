'use strict';

// Reminders: each user's own, or for everyone; a repeating one moves on when
// done; only the maker changes or deletes it; any signed-in user may use them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-reminders-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const reminders = require('../server/services/reminders');
const { refusal } = require('../server/permissions');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function user(name, admin = 0) {
  const id = Number(db.prepare('INSERT INTO users (username, full_name, password_hash, is_admin) VALUES (?, ?, ?, ?)')
    .run(name.toLowerCase(), name, 'x', admin).lastInsertRowid);
  return { id, full_name: name, is_admin: admin, permissions: '{}' };
}

const sara = user('Sara');
const omar = user('Omar');
const admin = user('Boss', 1);

test('each user sees their own reminders and the ones for everyone', () => {
  reminders.createReminder(db, sara, { title: 'Call Aisha', due_at: '2026-11-10T10:00' });
  reminders.createReminder(db, omar, { title: 'Bank run', due_at: '2026-11-10T09:00', for_all: true });
  assert.deepEqual(reminders.listReminders(db, sara).map((row) => row.title), ['Bank run', 'Call Aisha'], 'sorted by time');
  assert.deepEqual(reminders.listReminders(db, omar).map((row) => row.title), ['Bank run']);
});

test('a one-off reminder closes when done; a repeating one moves to its next time', () => {
  const once = reminders.createReminder(db, sara, { title: 'Once', due_at: '2026-11-09T08:00' });
  const done = reminders.doneReminder(db, sara, once.id);
  assert.equal(done.status, 'done');
  assert.equal(done.done_by, 'Sara');
  assert.ok(!reminders.listReminders(db, sara).some((row) => row.id === once.id));
  assert.ok(reminders.listReminders(db, sara, { status: 'done' }).some((row) => row.id === once.id));

  const daily = reminders.createReminder(db, sara, { title: 'Daily', due_at: '2026-11-09T09:00', repeat: 'daily' });
  assert.equal(reminders.doneReminder(db, sara, daily.id, { now: '2026-11-12T08:00' }).due_at, '2026-11-12T09:00', 'skips missed days');
  const monthly = reminders.createReminder(db, sara, { title: 'Rent', due_at: '2026-01-31T09:00', repeat: 'monthly' });
  assert.equal(reminders.doneReminder(db, sara, monthly.id, { now: '2026-01-31T10:00' }).due_at, '2026-02-28T09:00');
  const weekly = reminders.createReminder(db, sara, { title: 'Weekly', due_at: '2026-11-09T09:00', repeat: 'weekly' });
  assert.equal(reminders.doneReminder(db, sara, weekly.id, { now: '2026-11-09T09:05' }).due_at, '2026-11-16T09:00');
});

test('snooze moves the time; anyone who sees a shared reminder may mark it done', () => {
  const shared = reminders.createReminder(db, sara, { title: 'Shared', due_at: '2026-11-09T09:00', for_all: true });
  assert.equal(reminders.snoozeReminder(db, omar, shared.id, { due_at: '2026-11-09T09:10' }).due_at, '2026-11-09T09:10');
  assert.equal(reminders.doneReminder(db, omar, shared.id).done_by, 'Omar');
  assert.equal(reminders.reopenReminder(db, sara, shared.id).status, 'open');
});

test('only the maker (or the admin) changes or deletes a reminder', () => {
  const shared = reminders.createReminder(db, sara, { title: 'Mine', due_at: '2026-11-09T09:00', for_all: true });
  assert.throws(() => reminders.updateReminder(db, omar, shared.id, { title: 'Changed' }), /Only Sara/);
  assert.throws(() => reminders.deleteReminder(db, omar, shared.id), /Only Sara/);
  assert.equal(reminders.updateReminder(db, admin, shared.id, { title: 'Changed' }).title, 'Changed');
  const personal = reminders.createReminder(db, sara, { title: 'Private', due_at: '2026-11-09T09:00' });
  assert.throws(() => reminders.getReminder(db, omar, personal.id), /not found/);
  reminders.deleteReminder(db, sara, personal.id);
  assert.throws(() => reminders.getReminder(db, sara, personal.id), /not found/);
});

test('input is checked: time, repeat and the linked booking or visa', () => {
  assert.throws(() => reminders.createReminder(db, sara, { title: 'X', due_at: 'tomorrow' }), /date and time/);
  assert.throws(() => reminders.createReminder(db, sara, { title: '', due_at: '2026-11-09T09:00' }), /What is required/);
  assert.throws(() => reminders.createReminder(db, sara, { title: 'X', due_at: '2026-11-09T09:00', repeat: 'hourly' }), /repeats/);
  assert.throws(() => reminders.createReminder(db, sara, { title: 'X', due_at: '2026-11-09T09:00', link_type: 'visa', link_id: 999 }), /not found/);
});

test('staff with no rights can still use reminders', () => {
  const req = (method, url) => ({ method, path: url, query: {} });
  assert.equal(refusal(db, sara, req('GET', '/reminders')), null);
  assert.equal(refusal(db, sara, req('POST', '/reminders/1/done')), null);
  assert.equal(refusal(db, sara, req('DELETE', '/reminders/1')), null);
  assert.ok(refusal(db, sara, req('GET', '/bookings')), 'other screens still need rights');
});
