'use strict';

// Phone numbers are saved one way ("+971 50 806 7050") however they are
// typed; numbers saved before are tidied once, and one that cannot be read
// is kept as it was.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-phone-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const runMigrations = require('../server/migrations');
const { normalizePhone } = require('../server/phone');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('however it is typed, a number is saved one way', () => {
  for (const [typed, saved, country] of [
    ['0508067050', '+971 50 806 7050'],
    ['+971508067050', '+971 50 806 7050'],
    ['00971 50-806-7050', '+971 50 806 7050'],
    ['971508067050', '+971 50 806 7050'],
    ['‪+971 55 523 2703‬', '+971 55 523 2703'],
    ['052 331 9696', '+971 52 331 9696'],
    ['04 555 0142', '+971 4 555 0142'],
    ['0300 1234567', '+92 300 123 4567', 'PK'],
    ['+880 1712-345678', '+880 171 234 5678'],
    ['+1 242 357 1234', '+1 242 357 1234'],
    ['+1 (212) 555-0100', '+1 212 555 0100'],
    ['', ''],
  ]) assert.equal(normalizePhone(typed, 'Phone', country), saved, typed);
});

test('a number that does not fit is refused with a reason', () => {
  assert.throws(() => normalizePhone('50 806 70'), /United Arab Emirates number has 8 to 9 digits after \+971/);
  assert.throws(() => normalizePhone('+999 123 456'), /country code is not known/);
  assert.throws(() => normalizePhone('call me'), /digits only/);
});

test('numbers saved before are tidied on start; one that cannot be read is kept', () => {
  const add = (table, phone) => Number(db.prepare(`INSERT INTO ${table} (name, phone) VALUES ('P', ?)`).run(phone).lastInsertRowid);
  const local = add('customers', '0508067050');
  const marked = add('vendors', '‪+971 4 555 0201‬');
  const odd = add('customers', 'ask the office');
  db.prepare("UPDATE settings SET company_phone = '052 331 9696' WHERE id = 1").run();
  runMigrations(db);
  const phone = (table, id) => db.prepare(`SELECT phone FROM ${table} WHERE id = ?`).get(id).phone;
  assert.equal(phone('customers', local), '+971 50 806 7050');
  assert.equal(phone('vendors', marked), '+971 4 555 0201');
  assert.equal(phone('customers', odd), 'ask the office', 'nothing is lost');
  assert.equal(db.prepare('SELECT company_phone FROM settings').get().company_phone, '+971 52 331 9696');
});
