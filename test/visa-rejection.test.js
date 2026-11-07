'use strict';

// A visa rejected by immigration: the invoice and the sale stay. What the
// agency gives back is a credit note on that invoice, and money the supplier
// returns later can be passed on the same way.

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
const credits = require('../server/services/credits');
const statements = require('../server/services/statements');

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
const invoiceOf = (visaId) => db.prepare(
  'SELECT i.* FROM invoices i JOIN visa_applications v ON v.invoice_id = i.id WHERE v.id = ?',
).get(visaId);
const creditLeft = (customer) => db.prepare(`
  SELECT COALESCE(SUM(amount_cents - applied_cents - refunded_cents), 0) AS n
  FROM credit_notes WHERE customer_id = ? AND status = 'issued'
`).get(customer).n;

test('rejected and paid: the invoice and the sale stay, nothing goes back by default', () => {
  const { visa, customer } = submittedVisa('Kept All', 50_000);
  const sales = -balance('4320');
  const fees = -balance('4330');
  visas.rejectVisa(db, visa.id, { cancellation_date: '2026-11-05', reason: 'Refused by immigration' });
  const invoice = invoiceOf(visa.id);
  assert.equal(invoice.status, 'sent', 'the invoice is not voided');
  assert.equal(invoice.total_cents, 50_000);
  assert.equal(-balance('4320'), sales, 'visa sales are unchanged');
  assert.equal(-balance('4330'), fees, 'nothing is moved to cancellation income');
  const note = cancellations.getCancellation(db, noteFor(visa.id));
  assert.equal(note.keeps_invoice, true);
  assert.equal(note.customer_charges_cents, 50_000);
  assert.equal(note.refund_due_cents, 0);
  assert.equal(note.cancellation_invoice_id, null, 'no extra invoice');
  assert.equal(creditLeft(customer), 0);
  assert.equal(db.prepare('SELECT status FROM visa_applications WHERE id = ?').get(visa.id).status, 'rejected');
});

test('rejected and paid: the refund is a credit note the customer can be paid from', () => {
  const { visa, customer } = submittedVisa('Part Back', 50_000);
  const sales = -balance('4320');
  visas.rejectVisa(db, visa.id, { cancellation_date: '2026-11-05', refund_to_customer_cents: 20_000 });
  const note = cancellations.getCancellation(db, noteFor(visa.id));
  assert.equal(note.customer_charges_cents, 30_000);
  assert.equal(note.customer_credited_cents, 20_000);
  assert.equal(note.refund_remaining_cents, 0);
  assert.equal(sales - -balance('4320'), 20_000, 'the sale is lower by the refund');
  assert.equal(invoiceOf(visa.id).status, 'sent');
  assert.equal(creditLeft(customer), 20_000, 'held as customer credit, ready to pay back');
  const [credit] = note.credits;
  credits.refundCredit(db, credit.id, { refund_date: '2026-11-06', account_id: account('1000') });
  assert.equal(creditLeft(customer), 0);
});

test('rejected and not paid: the same invoice stays open, less any refund', () => {
  const { visa, customer } = submittedVisa('Unpaid', 0);
  visas.rejectVisa(db, visa.id, { cancellation_date: '2026-11-05', refund_to_customer_cents: 10_000 });
  const open = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(total_cents - amount_paid_cents - credit_applied_cents), 0) AS owed
    FROM invoices WHERE customer_id = ? AND status = 'sent'
  `).get(customer);
  assert.equal(open.n, 1, 'one invoice, no charges invoice');
  assert.equal(open.owed, 40_000);
  assert.equal(creditLeft(customer), 0, 'the credit went on the invoice');
});

test('the customer statement shows the invoice once, not reversed', () => {
  const { visa, customer } = submittedVisa('Statement', 50_000);
  visas.rejectVisa(db, visa.id, { cancellation_date: '2026-11-05', refund_to_customer_cents: 0 });
  const rows = statements.customerStatement(db, customer, { from: '2026-01-01', to: '2026-12-31' }).transactions;
  assert.deepEqual(rows.map((row) => row.kind), ['invoice', 'payment']);
  assert.ok(!/cancelled/.test(rows[0].description));
});

test('a refund to the customer cannot be more than the invoice', () => {
  const { visa } = submittedVisa('Too Much', 50_000);
  assert.throws(() => visas.rejectVisa(db, visa.id, { refund_to_customer_cents: 60_000 }), /cannot be more than the invoice total/);
});

test('immigration refunds later: the cost drops and part can go to the customer', () => {
  const { visa, bill, customer } = submittedVisa('Later Refund', 50_000);
  bills.recordBillPayment(db, bill.id, {
    amount_cents: 35_000, payment_date: '2026-11-02', method: 'Bank transfer', payment_account_id: account('1010'),
  });
  visas.rejectVisa(db, visa.id, { cancellation_date: '2026-11-05' });
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
  assert.equal(note.customer_charges_cents, 35_000);
  assert.equal(note.customer_credited_cents, 15_000);
  assert.equal(creditLeft(customer), 15_000, 'a credit note the customer can be paid from');
  assert.equal(invoiceOf(visa.id).status, 'sent');

  assert.throws(() => cancellations.recordSupplierRefund(db, id, {
    bill_id: bill.id, amount_cents: 20_000, date: '2026-11-21',
  }), /cannot exceed the available bill amount/);
});

test('rejected and not paid: a later supplier refund passed on lowers what they owe', () => {
  const { visa, customer, bill } = submittedVisa('Unpaid Later', 0);
  visas.rejectVisa(db, visa.id, { cancellation_date: '2026-11-05' });
  cancellations.recordSupplierRefund(db, noteFor(visa.id), {
    bill_id: bill.id, amount_cents: 10_000, date: '2026-11-10', pass_to_customer_cents: 10_000,
  });
  const inv = invoiceOf(visa.id);
  assert.equal(inv.total_cents - inv.amount_paid_cents - inv.credit_applied_cents, 40_000);
  assert.equal(creditLeft(customer), 0);
});

test('the books balance and every ledger check matches', () => {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  const summary = reconciliation.reconciliationSummary(db);
  assert.deepEqual(summary.checks.filter((check) => !check.matched).map((check) => check.code || check.label), []);
});
