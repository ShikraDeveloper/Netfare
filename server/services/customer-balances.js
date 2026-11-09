'use strict';

const { notFound, todayISO } = require('../util');

// Every balance here is derived from the live accounting documents. Nothing is
// cached, so the page always agrees with the ledger after a refund, credit,
// advance application or cancellation settlement.
const balanceSelect = `
  SELECT c.id, c.number, c.name, c.email, c.phone, c.address, c.notes, c.nationality, c.is_active,
    c.created_at, c.created_by, c.changed_by, c.changed_at,
    (SELECT MIN(i.due_date) FROM invoices i
     WHERE i.customer_id = c.id AND i.status = 'sent'
       AND (i.total_cents - i.amount_paid_cents - i.credit_applied_cents) > 0) AS oldest_due_date,
    COALESCE((
      SELECT COUNT(*) FROM invoices i
      WHERE i.customer_id = c.id AND i.status = 'sent'
        AND (i.total_cents - i.amount_paid_cents - i.credit_applied_cents) > 0
    ), 0) AS open_invoice_count,
    COALESCE((
      SELECT SUM(MAX(0, i.total_cents - i.amount_paid_cents - i.credit_applied_cents))
      FROM invoices i WHERE i.customer_id = c.id AND i.status = 'sent'
    ), 0) AS outstanding_cents,
    COALESCE((
      SELECT SUM(MAX(0, i.total_cents - i.amount_paid_cents - i.credit_applied_cents))
      FROM invoices i
      WHERE i.customer_id = c.id AND i.status = 'sent' AND i.due_date < ?
    ), 0) AS overdue_cents,
    COALESCE((
      SELECT SUM(MAX(0, cn.amount_cents - cn.applied_cents - cn.refunded_cents))
      FROM credit_notes cn WHERE cn.customer_id = c.id AND cn.status = 'issued'
    ), 0) AS unapplied_credit_cents,
    COALESCE((
      SELECT SUM(MAX(0, a.amount_cents - a.applied_cents - a.refunded_cents))
      FROM customer_advances a WHERE a.customer_id = c.id AND a.voided_at IS NULL
    ), 0) AS advance_cents,
    COALESCE((
      SELECT SUM(MAX(0, cc.refund_due_cents
        - COALESCE((
            SELECT SUM(r.amount_cents) FROM refunds r
            WHERE r.cancellation_id = cc.id AND r.status = 'paid'
          ), 0)
        - COALESCE((
            SELECT SUM(cn2.amount_cents) FROM credit_notes cn2
            WHERE cn2.cancellation_id = cc.id AND cn2.status = 'issued'
          ), 0)
      ))
      FROM cancellations cc WHERE cc.customer_id = c.id
    ), 0) AS cancellation_refund_cents
  FROM customers c
`;

function decorate(row) {
  const outstanding = Number(row.outstanding_cents) || 0;
  const unappliedCredits = Number(row.unapplied_credit_cents) || 0;
  const advances = Number(row.advance_cents) || 0;
  const refundPayable = Number(row.cancellation_refund_cents) || 0;
  const creditBalance = unappliedCredits + advances + refundPayable;
  return {
    ...row,
    outstanding_cents: outstanding,
    overdue_cents: Number(row.overdue_cents) || 0,
    open_invoice_count: Number(row.open_invoice_count) || 0,
    unapplied_credit_cents: unappliedCredits,
    advance_cents: advances,
    cancellation_refund_cents: refundPayable,
    credit_balance_cents: creditBalance,
    net_balance_cents: outstanding - creditBalance,
  };
}

function listCustomerBalances(db, { search, include_inactive, only_with_balance } = {}) {
  const rows = db.prepare(balanceSelect).all(todayISO()).map(decorate);
  const term = String(search || '').trim().toLowerCase();
  const withInactive = include_inactive === true || include_inactive === '1' || include_inactive === 'true';
  const withBalance = only_with_balance === true || only_with_balance === '1' || only_with_balance === 'true';
  // Who owes the longest first (oldest unpaid due date, then the larger
  // amount); then customers we owe money to; then everyone else by name.
  const group = (row) => (row.outstanding_cents > 0 ? 0 : row.credit_balance_cents > 0 ? 1 : 2);
  rows.sort((a, b) => group(a) - group(b)
    || (group(a) === 0 ? String(a.oldest_due_date).localeCompare(String(b.oldest_due_date)) || b.outstanding_cents - a.outstanding_cents : 0)
    || (group(a) === 1 ? b.credit_balance_cents - a.credit_balance_cents : 0)
    || String(a.name).localeCompare(String(b.name)));
  return rows.filter((row) => {
    if (!withInactive && !row.is_active) return false;
    if (withBalance
      && row.outstanding_cents === 0
      && row.credit_balance_cents === 0) return false;
    if (!term) return true;
    return [row.name, row.email, row.phone, row.notes]
      .some((value) => String(value || '').toLowerCase().includes(term));
  });
}

