import { api } from '../api.js';
import { activeVendors, purchaseAccounts, store } from '../store.js';
import { lineItemsHtml, mountLineItems } from '../line-items.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import {
  addDaysISO,
  avatar,
  bindDateRange,
  dateRangeHtml,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  inDateRange,
  openModal,
  optionsHtml,
  setHeader,
  statusBadge,
  todayISO,
  toast,
} from '../ui.js';

function billRow(bill) {
  return `
    <tr class="clickable" data-id="${bill.id}" tabindex="0">
      <td>
        <div class="cell-main">${esc(bill.number)}</div>
        <div class="cell-sub">${esc(fmtDate(bill.bill_date))}</div>
      </td>
      <td>
        <div class="party-cell">
          ${avatar(bill.vendor_name, 32)}
          <div class="party-info">
            <div class="cell-main">${esc(bill.vendor_name)}</div>
            <div class="cell-sub">${esc(bill.vendor_email || '')}</div>
          </div>
        </div>
      </td>
      <td class="nowrap">${esc(fmtDate(bill.due_date))}</td>
      <td>${statusBadge(bill.status_display)}</td>
      <td class="num">${fmtMoney(bill.total_cents)}</td>
      <td class="num ${bill.balance_cents > 0 && bill.status_display !== 'void' ? 'amount-due' : 'muted'}">
        ${bill.balance_cents > 0 && bill.status_display !== 'void' ? fmtMoney(bill.balance_cents) : '—'}
      </td>
      <td class="right muted">${icon('chevron', 16)}</td>
    </tr>
  `;
}

export async function render(container, { query } = {}) {
  const bills = await api.get('/bills');
  const outstanding = bills
    .filter((bill) => !['draft', 'void', 'paid'].includes(bill.status_display))
    .reduce((sum, bill) => sum + bill.balance_cents, 0);
  const openCount = bills.filter((bill) => !['draft', 'void', 'paid'].includes(bill.status_display)).length;

  setHeader({
    title: 'Bills & expenses',
    subtitle: `${bills.length} bill${bills.length === 1 ? '' : 's'} · ${fmtMoney(outstanding)} payable across ${openCount}`,
    actions: `<button class="btn btn-primary" data-action="new-bill">${icon('plus', 16)}<span>New bill</span></button>`,
  });

  if (!bills.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
    iconName: 'bill',
    title: 'No bills yet',
    message: 'Record a supplier bill or expense. Receiving it will post the expense and a payable to your ledger automatically.',
    action: '<button class="btn btn-primary" data-action="new-bill">Record your first bill</button>',
  })}
      </div>
    `;
    document.querySelectorAll('[data-action="new-bill"]').forEach((button) => {
      button.addEventListener('click', () => openBillModal({ onSaved: (bill) => { location.hash = `#/bills/${bill.id}`; } }));
    });
    maybeOpenNew(query, true);
    return;
  }

  container.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="bill-search" type="search" placeholder="Search bills or suppliers…" aria-label="Search bills or suppliers" autocomplete="off">
      </div>
      <select class="input" id="bill-status" aria-label="Filter bills by status" style="max-width:170px">
        <option value="all">All statuses</option>
        <option value="outstanding">Outstanding</option>
        <option value="draft">Draft</option>
        <option value="received">Received</option>
        <option value="partial">Partial</option>
        <option value="overdue">Overdue</option>
        <option value="paid">Paid</option>
        <option value="void">Void</option>
      </select>
      ${dateRangeHtml({ label: 'Bill date' })}
      <div class="spacer"></div>
      <span class="muted" id="bill-count" style="font-size:12px"></span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Bills</caption>
          <thead>
            <tr>
              <th scope="col">Bill</th>
              <th scope="col">Supplier</th>
              <th scope="col">Due date</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Total</th>
              <th scope="col" class="num">Balance</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="bill-body"></tbody>
        </table>
      </div>
      <div id="bill-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#bill-search');
  const statusSelect = container.querySelector('#bill-status');
  const body = container.querySelector('#bill-body');
  const countEl = container.querySelector('#bill-count');
  const paginationEl = container.querySelector('#bill-pagination');
  const dateRange = bindDateRange(container, () => applyFilters());
  let page = 1;
  let pageSize = DEFAULT_PAGE_SIZE;
  let filtered = [];

  function renderPage() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7">${emptyState({
        iconName: 'search',
        title: 'No matching bills',
        message: 'Try a different search term, status or date range.',
      })}</td></tr>`;
    } else {
      body.innerHTML = rows.map(billRow).join('');
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
    const status = statusSelect.value;
    const { from, to } = dateRange.values();
    filtered = bills.filter((bill) => {
      if (!inDateRange(bill.bill_date, from, to)) return false;
      const matchesStatus = status === 'all'
        || (status === 'outstanding'
          ? !['draft', 'void', 'paid'].includes(bill.status_display)
          : bill.status_display === status);
      if (!matchesStatus) return false;
      if (!term) return true;
      return [bill.number, bill.vendor_name, bill.vendor_email, bill.notes, bill.status_display]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    const filteredOutstanding = filtered
      .filter((bill) => !['draft', 'void', 'paid'].includes(bill.status_display))
      .reduce((sum, bill) => sum + bill.balance_cents, 0);
    const filteredOpen = filtered
      .filter((bill) => !['draft', 'void', 'paid'].includes(bill.status_display)).length;
    countEl.textContent = `${filtered.length} matching`;
    const subtitleEl = document.getElementById('page-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = `${filtered.length} bill${filtered.length === 1 ? '' : 's'} · ${fmtMoney(filteredOutstanding)} payable across ${filteredOpen}`;
    }
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  body.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) location.hash = `#/bills/${row.dataset.id}`;
  });
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.matches('tr[data-id]')) return;
    location.hash = `#/bills/${event.target.dataset.id}`;
  });

  document.querySelectorAll('[data-action="new-bill"]').forEach((button) => {
    button.addEventListener('click', () => openBillModal({ onSaved: (bill) => { location.hash = `#/bills/${bill.id}`; } }));
  });

  applyFilters();
  maybeOpenNew(query, false);
}

