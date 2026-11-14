'use strict';

// Regression tests for the 2026-10-28 audit findings F1–F11.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-audit-fixes-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const visaService = require('../server/services/visas');
const bookingService = require('../server/services/bookings');
const deposits = require('../server/services/visa-deposits');
const refundService = require('../server/services/refunds');
const cashDeposits = require('../server/services/cash-deposits');
const reconciliation = require('../server/services/reconciliation');
const statements = require('../server/services/statements');
const { dailySales } = require('../server/services/reports/daily-sales');
const { todayISO } = require('../server/util');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

const balanceAsOf = (code, date) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
  FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
  WHERE a.code = ? AND e.entry_date <= ?
`).get(code, date).total;

const check = (key) => reconciliation.reconciliationSummary(db).checks.find((item) => item.key === key);
const customer = (name) => Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Audit Vendor')").run().lastInsertRowid);

function serviceInvoice(customerId, date, cents) {
  return invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: date,
    items: [{ description: 'Service', quantity: 1, unit_price_cents: cents, account_id: account('4300').id }],
  });
}

function visa(customerId, date = '2026-10-01') {
  return visaService.createVisa(db, {
    customer_id: customerId,
    application_date: date,
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 35_000, account_id: account('4320').id }],
  });
}

function takeDeposit(visaId, cents, date = '2026-10-01') {
  return deposits.collectDeposit(db, { visa_id: visaId, amount_cents: cents, deposit_date: date, account_id: account('1000').id });
}

function assertBadRequest(fn, pattern) {
  assert.throws(fn, (error) => error.status === 400 && pattern.test(error.message));
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('F1: a day with no sales still lists money collected for older invoices', () => {
  const invoice = serviceInvoice(customer('F1'), '2026-10-01', 10_000);
  invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: 10_000, payment_date: '2026-10-20', deposit_account_id: account('1000').id, method: 'Cash',
  });
  const sections = dailySales(db, '2026-10-20', '2026-10-20').sections;
  assert.equal(sections.collections.length, 1);
  assert.equal(sections.summary.collected.cash, 10_000);
  assert.equal(sections.summary.position.cash.in_cents, 10_000, 'matches the cash ledger');
});

test('F2: a payment made from a visa deposit can only be undone from the deposit card', () => {
  const customerId = customer('F2');
  const v = visaService.submitVisa(db, visa(customerId).id);
  const dep = takeDeposit(v.id, 50_000);
  deposits.applyToInvoice(db, dep.id, { invoice_id: v.invoice_id, amount_cents: 20_000, event_date: '2026-10-02' });
  const payment = invoiceService.getInvoice(db, v.invoice_id).payments.find((row) => row.deposit_id);
  assert.equal(payment.refundable_cents, 0, 'not refundable as cash from the invoice');
  assertBadRequest(() => invoiceService.deleteInvoicePayment(db, payment.id, { remarks: 'x' }), /deposit card/);

  const direct = serviceInvoice(customerId, '2026-10-03', 10_000);
  const dep2 = takeDeposit(visa(customerId).id, 30_000);
  deposits.applyToInvoice(db, dep2.id, { invoice_id: direct.id, event_date: '2026-10-03' });
  assertBadRequest(() => invoiceService.voidInvoice(db, direct.id, { remarks: 'x' }), /deposit card/);
  assert.equal(check('visa_deposits').matched, true);

  deposits.voidLastEvent(db, dep.id, { remarks: 'Applied by mistake' });
  assert.equal(invoiceService.getInvoice(db, v.invoice_id).amount_paid_cents, 0);
  assert.equal(deposits.getDeposit(db, dep.id).held_cents, 50_000);
  assert.equal(check('visa_deposits').matched, true, '2600 still matches after the deposit-card void');
});

test('F3: a visa deposit refund is not added to the invoice balance on the statement', () => {
  const customerId = customer('F3');
  const v = visaService.submitVisa(db, visa(customerId).id);
  const dep = takeDeposit(v.id, 50_000);
  deposits.refundDeposit(db, dep.id, { account_id: account('1000').id, event_date: '2026-10-05' });
  const statement = statements.customerStatement(db, customerId, { to: '2026-12-31' });
  assert.equal(statement.closing_balance_cents, 35_000, 'only the open visa invoice');
  assert.deepEqual(statement.transactions.map((row) => row.kind), ['invoice']);
  assert.equal(statement.deposits.closing_held_cents, 0);
});

test('F4: a deposit refund links to its visa and is voided from the deposit card', () => {
  const v = visa(customer('F4'));
  const dep = takeDeposit(v.id, 10_000);
  deposits.refundDeposit(db, dep.id, { account_id: account('1000').id, amount_cents: 4_000, event_date: '2026-10-05' });
  const refundId = db.prepare('SELECT id FROM refunds WHERE deposit_id = ?').get(dep.id).id;
  const refund = refundService.getRefund(db, refundId);
  assert.deepEqual([refund.source_type, refund.document_id, refund.document_number], ['deposit', v.id, dep.number]);
  assert.equal(refund.remaining_refundable_cents, 6_000);
  assertBadRequest(() => refundService.voidRefund(db, refundId, { remarks: 'x' }), /Security deposit card/);
});

test('F5: a DSR for a period before the cancellation reads the same as before', () => {
  const b = bookingService.confirmBooking(db, bookingService.createBooking(db, {
    customer_id: customer('F5'),
    booking_date: '2026-10-05',
    due_date: '2026-10-05',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 100_000, account_id: account('4000').id }],
    cost_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 80_000, account_id: account('5000').id, vendor_id: vendorId }],
  }).id);
  invoiceService.recordInvoicePayment(db, b.invoice_id, {
    amount_cents: 40_000, payment_date: '2026-10-05', deposit_account_id: account('1000').id, method: 'Cash',
  });
  const snapshot = () => {
    const report = dailySales(db, '2026-10-05', '2026-10-05');
    const row = report.sections.tickets.find((item) => item.id === b.invoice_id);
    return { credit: row.split.credit, cancelled: row.cancelled_by, balance: report.totals.balance_cents, cost: row.cost_cents };
  };
  const before = snapshot();
  bookingService.cancelBooking(db, b.id, {
    cancellation_date: '2026-10-20',
    customer_charges_cents: 15_000,
    supplier_credits: [{ bill_id: b.bills[0].id, amount_cents: 50_000 }],
  });
  assert.deepEqual(snapshot(), before);
  assert.deepEqual([before.credit, before.balance, before.cost], [60_000, 60_000, 80_000]);
  const covering = dailySales(db, '2026-10-05', '2026-10-20').sections.tickets.find((item) => item.id === b.invoice_id);
  assert.equal(covering.cancelled_by.date, '2026-10-20');
  assert.equal(covering.split.credit, 0);
});

test('F7: visa deposits and cash deposits have separate number series', () => {
  const dep = takeDeposit(visa(customer('F7')).id, 5_000);
  assert.match(dep.number, /^SD-2026-/);
  invoiceService.recordInvoicePayment(db, serviceInvoice(customer('F7 cash'), '2026-10-01', 50_000).id, {
    amount_cents: 50_000, payment_date: '2026-10-01', deposit_account_id: account('1000').id, method: 'Cash',
  });
  const cash = cashDeposits.createDeposit(db, {
    amount_cents: 1_000, deposit_date: '2026-10-02', from_account_id: account('1000').id, to_account_id: account('1010').id,
  });
  assert.match(cash.number, /^DEP-2026-/);
  // A stale counter skips to the next free number instead of failing.
  db.prepare('UPDATE settings SET next_visa_deposit_number = 1').run();
  const next = takeDeposit(visa(customer('F7 b')).id, 5_000);
  assert.notEqual(next.number, dep.number);
});

test('F8: voiding a future-dated document today never lands before the original entry', () => {
  const future = '2099-01-15';
  const dep = takeDeposit(visa(customer('F8'), '2026-10-01').id, 60_000, future);
  deposits.voidLastEvent(db, dep.id, { remarks: 'Wrong date' });
  assert.equal(balanceAsOf('2600', '2098-12-31'), balanceAsOf('2600', todayISO()), 'nothing moves before the future date');
  // An invoice can no longer be posted with a date after today.
});

test('F10: a group applicant error is prefixed once', () => {
  assertBadRequest(() => visaService.createVisaGroup(db, {
    customer_id: customer('F10'),
    application_date: '2026-10-01',
    applicants: [
      { applicant_name: 'A', sale_items: [{ description: 'V', quantity: 1, unit_price_cents: 100, account_id: account('4320').id }] },
      { applicant_is_customer: false, applicant_name: '', sale_items: [{ description: 'V', quantity: 1, unit_price_cents: 100, account_id: account('4320').id }] },
    ],
  }), /^Applicant 2: Enter the applicant name$/);
});

test('F11: hot foreign keys are indexed', () => {
  const indexed = (table, column) => db.prepare(`PRAGMA index_list(${table})`).all()
    .some((index) => db.prepare(`PRAGMA index_info(${index.name})`).all()[0]?.name === column);
  for (const [table, column] of [
    ['invoice_items', 'invoice_id'], ['bill_items', 'bill_id'], ['invoices', 'booking_id'],
    ['invoices', 'visa_id'], ['bills', 'booking_id'], ['bills', 'visa_id'],
  ]) {
    assert.ok(indexed(table, column), `${table}.${column} has an index`);
  }
});