function openInvoices(db, customerId) {
  return db.prepare(`
    SELECT i.id, i.number, i.issue_date, i.due_date, i.status,
           i.total_cents, i.amount_paid_cents, i.credit_applied_cents,
           MAX(0, i.total_cents - i.amount_paid_cents - i.credit_applied_cents) AS balance_cents,
           b.number AS booking_number, v.number AS visa_number, v.applicant_name
    FROM invoices i
    LEFT JOIN bookings b ON b.id = i.booking_id
    LEFT JOIN visa_applications v ON v.id = i.visa_id
    WHERE i.customer_id = ? AND i.status = 'sent'
      AND (i.total_cents - i.amount_paid_cents - i.credit_applied_cents) > 0
    ORDER BY i.due_date, i.issue_date, i.id
  `).all(customerId);
}

function customerCredits(db, customerId) {
  return db.prepare(`
    SELECT cn.id, cn.number, cn.credit_date, cn.amount_cents, cn.applied_cents, cn.refunded_cents,
           cn.cancellation_id, cc.number AS cancellation_number,
           (cn.amount_cents - cn.applied_cents - cn.refunded_cents) AS remaining_cents
    FROM credit_notes cn
    LEFT JOIN cancellations cc ON cc.id = cn.cancellation_id
    WHERE cn.customer_id = ? AND cn.status = 'issued'
      AND cn.amount_cents > cn.applied_cents + cn.refunded_cents
    ORDER BY cn.credit_date, cn.id
  `).all(customerId);
}

function customerAdvances(db, customerId) {
  return db.prepare(`
    SELECT a.id, a.number, a.advance_date, a.amount_cents, a.applied_cents, a.refunded_cents, a.is_receipt,
           a.booking_id, a.visa_id, b.number AS booking_number, v.number AS visa_number,
           (a.amount_cents - a.applied_cents - a.refunded_cents) AS remaining_cents
    FROM customer_advances a
    LEFT JOIN bookings b ON b.id = a.booking_id
    LEFT JOIN visa_applications v ON v.id = a.visa_id
    WHERE a.customer_id = ? AND a.voided_at IS NULL
      AND a.amount_cents > a.applied_cents + a.refunded_cents
    ORDER BY a.advance_date, a.id
  `).all(customerId);
}

function cancellationRefunds(db, customerId) {
  return db.prepare(`
    SELECT cc.id, cc.number, cc.cancellation_date, cc.refund_due_cents,
           cc.source_type, cc.source_id,
           COALESCE((
             SELECT SUM(r.amount_cents) FROM refunds r
             WHERE r.cancellation_id = cc.id AND r.status = 'paid'
           ), 0) AS refunded_cents,
           COALESCE((
             SELECT SUM(cn.amount_cents) FROM credit_notes cn
             WHERE cn.cancellation_id = cc.id AND cn.status = 'issued'
           ), 0) AS credited_cents
    FROM cancellations cc
    WHERE cc.customer_id = ?
    ORDER BY cc.cancellation_date, cc.id
  `).all(customerId).map((row) => ({
    ...row,
    refunded_cents: Number(row.refunded_cents) || 0,
    credited_cents: Number(row.credited_cents) || 0,
    remaining_cents: Math.max(
      0,
      row.refund_due_cents - (Number(row.refunded_cents) || 0) - (Number(row.credited_cents) || 0),
    ),
  })).filter((row) => row.remaining_cents > 0);
}

function getCustomerBalance(db, customerId) {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Customer not found');
  const row = db.prepare(`${balanceSelect} WHERE c.id = ?`).get(todayISO(), id);
  if (!row) throw notFound('Customer not found');
  const customer = decorate(row);
  return {
    generated_at: todayISO(),
    customer,
    summary: {
      open_invoice_count: customer.open_invoice_count,
      outstanding_cents: customer.outstanding_cents,
      overdue_cents: customer.overdue_cents,
      unapplied_credit_cents: customer.unapplied_credit_cents,
      advance_cents: customer.advance_cents,
      cancellation_refund_cents: customer.cancellation_refund_cents,
      credit_balance_cents: customer.credit_balance_cents,
      net_balance_cents: customer.net_balance_cents,
    },
    open_invoices: openInvoices(db, id),
    credits: customerCredits(db, id),
    advances: customerAdvances(db, id),
    cancellation_refunds: cancellationRefunds(db, id),
  };
}

module.exports = {
  listCustomerBalances,
  getCustomerBalance,
};
