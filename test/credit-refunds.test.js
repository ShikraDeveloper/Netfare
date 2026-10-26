'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-credit-refund-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const invoiceService = require('../server/services/invoices');
const creditService = require('../server/services/credits');
const advanceService = require('../server/services/advances');
const refundService = require('../server/services/refunds');
const cancellationService = require('../server/services/cancellations');
const customerBalances = require('../server/services/customer-balances');
const settlementQueue = require('../server/services/settlement-queue');
const statements = require('../server/services/statements');
const reconciliation = require('../server/services/reconciliation');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

function balance(code) {
  return db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ?
  `).get(code).total;
}

// Liability accounts carry credit balances; report them as positive amounts.
function owed(code) {
  return 0 - balance(code);
}

function insertCustomer(name) {
  return Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
}

function insertVendor(name) {
  return Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(name).lastInsertRowid);
}

function assertBalanced() {
  const totals = db.prepare(`
    SELECT COALESCE(SUM(debit_cents), 0) AS debit, COALESCE(SUM(credit_cents), 0) AS credit
    FROM journal_lines
  `).get();
  assert.equal(totals.debit, totals.credit);
}

function assertCreditsReconcile() {
  const result = reconciliation.customerCreditsReconciliation(db);
  assert.ok(result.difference_cents === 0, `2450 matches open customer credits (difference ${result.difference_cents})`);
}

function standaloneCredit(customerId, amountCents, creditDate = '2026-01-10') {
  return creditService.createCredit(db, {
    customer_id: customerId,
    revenue_account_id: account('4000').id,
    amount_cents: amountCents,
    credit_date: creditDate,
  });
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a standalone customer credit can be refunded in cash in parts', () => {
  const customerId = insertCustomer('Credit Refund Customer');
  const credit = standaloneCredit(customerId, 50_000);
  const bankBefore = balance('1010');
  const revenueBefore = balance('4000');

  const partial = creditService.refundCredit(db, credit.id, {
    amount_cents: 20_000,
    refund_date: '2026-01-12',
    account_id: account('1010').id,
    method: 'Bank transfer',
    reference: 'TT-1',
  });
  assert.equal(partial.refunded_cents, 20_000);
  assert.equal(partial.remaining_cents, 30_000);
  assert.equal(partial.refunds.length, 1);
  assert.equal(balance('1010') - bankBefore, -20_000, 'bank pays the refund');
  assert.equal(owed('2450'), 30_000, '2450 keeps only the unrefunded credit');
  assert.equal(balance('4000'), revenueBefore, 'revenue is not reduced a second time');

  const refund = refundService.getRefund(db, partial.refunds[0].id);
  assert.equal(refund.source_type, 'credit');
  assert.equal(refund.document_id, credit.id);
  assert.equal(refund.document_number, credit.number);
  assert.equal(refund.remaining_refundable_cents, 30_000);
  assert.deepEqual(
    refund.journal_entry.lines.map((line) => [line.account_code, line.debit_cents, line.credit_cents]),
    [['2450', 20_000, 0], ['1010', 0, 20_000]],
  );

  // Omitting the amount refunds whatever is left.
  const full = creditService.refundCredit(db, credit.id, {
    refund_date: '2026-01-13',
    account_id: account('1000').id,
  });
  assert.equal(full.remaining_cents, 0);
  assert.equal(full.refunded_cents, 50_000);
  assert.equal(owed('2450'), 0);
  assertBalanced();
  assertCreditsReconcile();
});

test('credit refunds are validated against the remaining balance, dates and accounts', () => {
  const customerId = insertCustomer('Refund Validation Customer');
  const credit = standaloneCredit(customerId, 10_000);
  const bank = account('1010').id;

  assert.throws(
    () => creditService.refundCredit(db, credit.id, { amount_cents: 10_001, refund_date: '2026-01-12', account_id: bank }),
    /exceeds the remaining credit/,
  );
  assert.throws(
    () => creditService.refundCredit(db, credit.id, { amount_cents: 1_000, refund_date: '2026-01-09', account_id: bank }),
    /before the credit date/,
  );
  assert.throws(
    () => creditService.refundCredit(db, credit.id, { amount_cents: 1_000, refund_date: '2026-01-12', account_id: account('4000').id }),
    /bank or cash account/,
  );
  assert.throws(
    () => creditService.refundCredit(db, credit.id, { amount_cents: 10.5, refund_date: '2026-01-12', account_id: bank }),
    /whole number of cents/,
  );

  // Applied and refunded amounts share one remaining balance.
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-01-10',
    due_date: '2026-01-20',
    status: 'sent',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 6_000, account_id: account('4000').id }],
  });
  creditService.applyCredit(db, credit.id, { invoice_id: invoice.id, amount_cents: 6_000, applied_date: '2026-01-11' });
  assert.throws(
    () => creditService.refundCredit(db, credit.id, { amount_cents: 4_001, refund_date: '2026-01-12', account_id: bank }),
    /exceeds the remaining credit of 40.00/,
  );
  creditService.refundCredit(db, credit.id, { amount_cents: 4_000, refund_date: '2026-01-12', account_id: bank });
  const second = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-01-12',
    due_date: '2026-01-20',
    status: 'sent',
    items: [{ description: 'Hotel', quantity: 1, unit_price_cents: 5_000, account_id: account('4000').id }],
  });
  assert.throws(
    () => creditService.applyCredit(db, credit.id, { invoice_id: second.id, amount_cents: 1, applied_date: '2026-01-12' }),
    /no remaining balance/,
  );
  assert.throws(
    () => creditService.refundCredit(db, credit.id, { amount_cents: 1, refund_date: '2026-01-12', account_id: bank }),
    /no remaining balance/,
  );
  assertBalanced();
  assertCreditsReconcile();
});

test('voiding a credit refund restores the credit, and voiding the credit reverses its refunds', () => {
  const customerId = insertCustomer('Refund Void Customer');
  const credit = standaloneCredit(customerId, 30_000);
  const bankBefore = balance('1010');
  const refunded = creditService.refundCredit(db, credit.id, {
    amount_cents: 12_000,
    refund_date: '2026-01-12',
    account_id: account('1010').id,
  });

  refundService.voidRefund(db, refunded.refunds[0].id, { void_date: '2026-01-14', remarks: 'Wrong amount' });
  const restored = creditService.getCredit(db, credit.id);
  assert.equal(restored.refunded_cents, 0);
  assert.equal(restored.remaining_cents, 30_000);
  assert.equal(balance('1010'), bankBefore, 'void puts the cash back');
  assertCreditsReconcile();

  creditService.refundCredit(db, credit.id, { amount_cents: 5_000, refund_date: '2026-01-15', account_id: account('1010').id });
  const voided = creditService.voidCredit(db, credit.id, { remarks: 'Issued in error' });
  assert.equal(voided.status, 'void');
  assert.equal(voided.remaining_cents, 0);
  assert.equal(voided.refunded_cents, 0);
  assert.ok(voided.refunds.every((refund) => refund.status === 'void'), 'every refund is reversed');
  assert.equal(balance('1010'), bankBefore, 'bank is back where it started');
  assert.throws(
    () => creditService.refundCredit(db, credit.id, { amount_cents: 1, refund_date: '2026-01-16', account_id: account('1010').id }),
    /Only issued credit notes can be refunded/,
  );
  assertBalanced();
  assertCreditsReconcile();
});

test('a cancellation refund converted to credit can still be paid out in cash', () => {
  const customerId = insertCustomer('Cancellation Credit Customer');
  const vendorId = insertVendor('Cancellation Credit Airline');
  const draft = bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: '2026-02-01',
    due_date: '2026-02-01',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 80_000, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: 60_000, account_id: account('5000').id, vendor_id: vendorId }],
  });
  const booking = bookingService.confirmBooking(db, draft.id);
  invoiceService.recordInvoicePayment(db, booking.invoice_id, {
    amount_cents: 80_000,
    payment_date: '2026-02-02',
    deposit_account_id: account('1010').id,
  });
  bookingService.cancelBooking(db, booking.id, { cancellation_date: '2026-02-05', customer_charges_cents: 20_000 });
  const cancellation = cancellationService.getCancellationForSource(db, 'booking', booking.id);
  cancellationService.convertCancellationToCredit(db, cancellation.id, { credit_date: '2026-02-05' });
  const credit = db.prepare('SELECT * FROM credit_notes WHERE cancellation_id = ?').get(cancellation.id);
  assert.equal(credit.amount_cents, 60_000);

  const bankBefore = balance('1010');
  creditService.refundCredit(db, credit.id, { amount_cents: 60_000, refund_date: '2026-02-10', account_id: account('1010').id });
  assert.equal(balance('1010') - bankBefore, -60_000);
  assert.equal(owed('2450'), 0);
  assert.equal(owed('2500'), 0, 'the cancellation stays fully settled');
  assert.equal(cancellationService.getCancellation(db, cancellation.id).refund_remaining_cents, 0);
  assertBalanced();
  assertCreditsReconcile();
});

test('customer balances, settlement queue and statements subtract credit refunds', () => {
  const customerId = insertCustomer('Queue Credit Customer');
  const credit = standaloneCredit(customerId, 40_000, '2026-03-01');
  creditService.refundCredit(db, credit.id, { amount_cents: 15_000, refund_date: '2026-03-02', account_id: account('1010').id });

  const detail = customerBalances.getCustomerBalance(db, customerId);
  assert.equal(detail.summary.unapplied_credit_cents, 25_000);
  assert.equal(detail.credits.length, 1);
  assert.equal(detail.credits[0].remaining_cents, 25_000);
  assert.equal(detail.credits[0].refunded_cents, 15_000);

  const queue = settlementQueue.listSettlementQueue(db, { type: 'customer_credit', party_id: customerId });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].remaining_cents, 25_000);
  assert.equal(queue.items[0].action_label, 'Apply or refund');
  assert.equal(queue.totals.amount_cents, 25_000);

  const allCredits = settlementQueue.listSettlementQueue(db, { type: 'customer_credit' });
  assert.equal(allCredits.totals.amount_cents, owed('2450'), 'queue ties to 2450');

  // The statement follows receivables. A credit refund does not touch A/R,
  // so it must not appear as a statement line; it only lowers unapplied credit.
  const statement = statements.customerStatement(db, customerId, { from: '2026-01-01', to: '2026-12-31' });
  assert.ok(!statement.transactions.some((row) => row.kind === 'refund'), 'credit refund is not an A/R line');
  assert.equal(statement.closing_balance_cents, 0, 'no receivable is created by the refund');
  assert.equal(statement.unapplied_credits_cents, 25_000);

  creditService.refundCredit(db, credit.id, { refund_date: '2026-03-03', account_id: account('1000').id });
  const cleared = settlementQueue.listSettlementQueue(db, { type: 'customer_credit', party_id: customerId });
  assert.equal(cleared.items.length, 0, 'fully refunded credit leaves the queue');
  assert.equal(customerBalances.getCustomerBalance(db, customerId).summary.unapplied_credit_cents, 0);
  assertBalanced();
  assertCreditsReconcile();
});

test('credit refunds appear in the refund register as customer credit refunds', () => {
  const customerId = insertCustomer('Register Credit Customer');
  const credit = standaloneCredit(customerId, 7_500, '2026-04-01');
  creditService.refundCredit(db, credit.id, { amount_cents: 7_500, refund_date: '2026-04-02', account_id: account('1010').id });
  const rows = refundService.listRefunds(db, { type: 'customer', search: credit.number });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_type, 'credit');
  assert.equal(rows[0].document_number, credit.number);
  assert.equal(rows[0].party_name, 'Register Credit Customer');
});

test('customer statement matches A/R: advance refunds are excluded, payment refunds stay', () => {
  const customerId = insertCustomer('Statement Advance Customer');
  const advance = advanceService.createAdvance(db, {
    customer_id: customerId,
    amount_cents: 5_000,
    deposit_account_id: account('1010').id,
    advance_date: '2026-05-01',
  });
  advanceService.refundAdvance(db, advance.id, {
    amount_cents: 5_000,
    payment_account_id: account('1010').id,
    refund_date: '2026-05-02',
  });

  // An advance refund moves 2400 Customer Advances to the bank; it never
  // creates a receivable, so it must not appear on the A/R statement.
  let statement = statements.customerStatement(db, customerId, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(statement.transactions.length, 0, 'advance refund is not an A/R line');
  assert.equal(statement.closing_balance_cents, 0);

  // A refund of an invoice payment does reopen the receivable and stays visible.
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-05-03',
    due_date: '2026-05-10',
    status: 'sent',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 9_000, account_id: account('4000').id }],
  });
  const paid = invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: 9_000,
    payment_date: '2026-05-04',
    deposit_account_id: account('1010').id,
  });
  refundService.createRefund(db, {
    refund_type: 'customer',
    payment_id: paid.payments[0].id,
    amount_cents: 2_000,
    refund_date: '2026-05-05',
    account_id: account('1010').id,
  });

  statement = statements.customerStatement(db, customerId, { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(statement.transactions.map((row) => row.kind), ['invoice', 'payment', 'refund']);
  const receivable = invoiceService.getInvoice(db, invoice.id).balance_cents;
  assert.equal(receivable, 2_000);
  assert.equal(statement.closing_balance_cents, receivable, 'statement closing equals the open receivable');
  assertBalanced();
});
