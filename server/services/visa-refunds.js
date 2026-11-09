'use strict';

// Money that goes back after a visa is done or rejected, recorded from the
// visa page. Two plain documents, both linked to the visa:
//   - a refund to the customer: a credit note on the visa invoice. It first
//     lowers what the customer still owes; anything above that is paid back
//     from the chosen bank or cash account, or kept as their credit.
//   - a refund from the supplier: a supplier credit on the visa's bill. The
//     money stays with the supplier: it first clears what is unpaid on the
//     bill, then goes to the prepaid portal wallet or is held as credit with
//     the supplier. It is taken into the bank or cash only when the supplier
//     pays it out (Receive refund on the supplier statement, or Withdraw on
//     the portal).
// The invoice and the bill stay as they are; profit is the invoice less
// refunds to the customer, and the bill less refunds from the supplier.

const { bad, notFound, optionalStr, cents, dateISO, todayISO } = require('../util');
const { invoiceBalanceCents, isCashAccount } = require('../accounting');
const creditService = require('./credits');
const supplierCreditService = require('./supplier-credits');
const audit = require('./audit');

function visaRow(db, visaId) {
  const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(Number(visaId));
  if (!visa) throw notFound('Visa application not found');
  return visa;
}

function cashAccount(db, accountId) {
  if (!accountId) return null;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!account || !account.is_active || !isCashAccount(account)) throw bad('Choose an active bank or cash account');
  return account;
}

function customerRefundedCents(db, visaId) {
  return db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total FROM credit_notes WHERE visa_id = ? AND status = 'issued'
  `).get(Number(visaId)).total;
}

function refundCustomer(db, visaId, payload = {}) {
  return db.transaction(() => {
    const visa = visaRow(db, visaId);
    const invoice = visa.invoice_id ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(visa.invoice_id) : null;
    if (!invoice || invoice.status !== 'sent') throw bad('This visa has no open invoice to refund');
    const limit = invoice.total_cents - customerRefundedCents(db, visa.id);
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
      notes: optionalStr(payload.notes, 'Notes', 1000) || `Refund on visa ${visa.number}`,
    });
    db.prepare('UPDATE credit_notes SET visa_id = ? WHERE id = ?').run(visa.id, credit.id);
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
      entity_type: 'visa',
      entity_id: visa.id,
      entity_number: visa.number,
      action: 'refund',
      remarks: `Refund to the customer · credit note ${credit.number}`,
      amount_cents: amount,
    });
    return creditService.getCredit(db, credit.id);
  })();
}

function supplierRefund(db, visaId, payload = {}) {
  return db.transaction(() => {
    const visa = visaRow(db, visaId);
    const bill = db.prepare("SELECT * FROM bills WHERE id = ? AND visa_id = ? AND status = 'received'")
      .get(Number(payload.bill_id), visa.id);
    if (!bill) throw bad('Choose a supplier bill of this visa');
    const amount = cents(payload.amount_cents, 'Refund amount', { min: 1 });
    const date = dateISO(payload.date || todayISO(), 'Date');
    if (date < bill.bill_date) throw bad('The date cannot be before the bill date');
    const creditId = supplierCreditService.createSupplierCreditForCancellation(db, {
      vendor_id: bill.vendor_id,
      bill_id: bill.id,
      visa_id: visa.id,
      credit_date: date,
      amount_cents: amount,
      notes: optionalStr(payload.notes, 'Notes', 1000) || `Refund from the supplier on visa ${visa.number}`,
    });
    const credit = supplierCreditService.getSupplierCredit(db, creditId);
    audit.record(db, {
      entity_type: 'visa',
      entity_id: visa.id,
      entity_number: visa.number,
      action: 'supplier_refund',
      remarks: `Refund from the supplier on ${bill.number} · ${credit.number}`,
      amount_cents: amount,
    });
    return credit;
  })();
}

module.exports = { refundCustomer, supplierRefund, customerRefundedCents };
