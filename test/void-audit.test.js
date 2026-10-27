'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-void-audit-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const { postEntry } = require('../server/accounting');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');
const creditService = require('../server/services/credits');
const refundService = require('../server/services/refunds');
const advanceService = require('../server/services/advances');
const journalService = require('../server/services/journal');
const chequeService = require('../server/services/cheques');
const portalService = require('../server/services/portals');
const auditService = require('../server/services/audit');

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

function assertBalanced() {
  const totals = db.prepare(`
    SELECT COALESCE(SUM(debit_cents), 0) AS debit, COALESCE(SUM(credit_cents), 0) AS credit
    FROM journal_lines
  `).get();
  assert.equal(totals.debit, totals.credit, 'journal debits must equal credits');
}

function auditRows(entityType) {
  return db.prepare(
    'SELECT * FROM audit_logs WHERE entity_type = ? ORDER BY id',
  ).all(entityType);
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('voiding an invoice cascades payments and records remarks in the audit log', () => {
  const customerId = insertCustomer('Void Invoice Customer');
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'sent',
    items: [{ description: 'Consulting', quantity: 1, unit_price_cents: 100_000, account_id: account('4300').id }],
  });
  invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: 40_000,
    payment_date: '2026-10-20',
    method: 'Cash',
    deposit_account_id: account('1000').id,
  });

  const originalEntryId = invoiceService.getInvoice(db, invoice.id).journal_entry_id;
  const voided = invoiceService.voidInvoice(db, invoice.id, { remarks: 'Duplicate invoice' });

  assert.equal(voided.status, 'void');
  assert.equal(voided.amount_paid_cents, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM payments WHERE invoice_id = ? AND status = 'void'").get(invoice.id).c,
    1,
  );
  const invoiceAudit = auditRows('invoice').find((row) => row.entity_id === invoice.id);
  assert.ok(invoiceAudit);
  assert.equal(invoiceAudit.action, 'void');
  assert.equal(invoiceAudit.remarks, 'Duplicate invoice');
  const paymentAudit = auditRows('payment').find((row) => row.remarks === 'Duplicate invoice');
  assert.ok(paymentAudit);
  const reversal = db.prepare(
    'SELECT * FROM journal_entries WHERE reversal_of_id = ?',
  ).get(originalEntryId);
  assert.ok(reversal, 'invoice reversal is linked to the original entry');
  assertBalanced();
});

test('voiding an invoice with a refund and an applied credit reverses both', () => {
  const customerId = insertCustomer('Void Mixed Customer');
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'sent',
    items: [{ description: 'Package', quantity: 1, unit_price_cents: 100_000, account_id: account('4300').id }],
  });
  const paid = invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: 100_000,
    payment_date: '2026-10-20',
    method: 'Cash',
    deposit_account_id: account('1000').id,
  });
  refundService.createRefund(db, {
    refund_type: 'customer',
    payment_id: paid.payments[0].id,
    amount_cents: 40_000,
    refund_date: '2026-10-21',
    method: 'Cash',
    account_id: account('1000').id,
  });
  const credit = creditService.createCredit(db, {
    customer_id: customerId,
    credit_date: '2026-10-21',
    amount_cents: 40_000,
    revenue_account_id: account('4000').id,
  });
  creditService.applyCredit(db, credit.id, {
    invoice_id: invoice.id,
    amount_cents: 40_000,
    applied_date: '2026-10-21',
  });

  const voided = invoiceService.voidInvoice(db, invoice.id, { remarks: 'Duplicate package invoice' });
  assert.equal(voided.status, 'void');
  assert.equal(voided.amount_paid_cents, 0);
  assert.equal(voided.credit_applied_cents, 0);
  assert.equal(db.prepare('SELECT status FROM refunds WHERE invoice_id = ?').get(invoice.id).status, 'void');
  assert.equal(creditService.getCredit(db, credit.id).applied_cents, 0);
  assertBalanced();
});

test('voiding a bill cascades supplier payments and records remarks in the audit log', () => {
  const vendorId = insertVendor('Void Bill Supplier');
  const bill = billService.createBill(db, {
    vendor_id: vendorId,
    bill_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'received',
    items: [{ description: 'Hotel', quantity: 1, unit_price_cents: 90_000, account_id: account('6000').id }],
  });
  billService.recordBillPayment(db, bill.id, {
    amount_cents: 40_000,
    payment_date: '2026-10-20',
    method: 'Bank transfer',
    payment_account_id: account('1010').id,
  });

  const voided = billService.voidBill(db, bill.id, { remarks: 'Supplier cancelled the booking' });
  assert.equal(voided.status, 'void');
  assert.equal(voided.amount_paid_cents, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM bill_payments WHERE bill_id = ? AND status = 'void'").get(bill.id).c,
    1,
  );
  const audit = auditRows('bill').find((row) => row.entity_id === bill.id);
  assert.ok(audit);
  assert.equal(audit.remarks, 'Supplier cancelled the booking');
  assert.ok(auditRows('bill_payment').some((row) => row.remarks === 'Supplier cancelled the booking'));
  assertBalanced();
});

