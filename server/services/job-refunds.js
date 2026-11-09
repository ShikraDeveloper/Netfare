'use strict';

// Money that goes back on a booking or visa, recorded from its page. Two
// plain documents, both linked to the job:
//   - a refund to the customer: a credit note on the job's invoice. It first
//     lowers what the customer still owes; anything above that is paid back
//     from the chosen bank or cash account, or kept as their credit.
//   - a refund from the supplier: a supplier credit on the job's bill. The
//     money stays with the supplier: it first clears what is unpaid on the
//     bill, then goes to the prepaid portal wallet or is held as credit with
//     the supplier. It is taken into the bank or cash only when the supplier
//     pays it out (Receive refund on the supplier statement, or Withdraw on
//     the portal).
// The invoice and the bill stay as they are; profit is the invoice less
// refunds to the customer, and the bill less refunds from the supplier.
// A cancelled booking or visa (invoice void) can still get a supplier
// refund; its customer refund is settled from the cancellation note.

const { bad, notFound, optionalStr, cents, dateISO, todayISO } = require('../util');
const { invoiceBalanceCents, isCashAccount } = require('../accounting');
const creditService = require('./credits');
const supplierCreditService = require('./supplier-credits');
const audit = require('./audit');

const JOBS = {
  booking: { table: 'bookings', column: 'booking_id', label: 'booking', missing: 'Booking not found' },
  visa: { table: 'visa_applications', column: 'visa_id', label: 'visa', missing: 'Visa application not found' },
};

function jobConfig(sourceType) {
  const config = JOBS[sourceType];
  if (!config) throw bad('Refunds are for bookings and visas');
  return config;
}

function jobRow(db, sourceType, jobId) {
  const config = jobConfig(sourceType);
  const job = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(Number(jobId));
  if (!job) throw notFound(config.missing);
  return job;
}

function cashAccount(db, accountId) {
  if (!accountId) return null;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!account || !account.is_active || !isCashAccount(account)) throw bad('Choose an active bank or cash account');
  return account;
}

// The refunds shown on the job's page, with where each supplier refund sits.
function refundLists(db, sourceType, jobId) {
  const { column } = jobConfig(sourceType);
  return {
    customer_refunds: db.prepare(`
      SELECT cn.id, cn.number, cn.credit_date AS date, cn.amount_cents, cn.applied_cents, cn.refunded_cents,
             (cn.amount_cents - cn.applied_cents - cn.refunded_cents) AS remaining_cents
      FROM credit_notes cn WHERE cn.${column} = ? AND cn.status = 'issued' ORDER BY cn.credit_date, cn.id
    `).all(Number(jobId)),
    supplier_refunds: db.prepare(`
      SELECT scn.id, scn.number, scn.credit_date AS date, scn.amount_cents, b.number AS bill_number, vd.name AS vendor_name,
             scn.applied_cents, scn.portal_settled_cents, scn.refunded_cents,
             (scn.amount_cents - scn.applied_cents - scn.portal_settled_cents - scn.refunded_cents) AS held_cents
      FROM supplier_credit_notes scn
      LEFT JOIN bills b ON b.id = scn.bill_id
      LEFT JOIN vendors vd ON vd.id = scn.vendor_id
      WHERE COALESCE(scn.${column}, b.${column}) = ? AND scn.cancellation_id IS NULL AND scn.status = 'issued'
      ORDER BY scn.credit_date, scn.id
    `).all(Number(jobId)),
  };
}

function refundCustomer(db, sourceType, jobId, payload = {}) {
  return db.transaction(() => {
    const config = jobConfig(sourceType);
    const job = jobRow(db, sourceType, jobId);
    const invoice = job.invoice_id ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(job.invoice_id) : null;
    if (!invoice || invoice.status !== 'sent') throw bad(`This ${config.label} has no open invoice to refund`);
    const refunded = db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total FROM credit_notes WHERE ${config.column} = ? AND status = 'issued'
    `).get(job.id).total;
    const limit = invoice.total_cents - refunded;
    const amount = cents(payload.amount_cents, 'Refund amount', { min: 1 });
    if (amount > limit) throw bad(`The refund cannot be more than ${(limit / 100).toFixed(2)} (the invoice less earlier refunds)`);
    const date = dateISO(payload.date || todayISO(), 'Date');
    if (date < invoice.issue_date) throw bad('The date cannot be before the invoice date');
    const account = cashAccount(db, payload.account_id);
    const line = db.prepare(`
      SELECT account_id FROM invoice_items WHERE invoice_id = ? ORDER BY amount_cents DESC, id LIMIT 1
    `).get(invoice.id);
    const credit = creditService.createCredit(db, {
      customer_id: invoice.customer_id,
      revenue_account_id: line.account_id,
      credit_date: date,
      amount_cents: amount,
      notes: optionalStr(payload.notes, 'Notes', 1000) || `Refund on ${config.label} ${job.number}`,
    });
    db.prepare(`UPDATE credit_notes SET ${config.column} = ? WHERE id = ?`).run(job.id, credit.id);
    const owed = invoiceBalanceCents(db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id));
    const toInvoice = Math.min(amount, owed);
    if (toInvoice > 0) {
      creditService.applyCredit(db, credit.id, { invoice_id: invoice.id, amount_cents: toInvoice, applied_date: date });
    }
    if (account && amount > toInvoice) {
      creditService.refundCredit(db, credit.id, {
        amount_cents: amount - toInvoice,
        refund_date: date,
        account_id: account.id,
        method: optionalStr(payload.method, 'Method', 100) || (/cash/i.test(account.name) ? 'Cash' : 'Bank transfer'),
      });
    }
    audit.record(db, {
      entity_type: sourceType,
      entity_id: job.id,
      entity_number: job.number,
      action: 'refund',
      remarks: `Refund to the customer · credit note ${credit.number}`,
      amount_cents: amount,
    });
    return creditService.getCredit(db, credit.id);
  })();
}

function supplierRefund(db, sourceType, jobId, payload = {}) {
  return db.transaction(() => {
    const config = jobConfig(sourceType);
    const job = jobRow(db, sourceType, jobId);
    const bill = db.prepare(`SELECT * FROM bills WHERE id = ? AND ${config.column} = ? AND status = 'received'`)
      .get(Number(payload.bill_id), job.id);
    if (!bill) throw bad(`Choose a supplier bill of this ${config.label}`);
    const amount = cents(payload.amount_cents, 'Refund amount', { min: 1 });
    const date = dateISO(payload.date || todayISO(), 'Date');
    if (date < bill.bill_date) throw bad('The date cannot be before the bill date');
    const creditId = supplierCreditService.createSupplierCreditForCancellation(db, {
      vendor_id: bill.vendor_id,
      bill_id: bill.id,
      [config.column]: job.id,
      credit_date: date,
      amount_cents: amount,
      notes: optionalStr(payload.notes, 'Notes', 1000) || `Refund from the supplier on ${config.label} ${job.number}`,
    });
    const credit = supplierCreditService.getSupplierCredit(db, creditId);
    audit.record(db, {
      entity_type: sourceType,
      entity_id: job.id,
      entity_number: job.number,
      action: 'supplier_refund',
      remarks: `Refund from the supplier on ${bill.number} · ${credit.number}`,
      amount_cents: amount,
    });
    return credit;
  })();
}

module.exports = { refundCustomer, supplierRefund, refundLists };
