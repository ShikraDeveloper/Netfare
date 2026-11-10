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
  assert.deepEqual(cleanPermissions({ cancel: true }), { cancel: true });
  assert.deepEqual(cleanPermissions({ void: true }), { cancel: true }, 'the old void right becomes cancel');
});

test('view, edit and cancel decide each request', () => {
  const rights = { visas: 'edit', sales: 'view' };
  assert.equal(decide(rights, 'GET', '/visas/4'), null);
  assert.equal(decide(rights, 'POST', '/visas/4/approve'), null);
  assert.equal(decide(rights, 'POST', '/visa-deposits'), null);
  assert.match(decide(rights, 'POST', '/visas/4/cancel'), /right to cancel or reject/);
  assert.equal(decide({ ...rights, cancel: true }, 'POST', '/visas/4/cancel'), null);
  assert.equal(decide(rights, 'GET', '/invoices'), null);
  assert.match(decide(rights, 'POST', '/invoices/2/payments'), /Edit rights for Invoices/);
  assert.match(decide({ visas: 'edit', cancel: true }, 'POST', '/invoices/2/void'), /Edit rights/, 'without Edit the area answer comes first');
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
  assert.equal(decide({ visas: 'edit' }, 'DELETE', '/attachments/9'), null, 'removing a file needs Edit, not the admin');
  assert.match(decide({ visas: 'edit', cancel: true }, 'GET', '/users'), /Only the admin/);
  assert.match(decide({ visas: 'edit', cancel: true }, 'POST', '/admin/reset'), /Only the admin/);
});

test('void, correct and delete are for the admin only, under any case or name', () => {
  const rights = { sales: 'edit', visas: 'edit', books: 'edit', suppliers: 'edit', portals: 'edit', banking: 'edit', refunds: 'edit', bookings: 'edit', customers: 'edit', cancel: true };
  for (const path of [
    '/invoices/5/void', '/invoices/5/VOID', '/invoices/5/Void', '/opening-balances/VOID', '/bills/3/void',
    '/portals/topups/2/void', '/portals/refunds/2/void', '/credits/applications/4/void', '/refunds/8/void',
    '/visa-deposits/7/void-last', '/visa-deposits/7/VOID-LAST', '/bookings/2/void', '/cancellations/3/void',
    '/invoices/5/correct', '/bookings/2/CORRECT',
  ]) {
    assert.match(decide(rights, 'POST', path), /Only the admin can void, correct or delete/, path);
  }
  for (const path of ['/invoices/payments/4', '/bills/payments/4', '/invoices/5', '/customers/2', '/journal-entries/9']) {
    assert.match(decide(rights, 'DELETE', path), /Only the admin/, `DELETE ${path}`);
  }
  assert.equal(decide(rights, 'POST', '/visa-deposits/7/refund'), null, 'a deposit refund is a normal edit');
});

test('cancel and reject need the cancel right, under any case', () => {
  const rights = { visas: 'edit', bookings: 'edit' };
  for (const path of ['/visas/4/cancel', '/visas/4/CANCEL', '/visas/4/reject', '/bookings/2/cancel']) {
    assert.match(decide(rights, 'POST', path), /right to cancel or reject/, path);
    assert.equal(decide({ ...rights, cancel: true }, 'POST', path), null, path);
  }
});

test('saving opening balances with no amounts is for the admin only', () => {
  const rights = { books: 'edit', cancel: true };
  const amounts = { entry_date: '2026-01-01', balances: [{ account_id: 1, debit_cents: 5000, credit_cents: 0 }] };
  assert.equal(decide(rights, 'POST', '/opening-balances', {}, amounts), null);
  for (const balances of [[], [{ account_id: 1, debit_cents: 0, credit_cents: 0 }], undefined]) {
    assert.match(decide(rights, 'POST', '/opening-balances', {}, { entry_date: '2026-01-01', balances }), /Only the admin/);
  }
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
