import { api } from '../api.js';
import { activeCustomers, revenueAccounts, store } from '../store.js';
import { lineItemsHtml, mountLineItems } from '../line-items.js';
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

function invoiceRow(invoice) {
  return `
    <tr class="clickable" data-id="${invoice.id}">
      <td>
        <div class="cell-main">${esc(invoice.number)}</div>
        <div class="cell-sub">${esc(fmtDate(invoice.issue_date))}</div>
      </td>
      <td>
        <div class="party-cell">
          ${avatar(invoice.customer_name, 32)}
          <div class="party-info">
            <div class="cell-main">${esc(invoice.customer_name)}</div>
            <div class="cell-sub">${esc(invoice.customer_email || '')}</div>
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
  const outstanding = invoices
    .filter((invoice) => !['draft', 'void', 'paid'].includes(invoice.status_display))
    .reduce((sum, invoice) => sum + invoice.balance_cents, 0);
  const openCount = invoices.filter((invoice) => !['draft', 'void', 'paid'].includes(invoice.status_display)).length;

  setHeader({
    title: 'Invoices',
    subtitle: `${invoices.length} invoice${invoices.length === 1 ? '' : 's'} · ${fmtMoney(outstanding)} outstanding across ${openCount}`,
    actions: `<button class="btn btn-primary" data-action="new-invoice">${icon('plus', 16)}<span>New invoice</span></button>`,
  });

  if (!invoices.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
    iconName: 'invoice',
    title: 'No invoices yet',
    message: 'Create an invoice for a customer. Sending it will post revenue and a receivable to your ledger automatically.',
    action: '<button class="btn btn-primary" data-action="new-invoice">Create your first invoice</button>',
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
        <input class="input" id="invoice-search" type="search" placeholder="Search invoices or customers…" autocomplete="off">
      </div>
      <select class="input" id="invoice-status" style="max-width:170px">
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
        <table class="data">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Customer</th>
              <th>Due date</th>
              <th>Status</th>
              <th class="num">Total</th>
              <th class="num">Balance</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="invoice-body"></tbody>
        </table>
      </div>
    </div>
  `;

  const searchInput = container.querySelector('#invoice-search');
  const statusSelect = container.querySelector('#invoice-status');
  const body = container.querySelector('#invoice-body');
  const countEl = container.querySelector('#invoice-count');
  const dateRange = bindDateRange(container, () => applyFilters());

  function applyFilters() {
    const term = searchInput.value.trim().toLowerCase();
    const status = statusSelect.value;
    const { from, to } = dateRange.values();
    const filtered = invoices.filter((invoice) => {
      if (!inDateRange(invoice.issue_date, from, to)) return false;
      const matchesStatus = status === 'all'
        || (status === 'outstanding'
          ? !['draft', 'void', 'paid'].includes(invoice.status_display)
          : invoice.status_display === status);
      if (!matchesStatus) return false;
      if (!term) return true;
      return [invoice.number, invoice.customer_name, invoice.customer_email, invoice.notes, invoice.status_display]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });

    const filteredOutstanding = filtered
      .filter((invoice) => !['draft', 'void', 'paid'].includes(invoice.status_display))
      .reduce((sum, invoice) => sum + invoice.balance_cents, 0);
    const filteredOpen = filtered
      .filter((invoice) => !['draft', 'void', 'paid'].includes(invoice.status_display)).length;
    countEl.textContent = `${filtered.length} shown`;
    const subtitleEl = document.getElementById('page-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = `${filtered.length} invoice${filtered.length === 1 ? '' : 's'} · ${fmtMoney(filteredOutstanding)} outstanding across ${filteredOpen}`;
    }
    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="7">${emptyState({
    iconName: 'search',
    title: 'No matching invoices',
    message: 'Try a different search term, status or date range.',
  })}</td></tr>`;
      return;
    }
    body.innerHTML = filtered.map(invoiceRow).join('');
  }

  searchInput.addEventListener('input', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  body.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) location.hash = `#/invoices/${row.dataset.id}`;
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

export function openInvoiceModal({ invoice = null, onSaved = () => {} } = {}) {
  const isEdit = Boolean(invoice);
  const customers = activeCustomers();
  const accounts = revenueAccounts();

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
  const issueDate = invoice?.issue_date || todayISO();
  const dueDate = invoice?.due_date || addDaysISO(issueDate, Number(settings.payment_terms_days ?? 30));
  const taxRate = invoice?.tax_rate ?? settings.tax_rate ?? 0;

  const body = `
    <div class="form-grid">
      <div class="field full">
        <label for="invoice-customer">Customer</label>
        <select class="input" id="invoice-customer" name="customer_id" required>
          ${optionsHtml(customers, { selected: invoice?.customer_id, placeholder: 'Choose a customer…' })}
        </select>
      </div>
      <div class="field">
        <label for="invoice-issue">Issue date</label>
        <input class="input" id="invoice-issue" name="issue_date" type="date" value="${esc(issueDate)}" required>
      </div>
      <div class="field">
        <label for="invoice-due">Due date</label>
        <input class="input" id="invoice-due" name="due_date" type="date" value="${esc(dueDate)}" required>
      </div>
      <div class="field full" style="margin-top:2px">
        <label>Line items</label>
        ${lineItemsHtml(invoice?.items || [], accounts)}
        <div class="totals-panel">
          <div class="totals-row"><span>Subtotal</span><span id="sum-subtotal">${fmtMoney(0)}</span></div>
          <div class="totals-row">
            <span>Tax <input class="input tax-input" id="tax-rate" name="tax_rate" type="number" min="0" max="100" step="0.01" value="${esc(taxRate)}"> %</span>
            <span id="sum-tax">${fmtMoney(0)}</span>
          </div>
          <div class="totals-row total"><span>Total</span><span id="sum-total">${fmtMoney(0)}</span></div>
        </div>
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
            <span>Save as draft — don’t post to the ledger until you send it</span>
          </label>
        </div>
      `}
    </div>
  `;

  const modal = openModal({
    title: isEdit ? `Edit ${invoice.number}` : 'New invoice',
    subtitle: isEdit ? 'Draft invoices can be edited until they are sent.' : 'Sending an invoice posts a receivable and revenue to your books.',
    size: 'modal-xl',
    body,
    submitLabel: isEdit ? 'Save invoice' : 'Create invoice',
    onMount(overlay) {
      const taxInput = overlay.querySelector('#tax-rate');
      const editor = mountLineItems(overlay, {
        accounts,
        taxRate: () => Number(taxInput.value) || 0,
        onTotals(totals) {
          overlay.querySelector('#sum-subtotal').textContent = fmtMoney(totals.subtotal_cents);
          overlay.querySelector('#sum-tax').textContent = fmtMoney(totals.tax_cents);
          overlay.querySelector('#sum-total').textContent = fmtMoney(totals.total_cents);
        },
      });
      taxInput.addEventListener('input', editor.recalc);
      overlay.editor = editor;

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
        tax_rate: Number(values.get('tax_rate')) || 0,
        notes: values.get('notes'),
        terms: values.get('terms'),
        items,
        status,
      };
      const saved = isEdit
        ? await api.put(`/invoices/${invoice.id}`, payload)
        : await api.post('/invoices', payload);
      toast(isEdit ? 'Invoice updated' : (status === 'draft' ? 'Draft invoice saved' : `Invoice ${saved.number} created`));
      onSaved(saved);
    },
  });

  return modal;
}
