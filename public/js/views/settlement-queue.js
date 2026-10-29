import { api } from '../api.js';
import {
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  setHeader,
} from '../ui.js';

const TYPE_TONES = {
  cancellation_refund: 'source-cancellation',
  customer_credit: 'source-credit',
  customer_advance: 'source-advance',
  supplier_credit: 'source-supplier_credit',
};

const TYPE_ICONS = {
  cancellation_refund: 'x',
  customer_credit: 'invoice',
  customer_advance: 'wallet',
  supplier_credit: 'bill',
};

const TYPE_FILTERS = [
  ['all', 'All settlements'],
  ['cancellation_refund', 'Cancellation refunds'],
  ['customer_credit', 'Customer credits'],
  ['customer_advance', 'Customer advances'],
  ['supplier_credit', 'Supplier credits'],
];

function summaryCard(label, valueCents, meta, iconName, color) {
  return `
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">${esc(label)}</span>
        <span class="kpi-icon ${color}">${icon(iconName, 17)}</span>
      </div>
      <div class="kpi-value">${fmtMoney(valueCents)}</div>
      <div class="kpi-meta">${esc(meta)}</div>
    </div>
  `;
}

function ageLabel(days) {
  if (!days) return 'Today';
  return `${days} day${days === 1 ? '' : 's'}`;
}

function queueRow(item) {
  return `
    <tr class="clickable" data-href="${esc(item.href)}" tabindex="0">
      <td><span class="source ${TYPE_TONES[item.type] || ''}">${esc(item.type_label)}</span></td>
      <td>
        <div class="cell-main">${esc(item.party_name)}</div>
        <div class="cell-sub">${esc(item.detail || '')}</div>
      </td>
      <td>
        <div class="cell-main nowrap">${esc(item.number)}</div>
      </td>
      <td class="nowrap">${esc(fmtDate(item.date))}</td>
      <td class="nowrap">${esc(ageLabel(item.age_days))}</td>
      <td class="num amount-due">${fmtMoney(item.remaining_cents)}</td>
      <td><a class="btn btn-ghost btn-sm" href="${esc(item.href)}">${icon(TYPE_ICONS[item.type] || 'chevron', 14)}<span>${esc(item.action_label)}</span></a></td>
    </tr>
  `;
}

export async function render(container) {
  const data = await api.get('/settlement-queue');
  const { items, totals } = data;

  setHeader({
    title: 'Settlements',
    subtitle: `${totals.count} open settlement${totals.count === 1 ? '' : 's'} · ${fmtMoney(totals.amount_cents)} to apply or refund`,
    actions: `<a class="btn btn-secondary" href="#/customer-balances">${icon('customers', 15)}<span>Customer balances</span></a>`,
  });

  const byType = totals.by_type || {};
  const amountOf = (key) => Number(byType[key]?.amount_cents || 0);
  const countOf = (key) => Number(byType[key]?.count || 0);

  container.innerHTML = `
    <div class="kpi-grid">
      ${summaryCard('Cancellation refunds', amountOf('cancellation_refund'), `${countOf('cancellation_refund')} awaiting refund or credit`, 'x', 'red')}
      ${summaryCard('Customer credits', amountOf('customer_credit'), `${countOf('customer_credit')} credit note${countOf('customer_credit') === 1 ? '' : 's'} to apply`, 'invoice', 'amber')}
      ${summaryCard('Customer advances', amountOf('customer_advance'), `${countOf('customer_advance')} advance${countOf('customer_advance') === 1 ? '' : 's'} to apply or refund`, 'wallet', 'green')}
      ${summaryCard('Supplier credits', amountOf('supplier_credit'), `${countOf('supplier_credit')} credit${countOf('supplier_credit') === 1 ? '' : 's'} to apply or refund`, 'bill', 'indigo')}
    </div>

    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="queue-search" type="search" placeholder="Search settlements…" aria-label="Search settlement queue" autocomplete="off">
      </div>
      <select class="input" id="queue-type" aria-label="Filter settlement queue by type" style="max-width:210px">
        ${TYPE_FILTERS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
      </select>
      <div class="spacer"></div>
      <span class="muted" id="queue-count" style="font-size:12px"></span>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Settlements to make</caption>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Party</th>
              <th scope="col">Reference</th>
              <th scope="col">Date</th>
              <th scope="col">Age</th>
              <th scope="col" class="num">Amount</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="queue-body"></tbody>
        </table>
      </div>
    </div>
  `;

  const searchInput = container.querySelector('#queue-search');
  const typeSelect = container.querySelector('#queue-type');
  const body = container.querySelector('#queue-body');
  const countEl = container.querySelector('#queue-count');
  let filtered = [];

  function renderRows() {
    body.innerHTML = filtered.length
      ? filtered.map(queueRow).join('')
      : `<tr><td colspan="7">${emptyState({
        iconName: 'check',
        title: 'Nothing to settle',
        message: 'Cancellation refunds, unapplied customer credits, customer advances and supplier credits will appear here.',
      })}</td></tr>`;
    countEl.textContent = `${filtered.length} shown`;
  }

  function applyFilters() {
    const term = searchInput.value.trim().toLowerCase();
    const type = typeSelect.value;
    filtered = items.filter((item) => {
      if (type !== 'all' && item.type !== type) return false;
      if (!term) return true;
      return [item.number, item.party_name, item.detail, item.type_label]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    renderRows();
  }

  searchInput.addEventListener('input', applyFilters);
  typeSelect.addEventListener('change', applyFilters);
  applyFilters();

  container.onclick = (event) => {
    if (event.target.closest('a')) return;
    const row = event.target.closest('tr[data-href]');
    if (row) location.hash = row.dataset.href;
  };
  container.onkeydown = (event) => {
    if (event.key !== 'Enter' || !event.target.matches('tr[data-href]')) return;
    location.hash = event.target.dataset.href;
  };

  return () => {
    container.onclick = null;
    container.onkeydown = null;
  };
}
