'use strict';

// A visa rejected by immigration: the fees are kept unless the agency gives
// some back, and money the supplier returns later can be passed on.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-visa-rejection-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const visas = require('../server/services/visas');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const cancellations = require('../server/services/cancellations');
const reconciliation = require('../server/services/reconciliation');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const balance = (code) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS n
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
`).get(code).n;

// Sale 400 + fee 100, immigration cost 350; paid is what the customer paid.
function submittedVisa(name, paid) {
  const customer = Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
  const vendor = Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(`Immigration ${name}`).lastInsertRowid);
  const visa = visas.createVisa(db, {
    customer_id: customer, application_date: '2026-11-01', destination_country: 'United Arab Emirates', visa_type: 'tourist',
    applicant_is_customer: true,
    sale_items: [
      { description: 'UAE visa', quantity: 1, unit_price_cents: 40_000, account_id: account('4320') },
      { description: 'Service fee', quantity: 1, unit_price_cents: 10_000, account_id: account('4300') },
    ],
    cost_items: [{ description: 'Immigration fee', quantity: 1, unit_price_cents: 35_000, account_id: account('5120'), vendor_id: vendor }],
  });
  const submitted = visas.submitVisa(db, visa.id);
  if (paid) {
    invoices.recordInvoicePayment(db, submitted.invoice_id, {
      amount_cents: paid, payment_date: '2026-11-02', method: 'Cash', deposit_account_id: account('1000'),
    });
  }
  const bill = db.prepare('SELECT * FROM bills WHERE visa_id = ?').get(visa.id);
  return { visa, bill, customer };
}

function noteFor(visaId) {
  return db.prepare("SELECT id FROM cancellations WHERE source_type = 'visa' AND source_id = ?").get(visaId).id;
}

test('rejected and paid: by default nothing goes back, the fees are kept', () => {
  const { visa } = submittedVisa('Kept All', 50_000);
  const kept = -balance('4330');
  visas.rejectVisa(db, visa.id, { cancellation_date: '2026-11-05', refund_to_customer_cents: 0 });
  const note = cancellations.getCancellation(db, noteFor(visa.id));
  assert.equal(note.refund_due_cents, 0);
  assert.equal(note.customer_charges_cents, 50_000);
  assert.equal(-balance('4330') - kept, 50_000);
  assert.equal(db.prepare('SELECT status FROM visa_applications WHERE id = ?').get(visa.id).status, 'rejected');
});

test('rejected and paid: the refund entered is what the customer gets back', () => {
  const { visa } = submittedVisa('Part Back', 50_000);
  visas.rejectVisa(db, visa.id, { cancellation_date: '2026-11-05', refund_to_customer_cents: 20_000 });
  const note = cancellations.getCancellation(db, noteFor(visa.id));
  assert.equal(note.refund_due_cents, 20_000);
  assert.equal(note.customer_charges_cents, 30_000);
});

test('rejected and not paid: the customer still owes the fees', () => {
  const { visa, customer } = submittedVisa('Unpaid', 0);
  visas.rejectVisa(db, visa.id, { cancellation_date: '2026-11-05', refund_to_customer_cents: 0 });
  const owed = db.prepare(`
    SELECT COALESCE(SUM(total_cents - amount_paid_cents - credit_applied_cents), 0) AS n
    FROM invoices WHERE customer_id = ? AND status = 'sent'
  `).get(customer).n;
  assert.equal(owed, 50_000, 'an invoice for the fees replaces the voided one');
});

test('a refund to the customer cannot be more than the invoice', () => {
  const { visa } = submittedVisa('Too Much', 50_000);
  assert.throws(() => visas.rejectVisa(db, visa.id, { refund_to_customer_cents: 60_000 }), /cannot be more than the invoice total/);
});

test('immigration refunds later: the cost drops and part can go to the customer', () => {
  const { visa, bill } = submittedVisa('Later Refund', 50_000);
  bills.recordBillPayment(db, bill.id, {
    amount_cents: 35_000, payment_date: '2026-11-02', method: 'Bank transfer', payment_account_id: account('1010'),
  });
  visas.rejectVisa(db, visa.id, { cancellation_date: '2026-11-05', refund_to_customer_cents: 0 });
  const id = noteFor(visa.id);
  const cost = balance('5120');
  const bank = balance('1010');

  assert.throws(() => cancellations.recordSupplierRefund(db, id, {
    bill_id: bill.id, amount_cents: 20_000, date: '2026-11-20', pass_to_customer_cents: 25_000,
  }), /cannot get more than the supplier gave back/);

  const note = cancellations.recordSupplierRefund(db, id, {
    bill_id: bill.id, amount_cents: 20_000, date: '2026-11-20', account_id: account('1010'), pass_to_customer_cents: 15_000,
  });
  assert.equal(cost - balance('5120'), 20_000, 'the immigration cost is lower');
  assert.equal(balance('1010') - bank, 20_000, 'the money came into the bank');
  assert.equal(note.refund_due_cents, 15_000);
  assert.equal(note.refund_remaining_cents, 15_000, 'payable from the note like any refund');
  assert.equal(note.customer_charges_cents, 35_000);

  assert.throws(() => cancellations.recordSupplierRefund(db, id, {
    bill_id: bill.id, amount_cents: 20_000, date: '2026-11-21',
  }), /cannot exceed the available bill amount/);
});

test('the books balance and every ledger check matches', () => {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  const summary = reconciliation.reconciliationSummary(db);
  assert.deepEqual(summary.checks.filter((check) => !check.matched).map((check) => check.code || check.label), []);
});
