import { api } from '../api.js';
import { refreshMeta, store } from '../store.js';
import {
  avatar,
  emptyState,
  esc,
  fmtMoney,
  icon,
  longMonth,
  monthLabel,
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

function chartMoney(valueCents, compact = false) {
  return fmtMoney(valueCents, { compact });
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function chartTheme() {
  return {
    text: cssVar('--chart-text', '#64707d'),
    grid: cssVar('--chart-grid', 'rgba(11, 27, 46, 0.08)'),
    revenue: cssVar('--chart-revenue', '#f7b520'),
    revenueFill: cssVar('--chart-revenue-fill', 'rgba(247, 181, 32, 0.12)'),
    expense: cssVar('--chart-expense', '#4b6b8a'),
    expenseFill: cssVar('--chart-expense-fill', 'rgba(75, 107, 138, 0.08)'),
    tooltip: cssVar('--chart-tooltip', '#0b1b2e'),
    tooltipText: cssVar('--chart-tooltip-text', '#f7f1e5'),
    surface: cssVar('--surface', '#fffdf8'),
    palette: [
      cssVar('--accent', '#f7b520'),
      cssVar('--chart-blue', '#25638f'),
      cssVar('--green', '#1c7a5a'),
      cssVar('--chart-coral', '#d97757'),
      cssVar('--chart-purple', '#7c3aed'),
      cssVar('--chart-teal', '#0e7490'),
    ],
  };
}

function kpiCard(label, valueCents, meta, iconName, color, compact = false) {
  return `
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">${esc(label)}</span>
        <span class="kpi-icon ${color}">${icon(iconName, 17)}</span>
      </div>
      <div class="kpi-value">${chartMoney(valueCents, compact)}</div>
      <div class="kpi-meta">${meta}</div>
    </div>
  `;
}

function countCard(label, value, meta, iconName, color) {
  return `
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">${esc(label)}</span>
        <span class="kpi-icon ${color}">${icon(iconName, 17)}</span>
      </div>
      <div class="kpi-value">${esc(value)}</div>
      <div class="kpi-meta">${meta}</div>
    </div>
  `;
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
            tension: 0.35,
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
            tension: 0.35,
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
            ticks: { color: theme.text, padding: 8, callback: (value) => fmtMoney(value * 100, { compact: true }) },
          },
        },
      },
    });
    charts.push(trend);
  }

  const expenseCanvas = container.querySelector('#expense-chart');
  if (expenseCanvas) {
    const breakdown = data.expense_breakdown;
    const donut = new Chart(expenseCanvas, {
      type: 'doughnut',
      data: {
        labels: breakdown.map((item) => item.name),
        datasets: [{
          data: breakdown.map((item) => item.amount_cents / 100),
          backgroundColor: theme.palette.slice(0, breakdown.length),
          borderColor: theme.surface,
          borderWidth: 3,
          hoverOffset: 5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, padding: 14, font: { size: 11 } },
          },
          tooltip: {
            backgroundColor: theme.tooltip,
            titleColor: theme.tooltipText,
            bodyColor: theme.tooltipText,
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: (context) => ` ${context.label}: ${fmtMoney(Math.round(context.parsed * 100))}`,
            },
          },
        },
      },
    });
    charts.push(donut);
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
// What needs doing now, each linking to the screen where it is done.
function todayHtml(todo) {
  if (!todo) return '';
  const items = [
    { key: 'overdue_invoices', label: 'Overdue invoices', hint: 'to collect', href: '#/invoices', tone: 'red' },
    { key: 'to_settle', label: 'Money to give back', hint: 'refunds and credits', href: '#/settlement-queue', tone: 'amber' },
    { key: 'deposits_due', label: 'Visa deposits to refund', hint: 'visa cancelled or rejected', href: '#/reports/visa-deposits', tone: 'amber' },
    { key: 'bills_overdue', label: 'Bills overdue', hint: 'to pay suppliers', href: '#/bills', tone: 'red' },
    { key: 'draft_bookings', label: 'Draft bookings', hint: 'to confirm', href: '#/bookings', tone: 'blue' },
    { key: 'draft_visas', label: 'Draft visas', hint: 'to submit', href: '#/visas', tone: 'blue' },
  ];
  const open = items.filter((item) => todo[item.key]?.count > 0);
  return `
    <section class="card today-card" data-today>
      <div class="card-head">
        <div class="card-title"><h2>Today</h2><p>${open.length ? 'Things that need your attention' : 'Nothing waiting. All caught up.'}</p></div>
      </div>
      ${open.length ? `<div class="today-grid">${open.map((item) => `
        <a class="today-item tone-${item.tone}" href="${item.href}" data-today-item="${item.key}">
          <strong>${todo[item.key].count}</strong>
          <span>${esc(item.label)}<small>${todo[item.key].cents ? esc(fmtMoney(todo[item.key].cents)) + ' · ' : ''}${esc(item.hint)}</small></span>
          ${icon('chevron', 14)}
        </a>`).join('')}</div>` : ''}
    </section>`;
}

