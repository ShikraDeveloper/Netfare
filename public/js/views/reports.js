import { api } from '../api.js';
import { store } from '../store.js';
import {
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  setHeader,
  statusBadge,
} from '../ui.js';

const REPORTS = [
  { key: 'income-statement', label: 'Income statement', title: 'Income Statement' },
  { key: 'balance-sheet', label: 'Balance sheet', title: 'Balance Sheet' },
  { key: 'trial-balance', label: 'Trial balance', title: 'Trial Balance' },
  { key: 'daily-sales', label: 'Daily sales', title: 'Daily Sales' },
  { key: 'booking-margin', label: 'Booking margin', title: 'Booking Margin' },
  { key: 'visa-margin', label: 'Visa margin', title: 'Visa Margin' },
  { key: 'portal-wallets', label: 'Portal wallets', title: 'Portal Wallets' },
  { key: 'ar-aging', label: 'A/R aging', title: 'Accounts Receivable Aging' },
  { key: 'ap-aging', label: 'A/P aging', title: 'Accounts Payable Aging' },
];

function todayISO() {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function periodLabel(from, to) {
  if (from === to) return fmtDate(from, { long: true });
  return `${fmtDate(from, { long: true })} – ${fmtDate(to, { long: true })}`;
}

function reportHeader(title, subtitle, company) {
  return `
    <div class="report-head">
      <div class="report-company">${esc(company)}</div>
      <div class="report-title">${esc(title)}</div>
      <div class="report-period">${esc(subtitle)}</div>
    </div>
  `;
}

function sectionHead(label) {
  return `<div class="report-section-head"><span>${esc(label)}</span><span>Amount</span></div>`;
}

function reportRow(label, code, amount) {
  return `
    <div class="report-row">
      <div class="row-label">${code ? `<span class="code">${esc(code)}</span>` : ''}${esc(label)}</div>
      <div class="amount">${fmtMoney(amount)}</div>
    </div>
  `;
}

function incomeStatement(data) {
  const company = store.settings?.company_name || 'My Company';
  const revenue = data.revenue.length
    ? data.revenue.map((row) => reportRow(row.name, row.code, row.amount_cents)).join('')
    : '<div class="report-row subtle"><div class="row-label">No revenue in this period</div><div class="amount">—</div></div>';
  const expenses = data.expenses.length
    ? data.expenses.map((row) => reportRow(row.name, row.code, row.amount_cents)).join('')
    : '<div class="report-row subtle"><div class="row-label">No expenses in this period</div><div class="amount">—</div></div>';

  return `
    <div class="report-card">
      ${reportHeader('Income Statement', periodLabel(data.from, data.to), company)}
      <div class="report-section">
        ${sectionHead('Revenue')}
        ${revenue}
        <div class="report-row total"><div class="row-label">Total revenue</div><div class="amount">${fmtMoney(data.revenue_total_cents)}</div></div>
      </div>
      <div class="report-section">
        ${sectionHead('Expenses')}
        ${expenses}
        <div class="report-row total"><div class="row-label">Total expenses</div><div class="amount">${fmtMoney(data.expenses_total_cents)}</div></div>
      </div>
      <div class="report-net ${data.net_income_cents < 0 ? 'negative' : ''}">
        <span>Net income</span>
        <span class="amount">${fmtMoney(data.net_income_cents)}</span>
      </div>
    </div>
  `;
}

function balanceSheet(data) {
  const company = store.settings?.company_name || 'My Company';
  const rowsFor = (rows, emptyLabel) => (rows.length
    ? rows.map((row) => reportRow(row.name, row.code, row.amount_cents)).join('')
    : `<div class="report-row subtle"><div class="row-label">${emptyLabel}</div><div class="amount">—</div></div>`);

  return `
    <div class="report-card">
      ${reportHeader('Balance Sheet', `As of ${fmtDate(data.as_of, { long: true })}`, company)}
      <div class="report-section">
        ${sectionHead('Assets')}
        ${rowsFor(data.assets, 'No asset balances')}
        <div class="report-row total"><div class="row-label">Total assets</div><div class="amount">${fmtMoney(data.asset_total_cents)}</div></div>
      </div>
      <div class="report-section">
        ${sectionHead('Liabilities')}
        ${rowsFor(data.liabilities, 'No liabilities')}
        <div class="report-row total"><div class="row-label">Total liabilities</div><div class="amount">${fmtMoney(data.liability_total_cents)}</div></div>
      </div>
      <div class="report-section">
        ${sectionHead('Equity')}
        ${rowsFor(data.equity, 'No equity balances')}
        <div class="report-row total"><div class="row-label">Total equity</div><div class="amount">${fmtMoney(data.equity_total_cents)}</div></div>
      </div>
      <div class="report-net">
        <span>Total liabilities &amp; equity</span>
        <span class="amount">${fmtMoney(data.liabilities_and_equity_cents)}</span>
      </div>
      <div class="report-balance-note">
        ${data.balanced
    ? `${icon('check', 14)} Assets equal liabilities and equity.`
    : `${icon('alert', 14)} Out of balance by ${fmtMoney(Math.abs(data.difference_cents))}. Check your journal entries.`}
      </div>
    </div>
  `;
}

function trialBalance(data) {
  const company = store.settings?.company_name || 'My Company';
  const rows = data.rows.filter((row) => row.debit_cents !== 0 || row.credit_cents !== 0);
  if (!rows.length) {
    return `
      <div class="report-card">
        ${reportHeader('Trial Balance', `As of ${fmtDate(data.as_of, { long: true })}`, company)}
        <div class="report-empty">No ledger activity yet. Post an invoice, bill or journal entry to see a trial balance.</div>
      </div>
    `;
  }

  return `
    <div class="report-card">
      ${reportHeader('Trial Balance', `As of ${fmtDate(data.as_of, { long: true })}`, company)}
      <div class="table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Account</th>
              <th class="num">Debit</th>
              <th class="num">Credit</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td class="muted">${esc(row.code)}</td>
                <td>${esc(row.name)}</td>
                <td class="num">${row.debit_cents ? fmtMoney(row.debit_cents) : ''}</td>
                <td class="num">${row.credit_cents ? fmtMoney(row.credit_cents) : ''}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2">Totals</td>
              <td class="num">${fmtMoney(data.totals.debit_cents)}</td>
              <td class="num">${fmtMoney(data.totals.credit_cents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="report-balance-note">
        ${data.balanced
    ? `${icon('check', 14)} Debits equal credits.`
    : `${icon('alert', 14)} Debits and credits do not match.`}
      </div>
    </div>
  `;
}

function dailySales(data) {
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
        <table class="report-table daily-sales-table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th class="num">Sale</th>
              <th class="num">Cost</th>
              <th class="num">Margin</th>
              <th class="num">Paid</th>
              <th class="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            ${data.days.map((day) => {
    const rows = day.rows.map((row) => {
      const source = row.reference
        ? (row.kind === 'booking'
          ? `<a href="#/bookings/${row.reference_id}">${esc(row.reference)}</a>`
          : `<a href="#/visas/${row.reference_id}">${esc(row.reference)}</a>`)
        : 'Direct';
      return `
                <tr>
                  <td>
                    <div><a href="#/invoices/${row.id}">${esc(row.number)}</a></div>
                    <div class="cell-sub">${source}</div>
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
        ${icon('check', 14)} Cost comes from the linked booking or visa; direct invoices have no linked cost. Paid and balance are current as of today. Cash in hand and bank are closing balances for each day, and at the period end in the summary.
      </div>
    </div>
  `;
}

function agingReport(data, kind) {
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

function bookingMargin(data) {
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

function visaMargin(data) {
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

function portalWallets(data) {
  const company = store.settings?.company_name || 'My Company';
  if (!data.rows.length) {
    return `
      <div class="report-card">
        ${reportHeader('Portal Wallets', 'Live balances', company)}
        ${emptyState({
    iconName: 'wallet',
    title: 'No portals yet',
    message: 'Add the airline logins and IATA agency portals you use to track top-ups and balances.',
  })}
      </div>
    `;
  }

  return `
    <div class="report-card">
      ${reportHeader('Portal Wallets', 'Live balances', company)}
      <div class="table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              <th>Portal</th>
              <th>Supplier</th>
              <th>Terms</th>
              <th class="num">Topped up</th>
              <th class="num">Used</th>
              <th class="num">Withdrawn</th>
              <th class="num">Balance</th>
              <th class="num">Payable</th>
            </tr>
          </thead>
          <tbody>
            ${data.rows.map((row) => `
              <tr>
                <td><a href="#/portals/${row.id}">${esc(row.name)}</a></td>
                <td class="muted">${esc(row.vendor_name || '—')}</td>
                <td>${statusBadge(row.settlement)}</td>
                <td class="num">${fmtMoney(row.topup_total_cents)}</td>
                <td class="num">${fmtMoney(row.consumed_total_cents)}</td>
                <td class="num">${fmtMoney(row.refunded_total_cents)}</td>
                <td class="num" style="font-weight:650">${fmtMoney(row.balance_cents)}</td>
                <td class="num">${fmtMoney(row.outstanding_ap_cents)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3">Totals</td>
              <td class="num">${fmtMoney(data.totals.topup_total_cents)}</td>
              <td class="num">${fmtMoney(data.totals.consumed_total_cents)}</td>
              <td class="num">${fmtMoney(data.totals.refunded_total_cents)}</td>
              <td class="num">${fmtMoney(data.totals.balance_cents)}</td>
              <td class="num">${fmtMoney(data.totals.outstanding_ap_cents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="report-balance-note">
        ${icon('wallet', 14)} Wallet balances sit in <strong>1400 Supplier Advances</strong> until a booking uses them.
      </div>
    </div>
  `;
}

async function fetchReport(key, filters) {
  if (key === 'income-statement') {
    return api.get('/reports/income-statement', { from: filters.from, to: filters.to });
  }
  if (key === 'booking-margin') {
    return api.get('/reports/bookings', { from: filters.from, to: filters.to });
  }
  if (key === 'visa-margin') {
    return api.get('/reports/visas', { from: filters.from, to: filters.to });
  }
  if (key === 'daily-sales') {
    return api.get('/reports/daily-sales', { from: filters.from, to: filters.to });
  }
  if (key === 'portal-wallets') return api.get('/reports/portals');
  if (key === 'balance-sheet') return api.get('/reports/balance-sheet', { as_of: filters.asOf });
  if (key === 'trial-balance') return api.get('/reports/trial-balance', { as_of: filters.asOf });
  if (key === 'ar-aging') return api.get('/reports/ar-aging', { as_of: filters.asOf });
  return api.get('/reports/ap-aging', { as_of: filters.asOf });
}

function renderReport(key, data) {
  if (key === 'income-statement') return incomeStatement(data);
  if (key === 'balance-sheet') return balanceSheet(data);
  if (key === 'trial-balance') return trialBalance(data);
  if (key === 'daily-sales') return dailySales(data);
  if (key === 'booking-margin') return bookingMargin(data);
  if (key === 'visa-margin') return visaMargin(data);
  if (key === 'portal-wallets') return portalWallets(data);
  return agingReport(data, key === 'ar-aging' ? 'ar' : 'ap');
}

function controlsHtml(key, filters) {
  if (key === 'portal-wallets') return '';
  if (key === 'income-statement' || key === 'booking-margin' || key === 'visa-margin' || key === 'daily-sales') {
    return `
      <div class="field">
        <label for="report-from">From</label>
        <input class="input" id="report-from" type="date" value="${esc(filters.from)}">
      </div>
      <div class="field">
        <label for="report-to">To</label>
        <input class="input" id="report-to" type="date" value="${esc(filters.to)}">
      </div>
      ${key === 'daily-sales' ? `
        <div class="field">
          <label>Quick</label>
          <button type="button" class="btn btn-secondary" data-action="daily-today">Today</button>
        </div>` : ''}
    `;
  }
  return `
    <div class="field">
      <label for="report-as-of">As of</label>
      <input class="input" id="report-as-of" type="date" value="${esc(filters.asOf)}">
    </div>
  `;
}

export async function render(container, { params } = {}) {
  const requested = params?.[0] || 'income-statement';
  const active = REPORTS.find((report) => report.key === requested);
  if (!active) {
    location.hash = '#/reports/income-statement';
    return;
  }

  const today = todayISO();
  const filters = {
    from: `${today.slice(0, 7)}-01`,
    to: today,
    asOf: today,
  };

  setHeader({
    title: 'Reports',
    subtitle: 'Financial statements built from your posted ledger',
    actions: `<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>`,
  });

  const data = await fetchReport(active.key, filters);

  container.innerHTML = `
    <div class="tabs no-print">
      ${REPORTS.map((report) => `<a class="tab ${report.key === active.key ? 'active' : ''}" href="#/reports/${report.key}">${esc(report.label)}</a>`).join('')}
    </div>
    <div class="report-controls no-print">
      ${controlsHtml(active.key, filters)}
    </div>
    <div id="report-body">${renderReport(active.key, data)}</div>
  `;

  const body = container.querySelector('#report-body');

  async function reload() {
    const fromInput = container.querySelector('#report-from');
    const toInput = container.querySelector('#report-to');
    const asOfInput = container.querySelector('#report-as-of');
    if (fromInput) filters.from = fromInput.value;
    if (toInput) filters.to = toInput.value;
    if (asOfInput) filters.asOf = asOfInput.value;
    body.innerHTML = '<div class="loading" style="padding:60px 20px"><div class="spinner"></div><span>Running report…</span></div>';
    try {
      const fresh = await fetchReport(active.key, filters);
      body.innerHTML = renderReport(active.key, fresh);
    } catch (error) {
      body.innerHTML = `<div class="card"><div class="error-state"><h3>Could not run this report</h3><p>${esc(error.message)}</p></div></div>`;
    }
  }

  ['report-from', 'report-to', 'report-as-of'].forEach((id) => {
    const input = container.querySelector(`#${id}`);
    if (input) input.addEventListener('change', reload);
  });

  const todayButton = container.querySelector('[data-action="daily-today"]');
  if (todayButton) {
    todayButton.addEventListener('click', () => {
      filters.from = today;
      filters.to = today;
      container.querySelector('#report-from').value = today;
      container.querySelector('#report-to').value = today;
      reload();
    });
  }

  const print = () => window.print();
  container.querySelectorAll('[data-action="print"]').forEach((button) => button.addEventListener('click', print));
  document.querySelectorAll('#page-actions [data-action="print"]').forEach((button) => button.addEventListener('click', print));

  return () => {};
}
