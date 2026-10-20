import { store } from '../../store.js';
import { emptyState, esc, fmtDate, fmtMoney } from '../../ui.js';
import { reportHeader } from './common.js';

export function agingReport(data, kind) {
  const company = store.settings?.company_name || 'My Company';
  const title = kind === 'ar' ? 'Accounts Receivable Aging' : 'Accounts Payable Aging';
  if (!data.rows.length) {
    return `
      <div class="report-card">
        ${reportHeader(title, `As of ${fmtDate(data.as_of, { long: true })}`, company)}
        ${emptyState({
    iconName: kind === 'ar' ? 'invoice' : 'bill',
    title: kind === 'ar' ? 'Nothing outstanding' : 'No bills outstanding',
    message: kind === 'ar' ? 'Every sent invoice has been paid.' : 'Every received bill has been paid.',
  })}
      </div>
    `;
  }

  return `
    <div class="report-card">
      ${reportHeader(title, `As of ${fmtDate(data.as_of, { long: true })}`, company)}
      <div class="table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              <th>${kind === 'ar' ? 'Customer' : 'Vendor'}</th>
              <th class="num">Current</th>
              <th class="num">1–30 days</th>
              <th class="num">31–60 days</th>
              <th class="num">61–90 days</th>
              <th class="num">90+ days</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody>
            ${data.rows.map((row) => `
              <tr>
                <td>${esc(row.party_name)}</td>
                <td class="num">${row.current_cents ? fmtMoney(row.current_cents) : '—'}</td>
                <td class="num">${row.days_1_30_cents ? fmtMoney(row.days_1_30_cents) : '—'}</td>
                <td class="num">${row.days_31_60_cents ? fmtMoney(row.days_31_60_cents) : '—'}</td>
                <td class="num">${row.days_61_90_cents ? fmtMoney(row.days_61_90_cents) : '—'}</td>
                <td class="num">${row.days_90_plus_cents ? fmtMoney(row.days_90_plus_cents) : '—'}</td>
                <td class="num" style="font-weight:650">${fmtMoney(row.total_cents)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td class="num">${fmtMoney(data.totals.current_cents)}</td>
              <td class="num">${fmtMoney(data.totals.days_1_30_cents)}</td>
              <td class="num">${fmtMoney(data.totals.days_31_60_cents)}</td>
              <td class="num">${fmtMoney(data.totals.days_61_90_cents)}</td>
              <td class="num">${fmtMoney(data.totals.days_90_plus_cents)}</td>
              <td class="num">${fmtMoney(data.totals.total_cents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}

