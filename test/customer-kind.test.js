'use strict';

// A customer is a person or a company, and may have their own payment days:
// customers saved with a TRN before become companies once, and a booking or
// visa without a typed due date gets the customer's days (else Settings).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-customer-kind-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const runMigrations = require('../server/migrations');
const jobs = require('../server/services/jobs');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('customers saved with a TRN become companies, once', () => {
  db.exec('ALTER TABLE customers DROP COLUMN kind');
  const company = Number(db.prepare("INSERT INTO customers (name, trn) VALUES ('Old Co', '100245678900003')").run().lastInsertRowid);
  const person = Number(db.prepare("INSERT INTO customers (name) VALUES ('Old Person')").run().lastInsertRowid);
  runMigrations(db);
  const kind = (id) => db.prepare('SELECT kind FROM customers WHERE id = ?').get(id).kind;
  assert.equal(kind(company), 'company');
  assert.equal(kind(person), 'person');
  // Changed back by hand, it stays as chosen on the next start.
  db.prepare("UPDATE customers SET kind = 'person' WHERE id = ?").run(company);
  runMigrations(db);
  assert.equal(kind(company), 'person');
});

test('the due date follows the customer\'s own days, else the usual terms', () => {
  db.prepare('UPDATE settings SET payment_terms_days = 30 WHERE id = 1').run();
  const add = (days) => Number(db.prepare('INSERT INTO customers (name, payment_days) VALUES (?, ?)').run(`Days ${days}`, days).lastInsertRowid);
  assert.equal(jobs.defaultDueDate(db, '2026-11-18', add(15)), '2026-12-03');
  assert.equal(jobs.defaultDueDate(db, '2026-11-18', add(0)), '2026-11-18', 'due now');
  assert.equal(jobs.defaultDueDate(db, '2026-11-18', add(null)), '2026-12-18', 'the usual 30 days');
  assert.equal(jobs.defaultDueDate(db, '2026-11-18'), '2026-12-18');
});
