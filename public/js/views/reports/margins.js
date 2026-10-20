import { store } from '../../store.js';
import { emptyState, esc, fmtMoney, statusBadge } from '../../ui.js';
import { periodLabel, reportHeader } from './common.js';

export function bookingMargin(data) {
  const company = store.settings?.company_name || 'My Company';
  if (!data.rows.length) {
    return `
      <div class="report-card">
        ${reportHeader('Booking Margin', periodLabel(data.from, data.to), company)}
        ${emptyState({
    iconName: 'plane',
    title: 'No bookings in this period',
    message: 'Create a travel booking to track sale price, supplier cost and margin.',
  })}
      </div>
    `;
  }

  return `
    <div class="report-card">
      ${reportHeader('Booking Margin', periodLabel(data.from, data.to), company)}
      <div class="table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              <th>Booking</th>
              <th>Customer</th>
              <th>Destination</th>
              <th class="num">Sale</th>
              <th class="num">Cost</th>
              <th class="num">Margin</th>
              <th class="num">Margin %</th>
            </tr>
          </thead>
          <tbody>
            ${data.rows.map((row) => {
    const pct = row.sale_total_cents ? (row.margin_cents / row.sale_total_cents) * 100 : 0;
    return `
                <tr>
                  <td><a href="#/bookings/${row.id}">${esc(row.number)}</a></td>
                  <td>${esc(row.customer_name)}</td>
                  <td class="muted">${esc(row.destination || '—')}</td>
                  <td class="num">${fmtMoney(row.sale_total_cents)}</td>
                  <td class="num">${fmtMoney(row.cost_total_cents)}</td>
                  <td class="num ${row.margin_cents >= 0 ? 'margin-positive' : 'margin-negative'}">${fmtMoney(row.margin_cents)}</td>
                  <td class="num">${pct.toFixed(1)}%</td>
                </tr>`;
  }).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3">Totals</td>
              <td class="num">${fmtMoney(data.totals.sale_cents)}</td>
              <td class="num">${fmtMoney(data.totals.cost_cents)}</td>
              <td class="num">${fmtMoney(data.totals.margin_cents)}</td>
              <td class="num">${data.totals.margin_percent.toFixed(1)}%</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}

export function visaMargin(data) {
  const company = store.settings?.company_name || 'My Company';
  if (!data.rows.length) {
    return `
      <div class="report-card">
        ${reportHeader('Visa Margin', periodLabel(data.from, data.to), company)}
        ${emptyState({
    iconName: 'visa',
    title: 'No visa applications in this period',
    message: 'Create a visa application to track sale price, supplier cost and margin. Rejected and cancelled applications are excluded.',
  })}
      </div>
    `;
  }

  return `
    <div class="report-card">
      ${reportHeader('Visa Margin', periodLabel(data.from, data.to), company)}
      <div class="table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              <th>Visa</th>
              <th>Applicant</th>
              <th>Destination</th>
              <th>Type</th>
              <th>Status</th>
              <th class="num">Sale</th>
              <th class="num">Cost</th>
              <th class="num">Margin</th>
              <th class="num">Margin %</th>
            </tr>
          </thead>
          <tbody>
            ${data.rows.map((row) => {
    const pct = row.sale_total_cents ? (row.margin_cents / row.sale_total_cents) * 100 : 0;
    const type = row.visa_type ? row.visa_type.charAt(0).toUpperCase() + row.visa_type.slice(1) : '—';
    return `
                <tr>
                  <td><a href="#/visas/${row.id}">${esc(row.number)}</a></td>
                  <td>${esc(row.applicant_name || row.customer_name)}</td>
                  <td class="muted">${esc(row.destination_country || '—')}</td>
                  <td>${esc(type)}</td>
                  <td>${statusBadge(row.status)}</td>
                  <td class="num">${fmtMoney(row.sale_total_cents)}</td>
                  <td class="num">${fmtMoney(row.cost_total_cents)}</td>
                  <td class="num ${row.margin_cents >= 0 ? 'margin-positive' : 'margin-negative'}">${fmtMoney(row.margin_cents)}</td>
                  <td class="num">${pct.toFixed(1)}%</td>
                </tr>`;
  }).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="5">Totals</td>
              <td class="num">${fmtMoney(data.totals.sale_cents)}</td>
              <td class="num">${fmtMoney(data.totals.cost_cents)}</td>
              <td class="num">${fmtMoney(data.totals.margin_cents)}</td>
              <td class="num">${data.totals.margin_percent.toFixed(1)}%</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}

