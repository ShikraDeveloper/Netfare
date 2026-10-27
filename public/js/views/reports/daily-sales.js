import { store } from '../../store.js';
import { emptyState, esc, fmtDate, fmtMoney, icon } from '../../ui.js';
import { periodLabel, reportHeader } from './common.js';

export function dailySales(data) {
  const company = store.settings?.company_name || 'My Company';
  const salesLabel = (count) => `${count} sale${count === 1 ? '' : 's'}`;

  if (!data.days.length) {
    return `
      <div class="report-card">
        ${reportHeader('Daily Sales Report', periodLabel(data.from, data.to), company)}
        ${emptyState({
    iconName: 'invoice',
    title: 'No sales in this period',
    message: 'Send an invoice, confirm a booking or submit a visa application to see the daily sales report.',
  })}
      </div>
    `;
  }

  return `
    <div class="report-card">
      ${reportHeader('Daily Sales Report', periodLabel(data.from, data.to), company)}
      <div class="account-summary daily-summary">
        <div class="summary-tile"><span>Sales</span><strong>${fmtMoney(data.totals.sale_cents)}</strong></div>
        <div class="summary-tile"><span>Cost</span><strong>${fmtMoney(data.totals.cost_cents)}</strong></div>
        <div class="summary-tile">
          <span>Margin</span>
          <strong>${fmtMoney(data.totals.margin_cents)}</strong>
          <small class="sub">${data.totals.margin_percent.toFixed(1)}% margin</small>
        </div>
        <div class="summary-tile"><span>Paid</span><strong>${fmtMoney(data.totals.paid_cents)}</strong></div>
        <div class="summary-tile"><span>Outstanding</span><strong>${fmtMoney(data.totals.balance_cents)}</strong></div>
        <div class="summary-tile">
          <span>Cash in hand</span>
          <strong>${fmtMoney(data.cash?.cash_cents || 0)}</strong>
          <small class="sub">${esc(data.cash?.bank_label || 'Bank')} ${fmtMoney(data.cash?.bank_cents || 0)}</small>
        </div>
      </div>
      <div class="table-wrap">
        <table class="report-table daily-sales-table"><caption class="sr-only">Daily sales register</caption>
          <thead>
            <tr>
              <th scope="col">Invoice</th>
              <th scope="col">Customer</th>
              <th scope="col" class="num">Sale</th>
              <th scope="col" class="num">Cost</th>
              <th scope="col" class="num">Margin</th>
              <th scope="col" class="num">Paid</th>
              <th scope="col" class="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            ${data.days.map((day) => {
    const rows = day.rows.map((row) => {
      const source = row.reference
        ? (row.kind === 'booking'
          ? `<a href="#/bookings/${row.reference_id}">${esc(row.reference)}</a>`
          : `<a href="#/visas/${row.reference_id}">${esc(row.reference)}</a>`)
        : '<span class="dsr-service-income">Service income · no supplier cost</span>';
      // A cancellation is its own line on the cancellation date; the sale it
      // reverses stays on its own day, marked as cancelled.
      const link = row.is_cancellation
        ? `<a href="#/cancellations/${row.cancellation_id}">${esc(row.number)}</a>`
        : `<a href="#/invoices/${row.id}">${esc(row.number)}</a>`;
      const note = row.is_cancellation
        ? `<div class="cell-sub dsr-reversal">Reverses ${fmtMoney(row.reversed_sale_cents)} sale · charges ${fmtMoney(row.charges_cents)}${row.supplier_credits_cents ? ` · supplier credit ${fmtMoney(row.supplier_credits_cents)}` : ''}${row.charges_invoice_number ? ` · ${esc(row.charges_invoice_number)}` : ''}</div>`
        : row.cancelled_by
          ? `<div class="cell-sub"><span class="badge badge-cancelled">Cancelled</span> ${esc(fmtDate(row.cancelled_by.date))} · <a href="#/cancellations/${row.cancelled_by.id}">${esc(row.cancelled_by.number)}</a></div>`
          : '';
      return `
                <tr${row.is_cancellation ? ' class="dsr-cancellation-row"' : ''}>
                  <td>
                    <div>${link}</div>
                    <div class="cell-sub">${source}</div>
                    ${note}
                  </td>
                  <td>
                    <div class="cell-main">${esc(row.customer_name)}</div>
                    ${row.particulars ? `<div class="cell-sub">${esc(row.particulars)}</div>` : ''}
                  </td>
                  <td class="num">${fmtMoney(row.sale_cents)}</td>
                  <td class="num">${row.cost_cents ? fmtMoney(row.cost_cents) : '—'}</td>
                  <td class="num ${row.margin_cents >= 0 ? 'margin-positive' : 'margin-negative'}">${fmtMoney(row.margin_cents)}</td>
                  <td class="num">${fmtMoney(row.paid_cents)}</td>
                  <td class="num">${row.balance_cents ? fmtMoney(row.balance_cents) : '—'}</td>
                </tr>`;
    }).join('');

    const dayTotal = data.days.length > 1
      ? `
              <tr class="report-day-total">
                <td colspan="2">Day total · ${salesLabel(day.invoice_count)}</td>
                <td class="num">${fmtMoney(day.sale_cents)}</td>
                <td class="num">${fmtMoney(day.cost_cents)}</td>
                <td class="num">${fmtMoney(day.margin_cents)}</td>
                <td class="num">${fmtMoney(day.paid_cents)}</td>
                <td class="num">${fmtMoney(day.balance_cents)}</td>
              </tr>`
      : '';

    return `
            <tr class="report-day-head">
              <td colspan="7">
                <div class="report-day-line">
                  <span>${fmtDate(day.date, { long: true })} · ${salesLabel(day.invoice_count)}</span>
                  <span class="report-day-cash">Cash in hand ${fmtMoney(day.cash_cents || 0)} · ${esc(data.cash?.bank_label || 'Bank')} ${fmtMoney(day.bank_cents || 0)}</span>
                </div>
              </td>
            </tr>
            ${rows}
            ${dayTotal}`;
  }).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2">Totals · ${salesLabel(data.totals.invoice_count)}</td>
              <td class="num">${fmtMoney(data.totals.sale_cents)}</td>
              <td class="num">${fmtMoney(data.totals.cost_cents)}</td>
              <td class="num">${fmtMoney(data.totals.margin_cents)}</td>
              <td class="num">${fmtMoney(data.totals.paid_cents)}</td>
              <td class="num">${fmtMoney(data.totals.balance_cents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="report-balance-note">
        ${icon('check', 14)} A sale stays on the day it was made. When a booking or visa is cancelled, a separate cancellation line on the cancellation date reverses the sale and the supplier credit and adds the charges kept. Cost is the supplier bills posted for each booking or visa. Service invoices are income with no supplier cost, so their full amount is margin. Paid and balance are current as of today. Cash in hand and bank are closing balances for each day, and at the period end in the summary.
      </div>
    </div>
  `;
}

