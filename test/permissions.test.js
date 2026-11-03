'use strict';

// Which API requests a staff user's rights allow (server/permissions.js).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AREAS, cleanPermissions, refusal } = require('../server/permissions');

const fakeDb = { prepare: () => ({ get: () => ({ entity_type: 'visa' }) }) };

function decide(permissions, method, path, query = {}, body = {}) {
  return refusal(fakeDb, { is_admin: 0, permissions: JSON.stringify(permissions) }, { method, path, query, body });
}

test('every API prefix belongs to one area only', () => {
  const seen = new Map();
  for (const area of AREAS) {
    for (const prefix of area.prefixes || []) {
      assert.ok(!seen.has(prefix), `${prefix} is in ${seen.get(prefix)} and ${area.key}`);
      seen.set(prefix, area.key);
    }
  }
});

test('stored rights keep only known areas and allowed levels', () => {
  assert.deepEqual(
    cleanPermissions({ bookings: 'edit', dashboard: 'edit', reports: 'view', nonsense: 'edit', sales: 'admin', void: 'yes' }),
    { bookings: 'edit', reports: 'view' },
  );
  assert.deepEqual(cleanPermissions({ void: true }), { void: true });
});

test('view, edit and void decide each request', () => {
  const rights = { visas: 'edit', sales: 'view' };
  assert.equal(decide(rights, 'GET', '/visas/4'), null);
  assert.equal(decide(rights, 'POST', '/visas/4/approve'), null);
  assert.equal(decide(rights, 'POST', '/visa-deposits'), null);
  assert.match(decide(rights, 'POST', '/visas/4/cancel'), /void, cancel or delete/);
  assert.equal(decide({ ...rights, void: true }, 'POST', '/visas/4/cancel'), null);
  assert.equal(decide(rights, 'GET', '/invoices'), null);
  assert.match(decide(rights, 'POST', '/invoices/2/payments'), /Edit rights for Invoices/);
  assert.match(decide({ visas: 'edit', void: true }, 'POST', '/invoices/2/void'), /Edit rights/, 'void also needs Edit for that area');
  assert.equal(decide(rights, 'POST', '/advances'), null, 'a visa page records customer advances');
  assert.match(decide(rights, 'GET', '/bills'), /View rights for Suppliers/);
});

test('shared lists, the dashboard, journal entries and attachments', () => {
  for (const path of ['/settings', '/accounts', '/customers', '/vendors', '/portals']) {
    assert.equal(decide({}, 'GET', path), null, `${path} is readable for pickers`);
  }
  assert.match(decide({}, 'GET', '/customers/3'), /View rights/);
  assert.match(decide({}, 'PUT', '/settings'), /Edit rights for Company settings/);
  assert.equal(decide({ dashboard: 'view' }, 'GET', '/reports/dashboard'), null);
  assert.match(decide({ dashboard: 'view' }, 'GET', '/reports/balance-sheet'), /Reports/);
  assert.equal(decide({ sales: 'view' }, 'GET', '/journal-entries/12'), null, 'a document shows its own entry');
  assert.match(decide({ sales: 'view' }, 'GET', '/journal-entries'), /Journal/, 'not the whole journal');
  assert.equal(decide({ visas: 'view' }, 'GET', '/attachments/9/download'), null, 'a visa file follows visa rights');
  assert.match(decide({ bookings: 'edit' }, 'GET', '/attachments/9/download'), /View rights for Visas/);
  assert.equal(decide({ visas: 'edit' }, 'DELETE', '/attachments/9'), null, 'removing a file needs Edit, not Void');
  assert.match(decide({ visas: 'edit', void: true }, 'GET', '/users'), /Only the admin/);
  assert.match(decide({ visas: 'edit', void: true }, 'POST', '/admin/reset'), /Only the admin/);
});

test('void needs the void right under any case or name', () => {
  const rights = { sales: 'edit', visas: 'edit', books: 'edit' };
  for (const path of ['/invoices/5/VOID', '/invoices/5/Void', '/visas/4/CANCEL', '/opening-balances/VOID']) {
    assert.match(decide(rights, 'POST', path), /void, cancel or delete/, path);
  }
  assert.match(decide(rights, 'POST', '/visa-deposits/7/void-last'), /void, cancel or delete/);
  assert.match(decide(rights, 'POST', '/visa-deposits/7/VOID-LAST'), /void, cancel or delete/);
  assert.match(decide(rights, 'POST', '/visas/4/reject'), /void, cancel or delete/);
  assert.equal(decide({ ...rights, void: true }, 'POST', '/visas/4/reject'), null);
  assert.equal(decide(rights, 'POST', '/visa-deposits/7/refund'), null, 'a deposit refund is a normal edit');
});

test('saving opening balances with no amounts needs the void right', () => {
  const rights = { books: 'edit' };
  const amounts = { entry_date: '2026-01-01', balances: [{ account_id: 1, debit_cents: 5000, credit_cents: 0 }] };
  assert.equal(decide(rights, 'POST', '/opening-balances', {}, amounts), null);
  for (const balances of [[], [{ account_id: 1, debit_cents: 0, credit_cents: 0 }], undefined]) {
    assert.match(decide(rights, 'POST', '/opening-balances', {}, { entry_date: '2026-01-01', balances }), /void, cancel or delete/);
  }
  assert.equal(decide({ ...rights, void: true }, 'POST', '/opening-balances', {}, { balances: [] }), null);
});

test('an attachment id must be plain digits', () => {
  const bookings = { bookings: 'edit' };
  assert.match(decide(bookings, 'GET', '/attachments/%35/download', { entity_type: 'booking' }), /access to this file/);
  assert.match(decide(bookings, 'DELETE', '/attachments/%35', { entity_type: 'booking' }), /access to this file/);
  assert.match(decide(bookings, 'GET', '/attachments/5/download', { entity_type: 'booking' }), /View rights for Visas/, 'the stored row decides');
  assert.equal(decide(bookings, 'GET', '/attachments', { entity_type: 'booking' }), null, 'listing still follows entity_type');
});

test('the admin is never limited', () => {
  assert.equal(refusal(fakeDb, { is_admin: 1, permissions: '{}' }, { method: 'POST', path: '/admin/reset', query: {} }), null);
});
