import { api } from '../api.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import {
  avatar,
  emptyState,
  esc,
  fmtMoney,
  icon,
  setHeader,
} from '../ui.js';

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

function netClass(cents) {
  if (cents > 0) return 'amount-due';
  if (cents < 0) return 'amount-ok';
  return 'muted';
}

function balanceRow(row) {
  return `
    <tr class="clickable" data-id="${row.id}" tabindex="0">
      <td>
        <div class="party-cell">
          ${avatar(row.name, 34)}
          <div class="party-info">
            <div class="cell-main">${esc(row.name)} ${row.is_active ? '' : '<span class="chip chip-archived">Archived</span>'}</div>
            <div class="cell-sub">${esc(row.email || row.phone || 'No contact details')}</div>
          </div>
        </div>
      </td>
      <td class="num">${row.open_invoice_count || 0}</td>
      <td class="num ${row.outstanding_cents > 0 ? 'amount-due' : 'muted'}">${fmtMoney(row.outstanding_cents)}</td>
      <td class="num ${row.unapplied_credit_cents > 0 ? 'amount-ok' : 'muted'}">${fmtMoney(row.unapplied_credit_cents)}</td>
      <td class="num ${row.advance_cents > 0 ? 'amount-ok' : 'muted'}">${fmtMoney(row.advance_cents)}</td>
      <td class="num ${row.cancellation_refund_cents > 0 ? 'amount-ok' : 'muted'}">${fmtMoney(row.cancellation_refund_cents)}</td>
      <td class="num ${netClass(row.net_balance_cents)}">${fmtMoney(row.net_balance_cents)}</td>
      <td>
        <div class="row-actions">
          <a class="icon-btn" href="#/customer-balances/${row.id}" title="Balance details" aria-label="Balance details for ${esc(row.name)}">${icon('wallet', 16)}</a>
          <a class="icon-btn" href="#/customers/${row.id}/statement" title="Statement" aria-label="Statement for ${esc(row.name)}">${icon('file', 16)}</a>
        </div>
      </td>
    </tr>
  `;
}

export async function render(container) {
  const balances = await api.get('/customer-balances');
  const active = balances.filter((row) => row.is_active);
  const totals = active.reduce((sum, row) => {
    sum.outstanding += row.outstanding_cents;
    sum.overdue += row.overdue_cents;
    sum.credits += row.unapplied_credit_cents;
    sum.advances += row.advance_cents;
    sum.refunds += row.cancellation_refund_cents;
    sum.net += row.net_balance_cents;
    return sum;
  }, { outstanding: 0, overdue: 0, credits: 0, advances: 0, refunds: 0, net: 0 });
  const creditBalance = totals.credits + totals.advances + totals.refunds;

  setHeader({
    title: 'Customer balances',
    subtitle: `${active.length} active customer${active.length === 1 ? '' : 's'} · ${fmtMoney(totals.outstanding)} due · ${fmtMoney(creditBalance)} available credit`,
    actions: `<a class="btn btn-secondary" href="#/settlement-queue">${icon('clock', 15)}<span>Settlements</span></a>`,
  });

  if (!balances.length) {
    container.innerHTML = `<div class="card">${emptyState({
      iconName: 'customers',
      title: 'No customers yet',
      message: 'Add a customer and raise an invoice to see their receivable, credits, advances and cancellation refunds in one place.',
      action: '<a class="btn btn-primary" href="#/customers">Go to customers</a>',
    })}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="kpi-grid">
      ${summaryCard('A/R due', totals.outstanding, `${fmtMoney(totals.overdue)} overdue`, 'invoice', 'blue')}
      ${summaryCard('Customer credits', totals.credits, 'Unapplied credit notes', 'wallet', 'amber')}
      ${summaryCard('Advances & refunds', totals.advances + totals.refunds, `${fmtMoney(totals.advances)} advances · ${fmtMoney(totals.refunds)} refunds`, 'cash', 'indigo')}
      ${summaryCard('Net position', totals.net, totals.net >= 0 ? 'Customers owe you' : 'You owe customers', 'trendUp', totals.net >= 0 ? 'green' : 'amber')}
    </div>

    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="balance-search" type="search" placeholder="Search customers…" aria-label="Search customer balances" autocomplete="off">
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="balance-only">
        <span>With a balance only</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="balance-archived">
        <span>Show archived</span>
      </label>
      <div class="spacer"></div>
      <span class="muted" id="balance-count" style="font-size:12px"></span>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Customer balances</caption>
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col" class="num">Open invoices</th>
              <th scope="col" class="num">A/R due</th>
              <th scope="col" class="num">Credits</th>
              <th scope="col" class="num">Advances</th>
              <th scope="col" class="num">Refund payable</th>
              <th scope="col" class="num">Net position</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="balance-body"></tbody>
        </table>
      </div>
      <div id="balance-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#balance-search');
  const onlyWithBalance = container.querySelector('#balance-only');
  const showArchived = container.querySelector('#balance-archived');
  const body = container.querySelector('#balance-body');
  const countEl = container.querySelector('#balance-count');
  const paginationEl = container.querySelector('#balance-pagination');
  let page = 1;
  let pageSize = DEFAULT_PAGE_SIZE;
  let filtered = [];

  function renderPage() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    body.innerHTML = rows.length
      ? rows.map(balanceRow).join('')
      : `<tr><td colspan="8">${emptyState({
        iconName: 'search',
        title: 'No matching customers',
        message: 'Try another search, or turn off the balance and archived filters.',
      })}</td></tr>`;
    countEl.textContent = `${filtered.length} shown`;
    paginationEl.innerHTML = paginationHtml({ total: filtered.length, page, pageSize });
    bindPagination(paginationEl.querySelector('[data-pagination]'), ({ page: nextPage, pageSize: nextSize }) => {
      page = nextPage;
      pageSize = nextSize;
      renderPage();
    });
  }

  function applyFilters() {
    page = 1;
    const term = searchInput.value.trim().toLowerCase();
    const balanceOnly = onlyWithBalance.checked;
    const archived = showArchived.checked;
    filtered = balances.filter((row) => {
      if (!archived && !row.is_active) return false;
      if (balanceOnly && row.outstanding_cents === 0 && row.credit_balance_cents === 0) return false;
      if (!term) return true;
      return [row.name, row.email, row.phone, row.notes]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  onlyWithBalance.addEventListener('change', applyFilters);
  showArchived.addEventListener('change', applyFilters);
  applyFilters();

  function openRow(row) {
    if (row) location.hash = `#/customer-balances/${row.dataset.id}`;
  }

  body.addEventListener('click', (event) => {
    if (event.target.closest('a')) return;
    openRow(event.target.closest('tr[data-id]'));
  });
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.matches('tr[data-id]')) return;
    openRow(event.target);
  });
}
