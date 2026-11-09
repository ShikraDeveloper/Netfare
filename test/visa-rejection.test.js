'use strict';

// A visa rejected by immigration: only the status changes; the invoice, the
// sale and what the customer owes stay. Refunds to the customer and from the
// supplier are recorded from the visa page, at any time.

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
const visaRefunds = require('../server/services/visa-refunds');
const reconciliation = require('../server/services/reconciliation');
const credits = require('../server/services/credits');
const supplierCredits = require('../server/services/supplier-credits');
const statements = require('../server/services/statements');
const { dailySales } = require('../server/services/reports/daily-sales');
const { listSettlementQueue } = require('../server/services/settlement-queue');
const jobCosts = require('../server/services/job-costs');

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

const invoiceOf = (visaId) => db.prepare(
  'SELECT i.* FROM invoices i JOIN visa_applications v ON v.invoice_id = i.id WHERE v.id = ?',
).get(visaId);
const owed = (visaId) => {
  const invoice = invoiceOf(visaId);
  return invoice.total_cents - invoice.amount_paid_cents - invoice.credit_applied_cents;
};
const creditLeft = (customer) => db.prepare(`
  SELECT COALESCE(SUM(amount_cents - applied_cents - refunded_cents), 0) AS n
  FROM credit_notes WHERE customer_id = ? AND status = 'issued'
`).get(customer).n;

