import { api } from '../api.js';
import { refreshMeta } from '../store.js';
import { isLate, whenLabel } from '../reminders.js';
import { bindPops, canOpen, newMenuHtml } from '../menu.js';
import {
  avatar,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  monthLabel,
  numberCardHtml,
  openModal,
  segmentedHtml,
  setHeader,
  statusBadge,
  toast,
} from '../ui.js';

let charts = [];

function destroyCharts() {
  charts.forEach((chart) => {
    try { chart.destroy(); } catch { /* ignore */ }
  });
  charts = [];
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function chartTheme() {
  return {
    text: cssVar('--chart-text', '#64707d'),
    grid: cssVar('--chart-grid', 'rgba(11, 27, 46, 0.08)'),
    revenue: cssVar('--chart-revenue', '#2b8fcb'),
    revenueFill: cssVar('--chart-revenue-fill', 'rgba(43, 143, 203, 0.12)'),
    expense: cssVar('--chart-expense', '#4b6b8a'),
    expenseFill: cssVar('--chart-expense-fill', 'rgba(75, 107, 138, 0.08)'),
    tooltip: cssVar('--chart-tooltip', '#0b1b2e'),
    tooltipText: cssVar('--chart-tooltip-text', '#ffffff'),
    surface: cssVar('--surface', '#ffffff'),
    palette: [
      cssVar('--accent', '#4fb3e8'),
      cssVar('--chart-blue', '#25638f'),
      cssVar('--green', '#1c7a5a'),
      cssVar('--chart-coral', '#d97757'),
      cssVar('--chart-purple', '#7c3aed'),
      cssVar('--chart-teal', '#0e7490'),
    ],
  };
}

// The latest invoices, bills, bookings and visas in one card, one list at a
// time. Only the lists this user may open are offered.
const RECENT = [
  { value: 'invoices', label: 'Invoices', section: 'invoices',
    rows: (data) => data.recent_invoices.map((row) => ({ href: `#/invoices/${row.id}`, name: row.customer_name, sub: row.number, cents: row.total_cents, status: row.status_display })) },
  { value: 'bills', label: 'Bills', section: 'bills',
    rows: (data) => data.recent_bills.map((row) => ({ href: `#/bills/${row.id}`, name: row.vendor_name, sub: row.number, cents: row.total_cents, status: row.status_display })) },
  { value: 'bookings', label: 'Bookings', section: 'bookings',
    rows: (data) => (data.recent_bookings || []).map((row) => ({ href: `#/bookings/${row.id}`, name: row.customer_name, sub: row.number, cents: row.sale_total_cents, status: row.status })) },
  { value: 'visas', label: 'Visas', section: 'visas',
    rows: (data) => (data.recent_visas || []).map((row) => ({ href: `#/visas/${row.id}`, name: row.applicant_name || row.customer_name, sub: row.number, cents: row.sale_total_cents, status: row.status })) },
];

function recentHtml(data) {
  const lists = RECENT.filter((list) => canOpen(list.section));
  if (!lists.length) return '';
  const first = lists[0].value;
  return `
    <div class="card recent-card" data-recent>
      <div class="card-head">
        <div class="card-title"><h2>Recent</h2></div>
        ${lists.length > 1 ? segmentedHtml('recent', lists, first) : ''}
      </div>
      ${lists.map((list) => {
    const rows = list.rows(data);
    return `
      <div class="mini-list" data-recent-list="${list.value}"${list.value === first ? '' : ' hidden'}>
        ${rows.length ? rows.map((row) => `
          <a class="mini-row" href="${row.href}">
            ${avatar(row.name, 32)}
            <div class="mini-main"><div class="mini-title">${esc(row.name)}</div><div class="mini-sub">${esc(row.sub)}</div></div>
            <div class="mini-amount">${fmtMoney(row.cents)}<small>${statusBadge(row.status)}</small></div>
          </a>`).join('') : emptyState({ iconName: 'file', title: `No ${list.label.toLowerCase()} yet` })}
        <a class="mini-all" href="#/${list.value}">All ${list.label.toLowerCase()} ${icon('chevron', 12)}</a>
      </div>`;
  }).join('')}
    </div>`;
}

// The next few reminders; late ones first, in red.
function remindersCardHtml(reminders) {
  const shown = reminders.slice(0, 5);
  return `
    <div class="card reminders-mini" data-reminders-card>
      <div class="card-head">
        <div class="card-title"><h2>Reminders</h2></div>
        <a class="card-link" href="#/reminders">All ${icon('chevron', 13)}</a>
      </div>
      ${shown.length ? shown.map((reminder) => `
        <a class="reminder-mini${isLate(reminder) ? ' late' : ''}" href="#/reminders">
          <span>${esc(reminder.title)}</span>
          <span>${isLate(reminder) ? 'late · ' : ''}${esc(whenLabel(reminder.due_at))}</span>
        </a>`).join('') : emptyState({ iconName: 'clock', title: 'No reminders coming up' })}
    </div>`;
}

function bindRecent(container) {
  const card = container.querySelector('[data-recent]');
  if (!card) return;
  card.querySelectorAll('[data-seg-value]').forEach((button) => {
    button.addEventListener('click', () => {
      card.querySelectorAll('[data-seg-value]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
      card.querySelectorAll('[data-recent-list]').forEach((list) => { list.hidden = list.dataset.recentList !== button.dataset.segValue; });
    });
  });
}


// Axis labels in one short style: AED 0, AED 500, AED 2K, AED 12K.
function axisMoney(value) {
  if (!value) return 'AED 0';
  return `AED ${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`;
}

function renderCharts(data, container) {
  if (!window.Chart) return;
  const theme = chartTheme();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = theme.text;
  Chart.defaults.font.size = 11;

  const trendCanvas = container.querySelector('#revenue-chart');
  if (trendCanvas) {
    const trend = new Chart(trendCanvas, {
      type: 'line',
      data: {
        labels: data.chart.map((item) => monthLabel(item.month)),
        datasets: [
          {
            label: 'Revenue',
            data: data.chart.map((item) => item.revenue_cents / 100),
            borderColor: theme.revenue,
            backgroundColor: theme.revenueFill,
            fill: true,
            cubicInterpolationMode: 'monotone',
            borderWidth: 2.2,
            pointRadius: 3,
            pointHoverRadius: 5,
            pointBackgroundColor: theme.revenue,
            pointBorderColor: theme.surface,
            pointBorderWidth: 2,
          },
          {
            label: 'Expenses',
            data: data.chart.map((item) => item.expense_cents / 100),
            borderColor: theme.expense,
            backgroundColor: theme.expenseFill,
            fill: true,
            cubicInterpolationMode: 'monotone',
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 5,
            pointBackgroundColor: theme.expense,
            pointBorderColor: theme.surface,
            pointBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            align: 'end',
            labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, padding: 16 },
          },
          tooltip: {
            backgroundColor: theme.tooltip,
            titleColor: theme.tooltipText,
            bodyColor: theme.tooltipText,
            padding: 10,
            cornerRadius: 8,
            displayColors: true,
            boxWidth: 7,
            boxHeight: 7,
            callbacks: {
              label: (context) => ` ${context.dataset.label}: ${fmtMoney(Math.round(context.parsed.y * 100))}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: theme.text } },
          y: {
            beginAtZero: true,
            grid: { color: theme.grid, drawTicks: false },
            border: { display: false },
            ticks: { color: theme.text, padding: 8, maxTicksLimit: 6, callback: axisMoney },
          },
        },
      },
    });
    charts.push(trend);
  }
}

async function loadSample(container) {
  try {
    await api.post('/admin/demo', {});
    await refreshMeta();
    window.dispatchEvent(new Event('meta-changed'));
    toast('Sample business loaded. Explore the dashboard and reports.');
    destroyCharts();
    await render(container, { query: new URLSearchParams() });
  } catch (error) {
    toast(error.message, 'error');
  }
}

// Control accounts compared with the documents behind them. A difference
// means something was posted outside its normal document workflow.
// "Things pending": one line with the count, opening into groups and then
// items, each with how many days it has waited (services/reports/pending.js).
const PENDING_ICONS = {
  collect: 'invoice', pay: 'bill', card: 'cash', give_back: 'undo', deposits: 'visa', bank: 'bank', drafts: 'edit', compliance: 'clock',
};

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function ageBadge(item) {
  if (item.due_in) return `<span class="age age-0">due in ${plural(item.due_in, 'day')}</span>`;
  const tone = item.days > 30 ? 2 : item.days > 7 ? 1 : 0;
  return `<span class="age age-${tone}">${item.days ? plural(item.days, 'day') : 'today'}</span>`;
}

function pendingHtml(pending) {
  if (!pending) return '';
  if (!pending.count) {
    return `
      <section class="card pending-card" data-pending>
        <div class="pending-bar is-clear"><span class="pending-count tone-green">${icon('check', 16)}</span>
          <span class="pending-text"><strong>All caught up</strong><small>Nothing is waiting on anyone</small></span></div>
      </section>`;
  }
  const note = [pending.over_30 ? `${pending.over_30} older than 30 days` : '', pending.oldest_days ? `oldest ${plural(pending.oldest_days, 'day')}` : '']
    .filter(Boolean).join(' · ');
  const groups = pending.groups.map((group) => `
    <div class="pending-group" data-pending-group="${esc(group.key)}">
      <button type="button" class="pending-group-head" aria-expanded="false" aria-controls="pending-${esc(group.key)}">
        <span class="pending-icon tone-${esc(group.tone)}">${icon(PENDING_ICONS[group.key] || 'file', 15)}</span>
        <span class="pending-name">${esc(group.label)}${group.cents ? `<small>${esc(fmtMoney(group.cents))}</small>` : ''}</span>
        <span class="pending-n">${group.count}</span>
        ${ageBadge({ days: group.oldest_days })}
        ${icon('chevron', 14)}
      </button>
      <div class="pending-items" id="pending-${esc(group.key)}" hidden>
        ${group.items.map((item) => `
          <a class="pending-item" href="${esc(item.href)}">
            <span>${esc(item.label)}<small>${esc(item.sub)}</small></span>
            <span class="num">${item.cents ? esc(fmtMoney(item.cents)) : ''}</span>
            ${ageBadge(item)}
          </a>`).join('')}
        <a class="pending-all" href="${esc(group.href)}">${group.count > group.items.length ? `See all ${group.count}` : 'Open'} ${icon('chevron', 12)}</a>
      </div>
    </div>`).join('');
  return `
    <section class="card pending-card" data-pending>
      <button type="button" class="pending-bar" aria-expanded="false" aria-controls="pending-panel" data-pending-toggle>
        <span class="pending-count tone-${pending.over_30 ? 'red' : 'amber'}">${pending.count}</span>
        <span class="pending-text"><strong>${pending.count === 1 ? 'thing pending' : 'things pending'}</strong>${note ? `<small>${esc(note)}</small>` : ''}</span>
        ${icon('chevron', 16)}
      </button>
      <div class="pending-panel" id="pending-panel" hidden>${groups}</div>
    </section>`;
}

function bindPending(container) {
  const toggle = (button) => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    container.querySelector(`#${button.getAttribute('aria-controls')}`).hidden = !open;
  };
  container.querySelectorAll('[data-pending-toggle], .pending-group-head').forEach((button) => {
    button.addEventListener('click', () => toggle(button));
  });
}

function ledgerChecksCard(reconciliation) {
  if (!reconciliation || !Array.isArray(reconciliation.checks)) return '';
  const checks = reconciliation.checks;
  const differences = checks.filter((check) => !check.matched).length;
  // A folded line while every check matches; open with the differences.
  return `
    <details class="card ledger-checks" data-ledger-checks ${differences ? 'open' : ''}>
      <summary class="card-head">
        <div class="card-title"><h2>Ledger checks</h2></div>
        <span class="ledger-state ${differences ? 'down' : 'up'}" data-ledger-state>${icon(differences ? 'alert' : 'check', 13)} ${differences ? `${differences} to fix` : checks.length}</span>
        ${icon('chevron', 13)}
      </summary>
      <div class="table-wrap">
        <table class="data">
          <caption class="sr-only">Ledger checks: control accounts compared with open documents</caption>
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Compared with</th>
              <th scope="col" class="num">Ledger</th>
              <th scope="col" class="num">Documents</th>
              <th scope="col" class="num">Difference</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            ${checks.map((check) => `
              <tr data-check="${esc(check.key)}">
                <td><a href="${esc(check.href)}">${check.account_code ? `${esc(check.account_code)} · ` : ''}${esc(check.account_name)}</a></td>
                <td class="muted">${esc(check.documents_label)}</td>
                <td class="num">${fmtMoney(check.ledger_cents)}</td>
                <td class="num">${fmtMoney(check.documents_cents)}</td>
                <td class="num${check.matched ? '' : ' amount-due'}">${check.matched ? '—' : fmtMoney(check.difference_cents)}</td>
                <td>${check.matched
                  ? '<span class="badge badge-paid">Matched</span>'
                  : '<span class="badge badge-overdue">Difference</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <p class="ledger-checks-foot"><a href="#/reports/trial-balance">Open the trial balance ${icon('chevron', 12)}</a></p>
    </details>
  `;
}

// What the Cash card's total is made of: each money account, and the card
// and payment-link money still on its way to the bank.
function openCashBreakdown(data) {
  const row = (account) => {
    const waiting = account.code === '1030';
    const items = waiting && data.card_waiting.length ? `
      <ul class="cash-waiting">${data.card_waiting.map((item) => `
        <li><span>${esc(fmtDate(item.date))} · ${esc(item.customer || item.reference || 'Card payment')}${item.customer && item.reference ? ` <span class="muted">${esc(item.reference)}</span>` : ''}</span><span class="num">${fmtMoney(item.amount_cents)}</span></li>`).join('')}
      </ul>` : '';
    return `
      <tr data-cash-account="${esc(account.code)}">
        <td>
          <a href="${waiting ? '#/card-settlements' : '#/banking'}">${esc(account.name)}</a> <span class="muted">${esc(account.code)}</span>
          ${waiting ? '<div class="cell-sub">Not yet in the bank</div>' : ''}
          ${items}
        </td>
        <td class="num">${fmtMoney(account.balance_cents)}</td>
      </tr>`;
  };
  openModal({
    title: 'Cash',
    size: 'modal-md',
    hideFooter: true,
    body: `
      <div class="table-wrap" data-cash-breakdown>
        <table class="report-table"><caption class="sr-only">Money accounts</caption>
          <thead><tr><th scope="col">Account</th><th scope="col" class="num">Balance</th></tr></thead>
          <tbody>${data.cash_accounts.map(row).join('')}</tbody>
          <tfoot><tr><td>Total</td><td class="num">${fmtMoney(data.cash_cents)}</td></tr></tfoot>
        </table>
      </div>`,
    // A link leaves the dashboard, so the box closes with it.
    onMount: (overlay, close) => overlay.querySelectorAll('a[href^="#/"]').forEach((link) => link.addEventListener('click', () => close())),
  });
}

export async function render(container, { query } = {}) {
  destroyCharts();
  const [data, reconciliation, reminders] = await Promise.all([
    api.get('/reports/dashboard'),
    // The checks are advisory; the dashboard still renders if they fail.
    api.get('/reports/reconciliation').catch(() => null),
    api.get('/reminders', { status: 'open' }).catch(() => []),
  ]);
  // One New menu: the same as the sidebar's, shown here on phones, where
  // the sidebar is folded away.
  setHeader({ title: 'Dashboard', actions: `<div class="page-new">${newMenuHtml()}</div>` });
  bindPops(document.getElementById('page-actions'));

  const isEmpty = data.counts.invoices === 0 && data.counts.bills === 0
    && data.counts.bookings === 0 && (data.counts.visas || 0) === 0;

  const callout = isEmpty ? `
    <div class="callout">
      <div class="callout-icon">${icon('trendUp', 20)}</div>
      <div class="callout-text"><h3>Welcome to Netfare</h3></div>
      <div class="callout-actions">
        <button class="btn btn-secondary btn-sm" data-action="demo">Load sample data</button>
        <button class="btn btn-primary btn-sm" data-action="new-invoice">Create first invoice</button>
      </div>
    </div>
  ` : '';

  container.innerHTML = `
    ${callout}
    ${isEmpty ? '' : pendingHtml(data.pending)}
    <div class="kpi-grid kpi-grid-4">
      ${numberCardHtml({ label: 'Cash', cents: data.cash_cents, href: '#/banking' })}
      ${numberCardHtml({ label: 'To collect', cents: data.ar_outstanding_cents, href: '#/customer-balances', overdue: data.overdue_ar_cents > 0 })}
      ${numberCardHtml({ label: 'To pay', cents: data.ap_outstanding_cents, href: '#/bills', overdue: data.overdue_ap_cents > 0 })}
      ${numberCardHtml({ label: 'Portal wallets', cents: data.portals?.balance_cents ?? 0, href: '#/portals' })}
    </div>

    ${isEmpty ? '' : ledgerChecksCard(reconciliation)}

    <div class="dash-row">
      <div class="card chart-card">
        <div class="card-head">
          <div class="card-title"><h2>Revenue &amp; expenses</h2></div>
          <a class="card-link" href="#/reports/income-statement">P&amp;L ${icon('chevron', 13)}</a>
        </div>
        <div class="chart-wrap"><canvas id="revenue-chart" role="img" aria-label="Monthly revenue and expenses for the last six months"></canvas></div>
      </div>
      <div class="dash-side">
        ${remindersCardHtml(reminders)}
        ${recentHtml(data)}
      </div>
    </div>
  `;

  bindRecent(container);
  container.querySelector('.kpi-grid a.kpi[href="#/banking"]')?.addEventListener('click', (event) => {
    if (!data.cash_accounts) return;
    event.preventDefault();
    openCashBreakdown(data);
  });
  container.querySelectorAll('[data-action="new-invoice"]').forEach((button) => {
    button.addEventListener('click', () => { location.hash = '#/invoices?new=1'; });
  });
  bindPending(container);
  const demoButton = container.querySelector('[data-action="demo"]');
  if (demoButton) demoButton.addEventListener('click', () => loadSample(container));

  renderCharts(data, container);

  const onThemeChange = () => {
    if (!container.querySelector('#revenue-chart')) return;
    destroyCharts();
    renderCharts(data, container);
  };
  window.addEventListener('theme-changed', onThemeChange);
  // Done or snoozed from the alert: the card follows.
  const onRemindersChanged = async () => {
    const list = await api.get('/reminders', { status: 'open' }).catch(() => null);
    const card = container.querySelector('[data-reminders-card]');
    if (list && card) card.outerHTML = remindersCardHtml(list);
  };
  window.addEventListener('reminders-changed', onRemindersChanged);

  return () => {
    window.removeEventListener('theme-changed', onThemeChange);
    window.removeEventListener('reminders-changed', onRemindersChanged);
    destroyCharts();
  };
}
