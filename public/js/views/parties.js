import { api } from '../api.js';
import { nationalityList } from '../nationalities.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import { openingFieldsHtml, readOpening } from '../opening-balance.js';
import { refreshMeta } from '../store.js';
import {
  avatar,
  confirmDialog,
  emptyState,
  esc,
  fmtMoney,
  icon,
  openModal,
  setHeader,
  recordMetaHtml,
  toast,
} from '../ui.js';

const CONFIG = {
  customer: {
    base: '/customers',
    title: 'Customers',
    singular: 'customer',
    icon: 'customers',
    addLabel: 'New customer',
    listLabel: 'Invoice',
    emptyTitle: 'No customers yet',
    emptyAction: 'Add your first customer',
    countKey: 'invoice_count',
  },
  vendor: {
    base: '/vendors',
    title: 'Suppliers',
    singular: 'vendor',
    icon: 'vendors',
    addLabel: 'New supplier',
    listLabel: 'Bill',
    emptyTitle: 'No suppliers yet',
    emptyAction: 'Add your first supplier',
    countKey: 'bill_count',
  },
};

// A customer's row opens their page: balance, Receive payment, documents.
function customerPage(party) {
  return `#/customer-balances/${party.id}`;
}

function partyRow(party, config) {
  const count = party[config.countKey] || 0;
  const isCustomer = config.singular === 'customer';
  return `
    <tr data-id="${party.id}" ${isCustomer ? `class="clickable" data-href="${customerPage(party)}" tabindex="0"` : ''}>
      <td>
        <div class="party-cell">
          ${avatar(party.name, 34)}
          <div class="party-info">
            <div class="cell-main">${esc(party.name)} ${party.is_active ? '' : '<span class="chip chip-archived">Archived</span>'}</div>
            <div class="cell-sub">${esc([party.number, party.email || 'No email'].filter(Boolean).join(' · '))}</div>
          </div>
        </div>
      </td>
      <td class="nowrap">${esc(party.phone || '—')}</td>
      <td class="num">${count}</td>
      <td class="num ${party.outstanding_cents > 0 ? 'amount-due' : 'muted'}">${party.outstanding_cents > 0 ? fmtMoney(party.outstanding_cents) : '—'}</td>
      <td>
        <div class="row-actions">
          ${isCustomer ? `<a class="icon-btn" href="${customerPage(party)}" title="Open customer: payments and documents" aria-label="Open ${esc(party.name)}">${icon('chevron', 16)}</a>` : ''}
          <a class="icon-btn" href="#${config.base}/${party.id}/statement" title="Statement">${icon('file', 16)}</a>
          <button class="icon-btn" data-edit="${party.id}" title="Edit">${icon('edit', 16)}</button>
          <button class="icon-btn" data-archive="${party.id}" title="${party.is_active ? 'Archive' : 'Restore'}">${icon(party.is_active ? 'archive' : 'refresh', 16)}</button>
          ${count === 0 ? `<button class="icon-btn danger" data-delete="${party.id}" title="Delete">${icon('trash', 16)}</button>` : ''}
        </div>
      </td>
    </tr>
  `;
}

function partyModal({ party = null, config, onSaved }) {
  const isEdit = Boolean(party);
  openModal({
    title: isEdit ? `Edit ${party.name}` : config.addLabel,
    body: `
      <div class="form-grid">
        <div class="field full">
          <label for="party-name">Name</label>
          <input class="input" id="party-name" name="name" value="${esc(party?.name || '')}" placeholder="${config.singular === 'customer' ? 'Acme Studios' : 'Office Depot'}" required>
        </div>
        <div class="field">
          <label for="party-email">Email</label>
          <input class="input" id="party-email" name="email" type="email" value="${esc(party?.email || '')}" placeholder="billing@example.com">
        </div>
        <div class="field">
          <label for="party-phone">Phone</label>
          <input class="input" id="party-phone" name="phone" value="${esc(party?.phone || '')}" placeholder="(555) 555-0100">
        </div>
        ${config.singular === 'customer' ? `
        <div class="field">
          <label for="party-nationality">Nationality</label>
          <input class="input" id="party-nationality" name="nationality" maxlength="80" autocomplete="off" value="${esc(party?.nationality || '')}" placeholder="Start typing, e.g. Indian" ${nationalityList()}>
        </div>` : ''}
        <div class="field full">
          <label for="party-address">Address</label>
          <textarea class="input" id="party-address" name="address" rows="3" placeholder="Street address&#10;City, State ZIP">${esc(party?.address || '')}</textarea>
        </div>
        <div class="field full">
          <label for="party-notes">Notes</label>
          <textarea class="input" id="party-notes" name="notes" rows="2" placeholder="Optional internal notes">${esc(party?.notes || '')}</textarea>
        </div>
        ${isEdit ? '' : openingFieldsHtml(config.singular)}
      </div>
      ${isEdit ? recordMetaHtml(party) : ''}
    `,
    submitLabel: isEdit ? 'Save changes' : `Add ${config.singular}`,
    async onSubmit(form) {
      const values = new FormData(form);
      const payload = {
        name: values.get('name'),
        email: values.get('email'),
        phone: values.get('phone'),
        address: values.get('address'),
        notes: values.get('notes'),
      };
      if (config.singular === 'customer') payload.nationality = values.get('nationality');
      if (!isEdit) payload.opening = readOpening(form);
      if (!String(payload.name || '').trim()) throw new Error('Name is required');
      const saved = isEdit
        ? await api.put(`${config.base}/${party.id}`, payload)
        : await api.post(config.base, payload);
      toast(isEdit ? `${config.singular === 'customer' ? 'Customer' : 'Supplier'} updated` : `${config.singular === 'customer' ? 'Customer' : 'Supplier'} added`);
      await refreshMeta();
      window.dispatchEvent(new Event('meta-changed'));
      onSaved(saved);
    },
  });
}

