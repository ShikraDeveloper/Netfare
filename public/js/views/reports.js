import { api } from '../api.js';
import { store } from '../store.js';
import { esc, icon, printPage, setHeader, todayISO } from '../ui.js';
import { incomeStatement, balanceSheet, trialBalance } from './reports/financials.js';
import { dailySales, rememberProfit } from './reports/daily-sales.js';
import { agingReport } from './reports/aging.js';
import { bookingMargin, visaMargin } from './reports/margins.js';
import { portalWallets } from './reports/portal-wallets.js';
import { visaDeposits } from './reports/visa-deposits.js';

// Reports grouped by who uses them. `period` reports take a date range,
// `asOf` reports a single date.
const REPORTS = [
  { key: 'daily-sales', group: 'daily', label: 'Daily sales', title: 'Daily Sales Report', icon: 'cash', kind: 'period' },
  { key: 'ar-aging', group: 'daily', label: 'Who owes us', title: 'Trade Receivables Aging', icon: 'invoice', kind: 'asOf' },
  { key: 'visa-deposits', group: 'daily', label: 'Visa deposits', title: 'Visa Security Deposits', icon: 'visa', kind: 'none' },
  { key: 'income-statement', group: 'performance', label: 'Profit or loss', title: 'Statement of Profit or Loss', icon: 'trendUp', kind: 'period' },
  { key: 'booking-margin', group: 'performance', label: 'Booking gross profit', title: 'Booking Gross Profit', icon: 'plane', kind: 'period' },
  { key: 'visa-margin', group: 'performance', label: 'Visa gross profit', title: 'Visa Gross Profit', icon: 'visa', kind: 'period' },
  { key: 'balance-sheet', group: 'accountant', label: 'Financial position', title: 'Statement of Financial Position', icon: 'accounts', kind: 'asOf' },
  { key: 'trial-balance', group: 'accountant', label: 'Trial balance', title: 'Trial Balance', icon: 'journal', kind: 'asOf' },
  { key: 'ap-aging', group: 'accountant', label: 'What we owe suppliers', title: 'Trade Payables Aging', icon: 'bill', kind: 'asOf' },
  { key: 'portal-wallets', group: 'accountant', label: 'Portal wallets', title: 'Portal Wallets', icon: 'wallet', kind: 'none' },
];

const GROUPS = [
  { key: 'daily', title: 'Daily work' },
  { key: 'performance', title: 'How the business is doing' },
  { key: 'accountant', title: 'For your accountant' },
];

function reportsHome(container) {
  setHeader({ title: 'Reports', actions: '' });
  container.innerHTML = `
    <div class="reports-home" data-reports-home>
      ${GROUPS.map((group) => `
        <section class="reports-group">
          <h2>${esc(group.title)}</h2>
          <div class="reports-grid">
            ${REPORTS.filter((report) => report.group === group.key).map((report) => `
              <a class="report-card-link" href="#/reports/${report.key}" data-report-link="${report.key}">
                <span class="report-card-icon">${icon(report.icon, 18)}</span>
                <span class="report-card-text"><strong>${esc(report.label)}</strong></span>
                ${icon('chevron', 14)}
              </a>`).join('')}
          </div>
        </section>`).join('')}
    </div>`;
  return () => {};
}

function renderReport(key, data) {
  if (key === 'income-statement') return incomeStatement(data);
  if (key === 'balance-sheet') return balanceSheet(data);
  if (key === 'trial-balance') return trialBalance(data);
  if (key === 'daily-sales') return dailySales(data);
  if (key === 'booking-margin') return bookingMargin(data);
  if (key === 'visa-margin') return visaMargin(data);
  if (key === 'portal-wallets') return portalWallets(data);
  if (key === 'visa-deposits') return visaDeposits(data);
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
    return api.get('/reports/daily-sales', { from: filters.from, to: filters.to, staff: filters.staff });
  }
  if (key === 'portal-wallets') return api.get('/reports/portals');
  if (key === 'visa-deposits') return api.get('/reports/visa-deposits', { status: filters.depositStatus });
  if (key === 'balance-sheet') return api.get('/reports/balance-sheet', { as_of: filters.asOf });
  if (key === 'trial-balance') return api.get('/reports/trial-balance', { as_of: filters.asOf });
  if (key === 'ar-aging') return api.get('/reports/ar-aging', { as_of: filters.asOf });
  return api.get('/reports/ap-aging', { as_of: filters.asOf });
}

function monthStart(iso) { return `${iso.slice(0, 7)}-01`; }
function lastMonthRange(iso) {
  const first = new Date(`${monthStart(iso)}T00:00:00Z`);
  const end = new Date(first.getTime() - 86_400_000);
  const toIso = (date) => date.toISOString().slice(0, 10);
  return { from: `${toIso(end).slice(0, 7)}-01`, to: toIso(end) };
}

