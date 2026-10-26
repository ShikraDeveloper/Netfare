'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-phase2-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const invoiceService = require('../server/services/invoices');
const creditService = require('../server/services/credits');
const advanceService = require('../server/services/advances');
const cancellationService = require('../server/services/cancellations');
const supplierCreditService = require('../server/services/supplier-credits');
const customerBalances = require('../server/services/customer-balances');
const settlementQueue = require('../server/services/settlement-queue');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

function insertCustomer(name) {
  return Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
}

function insertVendor(name) {
  return Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(name).lastInsertRowid);
}

function insertAccount(code, name, type, normalBalance) {
  return Number(db.prepare(`
    INSERT INTO accounts (code, name, type, subtype, normal_balance)
    VALUES (?, ?, ?, ?, ?)
  `).run(code, name, type, type === 'revenue' ? 'operating_revenue' : 'operating_expense', normalBalance).lastInsertRowid);
}

function assertBalanced() {
  const totals = db.prepare(`
    SELECT COALESCE(SUM(debit_cents), 0) AS debit, COALESCE(SUM(credit_cents), 0) AS credit
    FROM journal_lines
  `).get();
  assert.equal(totals.debit, totals.credit);
}

function createSentInvoice(customerId, amountCents, { issueDate = '2020-01-01', dueDate = '2020-01-02' } = {}) {
  return invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: issueDate,
    due_date: dueDate,
    status: 'sent',
    items: [{
      description: 'Consulting',
      quantity: 1,
      unit_price_cents: amountCents,
      account_id: account('4000').id,
    }],
  });
}

function payInvoice(invoiceId, amountCents, paymentDate = '2020-01-05') {
  return invoiceService.recordInvoicePayment(db, invoiceId, {
    amount_cents: amountCents,
    payment_date: paymentDate,
    method: 'Cash',
    deposit_account_id: account('1000').id,
  });
}