test('reject only changes the status: invoice, sale and what is owed stay', () => {
  const { visa } = submittedVisa('Status Only', 20_000);
  const sales = -balance('4320');
  const lines = db.prepare('SELECT COUNT(*) AS n FROM journal_lines').get().n;
  const rejected = visas.rejectVisa(db, visa.id, { rejection_date: '2026-11-05', reason: 'Refused by immigration' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(invoiceOf(visa.id).status, 'sent');
  assert.equal(owed(visa.id), 30_000);
  assert.equal(-balance('4320'), sales);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_lines').get().n, lines, 'nothing posted');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cancellations WHERE source_type = 'visa' AND source_id = ?").get(visa.id).n, 0);
  const last = rejected.status_history.at(-1);
  assert.deepEqual([last.to_status, last.event_date, last.remarks], ['rejected', '2026-11-05', 'Refused by immigration']);
  assert.equal(rejected.payment_status, 'partial', 'the customer still owes the rest');
  assert.throws(() => visas.rejectVisa(db, visa.id, {}), /Only submitted or approved/);
});

test('refund to a paid customer: paid back from the bank in one step', () => {
  const { visa, customer } = submittedVisa('Paid Back', 50_000);
  visas.rejectVisa(db, visa.id, { rejection_date: '2026-11-05' });
  const cash = balance('1000');
  const credit = visaRefunds.refundCustomer(db, visa.id, { amount_cents: 20_000, date: '2026-11-06', account_id: account('1000') });
  assert.equal(credit.amount_cents, 20_000);
  assert.equal(cash - balance('1000'), 20_000, 'paid out');
  assert.equal(creditLeft(customer), 0);
  assert.equal(owed(visa.id), 0);
  const shown = visas.getVisa(db, visa.id);
  assert.deepEqual(shown.result, { sale_cents: 30_000, cost_cents: 35_000, margin_cents: -5_000 });
  assert.equal(shown.customer_refunds.length, 1);
});

test('refund kept as credit when no account is chosen', () => {
  const { visa, customer } = submittedVisa('Kept Credit', 50_000);
  visaRefunds.refundCustomer(db, visa.id, { amount_cents: 10_000, date: '2026-11-06' });
  assert.equal(creditLeft(customer), 10_000);
  const queue = listSettlementQueue(db, { party_id: customer }).items;
  assert.deepEqual(queue.map((row) => [row.type, row.remaining_cents]), [['customer_credit', 10_000]]);
});

test('refund to an unpaid customer lowers what they owe; no money moves', () => {
  const { visa, customer } = submittedVisa('Unpaid', 0);
  visas.rejectVisa(db, visa.id, { rejection_date: '2026-11-05' });
  const cash = balance('1000');
  visaRefunds.refundCustomer(db, visa.id, { amount_cents: 10_000, date: '2026-11-06', account_id: account('1000') });
  assert.equal(owed(visa.id), 40_000);
  assert.equal(balance('1000'), cash);
  assert.equal(creditLeft(customer), 0);
});

test('part paid: the refund clears what is owed first, the rest is paid back', () => {
  const { visa } = submittedVisa('Part Paid', 30_000);
  const cash = balance('1000');
  visaRefunds.refundCustomer(db, visa.id, { amount_cents: 40_000, date: '2026-11-06', account_id: account('1000') });
  assert.equal(owed(visa.id), 0);
  assert.equal(cash - balance('1000'), 20_000, 'paid 300, kept 100: 200 back');
});

test('refunds cannot exceed the invoice in total', () => {
  const { visa } = submittedVisa('Too Much', 50_000);
  visaRefunds.refundCustomer(db, visa.id, { amount_cents: 30_000, date: '2026-11-06' });
  assert.throws(() => visaRefunds.refundCustomer(db, visa.id, { amount_cents: 20_001, date: '2026-11-06' }), /cannot be more than 200.00/);
});

test('supplier refund: the cost drops and the money stays with the supplier until received', () => {
  const { visa, bill } = submittedVisa('Supplier Back', 50_000);
  bills.recordBillPayment(db, bill.id, {
    amount_cents: 35_000, payment_date: '2026-11-02', method: 'Bank transfer', payment_account_id: account('1010'),
  });
  visas.rejectVisa(db, visa.id, { rejection_date: '2026-11-05' });
  const cost = balance('5120');
  const bank = balance('1010');
  visaRefunds.supplierRefund(db, visa.id, { bill_id: bill.id, amount_cents: 25_000, date: '2026-11-20', account_id: account('1010') });
  assert.equal(cost - balance('5120'), 25_000);
  assert.equal(balance('1010'), bank, 'an account given by an old caller is ignored: nothing comes in yet');
  const [held] = visas.getVisa(db, visa.id).supplier_refunds;
  assert.equal(held.held_cents, 25_000, 'held with the supplier');
  supplierCredits.receiveVendorRefund(db, bill.vendor_id, { amount_cents: 25_000, date: '2026-11-20', account_id: account('1010') });
  assert.equal(balance('1010') - bank, 25_000, 'received when the supplier pays it out');
  visaRefunds.refundCustomer(db, visa.id, { amount_cents: 20_000, date: '2026-11-21', account_id: account('1010') });
  // Sale 500 − 200 = 300; cost 350 − 250 = 100; profit 200 (it was 150).
  const shown = visas.getVisa(db, visa.id);
  assert.deepEqual(shown.result, { sale_cents: 30_000, cost_cents: 10_000, margin_cents: 20_000 });
  assert.equal(visas.listVisas(db, {}).find((row) => row.id === visa.id).margin_cents, 20_000);
  const report = jobCosts.valueJobs(db, 'visa', [db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(visa.id)]);
  assert.equal(report[0].margin_cents, 20_000, 'the profit report agrees');
  assert.throws(() => visaRefunds.supplierRefund(db, visa.id, { bill_id: bill.id, amount_cents: 15_000, date: '2026-11-22' }), /exceed the bill total/);
});

test('supplier refund on an unpaid bill lowers what we owe them', () => {
  const { visa, bill } = submittedVisa('Bill Unpaid', 0);
  const bank = balance('1010');
  visaRefunds.supplierRefund(db, visa.id, { bill_id: bill.id, amount_cents: 10_000, date: '2026-11-20', account_id: account('1010') });
  const fresh = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id);
  assert.equal(fresh.total_cents - fresh.amount_paid_cents - fresh.credit_applied_cents, 25_000);
  assert.equal(balance('1010'), bank, 'no money came in');
});

test('daily sales: the sale stays on its day; refunds are lines on their own dates', () => {
  const { visa, bill } = submittedVisa('Dsr', 0);
  visas.rejectVisa(db, visa.id, { rejection_date: '2026-11-05' });
  visaRefunds.refundCustomer(db, visa.id, { amount_cents: 10_000, date: '2026-11-06' });
  visaRefunds.supplierRefund(db, visa.id, { bill_id: bill.id, amount_cents: 5_000, date: '2026-11-08' });
  const rows = (from, to) => dailySales(db, from, to).days.flatMap((day) => day.rows).filter((item) => item.reference === visa.number);
  const sale = rows('2026-11-01', '2026-11-01');
  assert.deepEqual(sale.map((row) => [row.sale_cents, row.cost_cents, row.balance_cents]), [[50_000, 35_000, 40_000]], 'the sale day is unchanged');
  const refundDay = rows('2026-11-06', '2026-11-06');
  assert.deepEqual(refundDay.map((row) => [row.particulars.split(' · ')[0], row.sale_cents, row.cost_cents, row.margin_cents]),
    [['Refund to customer', -10_000, 0, -10_000]]);
  const supplierDay = rows('2026-11-08', '2026-11-08');
  assert.deepEqual(supplierDay.map((row) => [row.particulars.split(' · ')[0], row.sale_cents, row.cost_cents, row.margin_cents]),
    [['Refund from supplier', 0, -5_000, 5_000]]);
  assert.deepEqual(rows('2026-11-05', '2026-11-05'), [], 'rejecting posts nothing');
  const month = rows('2026-11-01', '2026-11-30');
  const net = month.reduce((sum, row) => [sum[0] + row.sale_cents, sum[1] + row.cost_cents, sum[2] + row.margin_cents], [0, 0, 0]);
  assert.deepEqual(net, [40_000, 30_000, 10_000], 'the month nets to the profit report');
  assert.equal(visas.getVisa(db, visa.id).margin_cents, 10_000);
});

test('the statement shows the invoice once and the refund as a credit', () => {
  const { visa, customer } = submittedVisa('Statement', 0);
  visas.rejectVisa(db, visa.id, { rejection_date: '2026-11-05' });
  visaRefunds.refundCustomer(db, visa.id, { amount_cents: 10_000, date: '2026-11-06' });
  const rows = statements.customerStatement(db, customer, { from: '2026-01-01', to: '2026-12-31' }).transactions;
  assert.deepEqual(rows.map((row) => row.kind), ['invoice', 'credit']);
  assert.equal(rows.at(-1).balance_cents, 40_000);
});

test('voiding a refund credit note puts the sale and what is owed back', () => {
  const { visa } = submittedVisa('Void Credit', 0);
  const credit = visaRefunds.refundCustomer(db, visa.id, { amount_cents: 10_000, date: '2026-11-06' });
  credits.voidCredit(db, credit.id, { remarks: 'Entered by mistake' });
  assert.equal(owed(visa.id), 50_000);
  assert.equal(visas.getVisa(db, visa.id).margin_cents, 15_000);
});

test('receive refund from the supplier statement: oldest credits first, with bank charges', () => {
  const { visa, bill } = submittedVisa('Held Credit', 50_000);
  const vendor = bill.vendor_id;
  bills.recordBillPayment(db, bill.id, {
    amount_cents: 35_000, payment_date: '2026-11-02', method: 'Bank transfer', payment_account_id: account('1010'),
  });
  visaRefunds.supplierRefund(db, visa.id, { bill_id: bill.id, amount_cents: 10_000, date: '2026-11-10' });
  visaRefunds.supplierRefund(db, visa.id, { bill_id: bill.id, amount_cents: 15_000, date: '2026-11-11' });
  let statement = statements.vendorStatement(db, vendor, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(statement.unapplied_supplier_credits_cents, 25_000);
  assert.equal(statement.closing_balance_cents, -25_000, 'the supplier holds 250 for us');
  assert.throws(() => supplierCredits.receiveVendorRefund(db, vendor, { amount_cents: 25_001, account_id: account('1010') }), /cannot be more than the credit/);

  const bank = balance('1010');
  const fees = balance('6700');
  const done = supplierCredits.receiveVendorRefund(db, vendor, {
    amount_cents: 20_000, date: '2026-11-25', account_id: account('1010'), bank_charges_cents: 300,
  });
  assert.equal(done.credits_used, 2);
  assert.equal(balance('1010') - bank, 19_700);
  assert.equal(balance('6700') - fees, 300);
  statement = statements.vendorStatement(db, vendor, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(statement.unapplied_supplier_credits_cents, 5_000);
  assert.equal(statement.closing_balance_cents, -5_000);
  assert.deepEqual(statement.transactions.map((row) => row.kind),
    ['bill', 'payment', 'supplier_credit', 'supplier_credit', 'credit_refund', 'credit_refund']);
});

test('the books balance and every ledger check matches', () => {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  const summary = reconciliation.reconciliationSummary(db);
  assert.deepEqual(summary.checks.filter((check) => !check.matched).map((check) => check.code || check.label), []);
});
