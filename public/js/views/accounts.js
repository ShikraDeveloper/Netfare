import { api } from '../api.js';
import { refreshMeta, store } from '../store.js';
import {
  confirmDialog,
  emptyState,
  esc,
  fmtMoney,
  icon,
  openModal,
  setHeader,
  toast,
} from '../ui.js';

const TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const TYPE_LABELS = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expenses',
};

const SUBTYPES = [
  ['', '—'],
  ['current_asset', 'Current asset'],
  ['fixed_asset', 'Fixed asset'],
  ['cash', 'Cash / bank'],
  ['receivable', 'Receivable'],
  ['current_liability', 'Current liability'],
  ['long_term_liability', 'Long-term liability'],
  ['payable', 'Payable'],
  ['equity', 'Equity'],
  ['operating_revenue', 'Operating revenue'],
  ['other_revenue', 'Other revenue'],
  ['cogs', 'Cost of sales'],
  ['operating_expense', 'Operating expense'],
  ['other_expense', 'Other expense'],
];

const SUBTYPE_LABELS = Object.fromEntries(SUBTYPES);

function accountRow(account) {
  return `
    <tr ${account.is_active ? '' : 'style="opacity:.55"'}>
      <td class="nowrap muted" style="font-variant-numeric:tabular-nums">${esc(account.code)}</td>
      <td>
        <div class="cell-main">${esc(account.name)} ${account.is_system ? '<span class="chip">System</span>' : ''} ${account.is_cash ? '<span class="chip">Cash</span>' : ''} ${account.is_active ? '' : '<span class="chip chip-archived">Archived</span>'}</div>
        <div class="cell-sub">${esc(account.description || SUBTYPE_LABELS[account.subtype] || '')}</div>
      </td>
      <td class="num ${account.balance_cents < 0 ? 'muted' : ''}">${fmtMoney(account.balance_cents)}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-edit="${account.id}" title="Edit">${icon('edit', 16)}</button>
          ${account.is_system ? '' : `<button class="icon-btn" data-archive="${account.id}" title="${account.is_active ? 'Archive' : 'Restore'}">${icon(account.is_active ? 'archive' : 'refresh', 16)}</button>`}
          ${account.is_system ? '' : `<button class="icon-btn danger" data-delete="${account.id}" title="Delete">${icon('trash', 16)}</button>`}
        </div>
      </td>
    </tr>
  `;
}

