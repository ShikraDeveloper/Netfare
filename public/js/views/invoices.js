import { api } from '../api.js';
import { nationalityList } from '../nationalities.js';
import { activeCustomers, revenueAccounts, store } from '../store.js';
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
  segmentedHtml,
  setHeader,
  statusBadge,
  todayISO,
  toast,
} from '../ui.js';

function invoiceRow(invoice) {
  return `
    <tr class="clickable" data-id="${invoice.id}" tabindex="0">
      <td>
        <div class="cell-main">${esc(invoice.number)}</div>
        <div class="cell-sub">${esc(fmtDate(invoice.issue_date))}</div>
      </td>
      <td>
        <div class="party-cell">
          ${avatar(invoice.customer_name, 32)}
          <div class="party-info">
            <div class="cell-main">${esc(invoice.customer_name)}</div>
            <div class="cell-sub">${Number(invoice.beneficiary_is_customer) === 0 && invoice.beneficiary_name
              ? `For ${esc(invoice.beneficiary_name)}`
              : esc(invoice.customer_email || '')}</div>
          </div>
        </div>
      </td>
      <td class="nowrap">${esc(fmtDate(invoice.due_date))}</td>
      <td>${statusBadge(invoice.status_display)}</td>
      <td class="num">${fmtMoney(invoice.total_cents)}</td>
      <td class="num ${invoice.balance_cents > 0 && invoice.status_display !== 'void' ? 'amount-due' : 'muted'}">
        ${invoice.balance_cents > 0 && invoice.status_display !== 'void' ? fmtMoney(invoice.balance_cents) : '—'}
      </td>
      <td class="right muted">${icon('chevron', 16)}</td>
    </tr>
  `;
}

export async function render(container, { query } = {}) {
  const invoices = await api.get('/invoices');
  setHeader({
    title: 'Invoices',
    actions: `<button class="btn btn-primary" data-action="new-invoice">${icon('plus', 16)}<span>New invoice</span></button>`,
  });

  if (!invoices.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
    iconName: 'invoice',
    title: 'No invoices yet',
    action: '<button class="btn btn-primary" data-action="new-invoice">New invoice</button>',
  })}
      </div>
    `;
    document.querySelectorAll('[data-action="new-invoice"]').forEach((button) => {
      button.addEventListener('click', () => openInvoiceModal({ onSaved: (invoice) => { location.hash = `#/invoices/${invoice.id}`; } }));
    });
    maybeOpenNew(query, true);
    return;
  }

  container.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="invoice-search" type="search" placeholder="Search invoices or customers…" aria-label="Search invoices or customers" autocomplete="off">
      </div>
      <select class="input" id="invoice-status" aria-label="Filter invoices by status" style="max-width:170px">
        <option value="all">All statuses</option>
        <option value="outstanding">Outstanding</option>
        <option value="draft">Draft</option>
        <option value="sent">Sent</option>
        <option value="partial">Partial</option>
        <option value="overdue">Overdue</option>
        <option value="paid">Paid</option>
        <option value="void">Void</option>
      </select>
      ${dateRangeHtml({ label: 'Invoice date' })}
      <div class="spacer"></div>
      <span class="muted" id="invoice-count" style="font-size:12px"></span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data cards-sm"><caption class="sr-only">Invoices</caption>
          <thead>
            <tr>
              <th scope="col">Invoice</th>
              <th scope="col">Customer</th>
              <th scope="col">Due date</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Total</th>
              <th scope="col" class="num">Balance</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="invoice-body"></tbody>
        </table>
      </div>
      <div id="invoice-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#invoice-search');
  const statusSelect = container.querySelector('#invoice-status');
  const body = container.querySelector('#invoice-body');
  const countEl = container.querySelector('#invoice-count');
  const paginationEl = container.querySelector('#invoice-pagination');
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
        title: 'No matching invoices',
      })}</td></tr>`;
    } else {
      body.innerHTML = rows.map(invoiceRow).join('');
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
    filtered = invoices.filter((invoice) => {
      if (!inDateRange(invoice.issue_date, from, to)) return false;
      const matchesStatus = status === 'all'
        || (status === 'outstanding'
          ? !['draft', 'void', 'paid'].includes(invoice.status_display)
          : invoice.status_display === status);
      if (!matchesStatus) return false;
      if (!term) return true;
      return [invoice.number, invoice.customer_name, invoice.customer_email, invoice.notes, invoice.status_display, invoice.beneficiary_name]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });

    const filteredOutstanding = filtered
      .filter((invoice) => !['draft', 'void', 'paid'].includes(invoice.status_display))
      .reduce((sum, invoice) => sum + invoice.balance_cents, 0);
    const filteredOpen = filtered
      .filter((invoice) => !['draft', 'void', 'paid'].includes(invoice.status_display)).length;
    countEl.textContent = `${filtered.length} matching`;
    const subtitleEl = document.getElementById('page-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = `${filtered.length} invoice${filtered.length === 1 ? '' : 's'} · ${fmtMoney(filteredOutstanding)} outstanding across ${filteredOpen}`;
    }
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  body.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) location.hash = `#/invoices/${row.dataset.id}`;
  });
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.matches('tr[data-id]')) return;
    location.hash = `#/invoices/${event.target.dataset.id}`;
  });

  document.querySelectorAll('[data-action="new-invoice"]').forEach((button) => {
    button.addEventListener('click', () => openInvoiceModal({ onSaved: (invoice) => { location.hash = `#/invoices/${invoice.id}`; } }));
  });

  applyFilters();
  maybeOpenNew(query, false);
}