test('voiding a credit note reverses its invoice applications automatically', () => {
  const customerId = insertCustomer('Void Credit Customer');
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'sent',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 100_000, account_id: account('4300').id }],
  });
  const credit = creditService.createCredit(db, {
    customer_id: customerId,
    credit_date: '2026-10-20',
    amount_cents: 30_000,
    revenue_account_id: account('4000').id,
  });
  const applied = creditService.applyCredit(db, credit.id, {
    invoice_id: invoice.id,
    amount_cents: 30_000,
    applied_date: '2026-10-20',
  });
  assert.equal(applied.applied_cents, 30_000);

  const voided = creditService.voidCredit(db, credit.id, { remarks: 'Credit raised twice' });
  assert.equal(voided.status, 'void');
  assert.equal(voided.applied_cents, 0);
  assert.equal(invoiceService.getInvoice(db, invoice.id).credit_applied_cents, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM credit_applications WHERE credit_note_id = ?').get(credit.id).c,
    0,
  );
  assert.ok(auditRows('credit_note').some((row) => row.remarks === 'Credit raised twice'));
  const applicationAudit = auditRows('credit_application').find((row) => row.entity_id === applied.applications[0].id);
  assert.ok(applicationAudit);
  assertBalanced();
});

test('voiding an advance reverses its applied invoice payment and keeps an audit trail', () => {
  const customerId = insertCustomer('Void Advance Customer');
  const advance = advanceService.createAdvance(db, {
    customer_id: customerId,
    advance_date: '2026-10-20',
    amount_cents: 50_000,
    method: 'Bank transfer',
    deposit_account_id: account('1010').id,
  });
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: '2026-10-20',
    due_date: '2026-10-20',
    status: 'sent',
    items: [{ description: 'Visa service', quantity: 1, unit_price_cents: 30_000, account_id: account('4300').id }],
  });
  const applied = advanceService.applyAdvance(db, advance.id, {
    invoice_id: invoice.id,
    payment_date: '2026-10-20',
  });
  assert.equal(applied.applied_cents, 30_000);

  const voided = advanceService.voidAdvance(db, advance.id, { remarks: 'Customer cancelled the trip' });
  assert.equal(voided.voided, true);
  assert.equal(voided.remaining_cents, 0);
  assert.equal(voided.applied_cents, 0);
  assert.equal(invoiceService.getInvoice(db, invoice.id).amount_paid_cents, 0);
  const audit = auditRows('customer_advance').find((row) => row.entity_id === advance.id);
  assert.ok(audit);
  assert.equal(audit.remarks, 'Customer cancelled the trip');
  assert.ok(audit.amount_cents === 50_000);
  assertBalanced();
});

test('voiding a manual journal entry posts a reversal instead of deleting it', () => {
  const entryId = postEntry(db, {
    entry_date: '2026-10-20',
    memo: 'Manual adjustment',
    reference: 'ADJ-1',
    source_type: 'manual',
    lines: [
      { account_id: account('6000').id, debit_cents: 12_000, credit_cents: 0, description: 'Expense' },
      { account_id: account('1010').id, debit_cents: 0, credit_cents: 12_000, description: 'Bank' },
    ],
  });
  const result = journalService.voidManualEntry(db, entryId, { remarks: 'Wrong account used' });
  assert.equal(result.voided, true);
  const original = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
  assert.ok(original.voided_at);
  const reversal = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(result.void_entry_id);
  assert.equal(reversal.reversal_of_id, entryId);
  const audit = auditRows('journal_entry').find((row) => row.entity_id === entryId);
  assert.ok(audit);
  assert.equal(audit.remarks, 'Wrong account used');
  assert.throws(() => journalService.voidManualEntry(db, entryId, { remarks: 'Again' }), /already void/i);
  assert.throws(() => journalService.deleteManualEntry(db, entryId), /void and cannot be deleted/i);
  assertBalanced();
});

