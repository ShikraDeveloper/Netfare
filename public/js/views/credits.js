import { api } from '../api.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import {
  bindDateRange,
  dateRangeHtml,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  inDateRange,
  openModal,
  setHeader,
  toast,
  todayISO,
  toCents,
  entryTimeHtml,
} from '../ui.js';

function creditSourceBadge(credit) {
  if (credit.cancellation_number) {
    return `<span class="source source-cancellation">Cancellation ${esc(credit.cancellation_number)}</span>`;
  }
  return '<span class="source source-standalone">Standalone</span>';
}

function creditStatusBadge(credit) {
  if (credit.status === 'void') return '<span class="badge badge-void">Void</span>';
  if (Number(credit.remaining_cents) <= 0) return '<span class="badge badge-paid">Fully applied</span>';
  if (Number(credit.applied_cents) > 0) return '<span class="badge badge-partial">Partially applied</span>';
  return '<span class="badge badge-issued">Issued</span>';
}

export async function render(container, { query = new URLSearchParams() } = {}) {
  const [credits, customers, accounts, cancellations] = await Promise.all([
    api.get('/credits'),
    api.get('/customers'),
    api.get('/accounts'),
    api.get('/cancellations'),
  ]);
  const activeCustomers = customers.filter((customer) => customer.is_active);
  const revenueAccounts = accounts.filter((account) => account.is_active && account.type === 'revenue');
  const issued = credits.filter((credit) => credit.status === 'issued');
  const remaining = issued.reduce((sum, credit) => sum + credit.remaining_cents, 0);
  const openCancellationsByCustomer = new Map();
  for (const cancellation of cancellations) {
    if (cancellation.refund_remaining_cents <= 0) continue;
    const list = openCancellationsByCustomer.get(cancellation.customer_id) || [];
    list.push(cancellation);
    openCancellationsByCustomer.set(cancellation.customer_id, list);
  }

  setHeader({
    title: 'Credit notes & customer credits',
    actions: `<button class="btn btn-primary" data-action="new-credit">${icon('plus', 15)}<span>New credit note</span></button>`,
  });

  let body = '';
  if (!credits.length) {
    body = `<div class="card">${emptyState({
      iconName: 'invoice',
      title: 'No credit notes yet',
      action: '<button class="btn btn-primary" data-action="new-credit">Create credit note</button>',
    })}</div>`;
  } else {
    body = `
      <div class="toolbar">
        <div class="search-box">${icon('search', 17)}<input class="input" id="credit-search" type="search" placeholder="Search credit notes…" aria-label="Search credit notes" autocomplete="off"></div>
        <select class="input" id="credit-status" aria-label="Filter credit notes by status" style="max-width:160px">
          <option value="all">All statuses</option>
          <option value="issued">Issued</option>
          <option value="void">Void</option>
        </select>
        <select class="input" id="credit-source" aria-label="Filter credit notes by source" style="max-width:170px">
          <option value="all">All sources</option>
          <option value="standalone">Standalone</option>
          <option value="cancellation">Cancellation</option>
        </select>
        ${dateRangeHtml({ label: 'Credit date' })}
        <div class="spacer"></div>
        <span class="muted" id="credit-count" style="font-size:12px"></span>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table class="data"><caption class="sr-only">Credit notes</caption>
            <thead><tr><th scope="col">Credit note</th><th scope="col">Customer</th><th scope="col">Date</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Applied</th><th scope="col" class="num">Remaining</th><th scope="col">Status</th></tr></thead>
            <tbody id="credit-body"></tbody>
          </table>
        </div>
        <div id="credit-pagination"></div>
      </div>
    `;
  }
  container.innerHTML = body;

  const searchInput = container.querySelector('#credit-search');
  const statusSelect = container.querySelector('#credit-status');
  const sourceSelect = container.querySelector('#credit-source');
  const bodyEl = container.querySelector('#credit-body');
  const paginationEl = container.querySelector('#credit-pagination');
  const countEl = container.querySelector('#credit-count');
  const dateRange = bindDateRange(container, () => applyFilter());
  let page = 1;
  let pageSize = DEFAULT_PAGE_SIZE;
  let filtered = [];

  function renderPage() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    bodyEl.innerHTML = rows.length ? rows.map((credit) => `
      <tr class="clickable" data-id="${credit.id}" tabindex="0">
        <td><div class="cell-main">${esc(credit.number)}</div><div class="cell-sub">${creditSourceBadge(credit)} <span class="muted">${esc(credit.revenue_account_name)}</span></div></td>
        <td>${esc(credit.customer_name)}</td>
        <td class="nowrap">${esc(fmtDate(credit.credit_date))}${entryTimeHtml(credit.credit_date, credit.created_at)}</td>
        <td class="num">${fmtMoney(credit.amount_cents)}</td>
        <td class="num">${fmtMoney(credit.applied_cents)}</td>
        <td class="num ${credit.remaining_cents ? 'amount-due' : 'muted'}">${fmtMoney(credit.remaining_cents)}</td>
        <td>${creditStatusBadge(credit)}</td>
      </tr>
    `).join('') : `<tr><td colspan="7">${emptyState({ iconName: 'search', title: 'No matching credit notes' })}</td></tr>`;
    paginationEl.innerHTML = paginationHtml({ total: filtered.length, page, pageSize });
    bindPagination(paginationEl.querySelector('[data-pagination]'), ({ page: nextPage, pageSize: nextSize }) => {
      page = nextPage;
      pageSize = nextSize;
      renderPage();
    });
  }

  function applyFilter() {
    if (!searchInput || !bodyEl) return;
    page = 1;
    const term = searchInput.value.trim().toLowerCase();
    const status = statusSelect?.value || 'all';
    const source = sourceSelect?.value || 'all';
    const { from, to } = dateRange.values();
    filtered = credits.filter((credit) => {
      if (!inDateRange(credit.credit_date, from, to)) return false;
      if (status !== 'all' && credit.status !== status) return false;
      if (source === 'cancellation' && !credit.cancellation_id) return false;
      if (source === 'standalone' && credit.cancellation_id) return false;
      return [credit.number, credit.customer_name, credit.cancellation_number, credit.notes]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    countEl.textContent = `${filtered.length} matching`;
    renderPage();
  }

  if (searchInput) searchInput.addEventListener('input', applyFilter);
  if (statusSelect) statusSelect.addEventListener('change', applyFilter);
  if (sourceSelect) sourceSelect.addEventListener('change', applyFilter);
  if (bodyEl) {
    applyFilter();
    bodyEl.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-id]');
      if (row) location.hash = `#/credits/${row.dataset.id}`;
    });
    bodyEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !event.target.matches('tr[data-id]')) return;
      location.hash = `#/credits/${event.target.dataset.id}`;
    });
  }

  const openNew = () => openCreditModal({
    customers: activeCustomers,
    revenueAccounts,
    openCancellationsByCustomer,
    customerId: Number(query.get('customer')) || null,
    onSaved: (credit) => { location.hash = `#/credits/${credit.id}`; },
  });
  document.querySelectorAll('[data-action="new-credit"]').forEach((button) => button.addEventListener('click', openNew));
  if (query.get('new')) {
    history.replaceState(null, '', '#/credits');
    setTimeout(openNew, 40);
  }
}

