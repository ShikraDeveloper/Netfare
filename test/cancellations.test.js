'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-cancellation-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const visaService = require('../server/services/visas');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');
const cancellationService = require('../server/services/cancellations');
const supplierCreditService = require('../server/services/supplier-credits');
const creditService = require('../server/services/credits');
const advanceService = require('../server/services/advances');
const refundService = require('../server/services/refunds');
const portalService = require('../server/services/portals');
const complianceService = require('../server/services/compliance');
const chequeService = require('../server/services/cheques');
const cashDepositService = require('../server/services/cash-deposits');
const openingBalances = require('../server/services/opening-balances');
const reports = require('../server/services/reports');
const reconciliation = require('../server/services/reconciliation');
const vendorRoutes = require('../server/routes/vendors');
const { assertManualEntryAccounts } = require('../server/accounting');
const { cents } = require('../server/util');

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

function accountNet(code) {
  return db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ?
  `).get(code).total;
}

function creditBalance(code) {
  return -accountNet(code);
}

function assertBalanced() {
  const totals = db.prepare(`
    SELECT COALESCE(SUM(debit_cents), 0) AS debit, COALESCE(SUM(credit_cents), 0) AS credit
    FROM journal_lines
  `).get();
  assert.equal(totals.debit, totals.credit);
}

function assertReconciled() {
  const summary = reconciliation.reconciliationSummary(db);
  assert.equal(summary.supplier_credits.matched, true);
  assert.equal(summary.refund_payable.matched, true);
  assert.equal(summary.customer_credits.matched, true);
  assert.equal(summary.supplier_advances.matched, true);
}

// The original sale stays on its own day; the cancellation is its own line
// on the cancellation date. Together they give the net result.
function dsrLines(job, cancellationId, cancellationDate) {
  const original = reports.dailySales(db, job.booking_date, job.booking_date)
    .days.flatMap((day) => day.rows).find((row) => !row.is_cancellation && row.id === job.invoice_id);
  const cancelDay = reports.dailySales(db, cancellationDate, cancellationDate);
  const reversal = cancelDay.days.flatMap((day) => day.rows)
    .find((row) => row.is_cancellation && row.cancellation_id === cancellationId);
  assert.ok(original, 'the original sale stays in the DSR');
  assert.notEqual(original.status_display, 'cancelled', 'a report for the sale day reads as it did then');
  assert.equal(original.cancelled_by, null);
  const covering = reports.dailySales(db, job.booking_date, cancellationDate)
    .days.flatMap((day) => day.rows).find((row) => !row.is_cancellation && row.id === job.invoice_id);
  assert.equal(covering.status_display, 'cancelled', 'a report covering the cancellation marks the sale cancelled');
  assert.ok(reversal, 'the cancellation has its own line');
  const net = {};
  for (const key of ['sale_cents', 'cost_cents', 'margin_cents', 'paid_cents', 'balance_cents']) {
    net[key] = covering[key] + reversal[key];
  }
  return { original, reversal, cancelDay, net };
}

function makeJob({
  customerId,
  vendorId,
  saleCents,
  costCents,
  saleAccountId,
  costAccountId,
  bookingDate = '2026-10-20',
}) {
  const draft = bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: bookingDate,
    due_date: bookingDate,
    sale_items: [{
      description: 'Travel package',
      quantity: 1,
      unit_price_cents: saleCents,
      account_id: saleAccountId || account('4000').id,
    }],
    cost_items: [{
      description: 'Supplier cost',
      quantity: 1,
      unit_price_cents: costCents,
      account_id: costAccountId || account('5000').id,
      vendor_id: vendorId,
    }],
  });
  return bookingService.confirmBooking(db, draft.id);
}

function payInvoice(invoiceId, amount, paymentDate = '2026-10-20') {
  return invoiceService.recordInvoicePayment(db, invoiceId, {
    amount_cents: amount,
    payment_date: paymentDate,
    method: 'Cash',
    deposit_account_id: account('1000').id,
  });
}

function payBill(billId, amount, paymentDate = '2026-10-20') {
  return billService.recordBillPayment(db, billId, {
    amount_cents: amount,
    payment_date: paymentDate,
    method: 'Bank transfer',
    payment_account_id: account('1010').id,
  });
}

function attach(entityType, entityId, name) {
  db.prepare(`
    INSERT INTO attachments (entity_type, entity_id, file_name, mime_type, size_bytes, storage_name, data)
    VALUES (?, ?, ?, 'text/plain', 4, ?, ?)
  `).run(entityType, entityId, name, `${entityType}-${entityId}-${name}`, Buffer.from('test'));
}

function attachmentCount(entityType, entityId) {
  return db.prepare(
    'SELECT COUNT(*) AS count FROM attachments WHERE entity_type = ? AND entity_id = ?',
  ).get(entityType, entityId).count;
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('cancellation refunds the customer, records the fee and keeps retained cost', () => {
  const customerId = insertCustomer('Cancellation Customer');
  const vendorId = insertVendor('Cancellation Vendor');
  const saleAccount = insertAccount('4610', 'Cancellation Test Sales', 'revenue', 'credit');
  const costAccount = insertAccount('5610', 'Cancellation Test Cost', 'expense', 'debit');
  const beforeFee = creditBalance('4330');

  const job = makeJob({
    customerId, vendorId, saleCents: 250_000, costCents: 200_000, saleAccountId: saleAccount, costAccountId: costAccount,
  });
  payInvoice(job.invoice_id, 250_000);
  payBill(job.bills[0].id, 200_000);
  const paymentsBefore = db.prepare('SELECT COUNT(*) AS count FROM payments').get().count;
  const billPaymentsBefore = db.prepare('SELECT COUNT(*) AS count FROM bill_payments').get().count;

  const cancellation = cancellationService.cancelSource(db, {
    sourceType: 'booking',
    sourceId: job.id,
    finalStatus: 'cancelled',
    payload: {
      cancellation_date: '2026-11-01',
      customer_charges_cents: 220_000,
      supplier_credits: [],
      reason: 'Customer changed plans',
    },
  });

  assert.equal(cancellation.received_cents, 250_000);
  assert.equal(cancellation.refund_due_cents, 30_000);
  assert.equal(cancellation.refund_remaining_cents, 30_000);
  assert.equal(cancellation.cancellation_invoice_id, null);
  assert.equal(invoiceService.getInvoice(db, job.invoice_id).status, 'void');
  const cancelledReceipt = db.prepare('SELECT id FROM payments WHERE invoice_id = ?').get(job.invoice_id);
  assert.throws(
    () => invoiceService.deleteInvoicePayment(db, cancelledReceipt.id),
    /void invoice/i,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payments').get().count, paymentsBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bill_payments').get().count, billPaymentsBefore);
  assert.equal(creditBalance('4330') - beforeFee, 220_000);
  assert.equal(accountNet('5610'), 200_000);
  assert.equal((creditBalance('4330') - beforeFee) - accountNet('5610'), 20_000);
  assertReconciled();

  const dsr = dsrLines(job, cancellation.id, '2026-11-01');
  assert.deepEqual([dsr.original.sale_cents, dsr.original.cost_cents], [250_000, 200_000], 'sale day unchanged');
  assert.deepEqual([dsr.reversal.sale_cents, dsr.reversal.cost_cents, dsr.reversal.margin_cents], [-30_000, 0, -30_000]);
  assert.deepEqual([dsr.net.sale_cents, dsr.net.cost_cents, dsr.net.margin_cents], [220_000, 200_000, 20_000]);
  assert.equal(dsr.cancelDay.days[0].rows.length, 1);

  const paid = cancellationService.refundCancellation(db, cancellation.id, {
    refund_date: '2026-11-02',
    method: 'Cash',
    account_id: account('1000').id,
  });
  assert.equal(paid.refund_remaining_cents, 0);
  assert.equal(paid.customer_refunded_cents, 30_000);
  assert.equal(creditBalance('2500') + 0, 0);
  assertReconciled();
  assertBalanced();
});

test('cancellation refunds convert to customer credit and restore the refund when voided', () => {
  const customerId = insertCustomer('Converted Credit Customer');
  const vendorId = insertVendor('Converted Credit Vendor');
  const saleAccount = insertAccount('4618', 'Converted Credit Sales', 'revenue', 'credit');
  const costAccount = insertAccount('5618', 'Converted Credit Cost', 'expense', 'debit');
  const beforeRefundPayable = creditBalance('2500');
  const beforeCustomerCredits = creditBalance('2450');

  const job = makeJob({
    customerId,
    vendorId,
    saleCents: 100_000,
    costCents: 70_000,
    saleAccountId: saleAccount,
    costAccountId: costAccount,
    bookingDate: '2026-10-01',
  });
  payInvoice(job.invoice_id, 100_000, '2026-10-02');
  payBill(job.bills[0].id, 70_000, '2026-10-02');

  const cancellation = cancellationService.cancelSource(db, {
    sourceType: 'booking',
    sourceId: job.id,
    finalStatus: 'cancelled',
    payload: {
      cancellation_date: '2026-10-05',
      customer_charges_cents: 60_000,
      supplier_credits: [],
    },
  });
  assert.equal(cancellation.refund_remaining_cents, 40_000);
  assert.throws(
    () => cancellationService.convertCancellationToCredit(db, cancellation.id, {
      amount_cents: 15_000,
      credit_date: '2026-10-04',
    }),
    /before the cancellation date/i,
  );

  let converted = cancellationService.convertCancellationToCredit(db, cancellation.id, {
    amount_cents: 15_000,
    credit_date: '2026-10-06',
  });
  assert.equal(converted.refund_remaining_cents, 25_000);
  assert.equal(converted.customer_credited_cents, 15_000);
  assert.equal(creditBalance('2450') - beforeCustomerCredits, 15_000);
  assert.equal(creditBalance('2500') - beforeRefundPayable, 25_000);
  assertReconciled();

  const cancellationCredit = converted.credits.find((credit) => credit.amount_cents === 15_000);
  assert.ok(cancellationCredit);
  converted = cancellationService.refundCancellation(db, cancellation.id, {
    refund_date: '2026-10-07',
    method: 'Cash',
    account_id: account('1000').id,
  });
  assert.equal(converted.refund_remaining_cents, 0);
  assert.equal(creditBalance('2500') - beforeRefundPayable, 0);
  assertReconciled();

  const voided = creditService.voidCredit(db, cancellationCredit.id);
  assert.equal(voided.status, 'void');
  assert.equal(creditBalance('2450') - beforeCustomerCredits, 0);
  converted = cancellationService.getCancellation(db, cancellation.id);
  assert.equal(converted.refund_remaining_cents, 15_000);
  assert.equal(creditBalance('2500') - beforeRefundPayable, 15_000);
  assertReconciled();

  converted = cancellationService.refundCancellation(db, cancellation.id, {
    refund_date: '2026-10-08',
    method: 'Cash',
    account_id: account('1000').id,
  });
  assert.equal(converted.refund_remaining_cents, 0);
  assert.equal(creditBalance('2500') - beforeRefundPayable, 0);
  assertReconciled();
  assertBalanced();
});

test('draft visas cannot be rejected but may still be cancelled', () => {
  const customerId = insertCustomer('Draft Visa Customer');
  const visa = visaService.createVisa(db, {
    customer_id: customerId,
    application_date: '2026-10-01',
    due_date: '2026-10-10',
    sale_items: [{
      description: 'Visa service',
      quantity: 1,
      unit_price_cents: 10_000,
      account_id: account('4000').id,
    }],
  });

  assert.throws(() => visaService.rejectVisa(db, visa.id, {}), /only submitted or approved/i);
  const cancelled = visaService.cancelVisa(db, visa.id, { cancellation_date: '2026-10-02' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellation, null);
  assertBalanced();
});

test('charges above the amount received create a cancellation invoice', () => {
  const customerId = insertCustomer('Shortfall Customer');
  const vendorId = insertVendor('Shortfall Vendor');
  const saleAccount = insertAccount('4611', 'Shortfall Test Sales', 'revenue', 'credit');
  const costAccount = insertAccount('5611', 'Shortfall Test Cost', 'expense', 'debit');
  const beforeFee = creditBalance('4330');

  const job = makeJob({
    customerId, vendorId, saleCents: 100_000, costCents: 80_000, saleAccountId: saleAccount, costAccountId: costAccount,
  });
  payInvoice(job.invoice_id, 50_000);
  payBill(job.bills[0].id, 80_000);

  const cancellation = cancellationService.cancelSource(db, {
    sourceType: 'booking',
    sourceId: job.id,
    finalStatus: 'cancelled',
    payload: {
      cancellation_date: '2026-11-02',
      customer_charges_cents: 150_000,
      supplier_credits: [],
    },
  });

  assert.equal(cancellation.received_cents, 50_000);
  assert.equal(cancellation.refund_due_cents, 0);
  assert.equal(cancellation.refund_remaining_cents, 0);
  assert.ok(cancellation.cancellation_invoice_id);
  const cancellationInvoice = invoiceService.getInvoice(db, cancellation.cancellation_invoice_id);
  assert.equal(cancellationInvoice.total_cents, 100_000);
  assert.equal(cancellationInvoice.status, 'sent');
  assert.equal(cancellationInvoice.balance_cents, 100_000);
  assert.equal(creditBalance('4330') - beforeFee, 150_000);
  assert.equal((creditBalance('4330') - beforeFee) - accountNet('5611'), 70_000);
  assertReconciled();

  const dsr = dsrLines(job, cancellation.id, '2026-11-02');
  assert.deepEqual([dsr.reversal.sale_cents, dsr.reversal.cost_cents, dsr.reversal.paid_cents, dsr.reversal.balance_cents], [50_000, 0, 0, 100_000]);
  assert.equal(dsr.net.sale_cents, 150_000);
  assert.equal(dsr.net.cost_cents, 80_000);
  assert.equal(dsr.net.paid_cents, 50_000);
  assert.equal(dsr.net.balance_cents, 100_000);
  assert.equal(dsr.cancelDay.days[0].rows.length, 1, 'the charges invoice is part of the cancellation line');
  assertBalanced();
});

test('an unpaid supplier bill is fully settled by cancellation credit', () => {
  const customerId = insertCustomer('Unpaid Bill Customer');
  const vendorId = insertVendor('Unpaid Bill Vendor');
  const saleAccount = insertAccount('4612', 'Unpaid Bill Sales', 'revenue', 'credit');
  const costAccount = insertAccount('5612', 'Unpaid Bill Cost', 'expense', 'debit');
  const beforeFee = creditBalance('4330');

  const job = makeJob({
    customerId, vendorId, saleCents: 200_000, costCents: 120_000, saleAccountId: saleAccount, costAccountId: costAccount,
  });
  const billId = job.bills[0].id;
  const cancellation = cancellationService.cancelSource(db, {
    sourceType: 'booking',
    sourceId: job.id,
    finalStatus: 'cancelled',
    payload: {
      cancellation_date: '2026-11-03',
      customer_charges_cents: 100_000,
      supplier_credits: [{ bill_id: billId, amount_cents: 120_000 }],
    },
  });

  const bill = billService.getBill(db, billId);
  const credit = cancellation.supplier_credits[0];
  assert.equal(credit.amount_cents, 120_000);
  assert.equal(credit.applied_cents, 120_000);
  assert.equal(credit.remaining_cents, 0);
  assert.equal(bill.credit_applied_cents, 120_000);
  assert.equal(bill.balance_cents, 0);
  assert.equal(bill.status_display, 'paid');
  assert.equal(accountNet('5612'), 0);
  assert.equal(creditBalance('4330') - beforeFee, 100_000);
  assert.equal(accountNet('1450') + 0, 0);
  assert.equal(cancellation.refund_due_cents, 0);
  const cancellationInvoice = invoiceService.getInvoice(db, cancellation.cancellation_invoice_id);
  assert.equal(cancellationInvoice.total_cents, 100_000);
  assert.equal(cancellationInvoice.status, 'sent');
  assertReconciled();
  assertBalanced();
});

test('a partial airline credit leaves retained cost and an open supplier credit', () => {
  const customerId = insertCustomer('Airline Customer');
  const vendorId = insertVendor('Airline Vendor');
  const saleAccount = insertAccount('4613', 'Airline Sales', 'revenue', 'credit');
  const costAccount = insertAccount('5613', 'Airline Cost', 'expense', 'debit');
  const beforeFee = creditBalance('4330');

  const job = makeJob({
    customerId, vendorId, saleCents: 250_000, costCents: 200_000, saleAccountId: saleAccount, costAccountId: costAccount,
  });
  payInvoice(job.invoice_id, 250_000);
  payBill(job.bills[0].id, 200_000);

  const cancellation = cancellationService.cancelSource(db, {
    sourceType: 'booking',
    sourceId: job.id,
    finalStatus: 'cancelled',
    payload: {
      cancellation_date: '2026-11-04',
      customer_charges_cents: 170_000,
      supplier_credits: [{ bill_id: job.bills[0].id, amount_cents: 50_000 }],
    },
  });

  assert.equal(cancellation.refund_due_cents, 80_000);
  assert.equal(cancellation.supplier_credits[0].remaining_cents, 50_000);
  assert.equal(accountNet('5613'), 150_000);
  assert.equal((creditBalance('4330') - beforeFee) - accountNet('5613'), 20_000);
  assert.equal(accountNet('1450'), 50_000);
  const dsr = dsrLines(job, cancellation.id, '2026-11-04');
  assert.deepEqual([dsr.original.sale_cents, dsr.original.cost_cents], [250_000, 200_000], 'cost before the airline credit');
  assert.deepEqual([dsr.reversal.sale_cents, dsr.reversal.cost_cents, dsr.reversal.margin_cents], [-80_000, -50_000, -30_000]);
  assert.deepEqual([dsr.net.sale_cents, dsr.net.cost_cents, dsr.net.margin_cents], [170_000, 150_000, 20_000]);
  assertReconciled();
  assertBalanced();
});

test('supplier credits apply across bills, reverse, refund and void safely', () => {
  const vendorId = insertVendor('Standalone Credit Vendor');
  const costA = insertAccount('5621', 'Standalone Cost A', 'expense', 'debit');
  const costB = insertAccount('5622', 'Standalone Cost B', 'expense', 'debit');
  const firstBill = billService.createBill(db, {
    vendor_id: vendorId,
    bill_date: '2026-10-01',
    due_date: '2026-10-10',
    status: 'received',
    items: [{ description: 'Cost A', quantity: 1, unit_price_cents: 60_000, account_id: costA }],
  });
  const secondBill = billService.createBill(db, {
    vendor_id: vendorId,
    bill_date: '2026-10-02',
    due_date: '2026-10-12',
    status: 'received',
    items: [{ description: 'Cost B', quantity: 1, unit_price_cents: 50_000, account_id: costB }],
  });

  const beforeSupplierCredits = accountNet('1450');
  let credit = supplierCreditService.createSupplierCredit(db, {
    vendor_id: vendorId,
    credit_date: '2026-10-03',
    amount_cents: 70_000,
    items: [{ description: 'Supplier credit', account_id: costA, amount_cents: 70_000 }],
    notes: 'Standalone credit',
  });
  assert.equal(credit.remaining_cents, 70_000);

  supplierCreditService.applySupplierCredit(db, credit.id, {
    bill_id: firstBill.id, amount_cents: 40_000, applied_date: '2026-10-04',
  });
  credit = supplierCreditService.applySupplierCredit(db, credit.id, {
    bill_id: secondBill.id, amount_cents: 30_000, applied_date: '2026-10-05',
  });
  assert.equal(credit.remaining_cents, 0);
  assert.equal(billService.getBill(db, firstBill.id).balance_cents, 20_000);
  assert.equal(billService.getBill(db, secondBill.id).balance_cents, 20_000);
  assert.equal(accountNet('5621') + accountNet('5622'), 40_000);
  assert.equal(accountNet('1450') - beforeSupplierCredits, 0);
  assertReconciled();

  const secondApplication = credit.applications.find((application) => application.bill_id === secondBill.id);
  credit = supplierCreditService.deleteSupplierCreditApplication(db, secondApplication.id);
  assert.equal(credit.remaining_cents, 30_000);
  assert.equal(billService.getBill(db, secondBill.id).balance_cents, 50_000);
  assert.equal(accountNet('1450') - beforeSupplierCredits, 30_000);

  const refundResult = supplierCreditService.refundSupplierCredit(db, credit.id, {
    amount_cents: 20_000,
    refund_date: '2026-10-06',
    account_id: account('1010').id,
    method: 'Bank transfer',
  });
  assert.equal(refundResult.remaining_cents, 10_000);
  assert.equal(billService.getBill(db, secondBill.id).balance_cents, 50_000);
  assert.equal(billService.getBill(db, firstBill.id).balance_cents, 20_000);
  const refundDetail = refundService.getRefund(db, refundResult.refunds[0].id);
  assert.equal(refundDetail.source_type, 'supplier_credit');
  assert.equal(refundDetail.remaining_refundable_cents, 10_000);
  assert.equal(accountNet('1450') - beforeSupplierCredits, 10_000);
  assertReconciled();

  refundService.voidRefund(db, refundResult.refunds[0].id, { void_date: '2026-10-07' });
  credit = supplierCreditService.getSupplierCredit(db, credit.id);
  assert.equal(credit.remaining_cents, 30_000);
  assert.equal(billService.getBill(db, secondBill.id).balance_cents, 50_000);
  assert.equal(accountNet('1450') - beforeSupplierCredits, 30_000);

  const firstApplication = credit.applications.find((application) => application.bill_id === firstBill.id);
  supplierCreditService.deleteSupplierCreditApplication(db, firstApplication.id);
  credit = supplierCreditService.getSupplierCredit(db, credit.id);
  assert.equal(credit.remaining_cents, 70_000);
  assert.equal(billService.getBill(db, firstBill.id).balance_cents, 60_000);
  assert.equal(accountNet('1450') - beforeSupplierCredits, 70_000);

  const voided = supplierCreditService.voidSupplierCredit(db, credit.id);
  assert.equal(voided.status, 'void');
  assert.equal(voided.remaining_cents, 0);
  assert.equal(accountNet('5621') + accountNet('5622'), 110_000);
  assert.equal(accountNet('1450') - beforeSupplierCredits, 0);
  assertReconciled();
  assertBalanced();
});

test('portal-paid bill credits return to the wallet and appear in the portal ledger', () => {
  const customerId = insertCustomer('Portal Credit Customer');
  const vendorId = insertVendor('Portal Credit Vendor');
  const saleAccount = insertAccount('4616', 'Portal Credit Sales', 'revenue', 'credit');
  const costAccount = insertAccount('5616', 'Portal Credit Cost', 'expense', 'debit');
  const portal = portalService.createPortal(db, {
    name: 'Portal Credit Airline',
    portal_type: 'airline',
    settlement: 'prepaid',
    vendor_id: vendorId,
  });
  portalService.topUp(db, {
    portal_id: portal.id,
    topup_date: '2026-10-19',
    amount_cents: 100_000,
    deposit_account_id: account('1010').id,
    method: 'Bank transfer',
  });

  const job = makeJob({
    customerId, vendorId, saleCents: 120_000, costCents: 90_000, saleAccountId: saleAccount, costAccountId: costAccount,
  });
  const billId = job.bills[0].id;
  const beforeSupplierCredits = accountNet('1450');
  assert.equal(billService.getBill(db, billId).balance_cents, 0);
  assert.equal(portalService.getPortal(db, portal.id).balance_cents, 10_000);

  const cancellation = cancellationService.cancelSource(db, {
    sourceType: 'booking',
    sourceId: job.id,
    finalStatus: 'cancelled',
    payload: {
      cancellation_date: '2026-11-06',
      customer_charges_cents: 110_000,
      supplier_credits: [{ bill_id: billId, amount_cents: 90_000 }],
    },
  });
  const credit = cancellation.supplier_credits[0];
  const refreshedPortal = portalService.getPortal(db, portal.id);
  assert.equal(credit.applied_cents, 0);
  assert.equal(credit.portal_settled_cents, 90_000);
  assert.equal(credit.remaining_cents, 0);
  assert.equal(refreshedPortal.balance_cents, 100_000);
  assert.equal(refreshedPortal.credits.length, 1);
  assert.equal(refreshedPortal.credits[0].amount_cents, 90_000);
  assert.equal(refreshedPortal.credits[0].supplier_credit_number, credit.number);
  assert.equal(refreshedPortal.credits[0].bill_number, job.bills[0].number);

  const ledger = portalService.portalLedger(db, portal.id, {});
  const creditMovement = ledger.rows.find((row) => row.kind === 'portal_credit');
  assert.ok(creditMovement);
  assert.equal(creditMovement.debit_cents, 90_000);
  assert.equal(accountNet('1450') - beforeSupplierCredits, 0);
  assertReconciled();
  assertBalanced();
});

test('applied advances and customer credits are restored or consumed correctly at cancellation', () => {
  const customerId = insertCustomer('Mixed Settlement Customer');
  const vendorId = insertVendor('Mixed Settlement Vendor');
  const saleAccount = insertAccount('4617', 'Mixed Settlement Sales', 'revenue', 'credit');
  const costAccount = insertAccount('5617', 'Mixed Settlement Cost', 'expense', 'debit');

  const job = makeJob({
    customerId, vendorId, saleCents: 100_000, costCents: 70_000, saleAccountId: saleAccount, costAccountId: costAccount,
  });
  const customerCredit = creditService.createCredit(db, {
    customer_id: customerId,
    credit_date: '2026-10-18',
    amount_cents: 30_000,
    revenue_account_id: saleAccount,
  });
  creditService.applyCredit(db, customerCredit.id, {
    invoice_id: job.invoice_id,
    amount_cents: 30_000,
    applied_date: '2026-10-20',
  });
  const advance = advanceService.createAdvance(db, {
    customer_id: customerId,
    booking_id: job.id,
    advance_date: '2026-10-18',
    amount_cents: 20_000,
    deposit_account_id: account('1000').id,
    method: 'Cash',
  });
  advanceService.applyAdvance(db, advance.id, {
    invoice_id: job.invoice_id,
    payment_date: '2026-10-20',
  });
  payInvoice(job.invoice_id, 50_000);
  const beforeRefundPayable = creditBalance('2500');

  const cancellation = cancellationService.cancelSource(db, {
    sourceType: 'booking',
    sourceId: job.id,
    finalStatus: 'cancelled',
    payload: {
      cancellation_date: '2026-11-07',
      customer_charges_cents: 60_000,
      supplier_credits: [],
    },
  });

  const invoice = invoiceService.getInvoice(db, job.invoice_id);
  const restoredCredit = creditService.getCredit(db, customerCredit.id);
  const appliedAdvance = advanceService.getAdvance(db, advance.id);
  assert.equal(cancellation.received_cents, 70_000);
  assert.equal(cancellation.refund_due_cents, 10_000);
  assert.equal(invoice.credit_applied_cents, 0);
  assert.equal(restoredCredit.remaining_cents, 30_000);
  assert.equal(restoredCredit.applied_cents, 0);
  assert.equal(appliedAdvance.status, 'applied');
  assert.equal(appliedAdvance.applied_cents, 20_000);
  assert.equal(invoice.payments.filter((payment) => payment.status === 'posted').length, 2);
  assert.equal(creditBalance('2450'), 30_000);
  assert.equal(creditBalance('2500') - beforeRefundPayable, 10_000);
  assertReconciled();
  assertBalanced();
});

test('control accounts reject manual journals but opening balances still work', () => {
  for (const code of ['1100', '1400', '1450', '2000', '2400', '2450', '2500']) {
    assert.throws(
      () => assertManualEntryAccounts(db, [{ account_id: account(code).id }]),
      /control account/i,
      `${code} must be protected`,
    );
  }
  assert.doesNotThrow(() => assertManualEntryAccounts(db, [{ account_id: account('4330').id }]));

  const saved = openingBalances.saveOpeningBalances(db, {
    entry_date: '2026-01-01',
    balances: [{ account_id: account('1100').id, debit_cents: 90_000, credit_cents: 0 }],
  });
  assert.ok(saved.entry_id);
  assert.equal(saved.total_debit_cents, 90_000);
  openingBalances.clearOpeningBalances(db);
  assertBalanced();
});

test('recurring schedules keep the anchor day across short months', () => {
  const vendorId = insertVendor('Schedule Vendor');
  const item = complianceService.createCompliance(db, {
    name: 'Anchor Day Renewal',
    kind: 'filing',
    frequency: 'monthly',
    next_due_date: '2026-01-31',
    amount_cents: 0,
  });
  assert.equal(item.anchor_date, '2026-01-31');

  let next = complianceService.completeCompliance(db, item.id, { completed_date: '2026-01-31' });
  assert.equal(next.next_due_date, '2026-02-28');
  next = complianceService.completeCompliance(db, item.id, { completed_date: '2026-02-28' });
  assert.equal(next.next_due_date, '2026-03-31');

  const recurring = complianceService.createCompliance(db, {
    name: 'Anchor Day Cheques',
    kind: 'recurring_bill',
    frequency: 'monthly',
    next_due_date: '2026-01-31',
    amount_cents: 10_000,
    vendor_id: vendorId,
    account_id: account('5000').id,
  });
  const batch = chequeService.createBatch(db, {
    compliance_item_id: recurring.id,
    count: 3,
    first_cheque_number: '900001',
    start_date: '2026-01-31',
    frequency: 'monthly',
    amount_cents: 10_000,
    bank_name: 'Anchor Bank',
  });
  assert.deepEqual(batch.cheques.map((cheque) => cheque.cheque_date), [
    '2026-01-31', '2026-02-28', '2026-03-31',
  ]);
  assert.deepEqual([...new Set(batch.cheques.map((cheque) => cheque.anchor_date))], ['2026-01-31']);

  let linkedBill = null;
  let linkedPaymentId = null;
  const firstCheque = batch.cheques[0];
  linkedBill = billService.createBill(db, {
    vendor_id: vendorId,
    bill_date: '2026-01-31',
    due_date: '2026-01-31',
    status: 'received',
    items: [{ description: 'Cheque bill', quantity: 1, unit_price_cents: 10_000, account_id: account('5000').id }],
  });
  billService.recordBillPayment(db, linkedBill.id, {
    amount_cents: 10_000,
    payment_date: '2026-01-31',
    method: 'Cheque',
    cheque_number: firstCheque.cheque_number,
    cheque_date: '2026-01-31',
    bank_name: 'Anchor Bank',
    payment_account_id: account('1010').id,
  });
  linkedPaymentId = db.prepare(
    'SELECT bill_payment_id FROM post_dated_cheques WHERE id = ?',
  ).get(firstCheque.id).bill_payment_id;
  assert.ok(linkedPaymentId);
  assert.throws(() => chequeService.deleteCheque(db, firstCheque.id), /linked to a payment/i);
});

test('backdated cash deposits are checked against historical and current balances', () => {
  const cashId = Number(db.prepare(`
    INSERT INTO accounts (code, name, type, subtype, normal_balance, is_cash)
    VALUES ('1097', 'Backdated Cash', 'asset', 'current_asset', 'debit', 1)
  `).run().lastInsertRowid);
  const bankId = Number(db.prepare(`
    INSERT INTO accounts (code, name, type, subtype, normal_balance, is_cash)
    VALUES ('1096', 'Backdated Bank', 'asset', 'current_asset', 'debit', 1)
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO journal_entries (entry_date, memo, source_type)
    VALUES ('2026-02-01', 'Backdated cash opening', 'manual')
  `).run();
  const entryId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents)
    VALUES (?, ?, 100000, 0)
  `).run(entryId, cashId);
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents)
    VALUES (?, ?, 0, 100000)
  `).run(entryId, account('3000').id);

  db.prepare(`
    INSERT INTO journal_entries (entry_date, memo, source_type)
    VALUES ('2026-12-01', 'Future cash receipt', 'manual')
  `).run();
  const futureEntryId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents)
    VALUES (?, ?, 100000, 0)
  `).run(futureEntryId, cashId);
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents)
    VALUES (?, ?, 0, 100000)
  `).run(futureEntryId, account('3000').id);

  assert.throws(
    () => cashDepositService.createDeposit(db, {
      deposit_date: '2026-01-15',
      amount_cents: 5_000,
      from_account_id: cashId,
      to_account_id: bankId,
    }),
    /balance on 2026-01-15/i,
  );
  assert.throws(
    () => cashDepositService.createDeposit(db, {
      deposit_date: '2026-12-02',
      amount_cents: 150_000,
      from_account_id: cashId,
      to_account_id: bankId,
    }),
    /available Backdated Cash balance/i,
  );
  const deposit = cashDepositService.createDeposit(db, {
    deposit_date: '2026-10-21',
    amount_cents: 50_000,
    from_account_id: cashId,
    to_account_id: bankId,
  });
  assert.equal(deposit.amount_cents, 50_000);
  assertBalanced();
});

test('draft attachments are removed with their documents and payments are voided, not deleted', () => {
  const saleAccount = account('4300').id;
  const draftInvoice = invoiceService.createInvoice(db, {
    customer_id: insertCustomer('Attachment Customer'),
    issue_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'draft',
    items: [{ description: 'Draft invoice', quantity: 1, unit_price_cents: 10_000, account_id: saleAccount }],
  });
  attach('invoice', draftInvoice.id, 'invoice.txt');
  invoiceService.deleteInvoice(db, draftInvoice.id);
  assert.equal(attachmentCount('invoice', draftInvoice.id), 0);

  const draftBill = billService.createBill(db, {
    vendor_id: insertVendor('Attachment Vendor'),
    bill_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'draft',
    items: [{ description: 'Draft bill', quantity: 1, unit_price_cents: 10_000, account_id: account('5000').id }],
  });
  attach('bill', draftBill.id, 'bill.txt');
  billService.deleteBill(db, draftBill.id);
  assert.equal(attachmentCount('bill', draftBill.id), 0);

  const draftBooking = bookingService.createBooking(db, {
    customer_id: insertCustomer('Attachment Booking Customer'),
    booking_date: '2026-10-20',
    due_date: '2026-10-20',
    sale_items: [{ description: 'Draft booking', quantity: 1, unit_price_cents: 10_000, account_id: saleAccount }],
  });
  attach('booking', draftBooking.id, 'booking.txt');
  bookingService.deleteBooking(db, draftBooking.id);
  assert.equal(attachmentCount('booking', draftBooking.id), 0);

  const draftVisa = visaService.createVisa(db, {
    customer_id: insertCustomer('Attachment Visa Customer'),
    application_date: '2026-10-20',
    due_date: '2026-10-20',
    sale_items: [{ description: 'Draft visa', quantity: 1, unit_price_cents: 10_000, account_id: saleAccount }],
  });
  attach('visa', draftVisa.id, 'visa.txt');
  visaService.deleteVisa(db, draftVisa.id);
  assert.equal(attachmentCount('visa', draftVisa.id), 0);

  const customerId = insertCustomer('Void Payment Customer');
  const vendorId = insertVendor('Void Payment Vendor');
  const job = makeJob({
    customerId,
    vendorId,
    saleCents: 40_000,
    costCents: 30_000,
    saleAccountId: saleAccount,
    costAccountId: account('5000').id,
  });
  const paidInvoice = payInvoice(job.invoice_id, 40_000);
  const paidBill = payBill(job.bills[0].id, 30_000);
  const invoicePaymentId = paidInvoice.payments[0].id;
  const billPaymentId = paidBill.payments[0].id;

  invoiceService.deleteInvoicePayment(db, invoicePaymentId);
  billService.deleteBillPayment(db, billPaymentId);
  const invoicePayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(invoicePaymentId);
  const billPayment = db.prepare('SELECT * FROM bill_payments WHERE id = ?').get(billPaymentId);
  assert.equal(invoicePayment.status, 'void');
  assert.equal(billPayment.status, 'void');
  assert.ok(invoicePayment.void_entry_id);
  assert.ok(billPayment.void_entry_id);
  assert.equal(invoiceService.getInvoice(db, job.invoice_id).amount_paid_cents, 0);
  assert.equal(billService.getBill(db, job.bills[0].id).amount_paid_cents, 0);
  assertBalanced();
});

test('fractional cents, advance refunds and vendor deletion safeguards are enforced', () => {
  assert.throws(() => cents(100.5, 'Amount'), /whole number of cents/i);
  assert.throws(() => cents(0.005, 'Amount'), /whole number of cents/i);

  const customerId = insertCustomer('Advance Refund Customer');
  const advance = advanceService.createAdvance(db, {
    customer_id: customerId,
    advance_date: '2026-10-01',
    amount_cents: 50_000,
    deposit_account_id: account('1000').id,
    method: 'Cash',
  });
  const refunded = advanceService.refundAdvance(db, advance.id, {
    amount_cents: 20_000,
    refund_date: '2026-10-02',
    payment_account_id: account('1000').id,
  });
  assert.equal(refunded.advance.remaining_cents, 30_000);
  assert.equal(refunded.advance.refunds.length, 1);
  assert.equal(refunded.advance.refunds[0].amount_cents, 20_000);
  refundService.voidRefund(db, refunded.refund_id, { void_date: '2026-10-03' });
  const restored = advanceService.getAdvance(db, advance.id);
  assert.equal(restored.remaining_cents, 50_000);
  assert.equal(restored.status, 'open');
  assert.equal(restored.refunds[0].status, 'void');

  const vendorId = insertVendor('Protected Vendor');
  const costAccount = insertAccount('5631', 'Protected Vendor Cost', 'expense', 'debit');
  supplierCreditService.createSupplierCredit(db, {
    vendor_id: vendorId,
    credit_date: '2026-10-03',
    amount_cents: 10_000,
    items: [{ description: 'Protected credit', account_id: costAccount, amount_cents: 10_000 }],
  });
  assert.throws(() => vendorRoutes.deleteVendor(vendorId), /supplier credit notes/i);
  const deletableVendorId = insertVendor('Deletable Vendor');
  assert.deepEqual(vendorRoutes.deleteVendor(deletableVendorId), { deleted: true });
  assert.equal(db.prepare('SELECT id FROM vendors WHERE id = ?').get(deletableVendorId), undefined);

  const creditPortal = portalService.createPortal(db, {
    name: 'Credit Account Portal',
    portal_type: 'consolidator',
    settlement: 'credit',
    vendor_id: insertVendor('Credit Portal Vendor'),
  });
  // A credit account may be topped up; with no open bills it waits as an advance.
  const toppedUp = portalService.topUp(db, {
    portal_id: creditPortal.id,
    topup_date: '2026-10-04',
    amount_cents: 5_000,
    deposit_account_id: account('1010').id,
  });
  assert.equal(toppedUp.balance_cents, 5_000);
  assert.deepEqual(toppedUp.paid_bills, []);
  assertBalanced();
});
