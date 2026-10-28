'use strict';

const { dateISO, todayISO } = require('../../util');
const { invoiceDisplayStatus } = require('../../accounting');
const { cashBalances } = require('./aging');
const jobCosts = require('../job-costs');
const { dsrSections } = require('./dsr-sections');

function dailySales(db, from, to) {
  const start = dateISO(from, 'From date');
  const end = dateISO(to, 'To date');
  const today = todayISO();
  // Cost comes from the supplier bills actually posted for each job, less any
  // supplier credits, so a reissued or credited ticket shows its real margin.
  const bookingCosts = jobCosts.jobCostMap(db, 'booking');
  const visaCosts = jobCosts.jobCostMap(db, 'visa');

  const invoices = db.prepare(`
    SELECT i.id, i.number, i.issue_date, i.status, i.subtotal_cents,
           i.total_cents, i.amount_paid_cents, i.credit_applied_cents, i.booking_id, i.visa_id,
           c.name AS customer_name,
           b.number AS booking_number, b.destination,
           v.number AS visa_number, v.destination_country, v.visa_type,
           v.applicant_name,
           (SELECT ii.description FROM invoice_items ii
            WHERE ii.invoice_id = i.id
            ORDER BY ii.sort_order, ii.id LIMIT 1) AS particulars,
           x.id AS cancelled_by_id, x.number AS cancelled_by_number, x.cancellation_date AS cancelled_on
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN bookings b ON b.id = i.booking_id
    LEFT JOIN visa_applications v ON v.id = i.visa_id
    LEFT JOIN cancellations x ON x.invoice_id = i.id
    -- A sale cancelled later stays on the day it was made; the cancellation
    -- appears as its own line on the cancellation date. Invoices voided as
    -- mistakes are left out.
    WHERE (i.status = 'sent' OR (i.status = 'void' AND x.id IS NOT NULL))
      AND i.cancellation_id IS NULL
      AND i.issue_date >= ? AND i.issue_date <= ?
    ORDER BY i.issue_date, i.id
  `).all(start, end);

  const cancellations = db.prepare(`
    SELECT cc.*, c.name AS customer_name,
           oi.subtotal_cents AS original_sale_cents, oi.amount_paid_cents AS original_paid_cents,
           COALESCE((SELECT SUM(scn.amount_cents) FROM supplier_credit_notes scn
                     WHERE scn.cancellation_id = cc.id AND scn.status = 'issued'), 0) AS supplier_credits_cents,
           b.number AS booking_number, b.destination,
           v.number AS visa_number, v.destination_country, v.visa_type,
           v.applicant_name,
           ci.amount_paid_cents AS cancellation_invoice_paid_cents,
           ci.credit_applied_cents AS cancellation_invoice_credit_cents,
           ci.status AS cancellation_invoice_status
    FROM cancellations cc
    JOIN customers c ON c.id = cc.customer_id
    LEFT JOIN bookings b ON cc.source_type = 'booking' AND b.id = cc.source_id
    LEFT JOIN visa_applications v ON cc.source_type = 'visa' AND v.id = cc.source_id
    LEFT JOIN invoices ci ON ci.id = cc.cancellation_invoice_id
    LEFT JOIN invoices oi ON oi.id = cc.invoice_id
    WHERE cc.cancellation_date >= ? AND cc.cancellation_date <= ?
    ORDER BY cc.cancellation_date, cc.id
  `).all(start, end);

  // Supplier credits raised by a cancellation belong to the cancellation line,
  // so the original sale keeps the cost it had on the day it was made.
  const cancellationCredits = new Map();
  for (const row of db.prepare(`
    SELECT COALESCE(booking_id, 0) AS booking_id, COALESCE(visa_id, 0) AS visa_id, SUM(amount_cents) AS total
    FROM supplier_credit_notes WHERE cancellation_id IS NOT NULL AND status = 'issued'
    GROUP BY booking_id, visa_id
  `).all()) {
    if (row.booking_id) cancellationCredits.set(`booking:${row.booking_id}`, row.total);
    if (row.visa_id) cancellationCredits.set(`visa:${row.visa_id}`, row.total);
  }

  const items = [];
  for (const row of invoices) {
    const kind = row.booking_id ? 'booking' : row.visa_id ? 'visa' : 'direct';
    const jobCost = kind === 'booking'
      ? (bookingCosts.get(row.booking_id) || 0)
      : kind === 'visa'
        ? (visaCosts.get(row.visa_id) || 0)
        : 0;
    // Supplier credits raised by a cancellation belong to the cancellation
    // line, whenever it happened. The sale only counts as cancelled in this
    // report if the cancellation is on or before the period end, so a report
    // for an earlier period reads the same as when it was first printed.
    const hasCancellation = Boolean(row.cancelled_by_id);
    const cancelled = hasCancellation && row.cancelled_on <= end;
    const cost = hasCancellation && kind !== 'direct'
      ? jobCost + (cancellationCredits.get(`${kind}:${row.booking_id || row.visa_id}`) || 0)
      : jobCost;
    const sale = row.subtotal_cents;
    let particulars = row.particulars || '';
    if (!particulars && kind === 'booking') particulars = row.destination || '';
    if (!particulars && kind === 'visa') {
      const type = row.visa_type ? row.visa_type.charAt(0).toUpperCase() + row.visa_type.slice(1) : '';
      particulars = [row.destination_country, type ? `${type} visa` : ''].filter(Boolean).join(' · ');
    }

    items.push({
      id: row.id,
      number: row.number,
      issue_date: row.issue_date,
      customer_name: row.customer_name,
      kind,
      reference: row.booking_number || row.visa_number || null,
      reference_id: row.booking_id || row.visa_id || null,
      particulars,
      sale_cents: sale,
      cost_cents: cost,
      margin_cents: sale - cost,
      paid_cents: row.amount_paid_cents,
      balance_cents: cancelled ? 0 : Math.max(0, row.total_cents - row.amount_paid_cents - (row.credit_applied_cents || 0)),
      status_display: cancelled ? 'cancelled' : invoiceDisplayStatus({ ...row, status: 'sent' }, today),
      is_cancellation: false,
      cancelled_by: cancelled
        ? { id: row.cancelled_by_id, number: row.cancelled_by_number, date: row.cancelled_on }
        : null,
    });
  }

  for (const row of cancellations) {
    const retainedCost = (row.source_type === 'booking' ? bookingCosts : visaCosts).get(row.source_id) || 0;
    const originalSale = row.original_sale_cents || 0;
    const sale = row.customer_charges_cents || 0;
    const heldApplied = Math.min(row.received_cents || 0, sale);
    const invoiceOpen = row.cancellation_invoice_status === 'sent';
    const invoicePaid = invoiceOpen ? row.cancellation_invoice_paid_cents || 0 : 0;
    const invoiceCredits = invoiceOpen ? row.cancellation_invoice_credit_cents || 0 : 0;
    const paid = heldApplied + invoicePaid;
    // If the shortfall invoice was voided, only the charges taken from money
    // already received remain recognised income.
    const recognizedSale = row.cancellation_invoice_id && !invoiceOpen ? heldApplied : sale;
    const particulars = [
      `Cancellation ${row.number}`,
      row.source_type === 'booking' ? row.booking_number : row.visa_number,
      row.reason || '',
    ].filter(Boolean).join(' · ');

    items.push({
      id: row.id,
      number: row.number,
      charges_invoice_id: row.cancellation_invoice_id || null,
      charges_invoice_number: row.cancellation_invoice_id
        ? db.prepare('SELECT number FROM invoices WHERE id = ?').get(row.cancellation_invoice_id)?.number || null
        : null,
      issue_date: row.cancellation_date,
      customer_name: row.customer_name,
      kind: row.source_type,
      reference: row.source_type === 'booking' ? row.booking_number : row.visa_number,
      reference_id: row.source_id,
      particulars,
      // The cancellation reverses the original sale and its refunded cost,
      // and adds the charges the customer keeps paying.
      sale_cents: recognizedSale - originalSale,
      cost_cents: 0 - row.supplier_credits_cents,
      margin_cents: recognizedSale - originalSale + row.supplier_credits_cents,
      paid_cents: paid - (row.original_paid_cents || 0),
      charges_cents: recognizedSale,
      reversed_sale_cents: originalSale,
      supplier_credits_cents: row.supplier_credits_cents,
      balance_cents: invoiceOpen ? Math.max(0, sale - paid - invoiceCredits) : 0,
      status_display: 'cancellation',
      is_cancellation: true,
      cancellation_id: row.id,
      cancellation_number: row.number,
      received_cents: row.received_cents || 0,
      refund_due_cents: row.refund_due_cents || 0,
      supplier_credit_total_cents: row.supplier_credit_total_cents || 0,
      retained_cost_cents: retainedCost,
    });
  }

  items.sort((a, b) => {
    if (a.issue_date !== b.issue_date) return a.issue_date < b.issue_date ? -1 : 1;
    if (a.is_cancellation !== b.is_cancellation) return a.is_cancellation ? 1 : -1;
    return a.id - b.id;
  });

  const days = [];
  const totals = {
    invoice_count: 0,
    sale_cents: 0,
    cost_cents: 0,
    margin_cents: 0,
    paid_cents: 0,
    balance_cents: 0,
  };

  let day = null;
  for (const item of items) {
    if (!day || day.date !== item.issue_date) {
      day = {
        date: item.issue_date,
        invoice_count: 0,
        sale_cents: 0,
        cost_cents: 0,
        margin_cents: 0,
        paid_cents: 0,
        balance_cents: 0,
        rows: [],
      };
      days.push(day);
    }

    day.rows.push(item);
    day.invoice_count += 1;
    totals.invoice_count += 1;
    for (const key of ['sale_cents', 'cost_cents', 'margin_cents', 'paid_cents', 'balance_cents']) {
      day[key] += item[key];
      totals[key] += item[key];
    }
  }

  totals.margin_percent = totals.sale_cents ? (totals.margin_cents / totals.sale_cents) * 100 : 0;

  const cash = cashBalances(db, end);
  const cashDates = [...cash.byDate.keys()].sort();
  let cashIndex = 0;
  let runningCash = 0;
  let runningBank = 0;
  for (const day of days) {
    while (cashIndex < cashDates.length && cashDates[cashIndex] <= day.date) {
      const balance = cash.byDate.get(cashDates[cashIndex]);
      runningCash = balance.cash_cents;
      runningBank = balance.bank_cents;
      cashIndex += 1;
    }
    day.cash_cents = runningCash;
    day.bank_cents = runningBank;
  }

  const sections = dsrSections(db, start, end, items);
  sections.summary.sales.total_cents = totals.sale_cents;

  return {
    from: start,
    to: end,
    days,
    totals,
    sections,
    cash: {
      cash_cents: cash.cash_cents,
      bank_cents: cash.bank_cents,
      cash_label: cash.cash_label,
      bank_label: cash.bank_label,
    },
  };
}


module.exports = { dailySales };