function openCreditModal({ customers, revenueAccounts, openCancellationsByCustomer = new Map(), customerId = null, onSaved }) {
  openModal({
    title: 'New credit note',
    submitLabel: 'Issue credit note',
    body: `
      <div class="form-grid">
        <div class="field full">
          <label for="credit-customer">Customer</label>
          <select class="input" id="credit-customer" name="customer_id" required>
            <option value="">Choose a customer…</option>
            ${customers.map((customer) => `<option value="${customer.id}" ${customer.id === customerId ? 'selected' : ''}>${esc(customer.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field full">
          <div class="form-note" id="credit-cancellation-warning" hidden></div>
        </div>
        <div class="field">
          <label for="credit-date">Credit date</label>
          <input class="input" id="credit-date" name="credit_date" type="date" value="${todayISO()}" required>
        </div>
        <div class="field">
          <label for="credit-amount">Amount</label>
          <input class="input" id="credit-amount" name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00" required>
        </div>
        <div class="field full">
          <label for="credit-revenue">Revenue account</label>
          <select class="input" id="credit-revenue" name="revenue_account_id" required>
            ${revenueAccounts.map((account) => `<option value="${account.id}" ${account.code === '4000' ? 'selected' : ''}>${esc(account.code)} ${esc(account.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field full">
          <div class="form-note">
            Converting a cancellation refund? Use <strong>Convert to credit</strong> on the cancellation note instead, so revenue is not reduced twice.
          </div>
        </div>
        <div class="field full">
          <label for="credit-notes">Notes</label>
          <textarea class="input" id="credit-notes" name="notes" rows="2" placeholder="Reason for the credit">${''}</textarea>
        </div>
      </div>
    `,
    onMount(overlay) {
      const customerSelect = overlay.querySelector('#credit-customer');
      const warning = overlay.querySelector('#credit-cancellation-warning');
      if (!customerSelect || !warning) return;
      const syncWarning = () => {
        const cancellations = openCancellationsByCustomer.get(Number(customerSelect.value)) || [];
        if (!cancellations.length) {
          warning.hidden = true;
          warning.innerHTML = '';
          return;
        }
        warning.hidden = false;
        warning.innerHTML = `<strong>Open cancellation refund:</strong> ${cancellations.map((cancellation) => `${esc(cancellation.number)} (${fmtMoney(cancellation.refund_remaining_cents)} remaining)`).join(', ')}. Use <strong>Convert to credit</strong> on that cancellation note unless this is a separate adjustment.`;
      };
      customerSelect.addEventListener('change', syncWarning);
      syncWarning();
    },
    async onSubmit(form) {
      const values = new FormData(form);
      if (!values.get('customer_id')) throw new Error('Choose a customer');
      if (!values.get('revenue_account_id')) throw new Error('Choose a revenue account');
      const credit = await api.post('/credits', {
        customer_id: Number(values.get('customer_id')),
        credit_date: values.get('credit_date'),
        amount_cents: toCents(values.get('amount')),
        revenue_account_id: Number(values.get('revenue_account_id')),
        notes: values.get('notes'),
      });
      toast(`${credit.number} issued`);
      onSaved(credit);
    },
  });
}