test('a voided cheque cannot be edited, restored or deleted', () => {
  const vendorId = insertVendor('Void Cheque Supplier');
  const chequeId = Number(db.prepare(`
    INSERT INTO post_dated_cheques (vendor_id, cheque_number, cheque_date, amount_cents, bank_name, status)
    VALUES (?, 'CHQ-VOID-1', '2026-10-20', 25000, 'Test Bank', 'issued')
  `).run(vendorId).lastInsertRowid);

  const voided = chequeService.voidCheque(db, chequeId, { remarks: 'Cheque cancelled by supplier' });
  assert.equal(voided.status, 'cancelled');
  assert.ok(auditRows('cheque').some((row) => row.entity_id === chequeId && row.remarks === 'Cheque cancelled by supplier'));
  assert.throws(() => chequeService.updateCheque(db, chequeId, { status: 'issued' }), /void and cannot be edited/i);
  assert.throws(() => chequeService.deleteCheque(db, chequeId), /void and cannot be deleted/i);
});

test('portal top-ups, withdrawals and credits are voided without losing history', () => {
  const vendorId = insertVendor('Void Portal Supplier');
  const portal = portalService.createPortal(db, {
    name: 'Void Test Portal',
    portal_type: 'consolidator',
    settlement: 'prepaid',
    vendor_id: vendorId,
  });

  portalService.topUp(db, {
    portal_id: portal.id,
    topup_date: '2026-10-20',
    amount_cents: 100_000,
    method: 'Bank transfer',
    deposit_account_id: account('1010').id,
  });
  const firstTopup = db.prepare('SELECT * FROM portal_topups WHERE portal_id = ?').get(portal.id);
  const afterTopupVoid = portalService.voidTopup(db, firstTopup.id, { remarks: 'Wrong portal credited' });
  assert.equal(afterTopupVoid.balance_cents, 0);
  assert.equal(
    db.prepare('SELECT status FROM portal_topups WHERE id = ?').get(firstTopup.id).status,
    'void',
  );

  portalService.topUp(db, {
    portal_id: portal.id,
    topup_date: '2026-10-20',
    amount_cents: 80_000,
    method: 'Bank transfer',
    deposit_account_id: account('1010').id,
  });
  portalService.refundPortal(db, portal.id, {
    refund_date: '2026-10-20',
    amount_cents: 20_000,
    method: 'Bank transfer',
    payment_account_id: account('1010').id,
  });
  const refund = db.prepare('SELECT * FROM portal_refunds WHERE portal_id = ?').get(portal.id);
  const afterRefundVoid = portalService.voidPortalRefund(db, refund.id, { remarks: 'Withdrawal was not made' });
  assert.equal(afterRefundVoid.balance_cents, 80_000);
  assert.equal(db.prepare('SELECT status FROM portal_refunds WHERE id = ?').get(refund.id).status, 'void');

  const credit = portalService.recordPortalCredit(db, {
    portal_id: portal.id,
    credit_date: '2026-10-20',
    amount_cents: 15_000,
    notes: 'Goodwill credit',
  });
  const afterCreditVoid = portalService.voidPortalCredit(db, credit.id, { remarks: 'Credit entered twice' });
  assert.equal(afterCreditVoid.balance_cents, 80_000);

  const portalAudits = auditService.list(db, { entity_type: 'portal_topup', limit: 20 });
  assert.ok(portalAudits.rows.some((row) => row.remarks === 'Wrong portal credited'));
  assert.ok(auditRows('portal_refund').some((row) => row.remarks === 'Withdrawal was not made'));
  assert.ok(auditRows('portal_credit').some((row) => row.remarks === 'Credit entered twice'));
  assertBalanced();
});

test('a portal credit cannot be voided if it would make a past wallet balance negative', () => {
  const vendorId = insertVendor('Historical Portal Supplier');
  const portal = portalService.createPortal(db, {
    name: 'Historical Wallet Portal',
    portal_type: 'consolidator',
    settlement: 'prepaid',
    vendor_id: vendorId,
  });

  portalService.topUp(db, {
    portal_id: portal.id,
    topup_date: '2026-10-20',
    amount_cents: 100_000,
    method: 'Bank transfer',
    deposit_account_id: account('1010').id,
  });
  const credit = portalService.recordPortalCredit(db, {
    portal_id: portal.id,
    credit_date: '2026-10-21',
    amount_cents: 100_000,
    notes: 'Large portal credit',
  });
  portalService.refundPortal(db, portal.id, {
    refund_date: '2026-10-22',
    amount_cents: 150_000,
    method: 'Bank transfer',
    payment_account_id: account('1010').id,
  });
  portalService.topUp(db, {
    portal_id: portal.id,
    topup_date: '2026-10-23',
    amount_cents: 100_000,
    method: 'Bank transfer',
    deposit_account_id: account('1010').id,
  });

  assert.throws(
    () => portalService.voidPortalCredit(db, credit.id, { remarks: 'Remove the credit' }),
    /negative on a past date/i,
  );
  assert.equal(db.prepare('SELECT status FROM portal_credits WHERE id = ?').get(credit.id).status, 'posted');
  assertBalanced();
});
