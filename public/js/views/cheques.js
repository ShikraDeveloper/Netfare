import { api } from '../api.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import {
  bindDateRange,
  centsToInput,
  confirmDialog,
  currencySymbol,
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
  toCents,
} from '../ui.js';

const STATUSES = ['planned', 'issued', 'cleared', 'bounced', 'cancelled'];
const STATUS_OPTIONS = [
  { value: 'planned', label: 'Planned' },
  { value: 'issued', label: 'Issued' },
  { value: 'cleared', label: 'Cleared' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'cancelled', label: 'Cancelled' },
];
const FREQUENCIES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

function timingBadge(cheque) {
  if (!['planned', 'issued'].includes(cheque.status)) return '';
  if (cheque.timing === 'overdue') return `<span class="badge badge-overdue">${esc(cheque.timing_label)}</span>`;
  if (['today', 'soon'].includes(cheque.timing)) return `<span class="badge badge-partial">${esc(cheque.timing_label)}</span>`;
  return `<span class="badge badge-sent">${esc(cheque.timing_label)}</span>`;
}

function rowHtml(cheque) {
  const primary = cheque.status === 'planned'
    ? `<button class="btn btn-secondary btn-sm" data-issue="${cheque.id}">Mark issued</button>`
    : cheque.status === 'issued'
      ? `<button class="btn btn-success btn-sm" data-clear="${cheque.id}">Mark cleared</button>`
      : '';
  return `
    <tr data-id="${cheque.id}">
      <td>
        <div class="cell-main nowrap">${esc(fmtDate(cheque.cheque_date))}</div>
        <div style="margin-top:4px">${timingBadge(cheque)}</div>
      </td>
      <td>
        <div class="cell-main nowrap">${esc(cheque.cheque_number)}</div>
        <div class="cell-sub">${esc(cheque.reference || '')}</div>
      </td>
      <td>
        <div class="cell-main">${esc(cheque.vendor_name)}</div>
        <div class="cell-sub">${esc(cheque.item_name || 'No compliance item')}${cheque.item_frequency ? ` · ${esc(cheque.item_frequency)}` : ''}</div>
      </td>
      <td class="num">${fmtMoney(cheque.amount_cents)}</td>
      <td>${esc(cheque.bank_name || '—')}</td>
      <td>${statusBadge(cheque.status)}</td>
      <td>
        ${cheque.bill_number ? `<a href="#/bills/${cheque.bill_id}">${esc(cheque.bill_number)}</a>` : '—'}
        ${cheque.payment_number ? `<div class="cell-sub">${esc(cheque.payment_number)}</div>` : ''}
      </td>
      <td>
        <div class="row-actions">
          ${primary}
          <button class="icon-btn" data-edit="${cheque.id}" title="Edit cheque">${icon('edit', 15)}</button>
          <button class="icon-btn danger" data-delete="${cheque.id}" title="Delete cheque">${icon('trash', 15)}</button>
        </div>
      </td>
    </tr>
  `;
}

function kpi(label, value, meta, iconName, color) {
  return `
    <div class="kpi">
      <div class="kpi-top"><span class="kpi-label">${esc(label)}</span><span class="kpi-icon ${color}">${icon(iconName, 16)}</span></div>
      <div class="kpi-value">${esc(value)}</div>
      <div class="kpi-meta">${esc(meta)}</div>
    </div>
  `;
}

