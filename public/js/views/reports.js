import { api } from '../api.js';
import { esc, icon, setHeader, todayISO } from '../ui.js';
import { incomeStatement, balanceSheet, trialBalance } from './reports/financials.js';
import { dailySales } from './reports/daily-sales.js';
import { agingReport } from './reports/aging.js';
import { bookingMargin, visaMargin } from './reports/margins.js';
import { portalWallets } from './reports/portal-wallets.js';

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