function accountModal({ account = null, onSaved }) {
  const isEdit = Boolean(account);
  const isSystem = Boolean(account?.is_system);
  openModal({
    title: isEdit ? `Edit ${account.name}` : 'New account',
    body: `
      <div class="form-grid">
        <div class="field">
          <label for="account-code">Code</label>
          <input class="input" id="account-code" name="code" value="${esc(account?.code || '')}" placeholder="e.g. 6600" ${isSystem ? 'disabled' : ''} required>
          ${isSystem ? '<div class="hint">System account codes cannot be changed.</div>' : ''}
        </div>
        <div class="field">
          <label for="account-name">Name</label>
          <input class="input" id="account-name" name="name" value="${esc(account?.name || '')}" placeholder="e.g. Travel & meals" required>
        </div>
        <div class="field">
          <label for="account-type">Type</label>
          <select class="input" id="account-type" name="type" ${isSystem ? 'disabled' : ''}>
            ${TYPE_ORDER.map((type) => `<option value="${type}" ${account?.type === type ? 'selected' : ''}>${TYPE_LABELS[type]}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="account-subtype">Subtype</label>
          <select class="input" id="account-subtype" name="subtype">
            ${SUBTYPES.map(([value, label]) => `<option value="${value}" ${account?.subtype === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select>
        </div>
        <div class="field full">
          <label for="account-description">Description</label>
          <input class="input" id="account-description" name="description" value="${esc(account?.description || '')}" placeholder="What is this account used for?">
        </div>
        <div class="field full">
          <label class="checkbox-row">
            <input type="checkbox" name="is_cash" value="1" ${account?.is_cash ? 'checked' : ''}>
            <span>Treat as a cash or bank account — included in “Cash on hand” on the dashboard</span>
          </label>
        </div>
        ${isEdit && !isSystem ? `
          <div class="field full">
            <label class="checkbox-row">
              <input type="checkbox" name="is_active" value="1" ${account.is_active ? 'checked' : ''}>
              <span>Active — available for new transactions</span>
            </label>
          </div>
        ` : ''}
      </div>
    `,
    submitLabel: isEdit ? 'Save account' : 'Add account',
    async onSubmit(form) {
      const values = new FormData(form);
      const payload = {
        code: values.get('code') || account?.code,
        name: values.get('name'),
        type: values.get('type') || account?.type,
        subtype: values.get('subtype'),
        description: values.get('description'),
        is_cash: values.get('is_cash') ? 1 : 0,
      };
      if (isEdit && !isSystem) payload.is_active = values.get('is_active') ? 1 : 0;
      if (!String(payload.name || '').trim()) throw new Error('Account name is required');
      if (!isSystem && !String(payload.code || '').trim()) throw new Error('Account code is required');
      const saved = isEdit
        ? await api.put(`/accounts/${account.id}`, payload)
        : await api.post('/accounts', payload);
      toast(isEdit ? 'Account updated' : 'Account added');
      await refreshMeta();
      window.dispatchEvent(new Event('meta-changed'));
      onSaved(saved);
    },
  });
}

export async function render(container, { query } = {}) {
  const accounts = await api.get('/accounts', { include_inactive: 1 });
  const activeAccounts = accounts.filter((account) => account.is_active);

  const totals = Object.fromEntries(TYPE_ORDER.map((type) => [
    type,
    activeAccounts.filter((account) => account.type === type).reduce((sum, account) => sum + account.balance_cents, 0),
  ]));

  setHeader({
    title: 'Chart of accounts',
    actions: `<button class="btn btn-primary" data-action="new-account">${icon('plus', 16)}<span>New account</span></button>`,
  });

  container.innerHTML = `
    <div class="account-summary">
      ${TYPE_ORDER.map((type) => `
        <div class="summary-tile ${type === 'expense' || type === 'revenue' ? 'small' : ''}">
          <span>${TYPE_LABELS[type]}</span>
          <strong>${fmtMoney(totals[type])}</strong>
        </div>
      `).join('')}
    </div>

    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="account-search" type="search" placeholder="Search by name or code…" autocomplete="off">
      </div>
      <label class="checkbox-row" style="margin-left:4px">
        <input type="checkbox" id="show-archived">
        <span>Show archived</span>
      </label>
      <div class="spacer"></div>
      <span class="muted" id="account-count" style="font-size:12px"></span>
    </div>

    <div class="card" id="accounts-card"></div>
  `;

  const searchInput = container.querySelector('#account-search');
  const archivedToggle = container.querySelector('#show-archived');
  const card = container.querySelector('#accounts-card');
  const countEl = container.querySelector('#account-count');

  function applyFilters() {
    const term = searchInput.value.trim().toLowerCase();
    const showArchived = archivedToggle.checked;
    const filtered = accounts.filter((account) => {
      if (!showArchived && !account.is_active) return false;
      if (!term) return true;
      return [account.code, account.name, account.description, account.subtype]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    countEl.textContent = `${filtered.length} shown`;

    if (!filtered.length) {
      card.innerHTML = emptyState({
        iconName: 'search',
        title: 'No matching accounts',
        });
      return;
    }

    card.innerHTML = TYPE_ORDER.map((type) => {
      const rows = filtered.filter((account) => account.type === type);
      if (!rows.length) return '';
      const total = rows.reduce((sum, account) => sum + account.balance_cents, 0);
      return `
        <div class="account-group">
          <div class="account-group-head">
            <span>${TYPE_LABELS[type]}</span>
            <span>${fmtMoney(total)}</span>
          </div>
          <div class="table-wrap">
            <table class="data"><caption class="sr-only">${TYPE_LABELS[type]} accounts</caption>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Account</th>
                  <th scope="col" class="num">Balance</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>${rows.map(accountRow).join('')}</tbody>
            </table>
          </div>
        </div>
      `;
    }).join('');
  }

  searchInput.addEventListener('input', applyFilters);
  archivedToggle.addEventListener('change', applyFilters);

  function refresh() {
    return render(container, { query: new URLSearchParams() });
  }

  document.querySelectorAll('[data-action="new-account"]').forEach((button) => {
    button.addEventListener('click', () => accountModal({ onSaved: refresh }));
  });

  card.addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-edit]');
    if (editButton) {
      const account = accounts.find((item) => item.id === Number(editButton.dataset.edit));
      accountModal({ account, onSaved: refresh });
      return;
    }

    const archiveButton = event.target.closest('[data-archive]');
    if (archiveButton) {
      const account = accounts.find((item) => item.id === Number(archiveButton.dataset.archive));
      const confirmed = await confirmDialog({
        title: account.is_active ? `Archive ${account.name}?` : `Restore ${account.name}?`,
        message: account.is_active
          ? 'Archived accounts stay in your reports and history but cannot be used for new transactions.'
          : 'This account will be available again for new transactions.',
        confirmLabel: account.is_active ? 'Archive' : 'Restore',
        danger: account.is_active,
      });
      if (!confirmed) return;
      try {
        await api.put(`/accounts/${account.id}`, { is_active: !account.is_active });
        toast(account.is_active ? 'Account archived' : 'Account restored');
        await refreshMeta();
        window.dispatchEvent(new Event('meta-changed'));
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }

    const deleteButton = event.target.closest('[data-delete]');
    if (deleteButton) {
      const account = accounts.find((item) => item.id === Number(deleteButton.dataset.delete));
      const confirmed = await confirmDialog({
        title: `Delete ${account.name}?`,
        message: 'Accounts that have been used in a transaction cannot be deleted — archive them instead.',
        confirmLabel: 'Delete account',
      });
      if (!confirmed) return;
      try {
        await api.del(`/accounts/${account.id}`);
        toast('Account deleted');
        await refreshMeta();
        window.dispatchEvent(new Event('meta-changed'));
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  });

  applyFilters();

  if (query.get('new')) {
    history.replaceState(null, '', '#/accounts');
    setTimeout(() => {
      const button = document.querySelector('[data-action="new-account"]');
      if (button) button.click();
    }, 40);
  }

  return () => {};
}