export async function renderPartyView(container, { query = new URLSearchParams(), kind } = {}) {
  const config = CONFIG[kind];
  const parties = await api.get(config.base, { include_inactive: 1 });

  setHeader({
    title: config.title,
    actions: `<button class="btn btn-primary" data-action="new-party">${icon('plus', 16)}<span>${config.addLabel}</span></button>`,
  });

  if (!parties.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
    iconName: config.icon,
    title: config.emptyTitle,
    action: `<button class="btn btn-primary" data-action="new-party">${config.emptyAction}</button>`,
  })}
      </div>
    `;
    document.querySelectorAll('[data-action="new-party"]').forEach((button) => {
      button.addEventListener('click', () => partyModal({
        config,
        onSaved: () => renderPartyView(container, { query: new URLSearchParams(), kind }),
      }));
    });
    if (query.get('new')) {
      history.replaceState(null, '', `#/${kind === 'customer' ? 'customers' : 'vendors'}`);
      setTimeout(() => {
        const button = document.querySelector('[data-action="new-party"]');
        if (button) button.click();
      }, 40);
    }
    return;
  }

  container.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="party-search" type="search" placeholder="Search ${config.title.toLowerCase()}…" autocomplete="off">
      </div>
      <label class="checkbox-row" style="margin-left:4px">
        <input type="checkbox" id="show-archived">
        <span>Show archived</span>
      </label>
      <div class="spacer"></div>
      <span class="muted" id="party-count" style="font-size:12px"></span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">${config.title}</caption>
          <thead>
            <tr>
              <th scope="col">${config.singular === 'customer' ? 'Customer' : 'Supplier'}</th>
              <th scope="col">Phone</th>
              <th scope="col" class="num">${config.listLabel}s</th>
              <th scope="col" class="num">Outstanding</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="party-body"></tbody>
        </table>
      </div>
      <div id="party-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#party-search');
  const archivedToggle = container.querySelector('#show-archived');
  const body = container.querySelector('#party-body');
  const countEl = container.querySelector('#party-count');
  const paginationEl = container.querySelector('#party-pagination');
  let page = 1;
  let pageSize = DEFAULT_PAGE_SIZE;
  let filtered = [];

  function renderPage() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="5">${emptyState({
    iconName: 'search',
    title: `No matching ${config.singular}s`,
  })}</td></tr>`;
    } else {
      body.innerHTML = rows.map((party) => partyRow(party, config)).join('');
    }
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
    const showArchived = archivedToggle.checked;
    filtered = parties.filter((party) => {
      if (!showArchived && !party.is_active) return false;
      if (!term) return true;
      return [party.number, party.name, party.email, party.phone, party.notes].some((value) => String(value || '').toLowerCase().includes(term));
    });
    countEl.textContent = `${filtered.length} shown`;
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  archivedToggle.addEventListener('change', applyFilters);

  function refresh() {
    return renderPartyView(container, { query: new URLSearchParams(), kind });
  }

  document.querySelectorAll('[data-action="new-party"]').forEach((button) => {
    button.addEventListener('click', () => partyModal({ config, onSaved: refresh }));
  });

  body.addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-edit]');
    if (editButton) {
      const party = parties.find((item) => item.id === Number(editButton.dataset.edit));
      partyModal({ party, config, onSaved: refresh });
      return;
    }

    const archiveButton = event.target.closest('[data-archive]');
    if (archiveButton) {
      const party = parties.find((item) => item.id === Number(archiveButton.dataset.archive));
      const message = party.is_active
        ? `${party.name} will be hidden from new invoices and bills. Existing records are kept.`
        : `${party.name} will be available again for new invoices and bills.`;
      const confirmed = await confirmDialog({
        title: party.is_active ? `Archive ${party.name}?` : `Restore ${party.name}?`,
        message,
        confirmLabel: party.is_active ? 'Archive' : 'Restore',
        danger: party.is_active,
      });
      if (!confirmed) return;
      try {
        await api.put(`${config.base}/${party.id}`, { is_active: !party.is_active });
        toast(party.is_active ? 'Archived' : 'Restored');
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
      const party = parties.find((item) => item.id === Number(deleteButton.dataset.delete));
      const confirmed = await confirmDialog({
        title: `Delete ${party.name}?`,
        message: `${party.name} has no ${config.listLabel.toLowerCase()}s and will be permanently deleted.`,
        confirmLabel: 'Delete',
      });
      if (!confirmed) return;
      try {
        await api.del(`${config.base}/${party.id}`);
        toast(`${config.singular === 'customer' ? 'Customer' : 'Supplier'} deleted`);
        await refreshMeta();
        window.dispatchEvent(new Event('meta-changed'));
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }

    if (event.target.closest('a, button')) return;
    const row = event.target.closest('tr[data-href]');
    if (row) location.hash = row.dataset.href;
  });
  body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('tr[data-href]')) location.hash = event.target.dataset.href;
  });

  applyFilters();

  if (query.get('new')) {
    history.replaceState(null, '', `#/${kind === 'customer' ? 'customers' : 'vendors'}`);
    setTimeout(() => {
      const button = document.querySelector('[data-action="new-party"]');
      if (button) button.click();
    }, 40);
  }

  return () => {};
}