function createBooking(customerId, saleCents, bookingDate = '2020-03-01') {
  const draft = bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: bookingDate,
    due_date: bookingDate,
    sale_items: [{
      description: 'Travel package',
      quantity: 1,
      unit_price_cents: saleCents,
      account_id: account('4000').id,
    }],
  });
  return bookingService.confirmBooking(db, draft.id);
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('customer balances derive receivables, credits and advances from live documents', () => {
  const customerId = insertCustomer('Balance Customer');
  db.prepare('UPDATE customers SET email = ?, phone = ? WHERE id = ?')
    .run('balance@example.com', '+971500000000', customerId);

  const invoice = createSentInvoice(customerId, 100_000);
  payInvoice(invoice.id, 40_000);
  const credit = creditService.createCredit(db, {
    customer_id: customerId,
    revenue_account_id: account('4000').id,
    credit_date: '2020-02-01',
    amount_cents: 15_000,
  });
  const advance = advanceService.createAdvance(db, {
    customer_id: customerId,
    advance_date: '2020-02-02',
    amount_cents: 5_000,
    deposit_account_id: account('1000').id,
  });

  let balance = customerBalances.getCustomerBalance(db, customerId);
  assert.equal(balance.customer.id, customerId);
  assert.equal(balance.summary.outstanding_cents, 60_000);
  assert.equal(balance.summary.overdue_cents, 60_000);
  assert.equal(balance.summary.open_invoice_count, 1);
  assert.equal(balance.summary.unapplied_credit_cents, 15_000);
  assert.equal(balance.summary.advance_cents, 5_000);
  assert.equal(balance.summary.cancellation_refund_cents, 0);
  assert.equal(balance.summary.credit_balance_cents, 20_000);
  assert.equal(balance.summary.net_balance_cents, 40_000);
  assert.equal(balance.open_invoices.length, 1);
  assert.equal(balance.open_invoices[0].balance_cents, 60_000);
  assert.equal(balance.credits.length, 1);
  assert.equal(balance.credits[0].remaining_cents, 15_000);
  assert.equal(balance.advances.length, 1);
  assert.equal(balance.advances[0].remaining_cents, 5_000);

  creditService.applyCredit(db, credit.id, {
    invoice_id: invoice.id,
    amount_cents: 10_000,
    applied_date: '2020-02-03',
  });
  advanceService.applyAdvance(db, advance.id, {
    invoice_id: invoice.id,
    payment_date: '2020-02-04',
  });

  balance = customerBalances.getCustomerBalance(db, customerId);
  assert.equal(balance.summary.outstanding_cents, 45_000);
  assert.equal(balance.summary.unapplied_credit_cents, 5_000);
  assert.equal(balance.summary.advance_cents, 0);
  assert.equal(balance.summary.credit_balance_cents, 5_000);
  assert.equal(balance.summary.net_balance_cents, 40_000, 'settlement does not change the net position');
  assert.equal(balance.open_invoices[0].balance_cents, 45_000);
  assert.equal(balance.credits[0].remaining_cents, 5_000);
  assert.equal(balance.advances.length, 0);

  const listed = customerBalances.listCustomerBalances(db);
  const listedRow = listed.find((row) => row.id === customerId);
  assert.ok(listedRow);
  assert.equal(listedRow.net_balance_cents, 40_000);
  assert.equal(listedRow.email, 'balance@example.com');

  assert.equal(customerBalances.listCustomerBalances(db, { search: 'balance@example.com' }).length, 1);
  assert.equal(customerBalances.listCustomerBalances(db, { search: 'nobody' }).length, 0);
  assert.equal(customerBalances.listCustomerBalances(db, { only_with_balance: true })
    .some((row) => row.id === customerId), true);

  const settledId = insertCustomer('Settled Customer');
  createSentInvoice(settledId, 1_000);
  db.prepare('UPDATE customers SET is_active = 0 WHERE id = ?').run(settledId);
  assert.equal(
    customerBalances.listCustomerBalances(db).some((row) => row.id === settledId),
    false,
    'archived customers are hidden by default',
  );
  assert.equal(
    customerBalances.listCustomerBalances(db, { include_inactive: true })
      .some((row) => row.id === settledId),
    true,
  );

  assert.throws(() => customerBalances.getCustomerBalance(db, 999_999), /Customer not found/);
  creditService.voidCredit(db, credit.id, { remarks: 'Test cleanup' });
  assertBalanced();
});