function ledgerChecksCard(reconciliation) {
  if (!reconciliation || !Array.isArray(reconciliation.checks)) return '';
  const checks = reconciliation.checks;
  const differences = checks.filter((check) => !check.matched).length;
  const summary = differences
    ? `${differences} check${differences === 1 ? '' : 's'} need${differences === 1 ? 's' : ''} attention`
    : `All ${checks.length} checks match`;
  return `
    <details class="card ledger-checks" style="margin-top:16px" data-ledger-checks ${differences ? 'open' : ''}>
      <summary class="card-head">
        <div class="card-title">
          <h2>Ledger checks</h2>
          <p class="${differences ? 'down' : 'up'}">${icon(differences ? 'alert' : 'check', 13)} ${esc(summary)}</p>
        </div>
        <span class="card-link">${differences ? 'Hide details' : 'Show details'} ${icon('chevron', 13)}</span>
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

export async function render(container, { query } = {}) {
  destroyCharts();
  const [data, reconciliation] = await Promise.all([
    api.get('/reports/dashboard'),
    // The checks are advisory; the dashboard still renders if they fail.
    api.get('/reports/reconciliation').catch(() => null),
  ]);
  const month = longMonth(data.as_of);
  const company = store.settings?.company_name || 'My Company';

  setHeader({
    title: 'Dashboard',
    subtitle: `${month} · ${company}`,
    actions: `
      <button class="btn btn-secondary" data-action="new-bill">${icon('plus', 16)}<span>New bill</span></button>
      <button class="btn btn-secondary" data-action="new-visa">${icon('plus', 16)}<span>New visa</span></button>
      <button class="btn btn-primary" data-action="new-booking">${icon('plus', 16)}<span>New booking</span></button>
    `,
  });

  const bookings = data.bookings || { counts: {}, booking_count: 0, sale_cents: 0, cost_cents: 0, margin_cents: 0 };
  const visas = data.visas || { counts: {}, visa_count: 0, active_count: 0, sale_cents: 0, cost_cents: 0, margin_cents: 0 };
  const portals = data.portals || { count: 0, active_count: 0, balance_cents: 0, outstanding_ap_cents: 0 };
  const compliance = data.compliance || { active_count: 0, overdue_count: 0, due_soon_count: 0, attention_count: 0, next_items: [] };
  const complianceAttention = (compliance.next_items || [])
    .filter((item) => ['overdue', 'due', 'soon'].includes(item.due_state))
    .slice(0, 2);
  const isEmpty = data.counts.invoices === 0 && data.counts.bills === 0
    && data.counts.bookings === 0 && (data.counts.visas || 0) === 0;
  const complianceCallout = compliance.attention_count
    ? `<a class="callout" href="#/compliance" style="text-decoration:none;color:inherit;border-color:var(--amber-soft)">
        <div class="callout-icon" style="background:var(--amber-soft);color:var(--amber)">${icon('alert', 20)}</div>
        <div class="callout-text">
          <h3>Compliance needs attention</h3>
          <p>${compliance.overdue_count} overdue · ${compliance.due_soon_count} due soon${complianceAttention.length ? ` · ${complianceAttention.map((item) => esc(item.name)).join(' · ')}` : ''}</p>
        </div>
        <div class="callout-actions"><span class="btn btn-secondary btn-sm">Open compliance</span></div>
      </a>`
    : '';
  const overdueAr = data.overdue_ar_cents > 0
    ? `<span class="down">${fmtMoney(data.overdue_ar_cents, { compact: true })} overdue</span>`
    : 'All invoices are current';

  const invoicesHtml = data.recent_invoices.length
    ? data.recent_invoices.map((invoice) => `
        <a class="mini-row" href="#/invoices/${invoice.id}">
          ${avatar(invoice.customer_name, 32)}
          <div class="mini-main">
            <div class="mini-title">${esc(invoice.customer_name)}</div>
            <div class="mini-sub">${esc(invoice.number)} · ${esc(invoice.issue_date)}</div>
          </div>
          <div class="mini-amount">${fmtMoney(invoice.total_cents)}<small>${statusBadge(invoice.status_display)}</small></div>
        </a>
      `).join('')
    : emptyState({
      iconName: 'invoice',
      title: 'No invoices yet',
      message: 'Create your first invoice and it will appear here.',
      action: '<button class="btn btn-primary btn-sm" data-action="new-invoice">Create invoice</button>',
    });

  const billsHtml = data.recent_bills.length
    ? data.recent_bills.map((bill) => `
        <a class="mini-row" href="#/bills/${bill.id}">
          ${avatar(bill.vendor_name, 32)}
          <div class="mini-main">
            <div class="mini-title">${esc(bill.vendor_name)}</div>
            <div class="mini-sub">${esc(bill.number)} · ${esc(bill.bill_date)}</div>
          </div>
          <div class="mini-amount">${fmtMoney(bill.total_cents)}<small>${statusBadge(bill.status_display)}</small></div>
        </a>
      `).join('')
    : emptyState({
      iconName: 'bill',
      title: 'No bills yet',
      message: 'Record a supplier bill to track payables.',
      action: '<button class="btn btn-secondary btn-sm" data-action="new-bill">Record bill</button>',
    });

  const recentBookings = data.recent_bookings || [];
  const bookingsHtml = recentBookings.length
    ? recentBookings.map((booking) => `
        <a class="mini-row" href="#/bookings/${booking.id}">
          ${avatar(booking.customer_name, 32)}
          <div class="mini-main">
            <div class="mini-title">${esc(booking.customer_name)}</div>
            <div class="mini-sub">${esc(booking.number)} · ${esc(booking.destination || 'No destination')}</div>
          </div>
          <div class="mini-amount">${fmtMoney(booking.sale_total_cents)}<small>${statusBadge(booking.status)}</small></div>
        </a>
      `).join('')
    : emptyState({
      iconName: 'plane',
      title: 'No bookings yet',
      message: 'Create a travel booking to track sale price, supplier cost and gross profit.',
      action: '<button class="btn btn-primary btn-sm" data-action="new-booking">Create booking</button>',
    });

  const recentVisas = data.recent_visas || [];
  const visasHtml = recentVisas.length
    ? recentVisas.map((visa) => `
        <a class="mini-row" href="#/visas/${visa.id}">
          ${avatar(visa.applicant_name || visa.customer_name, 32)}
          <div class="mini-main">
            <div class="mini-title">${esc(visa.applicant_name || visa.customer_name)}</div>
            <div class="mini-sub">${esc(visa.number)} · ${esc(visa.destination_country || 'Visa application')}</div>
          </div>
          <div class="mini-amount">${fmtMoney(visa.sale_total_cents)}<small>${statusBadge(visa.status)}</small></div>
        </a>
      `).join('')
    : emptyState({
      iconName: 'visa',
      title: 'No visa applications yet',
      message: 'Create a visa application to track applicants, embassy costs and gross profit.',
      action: '<button class="btn btn-primary btn-sm" data-action="new-visa">Create visa</button>',
    });

  const recentTopups = data.recent_topups || [];
  const topupsHtml = recentTopups.length
    ? recentTopups.map((topup) => `
        <a class="mini-row" href="#/portals/${topup.portal_id}">
          ${avatar(topup.portal_name, 32)}
          <div class="mini-main">
            <div class="mini-title">${esc(topup.portal_name)}</div>
            <div class="mini-sub">${esc(topup.number)} · ${esc(topup.topup_date)}${topup.reference ? ` · ${esc(topup.reference)}` : ''}</div>
          </div>
          <div class="mini-amount">${fmtMoney(topup.amount_cents)}<small>top-up</small></div>
        </a>
      `).join('')
    : emptyState({
      iconName: 'wallet',
      title: 'No portal top-ups yet',
      message: 'Top up an airline, agency or visa-agent wallet to track the balance you hold there.',
      action: '<button class="btn btn-secondary btn-sm" data-action="new-portal">Add a portal</button>',
    });

  const callout = isEmpty ? `
    <div class="callout">
      <div class="callout-icon">${icon('trendUp', 20)}</div>
      <div class="callout-text">
        <h3>Welcome to Ledgerly</h3>
        <p>Your books are ready. Load a sample business to explore invoices, bills and reports — or start with a blank ledger.</p>
      </div>
      <div class="callout-actions">
        <button class="btn btn-secondary btn-sm" data-action="demo">Load sample data</button>
        <button class="btn btn-primary btn-sm" data-action="new-invoice">Create first invoice</button>
      </div>
    </div>
  ` : '';

  const expenseEmpty = data.expense_breakdown.length === 0;

  container.innerHTML = `
    ${callout}
    ${isEmpty ? '' : todayHtml(data.todo)}
    ${complianceCallout}
    <div class="kpi-grid">
      ${kpiCard('Cash in hand', data.cash_only_cents ?? data.cash_cents, `${data.cash_only_cents > 0 ? '<a href="#/banking?new=1">Deposit cash</a> · ' : ''}Cash at bank ${fmtMoney(data.bank_cents ?? 0, { compact: true })}`, 'wallet', 'indigo')}
      ${kpiCard('Trade receivables', data.ar_outstanding_cents, `${data.ar_count} open invoice${data.ar_count === 1 ? '' : 's'} · ${overdueAr}`, 'invoice', 'blue')}
      ${kpiCard(`Revenue · ${month.split(' ')[0]}`, data.revenue_mtd_cents, `Profit for the month ${fmtMoney(data.net_income_mtd_cents, { compact: true })}`, 'trendUp', 'green')}
      ${kpiCard(`Expenses · ${month.split(' ')[0]}`, data.expenses_mtd_cents, `Trade payables ${fmtMoney(data.ap_outstanding_cents, { compact: true })}`, 'cash', 'amber')}
      ${kpiCard(`Booking gross profit · ${month.split(' ')[0]}`, bookings.margin_cents, `${bookings.booking_count} booking${bookings.booking_count === 1 ? '' : 's'} · sales ${fmtMoney(bookings.sale_cents, { compact: true })}`, 'plane', 'indigo')}
      ${kpiCard(`Visa gross profit · ${month.split(' ')[0]}`, visas.margin_cents, `${visas.visa_count} application${visas.visa_count === 1 ? '' : 's'} · sales ${fmtMoney(visas.sale_cents, { compact: true })}`, 'visa', 'green')}
      ${countCard('Visa pipeline', String(visas.active_count || 0), `${visas.counts.issued || 0} issued · ${visas.counts.rejected || 0} rejected`, 'visa', 'amber')}
      ${kpiCard('Portal wallets', portals.balance_cents, `${portals.active_count} portal${portals.active_count === 1 ? '' : 's'} · ${fmtMoney(portals.outstanding_ap_cents, { compact: true })} payable`, 'wallet', 'green')}
    </div>

    ${isEmpty ? '' : ledgerChecksCard(reconciliation)}

    <div class="charts-grid">
      <div class="card chart-card">
        <div class="card-head">
          <div class="card-title">
            <h2>Revenue &amp; expenses</h2>
            <p>Last six months</p>
          </div>
          <a class="card-link" href="#/reports/income-statement">P&amp;L ${icon('chevron', 13)}</a>
        </div>
        <div class="chart-wrap"><canvas id="revenue-chart" role="img" aria-label="Monthly revenue and expenses for the last six months"></canvas></div>
      </div>
      <div class="card chart-card">
        <div class="card-head">
          <div class="card-title">
            <h2>Expenses by category</h2>
            <p>${esc(month)}</p>
          </div>
        </div>
        <div class="chart-wrap">
          ${expenseEmpty
    ? emptyState({ iconName: 'cash', title: 'No expenses this month', message: 'Record a bill to see your spending breakdown.' })
    : `<canvas id="expense-chart" role="img" aria-label="Expenses by category for ${esc(month)}"></canvas>`}
        </div>
      </div>
    </div>

    <div class="dash-grid">
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Recent invoices</h2><p>Latest activity from your customers</p></div>
          <a class="card-link" href="#/invoices">View all ${icon('chevron', 13)}</a>
        </div>
        <div class="mini-list">${invoicesHtml}</div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Recent bills</h2><p>${fmtMoney(data.ap_outstanding_cents, { compact: true })} outstanding</p></div>
          <a class="card-link" href="#/bills">View all ${icon('chevron', 13)}</a>
        </div>
        <div class="mini-list">${billsHtml}</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div class="card-title"><h2>Recent bookings</h2><p>${fmtMoney(bookings.margin_cents, { compact: true })} margin this month</p></div>
        <a class="card-link" href="#/bookings">View all ${icon('chevron', 13)}</a>
      </div>
      <div class="mini-list">${bookingsHtml}</div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div class="card-title"><h2>Recent visa applications</h2><p>${visas.active_count || 0} in progress · ${visas.counts.issued || 0} issued</p></div>
        <a class="card-link" href="#/visas">View all ${icon('chevron', 13)}</a>
      </div>
      <div class="mini-list">${visasHtml}</div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div class="card-title"><h2>Recent portal top-ups</h2><p>${fmtMoney(portals.balance_cents, { compact: true })} held in wallets</p></div>
        <a class="card-link" href="#/portals">View all ${icon('chevron', 13)}</a>
      </div>
      <div class="mini-list">${topupsHtml}</div>
    </div>
  `;

  document.querySelectorAll('[data-action="new-invoice"]').forEach((button) => {
    button.addEventListener('click', () => { location.hash = '#/invoices?new=1'; });
  });
  document.querySelectorAll('[data-action="new-bill"]').forEach((button) => {
    button.addEventListener('click', () => { location.hash = '#/bills?new=1'; });
  });
  document.querySelectorAll('[data-action="new-booking"]').forEach((button) => {
    button.addEventListener('click', () => { location.hash = '#/bookings?new=1'; });
  });
  document.querySelectorAll('[data-action="new-visa"]').forEach((button) => {
    button.addEventListener('click', () => { location.hash = '#/visas?new=1'; });
  });
  document.querySelectorAll('[data-action="new-portal"]').forEach((button) => {
    button.addEventListener('click', () => { location.hash = '#/portals?new=1'; });
  });
  const demoButton = container.querySelector('[data-action="demo"]');
  if (demoButton) demoButton.addEventListener('click', () => loadSample(container));

  renderCharts(data, container);

  const onThemeChange = () => {
    if (!container.querySelector('#revenue-chart') && !container.querySelector('#expense-chart')) return;
    destroyCharts();
    renderCharts(data, container);
  };
  window.addEventListener('theme-changed', onThemeChange);

  return () => {
    window.removeEventListener('theme-changed', onThemeChange);
    destroyCharts();
  };
}
