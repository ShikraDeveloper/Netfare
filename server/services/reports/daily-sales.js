'use strict';

const { dateISO, todayISO } = require('../../util');
const { invoiceDisplayStatus } = require('../../accounting');
const { cashBalances } = require('./aging');

function dailySales(db, from, to) {
  const start = dateISO(from, 'From date');
  const end = dateISO(to, 'To date');
  const today = todayISO();

  const rows = db.prepare(`
    SELECT i.id, i.number, i.issue_date, i.status, i.subtotal_cents,
           i.total_cents, i.amount_paid_cents, i.credit_applied_cents, i.booking_id, i.visa_id,
           c.name AS customer_name,
           b.number AS booking_number, b.destination,
           b.cost_total_cents AS booking_cost_cents,
           v.number AS visa_number, v.destination_country, v.visa_type,
           v.applicant_name, v.cost_total_cents AS visa_cost_cents,
           (SELECT ii.description FROM invoice_items ii
            WHERE ii.invoice_id = i.id
            ORDER BY ii.sort_order, ii.id LIMIT 1) AS particulars
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN bookings b ON b.id = i.booking_id
    LEFT JOIN visa_applications v ON v.id = i.visa_id
    WHERE i.status = 'sent' AND i.issue_date >= ? AND i.issue_date <= ?
    ORDER BY i.issue_date, i.id
  `).all(start, end);

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
  for (const row of rows) {
    const kind = row.booking_id ? 'booking' : row.visa_id ? 'visa' : 'direct';
    const cost = kind === 'booking'
      ? (row.booking_cost_cents || 0)
      : kind === 'visa'
        ? (row.visa_cost_cents || 0)
        : 0;
    const sale = row.subtotal_cents;
    let particulars = row.particulars || '';
    if (!particulars && kind === 'booking') particulars = row.destination || '';
    if (!particulars && kind === 'visa') {
      const type = row.visa_type ? row.visa_type.charAt(0).toUpperCase() + row.visa_type.slice(1) : '';
      particulars = [row.destination_country, type ? `${type} visa` : ''].filter(Boolean).join(' · ');
    }

    const item = {
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
      balance_cents: Math.max(0, row.total_cents - row.amount_paid_cents - (row.credit_applied_cents || 0)),
      status_display: invoiceDisplayStatus(row, today),
    };

    if (!day || day.date !== row.issue_date) {
      day = {
        date: row.issue_date,
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

  return {
    from: start,
    to: end,
    days,
    totals,
    cash: {
      cash_cents: cash.cash_cents,
      bank_cents: cash.bank_cents,
      cash_label: cash.cash_label,
      bank_label: cash.bank_label,
    },
  };
}


module.exports = { dailySales };
