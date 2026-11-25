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

test('a reminder given to someone: they see it and can change it, so can the one who made it', () => {
  const given = reminders.createReminder(db, sara, { title: 'Call Farooq', due_at: '2026-11-26T10:00', assign_to: omar.id });
  assert.equal(given.owner_name, 'Omar');
  assert.ok(reminders.listReminders(db, omar).some((row) => row.id === given.id), 'Omar sees it');
  assert.ok(reminders.listReminders(db, sara).some((row) => row.id === given.id), 'Sara, who made it, still sees it');
  assert.equal(reminders.updateReminder(db, omar, given.id, { title: 'Call Farooq today' }).title, 'Call Farooq today');
  assert.equal(reminders.updateReminder(db, sara, given.id, { assign_to: sara.id }).owner_name, 'Sara');
  assert.throws(() => reminders.createReminder(db, sara, { title: 'X', due_at: '2026-11-26T10:00', assign_to: 9999 }), /who the reminder is for/);
  assert.deepEqual(reminders.people(db).map((row) => row.full_name), ['Boss', 'Omar', 'Sara']);
});

test('a payment reminder linked to an invoice knows the customer, phone and what is due; suggestions skip what is handled or ignored', () => {
  const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
  const customer = Number(db.prepare("INSERT INTO customers (name, phone) VALUES ('Farooq Engineering', '+971 6 743 5263')").run().lastInsertRowid);
  const invoice = require('../server/services/invoices').createInvoice(db, {
    customer_id: customer, issue_date: '2026-11-20', due_date: '2026-11-23', status: 'sent',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 152_000, account_id: account('4300') }],
  });
  const boss = { ...admin };
  const suggested = reminders.suggestions(db, boss, '2026-11-25').filter((row) => row.link_type === 'invoice');
  assert.deepEqual(suggested.map((row) => [row.key, row.name, row.due_cents]), [[`invoice:${invoice.id}`, 'Farooq Engineering', 152_000]]);
  assert.equal(reminders.suggestions(db, sara, '2026-11-25').length, 0, 'staff without Invoices see no invoice suggestions');

  const linked = reminders.createReminder(db, boss, { title: 'Payment reminder', due_at: '2026-11-26T10:00', link_type: 'invoice', link_id: invoice.id });
  assert.deepEqual([linked.link_number, linked.customer_name, linked.customer_phone, linked.due_cents, linked.invoice_due_date],
    [invoice.number, 'Farooq Engineering', '+971 6 743 5263', 152_000, '2026-11-23']);
  assert.equal(reminders.suggestions(db, boss, '2026-11-25').filter((row) => row.link_type === 'invoice').length, 0, 'already has a reminder');
  reminders.doneReminder(db, boss, linked.id);
  assert.equal(reminders.suggestions(db, boss, '2026-11-25').filter((row) => row.link_type === 'invoice').length, 1, 'back once the reminder is done');
  reminders.dismissSuggestion(db, `invoice:${invoice.id}`);
  assert.equal(reminders.suggestions(db, boss, '2026-11-25').filter((row) => row.link_type === 'invoice').length, 0, 'ignored stays away');
  db.prepare("UPDATE reminder_dismissals SET dismissed_at = datetime('now', '-8 days') WHERE key = ?").run(`invoice:${invoice.id}`);
  assert.equal(reminders.suggestions(db, boss, '2026-11-25').filter((row) => row.link_type === 'invoice').length, 1, 'back after a week while still unpaid');
  reminders.dismissSuggestion(db, `invoice:${invoice.id}`);
  assert.equal(reminders.suggestions(db, boss, '2026-11-25').filter((row) => row.link_type === 'invoice').length, 0, 'ignoring again starts a new week');
  assert.throws(() => reminders.dismissSuggestion(db, 'drop table'), /suggestion/);

  const forCustomer = reminders.createReminder(db, boss, { title: 'Statement', due_at: '2026-11-26T10:00', link_type: 'customer', link_id: customer });
  assert.deepEqual([forCustomer.link_number, forCustomer.due_cents], ['Farooq Engineering', 152_000]);
});

test('books from before keep their reminders when the table takes its new shape', () => {
  const runMigrations = require('../server/migrations');
  db.exec(`
    DROP TABLE reminders;
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', due_at TEXT NOT NULL,
      repeat TEXT NOT NULL DEFAULT 'never', for_all INTEGER NOT NULL DEFAULT 0, owner_user_id INTEGER,
      link_type TEXT CHECK (link_type IN ('booking', 'visa')), link_id INTEGER,
      status TEXT NOT NULL DEFAULT 'open', done_at TEXT, done_by TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  db.prepare("INSERT INTO reminders (id, title, due_at, owner_user_id, created_by) VALUES (7, 'Old one', '2026-11-25T09:00', ?, 'Sara')").run(sara.id);
  runMigrations(db);
  const kept = reminders.getReminder(db, sara, 7);
  assert.deepEqual([kept.title, kept.made_by_user_id], ['Old one', sara.id]);
  const customer = Number(db.prepare("INSERT INTO customers (name) VALUES ('After move')").run().lastInsertRowid);
  assert.equal(reminders.createReminder(db, sara, { title: 'New', due_at: '2026-11-26T09:00', link_type: 'customer', link_id: customer }).link_type, 'customer');
});