function maybeOpenNew(query, alreadyBound) {
  if (query && query.get('new')) {
    history.replaceState(null, '', '#/invoices');
    if (!alreadyBound) {
      openInvoiceModal({ onSaved: (invoice) => { location.hash = `#/invoices/${invoice.id}`; } });
    } else {
      setTimeout(() => {
        document.querySelector('[data-action="new-invoice"]').click();
      }, 40);
    }
  }
}

const SERVICE_INVOICE_BLOCKED_CODES = ['4000', '4100', '4320'];

export function openInvoiceModal({ invoice = null, onSaved = () => {} } = {}) {
  const isEdit = Boolean(invoice);
  const customers = activeCustomers();
  // Ticket, package and visa revenue is invoiced from bookings and visas, where
  // the supplier cost is recorded too. Service charges come first.
  const accounts = revenueAccounts()
    .filter((account) => !SERVICE_INVOICE_BLOCKED_CODES.includes(account.code))
    .sort((a, b) => (b.code === '4300') - (a.code === '4300') || a.code.localeCompare(b.code));

  if (!customers.length) {
    openModal({
      title: 'Add a customer first',
      size: 'modal-sm',
      body: '<p class="confirm-text">Invoices need someone to bill. Add your first customer, then come back to create the invoice.</p>',
      submitLabel: 'Add customer',
      onSubmit: async () => {
        location.hash = '#/customers?new=1';
      },
    });
    return;
  }

  if (!accounts.length) {
    toast('Add an active revenue account before creating invoices.', 'error');
    location.hash = '#/accounts?new=1';
    return;
  }

  const settings = store.settings || {};
  const forSomeoneElse = invoice ? Number(invoice.beneficiary_is_customer) === 0 : false;
  const issueDate = invoice?.issue_date || todayISO();
  const dueDate = invoice?.due_date || addDaysISO(issueDate, Number(settings.payment_terms_days ?? 30));

  // Tickets, packages and visas are sold from a booking or visa, so their
  // supplier cost is recorded too; the switch at the top goes there.
  // A traveller other than the customer is printed on the invoice; it is
  // still billed to the customer.
  const body = `
    <div class="form-grid">
      ${isEdit ? '' : `<div class="field full">${segmentedHtml('invoice-kind', [
    { value: 'service', label: 'Service' },
    { value: 'booking', label: 'Booking', action: 'new-booking' },
    { value: 'visa', label: 'Visa', action: 'new-visa' },
  ], 'service')}</div>`}
      <div class="field">
        <label for="invoice-customer">Customer</label>
        <select class="input" id="invoice-customer" name="customer_id" required>
          ${optionsHtml(customers, { selected: invoice?.customer_id, placeholder: 'Choose…' })}
        </select>
      </div>
      <div class="field">
        <label for="invoice-issue">Date</label>
        <input class="input" id="invoice-issue" name="issue_date" type="date" value="${esc(issueDate)}" required>
      </div>
      <div class="field full">
        <label for="invoice-beneficiary">Traveller</label>
        <input class="input" id="invoice-beneficiary" name="beneficiary_name" maxlength="160" autocomplete="off"
          value="${esc(forSomeoneElse ? invoice?.beneficiary_name || '' : '')}" placeholder="Same as customer">
      </div>
      <div class="field full">
        ${lineItemsHtml(invoice?.items || [], accounts, { compact: true })}
        <div class="totals-panel">
          <div class="totals-row total"><span>Total</span><span id="sum-total">${fmtMoney(0)}</span></div>
        </div>
      </div>
      <details class="field full more-details"${invoice?.notes || invoice?.terms ? ' open' : ''}>
        <summary>More details</summary>
        <div class="form-grid">
          <div class="field">
            <label for="invoice-due">Due date</label>
            <input class="input" id="invoice-due" name="due_date" type="date" value="${esc(dueDate)}" required>
          </div>
          <div class="field" data-beneficiary-field ${forSomeoneElse ? '' : 'hidden'}>
            <label for="invoice-beneficiary-nationality">Nationality</label>
            <input class="input" id="invoice-beneficiary-nationality" name="beneficiary_nationality" maxlength="80" autocomplete="off" ${nationalityList()}
              value="${esc(invoice?.beneficiary_nationality || '')}" placeholder="Optional">
          </div>
          <div class="field" data-beneficiary-field ${forSomeoneElse ? '' : 'hidden'}>
            <label for="invoice-beneficiary-passport">Passport number</label>
            <input class="input" id="invoice-beneficiary-passport" name="beneficiary_passport" maxlength="60" autocomplete="off"
              value="${esc(invoice?.beneficiary_passport || '')}" placeholder="Optional">
          </div>
          <div class="field">
            <label for="invoice-notes">Notes</label>
            <textarea class="input" id="invoice-notes" name="notes" rows="3" placeholder="A note shown on the invoice">${esc(invoice?.notes || '')}</textarea>
          </div>
          <div class="field">
            <label for="invoice-terms">Payment terms</label>
            <textarea class="input" id="invoice-terms" name="terms" rows="3" placeholder="Payment instructions">${esc(invoice?.terms || '')}</textarea>
          </div>
          ${isEdit ? '' : `
            <div class="field full">
              <label class="checkbox-row">
                <input type="checkbox" name="save_draft" value="1">
                <span>Save as draft</span>
              </label>
            </div>
          `}
        </div>
      </details>
    </div>
  `;

  const modal = openModal({
    title: isEdit ? `Edit ${invoice.number}` : 'New invoice',
    size: 'modal-xl',
    body,
    submitLabel: isEdit ? 'Save invoice' : 'Create',
    onMount(overlay) {
      const editor = mountLineItems(overlay, {
        accounts,
        onTotals(totals) {
          overlay.querySelector('#sum-total').textContent = fmtMoney(totals.total_cents);
        },
      });
      overlay.editor = editor;

      // Booking and Visa leave this form for theirs.
      overlay.querySelectorAll('[data-seg="invoice-kind"] [data-seg-value]').forEach((button) => {
        if (button.dataset.segValue === 'service') return;
        button.addEventListener('click', () => {
          overlay.querySelector('[data-close]')?.click();
          location.hash = `#/${button.dataset.segValue}s?new=1`;
        });
      });

      // Nationality and passport (under More details) only matter for a traveller.
      const beneficiaryName = overlay.querySelector('#invoice-beneficiary');
      const syncTraveller = () => {
        const isOther = Boolean(beneficiaryName.value.trim());
        overlay.querySelectorAll('[data-beneficiary-field]').forEach((field) => { field.hidden = !isOther; });
      };
      beneficiaryName.addEventListener('input', syncTraveller);

      if (!isEdit) {
        const issueInput = overlay.querySelector('#invoice-issue');
        const dueInput = overlay.querySelector('#invoice-due');
        let dueTouched = false;
        dueInput.addEventListener('change', () => { dueTouched = true; });
        issueInput.addEventListener('change', () => {
          if (!dueTouched && issueInput.value) {
            dueInput.value = addDaysISO(issueInput.value, Number(settings.payment_terms_days ?? 30));
          }
        });
      }
    },
    async onSubmit(form) {
      const editor = modal?.overlay?.editor || form.closest('.modal').querySelector('form').editor;
      const values = new FormData(form);
      const items = editor ? editor.getItems() : [];
      if (!items.length) throw new Error('Add at least one line item');
      for (const item of items) {
        if (!item.description) throw new Error('Every line needs a description');
        if (!item.account_id) throw new Error('Every line needs an account');
      }
      const status = isEdit ? 'draft' : (values.get('save_draft') ? 'draft' : 'sent');
      const payload = {
        customer_id: Number(values.get('customer_id')),
        issue_date: values.get('issue_date'),
        due_date: values.get('due_date'),
        notes: values.get('notes'),
        terms: values.get('terms'),
        items,
        status,
      };
      const traveller = String(values.get('beneficiary_name') || '').trim();
      payload.beneficiary_is_customer = !traveller;
      if (traveller) {
        payload.beneficiary_name = traveller;
        payload.beneficiary_nationality = values.get('beneficiary_nationality');
        payload.beneficiary_passport = values.get('beneficiary_passport');
      }
      const saved = isEdit
        ? await api.put(`/invoices/${invoice.id}`, payload)
        : await api.post('/invoices', payload);
      toast(isEdit ? 'Invoice updated' : (status === 'draft' ? 'Draft invoice saved' : `Invoice ${saved.number} created`));
      onSaved(saved);
    },
  });

  return modal;
}