test('settlement queue aggregates cancellation refunds, credits, advances and supplier credits', () => {
  const customerId = insertCustomer('Queue Customer');
  const vendorId = insertVendor('Queue Vendor');
  const costAccountId = insertAccount('5690', 'Queue Test Cost', 'expense', 'debit');

  const booking = createBooking(customerId, 100_000);
  payInvoice(booking.invoice_id, 100_000, '2020-03-02');
  const cancellation = cancellationService.cancelSource(db, {
    sourceType: 'booking',
    sourceId: booking.id,
    payload: {
      cancellation_date: '2020-03-05',
      customer_charges_cents: 80_000,
      supplier_credits: [],
      reason: 'Customer changed plans',
    },
  });
  assert.equal(cancellation.refund_due_cents, 20_000);
  assert.equal(cancellation.refund_remaining_cents, 20_000);

  const credit = creditService.createCredit(db, {
    customer_id: customerId,
    revenue_account_id: account('4000').id,
    credit_date: '2020-03-06',
    amount_cents: 15_000,
  });
  const advance = advanceService.createAdvance(db, {
    customer_id: customerId,
    advance_date: '2020-03-07',
    amount_cents: 5_000,
    deposit_account_id: account('1000').id,
  });
  const supplierCredit = supplierCreditService.createSupplierCredit(db, {
    vendor_id: vendorId,
    credit_date: '2020-03-08',
    items: [{ description: 'Supplier refund', account_id: costAccountId, amount_cents: 8_000 }],
  });

  let queue = settlementQueue.listSettlementQueue(db);
  assert.equal(queue.totals.count, 4);
  assert.equal(queue.totals.amount_cents, 48_000);
  assert.equal(queue.totals.by_type.cancellation_refund.count, 1);
  assert.equal(queue.totals.by_type.cancellation_refund.amount_cents, 20_000);
  assert.equal(queue.totals.by_type.customer_credit.count, 1);
  assert.equal(queue.totals.by_type.customer_credit.amount_cents, 15_000);
  assert.equal(queue.totals.by_type.customer_advance.count, 1);
  assert.equal(queue.totals.by_type.customer_advance.amount_cents, 5_000);
  assert.equal(queue.totals.by_type.supplier_credit.count, 1);
  assert.equal(queue.totals.by_type.supplier_credit.amount_cents, 8_000);

  const cancellationItem = queue.items.find((item) => item.type === 'cancellation_refund');
  assert.equal(cancellationItem.document_id, cancellation.id);
  assert.equal(cancellationItem.id, `cancellation_refund-${cancellation.id}`);
  assert.match(cancellationItem.href, new RegExp(`#/cancellations/${cancellation.id}$`));
  assert.match(cancellationItem.detail, /Booking/);
  assert.ok(cancellationItem.age_days >= 0);

  const creditItem = queue.items.find((item) => item.type === 'customer_credit');
  assert.equal(creditItem.document_id, credit.id);
  assert.equal(creditItem.detail, 'Standalone customer credit');
  assert.match(creditItem.href, new RegExp(`#/credits/${credit.id}$`));

  const advanceItem = queue.items.find((item) => item.type === 'customer_advance');
  assert.equal(advanceItem.document_id, advance.id);
  assert.match(advanceItem.href, new RegExp(`#/customer-balances/${customerId}$`));

  const supplierItem = queue.items.find((item) => item.type === 'supplier_credit');
  assert.equal(supplierItem.document_id, supplierCredit.id);
  assert.equal(supplierItem.detail, 'Standalone supplier credit');
  assert.match(supplierItem.href, new RegExp(`#/supplier-credits/${supplierCredit.id}$`));

  const onlyCredits = settlementQueue.listSettlementQueue(db, { type: 'customer_credit' });
  assert.equal(onlyCredits.totals.count, 1);
  assert.equal(onlyCredits.totals.amount_cents, 15_000);
  assert.equal(onlyCredits.items[0].type, 'customer_credit');

  const allTypes = settlementQueue.listSettlementQueue(db, { type: 'all' });
  assert.equal(allTypes.totals.count, 4);

  const byCustomer = settlementQueue.listSettlementQueue(db, { party_id: customerId });
  assert.equal(byCustomer.totals.count, 3);
  assert.equal(byCustomer.items.some((item) => item.type === 'supplier_credit'), false);

  const searched = settlementQueue.listSettlementQueue(db, { search: 'queue vendor' });
  assert.equal(searched.totals.count, 1);
  assert.equal(searched.items[0].type, 'supplier_credit');

  assert.throws(
    () => settlementQueue.listSettlementQueue(db, { type: 'unknown' }),
    /settlement queue type/i,
  );

  cancellationService.refundCancellation(db, cancellation.id, {
    refund_date: '2020-03-09',
    method: 'Cash',
    account_id: account('1000').id,
  });
  queue = settlementQueue.listSettlementQueue(db);
  assert.equal(queue.totals.by_type.cancellation_refund.count, 0);
  assert.equal(queue.totals.count, 3);
  assert.equal(queue.totals.amount_cents, 28_000);

  const balance = customerBalances.getCustomerBalance(db, customerId);
  assert.equal(balance.summary.cancellation_refund_cents, 0);
  assert.equal(balance.summary.unapplied_credit_cents, 15_000);
  assert.equal(balance.summary.advance_cents, 5_000);
  assertBalanced();
});
