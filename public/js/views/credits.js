import { api } from '../api.js';
import {
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  openModal,
  setHeader,
  toast,
  todayISO,
  toCents,
} from '../ui.js';

export async function render(container, { query = new URLSearchParams() } = {}) {
  const [credits, customers, accounts] = await Promise.all([
    api.get('/credits'),
    api.get('/customers'),
    api.get('/accounts'),
  ]);
  const activeCustomers = customers.filter((customer) => customer.is_active);
  const revenueAccounts = accounts.filter((account) => account.is_active && account.type === 'revenue');
  const issued = credits.filter((credit) => credit.status === 'issued');
  const remaining = issued.reduce((sum, credit) => sum + credit.remaining_cents, 0);

  setHeader({
    title: 'Credit notes',
    subtitle: `${issued.length} open · ${fmtMoney(remaining)} unapplied customer credit`,
    actions: `<button class="btn btn-primary" data-action="new-credit">${icon('plus', 15)}<span>New credit note</span></button>`,
  });

  let body = '';
  if (!credits.length) {
    body = `<div class="card">${emptyState({
      iconName: 'invoice',
      title: 'No credit notes yet',
      message: 'Issue a credit note when a customer is owed a refund or adjustment. Apply it to an open invoice or keep it as an unapplied credit.',
      action: '<button class="btn btn-primary" data-action="new-credit">Create credit note</button>',
    })}</div>`;
  } else {
    body = `
      <div class="toolbar">
        <div class="search-box">${icon('search', 17)}<input class="input" id="credit-search" type="search" placeholder="Search credit notes…" autocomplete="off"></div>
        <div class="spacer"></div>
        <span class="muted" id="credit-count" style="font-size:12px"></span>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>Credit note</th><th>Customer</th><th>Date</th><th class="num">Amount</th><th class="num">Applied</th><th class="num">Remaining</th><th>Status</th></tr></thead>
            <tbody id="credit-body"></tbody>
          </table>
        </div>
      </div>
    `;
  }
  container.innerHTML = body;

  function applyFilter() {
    const searchInput = container.querySelector('#credit-search');
    const bodyEl = container.querySelector('#credit-body');
    if (!searchInput || !bodyEl) return;
    const term = searchInput.value.trim().toLowerCase();
    const rows = credits.filter((credit) => [credit.number, credit.customer_name, credit.notes]
      .some((value) => String(value || '').toLowerCase().includes(term)));
    container.querySelector('#credit-count').textContent = `${rows.length} shown`;
    bodyEl.innerHTML = rows.length ? rows.map((credit) => `
      <tr class="clickable" data-id="${credit.id}">
        <td><div class="cell-main">${esc(credit.number)}</div><div class="cell-sub">${esc(credit.revenue_account_name)}</div></td>
        <td>${esc(credit.customer_name)}</td>
        <td class="nowrap">${esc(fmtDate(credit.credit_date))}</td>
        <td class="num">${fmtMoney(credit.amount_cents)}</td>
        <td class="num">${fmtMoney(credit.applied_cents)}</td>
        <td class="num ${credit.remaining_cents ? 'amount-due' : 'muted'}">${fmtMoney(credit.remaining_cents)}</td>
        <td><span class="badge badge-${credit.status === 'issued' ? 'issued' : 'void'}">${credit.status === 'issued' ? 'Issued' : 'Void'}</span></td>
      </tr>
    `).join('') : `<tr><td colspan="7">${emptyState({ iconName: 'search', title: 'No matching credit notes', message: 'Try a different search term.' })}</td></tr>`;
  }

  const searchInput = container.querySelector('#credit-search');
  if (searchInput) searchInput.addEventListener('input', applyFilter);
  const bodyEl = container.querySelector('#credit-body');
  if (bodyEl) {
    applyFilter();
    bodyEl.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-id]');
      if (row) location.hash = `#/credits/${row.dataset.id}`;
    });
  }

  const openNew = () => openCreditModal({
    customers: activeCustomers,
    revenueAccounts,
    customerId: Number(query.get('customer')) || null,
    onSaved: (credit) => { location.hash = `#/credits/${credit.id}`; },
  });
  document.querySelectorAll('[data-action="new-credit"]').forEach((button) => button.addEventListener('click', openNew));
  if (query.get('new')) {
    history.replaceState(null, '', '#/credits');
    setTimeout(openNew, 40);
  }
}

function openCreditModal({ customers, revenueAccounts, customerId = null, onSaved }) {
  openModal({
    title: 'New credit note',
    subtitle: 'Issue a customer credit and post it to the ledger.',
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
          <div class="hint">This account is debited, reducing the related revenue.</div>
        </div>
        <div class="field full">
          <label for="credit-notes">Notes</label>
          <textarea class="input" id="credit-notes" name="notes" rows="2" placeholder="Reason for the credit">${''}</textarea>
        </div>
      </div>
    `,
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