// The start of the financial year that holds `iso` (Settings → fiscal year start month).
function yearStart(iso) {
  const month = Number(store.settings?.fiscal_year_start_month) || 1;
  const year = Number(iso.slice(0, 4)) - (Number(iso.slice(5, 7)) < month ? 1 : 0);
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

// Quick ranges first, exact dates after.
function controlsHtml(report, filters) {
  if (report.key === 'visa-deposits') {
    return `
      <div class="field">
        <label for="report-deposit-status">Show</label>
        <select class="input" id="report-deposit-status">
          <option value="open" ${filters.depositStatus !== 'all' ? 'selected' : ''}>Still held</option>
          <option value="all" ${filters.depositStatus === 'all' ? 'selected' : ''}>All deposits</option>
        </select>
      </div>`;
  }
  if (report.kind === 'period') {
    return `
      <div class="report-presets" role="group" aria-label="Quick periods">
        <button type="button" class="btn btn-secondary btn-sm" data-preset="today" data-action="daily-today">Today</button>
        <button type="button" class="btn btn-secondary btn-sm" data-preset="month">This month</button>
        <button type="button" class="btn btn-secondary btn-sm" data-preset="last-month">Last month</button>
        <button type="button" class="btn btn-secondary btn-sm" data-preset="year">This year</button>
      </div>
      <div class="field">
        <label for="report-from">From</label>
        <input class="input" id="report-from" type="date" value="${esc(filters.from)}">
      </div>
      <div class="field">
        <label for="report-to">To</label>
        <input class="input" id="report-to" type="date" value="${esc(filters.to)}">
      </div>`;
  }
  if (report.kind === 'asOf') {
    return `
      <div class="report-presets" role="group" aria-label="Quick dates">
        <button type="button" class="btn btn-secondary btn-sm" data-preset="as-today">Today</button>
        <button type="button" class="btn btn-secondary btn-sm" data-preset="as-month-end">End of last month</button>
      </div>
      <div class="field">
        <label for="report-as-of">As of</label>
        <input class="input" id="report-as-of" type="date" value="${esc(filters.asOf)}">
      </div>`;
  }
  return '';
}

export async function render(container, { params } = {}) {
  const requested = params?.[0];
  if (!requested) return reportsHome(container);
  const active = REPORTS.find((report) => report.key === requested);
  if (!active) {
    location.hash = '#/reports';
    return;
  }

  const today = todayISO();
  const filters = {
    from: monthStart(today),
    to: today,
    asOf: today,
    depositStatus: 'open',
    staff: '',
  };

  setHeader({
    title: active.title,
    actions: `
      <a class="btn btn-ghost" href="#/reports" data-all-reports>${icon('reports', 15)}<span>All reports</span></a>
      <button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>`,
  });

  const data = await fetchReport(active.key, filters);

  const controls = controlsHtml(active, filters);
  container.innerHTML = `
    ${controls ? `<div class="report-controls no-print">${controls}</div>` : ''}
    <div id="report-body">${renderReport(active.key, data)}</div>
  `;

  const body = container.querySelector('#report-body');

  // DSR "Show profit" switch: shows or hides cost and margin on screen and in print.
  body.addEventListener('change', (event) => {
    if (!event.target.matches('[data-dsr-profit]')) return;
    event.target.closest('[data-dsr]')?.classList.toggle('show-profit', event.target.checked);
    rememberProfit(event.target.checked);
  });

  // DSR sections fold open and shut (print shows them all).
  body.addEventListener('click', (event) => {
    const fold = event.target.closest('[data-dsr-fold]');
    if (!fold) return;
    const open = fold.closest('[data-dsr-section]').classList.toggle('is-open');
    fold.setAttribute('aria-expanded', String(open));
  });

  // DSR staff picker: one staff member's sales, or everyone's.
  body.addEventListener('change', (event) => {
    if (!event.target.matches('[data-dsr-staff]')) return;
    filters.staff = event.target.value;
    reload();
  });

  async function reload() {
    const fromInput = container.querySelector('#report-from');
    const toInput = container.querySelector('#report-to');
    const asOfInput = container.querySelector('#report-as-of');
    if (fromInput) filters.from = fromInput.value;
    if (toInput) filters.to = toInput.value;
    if (asOfInput) filters.asOf = asOfInput.value;
    const depositStatus = container.querySelector('#report-deposit-status');
    if (depositStatus) filters.depositStatus = depositStatus.value;
    body.innerHTML = '<div class="loading" style="padding:60px 20px"><div class="spinner"></div><span>Running report…</span></div>';
    try {
      const fresh = await fetchReport(active.key, filters);
      body.innerHTML = renderReport(active.key, fresh);
    } catch (error) {
      body.innerHTML = `<div class="card"><div class="error-state"><h3>Could not run this report</h3><p>${esc(error.message)}</p></div></div>`;
    }
  }

  ['report-from', 'report-to', 'report-as-of', 'report-deposit-status'].forEach((id) => {
    const input = container.querySelector(`#${id}`);
    if (input) input.addEventListener('change', reload);
  });

  container.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = button.dataset.preset;
      const set = (id, value) => { const input = container.querySelector(`#${id}`); if (input) input.value = value; };
      if (preset === 'today') { set('report-from', today); set('report-to', today); }
      if (preset === 'month') { set('report-from', monthStart(today)); set('report-to', today); }
      if (preset === 'last-month') { const range = lastMonthRange(today); set('report-from', range.from); set('report-to', range.to); }
      if (preset === 'year') { set('report-from', yearStart(today)); set('report-to', today); }
      if (preset === 'as-today') set('report-as-of', today);
      if (preset === 'as-month-end') set('report-as-of', lastMonthRange(today).to);
      container.querySelectorAll('[data-preset]').forEach((other) => other.classList.toggle('active', other === button));
      reload();
    });
  });

  const print = () => printPage();
  container.querySelectorAll('[data-action="print"]').forEach((button) => button.addEventListener('click', print));
  document.querySelectorAll('#page-actions [data-action="print"]').forEach((button) => button.addEventListener('click', print));

  return () => {};
}