async function openBatchModal(recurringItems, onSaved) {
  if (!recurringItems.length) {
    toast('Add an active recurring bill under Compliance first.', 'error');
    return null;
  }
  const first = recurringItems[0];
  return openModal({
    title: 'Create post-dated cheques',
    subtitle: 'Schedule a batch of cheques for office rent or another recurring bill.',
    body: `
      <div class="form-grid">
        <div class="field full">
          <label for="pdc-item">Compliance item</label>
          <select class="input" id="pdc-item" name="compliance_item_id">
            ${optionsHtml(recurringItems, {
              selected: first.id,
              placeholder: 'Choose a recurring bill…',
              labelKey: (item) => `${item.name} · ${item.vendor_name || 'No vendor'} · ${fmtMoney(item.amount_cents)}`,
            })}
          </select>
          <div class="hint">Only active recurring bills with a vendor can have post-dated cheques.</div>
        </div>
        <div class="field">
          <label for="pdc-first">First cheque number</label>
          <input class="input" id="pdc-first" name="first_cheque_number" placeholder="e.g. 004512" required autocomplete="off">
        </div>
        <div class="field">
          <label for="pdc-start">First cheque date</label>
          <input class="input" id="pdc-start" name="start_date" type="date" value="${esc(first.next_due_date || todayISO())}" required>
        </div>
        <div class="field">
          <label for="pdc-count">Number of cheques</label>
          <input class="input" id="pdc-count" name="count" type="number" min="1" max="60" value="12" required>
          <div class="hint">1–60 cheques. Example: 12 monthly or 4 quarterly.</div>
        </div>
        <div class="field">
          <label for="pdc-amount">Amount per cheque</label>
          <div class="money-input">
            <span>${esc(currencySymbol())}</span>
            <input class="input" id="pdc-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(first.amount_cents)}" required>
          </div>
        </div>
        <div class="field">
          <label for="pdc-frequency">Frequency</label>
          <select class="input" id="pdc-frequency" name="frequency">
            ${FREQUENCIES.map((option) => `<option value="${option.value}" ${option.value === 'monthly' ? 'selected' : ''}>${option.label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="pdc-bank">Bank</label>
          <input class="input" id="pdc-bank" name="bank_name" placeholder="e.g. Emirates NBD" autocomplete="off">
        </div>
        <div class="field">
          <label for="pdc-status">Initial status</label>
          <select class="input" id="pdc-status" name="initial_status">
            <option value="planned">Planned</option>
            <option value="issued" selected>Issued</option>
          </select>
        </div>
        <div class="field full">
          <label for="pdc-reference">Reference</label>
          <input class="input" id="pdc-reference" name="reference" placeholder="Optional rent/lease reference" autocomplete="off">
        </div>
        <div class="field full">
          <label for="pdc-notes">Notes</label>
          <textarea class="input" id="pdc-notes" name="notes" rows="2" placeholder="Cheque book, lease year or handover note"></textarea>
        </div>
        <div class="field full">
          <div class="form-note">These cheques are a <strong>register</strong>; no ledger entry is posted when the batch is created. Recording the cheque payment on the bill posts the entry and can mark the cheque cleared automatically.</div>
        </div>
      </div>
    `,
    submitLabel: 'Create cheque batch',
    onMount(overlay) {
      const itemSelect = overlay.querySelector('#pdc-item');
      const amount = overlay.querySelector('#pdc-amount');
      const start = overlay.querySelector('#pdc-start');
      const frequency = overlay.querySelector('#pdc-frequency');
      const sync = () => {
        const item = recurringItems.find((row) => row.id === Number(itemSelect.value));
        if (!item) return;
        if (item.amount_cents) amount.value = centsToInput(item.amount_cents);
        start.value = item.next_due_date || todayISO();
        if (['monthly', 'quarterly', 'yearly'].includes(item.frequency)) frequency.value = item.frequency;
      };
      itemSelect.addEventListener('change', sync);
      sync();
    },
    async onSubmit(form) {
      const values = new FormData(form);
      const count = Number(values.get('count') || 0);
      if (count < 1) throw new Error('Enter at least one cheque');
      const amount = toCents(values.get('amount'));
      if (amount <= 0) throw new Error('Enter the cheque amount');
      const result = await api.post('/cheques/batch', {
        compliance_item_id: Number(values.get('compliance_item_id')),
        first_cheque_number: values.get('first_cheque_number'),
        start_date: values.get('start_date'),
        count,
        amount_cents: amount,
        frequency: values.get('frequency'),
        bank_name: values.get('bank_name'),
        initial_status: values.get('initial_status'),
        reference: values.get('reference'),
        notes: values.get('notes'),
      });
      toast(`${result.count} post-dated cheque${result.count === 1 ? '' : 's'} created`);
      if (onSaved) await onSaved(result);
    },
  });
}

async function openEditModal(cheque, onSaved) {
  const linked = Boolean(cheque.bill_payment_id);
  return openModal({
    title: `Edit cheque ${cheque.cheque_number}`,
    subtitle: `${cheque.vendor_name} · ${cheque.item_name || 'No compliance item'}`,
    body: `
      <div class="form-grid">
        <div class="field">
          <label for="pdc-edit-number">Cheque number</label>
          <input class="input" id="pdc-edit-number" name="cheque_number" value="${esc(cheque.cheque_number)}" required autocomplete="off" ${linked ? 'disabled' : ''}>
        </div>
        <div class="field">
          <label for="pdc-edit-date">Cheque date</label>
          <input class="input" id="pdc-edit-date" name="cheque_date" type="date" value="${esc(cheque.cheque_date)}" required ${linked ? 'disabled' : ''}>
        </div>
        <div class="field">
          <label for="pdc-edit-amount">Amount</label>
          <div class="money-input">
            <span>${esc(currencySymbol())}</span>
            <input class="input" id="pdc-edit-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(cheque.amount_cents)}" required ${linked ? 'disabled' : ''}>
          </div>
        </div>
        <div class="field">
          <label for="pdc-edit-bank">Bank</label>
          <input class="input" id="pdc-edit-bank" name="bank_name" value="${esc(cheque.bank_name || '')}" autocomplete="off" ${linked ? 'disabled' : ''}>
        </div>
        <div class="field">
          <label for="pdc-edit-status">Status</label>
          <select class="input" id="pdc-edit-status" name="status" ${linked ? 'disabled' : ''}>
            ${STATUS_OPTIONS.map((option) => `<option value="${option.value}" ${option.value === cheque.status ? 'selected' : ''}>${option.label}</option>`).join('')}
          </select>
          ${linked ? '<div class="hint">Linked to a bill payment; remove the payment before changing status.</div>' : ''}
        </div>
        <div class="field">
          <label for="pdc-edit-reference">Reference</label>
          <input class="input" id="pdc-edit-reference" name="reference" value="${esc(cheque.reference || '')}" autocomplete="off">
        </div>
        <div class="field full">
          <label for="pdc-edit-notes">Notes</label>
          <textarea class="input" id="pdc-edit-notes" name="notes" rows="2">${esc(cheque.notes || '')}</textarea>
        </div>
        ${linked ? `<div class="field full"><div class="form-note">Linked to ${esc(cheque.bill_number || 'a bill')}${cheque.payment_number ? ` · ${esc(cheque.payment_number)}` : ''}. The payment keeps the cheque marked as cleared.</div></div>` : ''}
      </div>
    `,
    submitLabel: 'Save cheque',
    async onSubmit(form) {
      const values = new FormData(form);
      const amount = linked ? cheque.amount_cents : toCents(values.get('amount'));
      if (!linked && amount <= 0) throw new Error('Enter the cheque amount');
      await api.put(`/cheques/${cheque.id}`, {
        cheque_number: linked ? undefined : values.get('cheque_number'),
        cheque_date: linked ? undefined : values.get('cheque_date'),
        amount_cents: linked ? undefined : amount,
        bank_name: linked ? undefined : values.get('bank_name'),
        status: linked ? undefined : values.get('status'),
        reference: values.get('reference'),
        notes: values.get('notes'),
      });
      toast(`Cheque ${cheque.cheque_number} updated`);
      if (onSaved) await onSaved();
    },
  });
}

export async function render(container, { query } = {}) {
  const [data, compliance] = await Promise.all([
    api.get('/cheques'),
    api.get('/compliance'),
  ]);
  const cheques = data.cheques;
  const summary = data.summary;
  const recurringItems = (compliance.items || [])
    .filter((item) => item.kind === 'recurring_bill' && item.status === 'active' && item.vendor_id);

  setHeader({
    title: 'Post-dated cheques',
    subtitle: `${summary.scheduled_count} scheduled · ${summary.upcoming_count} due in 30 days · ${summary.cleared_count} cleared`,
    actions: `
      <a class="btn btn-secondary" href="#/compliance">${icon('check', 16)}<span>Compliance</span></a>
      <button class="btn btn-primary" data-action="new-batch">${icon('plus', 16)}<span>New cheque batch</span></button>
    `,
  });

  const bindNewBatch = () => {
    document.querySelectorAll('[data-action="new-batch"]').forEach((button) => {
      button.addEventListener('click', () => openBatchModal(recurringItems, () => render(container)));
    });
  };

  if (!cheques.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
          iconName: 'cheque',
          title: 'No post-dated cheques yet',
          message: recurringItems.length
            ? 'Create a batch of 12 monthly cheques for office rent or another recurring bill. The register tracks each cheque number, date, bank and clearance status.'
            : 'Add an active recurring bill under Compliance first, then create a cheque batch here.',
          action: recurringItems.length
            ? '<button class="btn btn-primary" data-action="new-batch">Create 12-cheque batch</button>'
            : '<a class="btn btn-primary" href="#/compliance">Go to Compliance</a>',
        })}
      </div>
    `;
    bindNewBatch();
    return;
  }

  container.innerHTML = `
    <div class="kpi-grid">
      ${kpi('Upcoming 30 days', fmtMoney(summary.upcoming_cents), `${summary.upcoming_count} cheque${summary.upcoming_count === 1 ? '' : 's'}`, 'clock', 'amber')}
      ${kpi('Scheduled', fmtMoney(summary.scheduled_cents), `${summary.scheduled_count} planned or issued`, 'cheque', 'blue')}
      ${kpi('Cleared', fmtMoney(summary.cleared_cents), `${summary.cleared_count} cheque${summary.cleared_count === 1 ? '' : 's'}`, 'check', 'green')}
      ${kpi('Bounced', String(summary.bounced_count), summary.bounced_count ? 'Needs follow-up' : 'None', 'alert', summary.bounced_count ? 'red' : 'green')}
    </div>

    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="cheque-search" type="search" placeholder="Search cheque, vendor or bank…" autocomplete="off">
      </div>
      <select class="input" id="cheque-status" style="max-width:160px">
        <option value="all">All statuses</option>
        ${STATUSES.map((status) => `<option value="${status}">${status.charAt(0).toUpperCase()}${status.slice(1)}</option>`).join('')}
      </select>
      ${dateRangeHtml({ label: 'Cheque date' })}
      <div class="spacer"></div>
      <span class="muted" id="cheque-count" style="font-size:12px"></span>
    </div>

    <div class="stmt-hint no-print">This is a cheque register. The ledger posts when you record the cheque payment on the bill; matching cheque number + amount marks the cheque <strong>Cleared</strong> automatically.</div>

    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Cheque date</th>
              <th>Cheque</th>
              <th>Vendor / item</th>
              <th class="num">Amount</th>
              <th>Bank</th>
              <th>Status</th>
              <th>Bill / payment</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="cheque-body"></tbody>
        </table>
      </div>
      <div id="cheque-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#cheque-search');
  const statusSelect = container.querySelector('#cheque-status');
  const body = container.querySelector('#cheque-body');
  const countEl = container.querySelector('#cheque-count');
  const paginationEl = container.querySelector('#cheque-pagination');
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
      body.innerHTML = `<tr><td colspan="8">${emptyState({
        iconName: 'search',
        title: 'No matching cheques',
        message: 'Try a different search, status or cheque date range.',
      })}</td></tr>`;
    } else {
      body.innerHTML = rows.map(rowHtml).join('');
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
    filtered = cheques.filter((cheque) => {
      if (status !== 'all' && cheque.status !== status) return false;
      if (!inDateRange(cheque.cheque_date, from, to)) return false;
      if (!term) return true;
      return [
        cheque.cheque_number,
        cheque.vendor_name,
        cheque.item_name,
        cheque.bank_name,
        cheque.reference,
        cheque.notes,
        cheque.bill_number,
        cheque.payment_number,
      ].some((value) => String(value || '').toLowerCase().includes(term));
    });
    countEl.textContent = `${filtered.length} shown`;
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  bindNewBatch();

  body.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      const cheque = cheques.find((row) => row.id === Number(edit.dataset.edit));
      if (!cheque) return;
      try {
        await openEditModal(cheque, () => render(container));
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const issue = event.target.closest('[data-issue]');
    if (issue) {
      const cheque = cheques.find((row) => row.id === Number(issue.dataset.issue));
      if (!cheque) return;
      try {
        await api.put(`/cheques/${cheque.id}`, { status: 'issued' });
        toast(`Cheque ${cheque.cheque_number} marked issued`);
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const clear = event.target.closest('[data-clear]');
    if (clear) {
      const cheque = cheques.find((row) => row.id === Number(clear.dataset.clear));
      if (!cheque) return;
      const confirmed = await confirmDialog({
        title: 'Mark cheque cleared?',
        message: `${cheque.cheque_number} · ${fmtMoney(cheque.amount_cents)} will be marked cleared in the register. Record the cheque payment on the bill to post it to the ledger.`,
        confirmLabel: 'Mark cleared',
        danger: false,
      });
      if (!confirmed) return;
      try {
        await api.put(`/cheques/${cheque.id}`, { status: 'cleared' });
        toast(`Cheque ${cheque.cheque_number} marked cleared`);
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const del = event.target.closest('[data-delete]');
    if (del) {
      const cheque = cheques.find((row) => row.id === Number(del.dataset.delete));
      if (!cheque) return;
      const confirmed = await confirmDialog({
        title: `Delete cheque ${cheque.cheque_number}?`,
        message: 'The cheque will be removed from the register. Any bill payment already recorded stays in the ledger.',
        confirmLabel: 'Delete cheque',
      });
      if (!confirmed) return;
      try {
        await api.del(`/cheques/${cheque.id}`);
        toast(`Cheque ${cheque.cheque_number} deleted`);
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  });

  applyFilters();
}