function maybeOpenNew(query, alreadyBound) {
  if (query && query.get('new')) {
    history.replaceState(null, '', '#/bills');
    if (!alreadyBound) {
      openBillModal({ onSaved: (bill) => { location.hash = `#/bills/${bill.id}`; } });
    } else {
      setTimeout(() => {
        const button = document.querySelector('[data-action="new-bill"]');
        if (button) button.click();
      }, 40);
    }
  }
}

export function openBillModal({ bill = null, onSaved = () => {} } = {}) {
  const isEdit = Boolean(bill);
  const vendors = activeVendors();
  const accounts = purchaseAccounts();

  if (!vendors.length) {
    openModal({
      title: 'Add a supplier first',
      size: 'modal-sm',
      body: '<p class="confirm-text">Bills need a vendor. Add a vendor, then come back to record the bill.</p>',
      submitLabel: 'Add supplier',
      onSubmit: async () => {
        location.hash = '#/vendors?new=1';
      },
    });
    return;
  }

  if (!accounts.length) {
    toast('Add an active expense account before recording bills.', 'error');
    location.hash = '#/accounts?new=1';
    return;
  }

  const settings = store.settings || {};
  const billDate = bill?.bill_date || todayISO();
  const dueDate = bill?.due_date || addDaysISO(billDate, Number(settings.payment_terms_days ?? 30));

  const body = `
    <div class="form-grid">
      <div class="field full">
        <label for="bill-vendor">Supplier</label>
        <select class="input" id="bill-vendor" name="vendor_id" required>
          ${optionsHtml(vendors, { selected: bill?.vendor_id, placeholder: 'Choose a supplier…' })}
        </select>
      </div>
      <div class="field">
        <label for="bill-date">Bill date</label>
        <input class="input" id="bill-date" name="bill_date" type="date" value="${esc(billDate)}" required>
      </div>
      <div class="field">
        <label for="bill-due">Due date</label>
        <input class="input" id="bill-due" name="due_date" type="date" value="${esc(dueDate)}" required>
      </div>
      <div class="field full" style="margin-top:2px">
        <label>Expense lines</label>
        ${lineItemsHtml(bill?.items || [], accounts)}
        <div class="totals-panel">
          <div class="totals-row"><span>Subtotal</span><span id="sum-subtotal">${fmtMoney(0)}</span></div>
          <div class="totals-row total"><span>Total</span><span id="sum-total">${fmtMoney(0)}</span></div>
        </div>
      </div>
      <div class="field full">
        <label for="bill-notes">Notes</label>
        <textarea class="input" id="bill-notes" name="notes" rows="3" placeholder="Optional note about this bill">${esc(bill?.notes || '')}</textarea>
      </div>
      ${isEdit ? '' : `
        <div class="field full">
          <label class="checkbox-row">
            <input type="checkbox" name="save_draft" value="1">
            <span>Save as draft — don’t post to the ledger yet</span>
          </label>
        </div>
      `}
    </div>
  `;

  const modal = openModal({
    title: isEdit ? `Edit ${bill.number}` : 'New bill',
    subtitle: isEdit ? 'Draft bills can be edited until they are received.' : 'Receiving a bill posts the expense and a payable to your books.',
    size: 'modal-xl',
    body,
    submitLabel: isEdit ? 'Save bill' : 'Save bill',
    onMount(overlay) {
      const editor = mountLineItems(overlay, {
        accounts,
        onTotals(totals) {
          overlay.querySelector('#sum-subtotal').textContent = fmtMoney(totals.subtotal_cents);
          overlay.querySelector('#sum-total').textContent = fmtMoney(totals.total_cents);
        },
      });
      overlay.editor = editor;

      if (!isEdit) {
        const dateInput = overlay.querySelector('#bill-date');
        const dueInput = overlay.querySelector('#bill-due');
        let dueTouched = false;
        dueInput.addEventListener('change', () => { dueTouched = true; });
        dateInput.addEventListener('change', () => {
          if (!dueTouched && dateInput.value) {
            dueInput.value = addDaysISO(dateInput.value, Number(settings.payment_terms_days ?? 30));
          }
        });
      }
    },
    async onSubmit(form) {
      const editor = modal?.overlay?.editor;
      const values = new FormData(form);
      const items = editor ? editor.getItems() : [];
      if (!items.length) throw new Error('Add at least one line item');
      for (const item of items) {
        if (!item.description) throw new Error('Every line needs a description');
        if (!item.account_id) throw new Error('Every line needs an account');
      }
      const status = isEdit ? 'draft' : (values.get('save_draft') ? 'draft' : 'received');
      const payload = {
        vendor_id: Number(values.get('vendor_id')),
        bill_date: values.get('bill_date'),
        due_date: values.get('due_date'),
        notes: values.get('notes'),
        items,
        status,
      };
      const saved = isEdit
        ? await api.put(`/bills/${bill.id}`, payload)
        : await api.post('/bills', payload);
      toast(isEdit ? 'Bill updated' : (status === 'draft' ? 'Draft bill saved' : `Bill ${saved.number} recorded`));
      onSaved(saved);
    },
  });

  return modal;
}
