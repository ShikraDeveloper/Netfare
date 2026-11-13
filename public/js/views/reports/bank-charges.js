import { store } from '../../store.js';
import { emptyState, esc, fmtDate, fmtMoney } from '../../ui.js';
import { periodLabel, reportHeader } from './common.js';

// Bank charges (6700) and card / payment-link fees (6710) in the period, each
// with what it was on; totals by kind and by month.
export function bankCharges(data) {
  const company = store.settings?.company_name || 'My Company';
  const head = reportHeader('Bank Charges & Card Fees', periodLabel(data.from, data.to), company);
  if (!data.rows.length) {
    return `<div class="report-card">${head}${emptyState({ iconName: 'cash', title: 'No bank charges or card fees in this period' })}</div>`;
  }
  const t = data.totals;
  const kinds = Object.entries(t.by_kind).sort((a, b) => b[1] - a[1]);
  const months = Object.entries(t.by_month).sort((a, b) => a[0].localeCompare(b[0]));
  return `
    <div class="report-card" data-bank-charges>
      ${head}
      <div class="account-summary">
        <div class="summary-tile"><span>Bank charges (6700)</span><strong>${fmtMoney(t.bank_charges_cents)}</strong></div>
        <div class="summary-tile"><span>Card &amp; payment link fees (6710)</span><strong>${fmtMoney(t.card_fees_cents)}</strong></div>
        <div class="summary-tile"><span>Total</span><strong>${fmtMoney(t.total_cents)}</strong></div>
      </div>
      <div class="table-wrap">
        <table class="report-table" data-bank-charges-kinds><caption class="sr-only">Charges by kind</caption>
          <thead><tr><th scope="col">Kind</th><th scope="col" class="num">Amount</th></tr></thead>
          <tbody>${kinds.map(([kind, cents]) => `<tr><td>${esc(data.kind_labels[kind] || kind)}</td><td class="num">${fmtMoney(cents)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      ${months.length > 1 ? `
      <div class="table-wrap">
        <table class="report-table"><caption class="sr-only">Charges by month</caption>
          <thead><tr><th scope="col">Month</th><th scope="col" class="num">Amount</th></tr></thead>
          <tbody>${months.map(([month, cents]) => `<tr><td>${esc(new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</td><td class="num">${fmtMoney(cents)}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : ''}
      <div class="table-wrap">
        <table class="report-table" data-bank-charges-rows><caption class="sr-only">Every charge</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Kind</th>
              <th scope="col">On</th>
              <th scope="col">Customer / supplier</th>
              <th scope="col">Bank account</th>
              <th scope="col" class="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${data.rows.map((row) => `
              <tr>
                <td class="nowrap">${esc(fmtDate(row.date))}</td>
                <td>${esc(row.kind_label || row.kind)}</td>
                <td><a href="${esc(row.document.href)}">${esc(row.document.number)}</a>${row.detail ? `<div class="cell-sub">${esc(row.detail)}</div>` : ''}</td>
                <td>${esc(row.party || '—')}</td>
                <td class="muted">${esc(row.bank_account || '—')}</td>
                <td class="num">${fmtMoney(row.amount_cents)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot><tr><td colspan="5">Total</td><td class="num">${fmtMoney(t.total_cents)}</td></tr></tfoot>
        </table>
      </div>
    </div>
  `;
}
