'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-invoice-beneficiary-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const statements = require('../server/services/statements');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

function insertCustomer(name) {
  return Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
}

const customerId = insertCustomer('Sponsor Company LLC');

function invoicePayload(extra = {}) {
  return {
    customer_id: customerId,
    issue_date: '2026-07-01',
    items: [{ description: 'Airport meet & assist service', quantity: 1, unit_price_cents: 250_000, account_id: account('4300').id }],
    ...extra,
  };
}

function assertBadRequest(fn, pattern) {
  assert.throws(fn, (error) => error.status === 400 && pattern.test(error.message));
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('an invoice is for the customer unless the toggle is on', () => {
  const invoice = invoiceService.createInvoice(db, invoicePayload({ beneficiary_name: 'Ignored when off' }));
  assert.equal(invoice.beneficiary_is_customer, 1);
  assert.equal(invoice.beneficiary_name, '');
  assert.equal(invoice.beneficiary_passport_masked, '');
});

test('an invoice for someone else needs the person’s name and keeps the customer as the ledger party', () => {
  assertBadRequest(
    () => invoiceService.createInvoice(db, invoicePayload({ beneficiary_is_customer: false, beneficiary_name: '  ' })),
    /Enter the name of the person this invoice is for/,
  );

  const invoice = invoiceService.createInvoice(db, invoicePayload({
    beneficiary_is_customer: false,
    beneficiary_name: 'Sara Ahmed',
    beneficiary_nationality: 'Pakistani',
    beneficiary_passport: 'AB1234567',
  }));
  assert.equal(invoice.customer_id, customerId, 'billed to the paying customer');
  assert.equal(invoice.beneficiary_is_customer, 0);
  assert.equal(invoice.beneficiary_name, 'Sara Ahmed');
  assert.equal(invoice.beneficiary_nationality, 'Pakistani');
  assert.equal(invoice.beneficiary_passport_masked, '•••• 4567');
  assert.ok(!JSON.stringify(invoice).includes('AB1234567'), 'a sent invoice never returns the full passport');

  const arLine = db.prepare(`
    SELECT l.debit_cents FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.entry_id = ? AND a.code = '1100'
  `).get(invoice.journal_entry_id);
  assert.equal(arLine.debit_cents, 250_000, 'the receivable is posted as usual');

  const found = invoiceService.listInvoices(db, { search: 'Sara Ahmed' });
  assert.deepEqual(found.map((row) => row.id), [invoice.id], 'search finds the person');
});

test('draft edits keep, change or clear the person', () => {
  const draft = invoiceService.createInvoice(db, invoicePayload({
    status: 'draft',
    beneficiary_is_customer: false,
    beneficiary_name: 'Omar Visitor',
    beneficiary_passport: 'Z9988776',
  }));
  assert.equal(draft.beneficiary_passport, 'Z9988776', 'drafts return the full passport so it can be edited');

  const kept = invoiceService.updateInvoice(db, draft.id, { items: invoicePayload().items });
  assert.equal(kept.beneficiary_is_customer, 0);
  assert.equal(kept.beneficiary_name, 'Omar Visitor');
  assert.equal(kept.beneficiary_passport, 'Z9988776');

  const renamed = invoiceService.updateInvoice(db, draft.id, {
    items: invoicePayload().items,
    beneficiary_is_customer: false,
    beneficiary_name: 'Omar Khan',
  });
  assert.equal(renamed.beneficiary_name, 'Omar Khan');
  assert.equal(renamed.beneficiary_passport, 'Z9988776');

  const finalized = invoiceService.finalizeInvoice(db, draft.id);
  assert.equal(finalized.beneficiary_name, 'Omar Khan', 'posting keeps the person');
  assert.equal(finalized.beneficiary_passport, undefined);

  const second = invoiceService.createInvoice(db, invoicePayload({
    status: 'draft',
    beneficiary_is_customer: false,
    beneficiary_name: 'To Be Cleared',
  }));
  const cleared = invoiceService.updateInvoice(db, second.id, { items: invoicePayload().items, beneficiary_is_customer: true });
  assert.equal(cleared.beneficiary_is_customer, 1);
  assert.equal(cleared.beneficiary_name, '');
});

test('the customer statement names the person with a masked passport', () => {
  const statement = statements.customerStatement(db, customerId, {});
  const rows = statement.transactions.filter((row) => row.kind === 'invoice' && row.beneficiary);
  assert.ok(rows.some((row) => row.beneficiary.name === 'Sara Ahmed' && row.beneficiary.passport_masked === '•••• 4567'));
  assert.ok(!JSON.stringify(statement).includes('AB1234567'));
});
