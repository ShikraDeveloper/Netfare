import { api } from '../api.js';
import { activeVendors, expenseAccounts, store } from '../store.js';
import {
  centsToInput,
  confirmDialog,
  currencySymbol,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  openModal,
  optionsHtml,
  setHeader,
  statusBadge,
  todayISO,
  toast,
  toCents,
} from '../ui.js';

const KIND_OPTIONS = [
  { value: 'recurring_bill', label: 'Recurring bill — rent, utilities, salaries' },
  { value: 'filing', label: 'Filing — VAT return, corporate tax' },
  { value: 'renewal', label: 'Renewal — licence, lease, insurance' },
];

const FREQUENCY_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'once', label: 'One-time' },
];

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'done', label: 'Done' },
];

const PAYMENT_METHODS = ['Bank transfer', 'Cheque', 'Cash', 'Credit card', 'Other'];

const CATEGORIES = {
  recurring_bill: ['Office rent', 'Utilities', 'Salaries', 'Internet & phone', 'Software', 'Insurance', 'Trade licence', 'Other'],
  filing: ['VAT return', 'Corporate tax', 'Payroll', 'Other'],
  renewal: ['Trade licence', 'Lease', 'Insurance', 'Vehicle registration', 'Visa quota', 'Other'],
};

const ACTION_LABELS = {
  created: 'Created',
  updated: 'Updated',
  bill_generated: 'Draft bill created',
  completed: 'Marked complete',
  skipped: 'Skipped period',
};

function kindBadge(kind) {
  const cls = kind === 'recurring_bill' ? 'badge-sent' : kind === 'filing' ? 'badge-partial' : 'badge-issued';
  const label = kind === 'recurring_bill' ? 'Recurring' : kind === 'filing' ? 'Filing' : 'Renewal';
  return `<span class="badge ${cls}">${label}</span>`;
}

function dueBadge(item) {
  if (item.status === 'paused') return '<span class="badge badge-paused">Paused</span>';
  if (item.status === 'done') return '<span class="badge badge-done">Done</span>';
  if (item.due_state === 'overdue') return `<span class="badge badge-overdue">${esc(item.due_label)}</span>`;
  if (['due', 'soon'].includes(item.due_state)) return `<span class="badge badge-partial">${esc(item.due_label)}</span>`;
  return `<span class="badge badge-sent">${esc(item.due_label)}</span>`;
}

function categoryOptions(kind, selected) {
  const categories = CATEGORIES[kind] || CATEGORIES.recurring_bill;
  const list = selected && !categories.includes(selected) ? [selected, ...categories] : categories;
  return list.map((category) => `<option value="${esc(category)}" ${category === selected ? 'selected' : ''}>${esc(category)}</option>`).join('');
}

function logsHtml(item) {
  if (!item?.logs?.length) return '';
  return `
    <div class="form-note" id="ci-activity">
      <strong>Recent activity</strong>
      <div style="display:grid;gap:5px;margin-top:6px">
        ${item.logs.slice(0, 6).map((log) => `
          <div><span class="muted">${esc(fmtDate(log.event_date))}</span> · ${esc(ACTION_LABELS[log.action] || log.action)}${log.detail ? ` · ${esc(log.detail)}` : ''}</div>
        `).join('')}
      </div>
    </div>
  `;
}

function modalBody(item = null) {
  const vendors = activeVendors().sort((a, b) => a.name.localeCompare(b.name));
  const accounts = expenseAccounts()
    .filter((account) => account.type === 'expense' || account.code === '1200')
    .sort((a, b) => a.code.localeCompare(b.code));
  const kind = item?.kind || 'recurring_bill';
  const category = item?.category || CATEGORIES[kind][0];
  const frequency = item?.frequency || (kind === 'renewal' ? 'yearly' : kind === 'filing' ? 'quarterly' : 'monthly');
  const amount = item?.amount_cents != null ? centsToInput(item.amount_cents) : '';
  const taxRate = item?.tax_rate != null ? item.tax_rate : (store.settings?.tax_rate || 0);
  return `
    <div class="form-grid">
      <div class="field full">
        <label for="ci-kind">Compliance type</label>
        <select class="input" id="ci-kind" name="kind">
          ${KIND_OPTIONS.map((option) => `<option value="${option.value}" ${option.value === kind ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field full">
        <label for="ci-name">Name</label>
        <input class="input" id="ci-name" name="name" value="${esc(item?.name || '')}" placeholder="e.g. Office rent — Al Wasl" required autocomplete="off">
      </div>
      <div class="field">
        <label for="ci-category">Category</label>
        <select class="input" id="ci-category" name="category">${categoryOptions(kind, category)}</select>
      </div>
      <div class="field">
        <label for="ci-status">Status</label>
        <select class="input" id="ci-status" name="status">
          ${STATUS_OPTIONS.map((option) => `<option value="${option.value}" ${option.value === (item?.status || 'active') ? 'selected' : ''}>${option.label}</option>`).join('')}
        </select>
      </div>
      <div class="field full" data-ci-recurring>
        <label for="ci-vendor">Vendor — who you pay</label>
        <select class="input" id="ci-vendor" name="vendor_id">
          ${optionsHtml(vendors, { selected: item?.vendor_id, placeholder: 'Choose a vendor…' })}
        </select>
        <div class="hint">Required for recurring bills. Generated draft bills are recorded against this vendor’s payable account.</div>
      </div>
      <div class="field full" data-ci-recurring>
        <label for="ci-account">Expense account — what the cost is for</label>
        <select class="input" id="ci-account" name="account_id">
          ${optionsHtml(accounts, {
            selected: item?.account_id,
            placeholder: 'Choose an expense account…',
            labelKey: (account) => `${account.code} · ${account.name}`,
          })}
        </select>
        <div class="hint">Examples: 6000 Rent Expense, 6100 Utilities Expense, 6200 Salaries &amp; Wages.</div>
      </div>
      <div class="field">
        <label for="ci-amount" id="ci-amount-label">${kind === 'recurring_bill' ? (item?.variable_amount ? 'Typical amount (optional)' : 'Amount') : 'Fee / estimate (optional)'}</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="ci-amount" name="amount" type="number" min="0" step="0.01" value="${amount}" placeholder="0.00">
        </div>
      </div>
      <div class="field" data-ci-recurring>
        <label for="ci-tax">Tax rate %</label>
        <input class="input" id="ci-tax" name="tax_rate" type="number" min="0" max="100" step="0.01" value="${esc(taxRate)}">
      </div>
      <div class="field" data-ci-recurring>
        <label for="ci-payment-method">Payment method</label>
        <select class="input" id="ci-payment-method" name="payment_method">
          ${PAYMENT_METHODS.map((method) => `<option value="${esc(method)}" ${method === (item?.payment_method || 'Bank transfer') ? 'selected' : ''}>${esc(method)}</option>`).join('')}
        </select>
        <div class="hint">Default when the generated draft bill is paid. Choose Cheque for office rent paid by cheque.</div>
      </div>
      <div class="field">
        <label for="ci-frequency">Frequency</label>
        <select class="input" id="ci-frequency" name="frequency">
          ${FREQUENCY_OPTIONS.map((option) => `<option value="${option.value}" ${option.value === frequency ? 'selected' : ''}>${option.label}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="ci-next-due">Next due date</label>
        <input class="input" id="ci-next-due" name="next_due_date" type="date" value="${esc(item?.next_due_date || todayISO())}" required>
      </div>
      <div class="field">
        <label for="ci-end">End date <span class="muted">(optional)</span></label>
        <input class="input" id="ci-end" name="end_date" type="date" value="${esc(item?.end_date || '')}">
      </div>
      <div class="field">
        <label for="ci-reminder">Remind me before</label>
        <input class="input" id="ci-reminder" name="reminder_days" type="number" min="0" max="365" step="1" value="${esc(item?.reminder_days ?? 14)}">
        <div class="hint">Days before the due date</div>
      </div>
      <div class="field full" data-ci-recurring>
        <label class="checkline" style="display:flex;align-items:center;gap:8px;font-size:13px">
          <input type="checkbox" id="ci-variable" name="variable_amount" ${item?.variable_amount ? 'checked' : ''}>
          <span>Amount varies each period</span>
        </label>
        <div class="hint">For utilities such as Etihad WE, DEWA or phone bills. The amount above is only an estimate; when you create the bill you’ll enter the actual amount. Auto-draft is disabled.</div>
      </div>
      <div class="field full" data-ci-recurring id="ci-auto-field">
        <label class="checkline" style="display:flex;align-items:center;gap:8px;font-size:13px">
          <input type="checkbox" id="ci-auto" name="auto_create_bill" ${item?.auto_create_bill ? 'checked' : ''}>
          <span>Auto-create a draft bill when due</span>
        </label>
        <div class="hint">Use this for fixed amounts like office rent or salaries. The draft bill can be reviewed before posting.</div>
      </div>
      <div class="field full">
        <label for="ci-notes">Notes</label>
        <textarea class="input" id="ci-notes" name="notes" rows="2" placeholder="Lease reference, filing period, renewal contact…">${esc(item?.notes || '')}</textarea>
      </div>
      ${logsHtml(item) ? `<div class="field full">${logsHtml(item)}</div>` : ''}
    </div>
  `;
}

function syncVariableFields(overlay) {
  const recurring = overlay.querySelector('#ci-kind').value === 'recurring_bill';
  const variable = recurring && overlay.querySelector('#ci-variable')?.checked;
  const amountLabel = overlay.querySelector('#ci-amount-label');
  if (amountLabel) {
    amountLabel.textContent = recurring
      ? (variable ? 'Typical amount (optional)' : 'Amount')
      : 'Fee / estimate (optional)';
  }
  const auto = overlay.querySelector('#ci-auto');
  const autoField = overlay.querySelector('#ci-auto-field');
  if (auto && variable) auto.checked = false;
  if (auto) auto.disabled = Boolean(variable);
  if (autoField) autoField.hidden = Boolean(variable);
}

function syncKindFields(overlay, { resetCategory = false, isNew = false } = {}) {
  const kind = overlay.querySelector('#ci-kind').value;
  const recurring = kind === 'recurring_bill';
  overlay.querySelectorAll('[data-ci-recurring]').forEach((el) => { el.hidden = !recurring; });
  const category = overlay.querySelector('#ci-category');
  const categories = CATEGORIES[kind] || CATEGORIES.recurring_bill;
  const current = category.value;
  const nextCategory = resetCategory || !categories.includes(current) ? categories[0] : current;
  category.innerHTML = categoryOptions(kind, nextCategory);
  if (isNew || resetCategory) {
    const frequency = overlay.querySelector('#ci-frequency');
    frequency.value = kind === 'renewal' ? 'yearly' : kind === 'filing' ? 'quarterly' : 'monthly';
  }
  syncVariableFields(overlay);
}

export async function openComplianceModal({ item = null, defaults = {}, onSaved = null } = {}) {
  const full = item?.id ? await api.get(`/compliance/${item.id}`) : null;
  const seed = full || item || defaults;
  const kind = seed.kind || defaults.kind || 'recurring_bill';
  const category = seed.category || defaults.category || CATEGORIES[kind]?.[0] || 'Other';
  const modal = openModal({
    title: full ? `Edit ${full.name}` : 'New compliance item',
    subtitle: full ? `${full.kind_label} · ${full.frequency_label}` : 'Recurring bills, filings and renewals in one place.',
    body: modalBody({ ...seed, kind, category }),
    submitLabel: full ? 'Save changes' : 'Add item',
    onMount(overlay) {
      const kindSelect = overlay.querySelector('#ci-kind');
      kindSelect.addEventListener('change', () => syncKindFields(overlay, { resetCategory: true, isNew: !full }));
      overlay.querySelector('#ci-variable')?.addEventListener('change', () => syncVariableFields(overlay));
      syncKindFields(overlay, { isNew: !full });
    },
    async onSubmit(form) {
      const values = new FormData(form);
      const selectedKind = values.get('kind');
      const recurring = selectedKind === 'recurring_bill';
      const nextDue = values.get('next_due_date');
      const endDate = values.get('end_date');
      if (!nextDue) throw new Error('Choose the next due date');
      if (endDate && endDate < nextDue) throw new Error('End date cannot be before the next due date');
      const variable = recurring && values.get('variable_amount') === 'on';
      const amount = recurring ? toCents(values.get('amount')) : toCents(values.get('amount') || 0);
      if (recurring && !variable && amount <= 0) throw new Error('Enter an amount greater than zero for a recurring bill');
      if (recurring && !Number(values.get('vendor_id'))) throw new Error('Choose a vendor');
      if (recurring && !Number(values.get('account_id'))) throw new Error('Choose an expense account');
      const payload = {
        kind: selectedKind,
        name: values.get('name'),
        category: values.get('category'),
        status: values.get('status'),
        vendor_id: recurring ? Number(values.get('vendor_id')) : null,
        account_id: recurring ? Number(values.get('account_id')) : null,
        amount_cents: amount,
        variable_amount: variable,
        payment_method: recurring ? (values.get('payment_method') || 'Bank transfer') : 'Bank transfer',
        tax_rate: recurring ? Number(values.get('tax_rate') || 0) : 0,
        frequency: values.get('frequency'),
        next_due_date: nextDue,
        end_date: endDate || null,
        reminder_days: Number(values.get('reminder_days') || 14),
        auto_create_bill: recurring && !variable && values.get('auto_create_bill') === 'on',
        notes: values.get('notes'),
      };
      const saved = full
        ? await api.put(`/compliance/${full.id}`, payload)
        : await api.post('/compliance', payload);
      toast(full ? 'Compliance item updated' : `${saved.name} added to compliance`);
      if (onSaved) await onSaved(saved);
      return modal;
    },
  });
  return modal;
}

export async function openGenerateBillModal(item, onSaved = null) {
  return openModal({
    title: `Create draft bill — ${item.name}`,
    subtitle: item.variable_amount
      ? `${fmtDate(item.next_due_date)} · enter this period’s actual amount`
      : `${fmtDate(item.next_due_date)} · review before creating the draft`,
    body: `
      <div class="form-grid">
        <div class="field">
          <label for="gb-amount">Actual amount</label>
          <div class="money-input">
            <span>${esc(currencySymbol())}</span>
            <input class="input" id="gb-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(item.amount_cents)}" required>
          </div>
          <div class="hint">${item.variable_amount ? 'Enter the amount from this month’s bill.' : 'Change this if this period’s bill is different.'}</div>
        </div>
        <div class="field">
          <label for="gb-tax">Tax rate %</label>
          <input class="input" id="gb-tax" name="tax_rate" type="number" min="0" max="100" step="0.01" value="${esc(item.tax_rate ?? 0)}">
        </div>
        <div class="field">
          <label for="gb-date">Bill date</label>
          <input class="input" id="gb-date" name="bill_date" type="date" value="${esc(item.next_due_date)}" required>
        </div>
        <div class="field">
          <label for="gb-due">Due date</label>
          <input class="input" id="gb-due" name="due_date" type="date" value="${esc(item.next_due_date)}" required>
        </div>
        <div class="field full">
          <label for="gb-notes">Notes</label>
          <textarea class="input" id="gb-notes" name="notes" rows="2" placeholder="Optional note for this bill"></textarea>
        </div>
        <div class="field full">
          <div class="form-note">This creates a <strong>draft bill</strong>; nothing posts to the ledger until you receive it under Bills.</div>
        </div>
      </div>
    `,
    submitLabel: 'Create draft bill',
    async onSubmit(form) {
      const values = new FormData(form);
      const amount = toCents(values.get('amount'));
      if (amount <= 0) throw new Error('Enter the actual amount for this period');
      const billDate = values.get('bill_date');
      const dueDate = values.get('due_date');
      if (!billDate) throw new Error('Choose the bill date');
      if (!dueDate) throw new Error('Choose the due date');
      if (dueDate < billDate) throw new Error('Due date cannot be before the bill date');
      const result = await api.post(`/compliance/${item.id}/generate`, {
        amount_cents: amount,
        bill_date: billDate,
        due_date: dueDate,
        tax_rate: Number(values.get('tax_rate') || 0),
        notes: values.get('notes'),
      });
      toast(`Draft bill ${result.bill.number} created`);
      if (onSaved) await onSaved(result);
    },
  });
}

function rowHtml(item) {
  const actions = [];
  if (item.status === 'active') {
    if (item.kind === 'recurring_bill') {
      actions.push(`<button class="btn btn-secondary btn-sm" data-generate="${item.id}" title="Create a draft bill">${icon('bill', 14)}<span>Create bill</span></button>`);
    } else {
      actions.push(`<button class="btn btn-success btn-sm" data-complete="${item.id}" title="Mark complete">${icon('check', 14)}<span>Mark done</span></button>`);
    }
    actions.push(`<button class="icon-btn" data-skip="${item.id}" title="Skip this period">${icon('refresh', 15)}</button>`);
  }
  actions.push(`<button class="icon-btn" data-edit="${item.id}" title="Edit item">${icon('edit', 15)}</button>`);
  actions.push(`<button class="icon-btn danger" data-delete="${item.id}" title="Delete item">${icon('trash', 15)}</button>`);
  return `
    <tr data-id="${item.id}">
      <td>
        <div class="cell-main">${esc(item.name)}</div>
        <div class="cell-sub">${esc(item.category)}${item.vendor_name ? ` · ${esc(item.vendor_name)}` : ''}</div>
        ${item.last_generated_date ? `<div class="cell-sub">Last bill ${esc(fmtDate(item.last_generated_date))}</div>` : ''}
        ${item.last_completed_date ? `<div class="cell-sub">Last completed ${esc(fmtDate(item.last_completed_date))}</div>` : ''}
      </td>
      <td>${kindBadge(item.kind)}</td>
      <td>
        <div class="cell-main">${esc(item.frequency_label)}</div>
        <div class="cell-sub">${item.variable_amount ? 'Variable amount' : item.auto_create_bill ? 'Auto draft' : item.kind === 'recurring_bill' ? 'Manual draft' : 'Reminder'}${item.payment_method === 'Cheque' ? ' · Cheque' : ''}</div>
      </td>
      <td>
        <div class="cell-main nowrap">${esc(fmtDate(item.next_due_date))}</div>
        <div style="margin-top:4px">${dueBadge(item)}</div>
      </td>
      <td class="num">${item.amount_cents ? `${item.variable_amount ? '~' : ''}${fmtMoney(item.amount_cents)}` : '—'}</td>
      <td>${statusBadge(item.status)}</td>
      <td>
        <div class="row-actions">${actions.join('')}</div>
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

export async function render(container, { query } = {}) {
  const data = await api.get('/compliance', { auto: 1 });
  const summary = data.summary;
  const items = data.items;

  if (data.generated?.length) {
    toast(`${data.generated.length} draft bill${data.generated.length === 1 ? '' : 's'} created from compliance`);
  }
  if (data.errors?.length) {
    toast(`${data.errors.length} compliance item${data.errors.length === 1 ? '' : 's'} could not generate a bill`, 'error');
  }

  setHeader({
    title: 'Compliance',
    subtitle: `${summary.active_count} active · ${summary.overdue_count} overdue · ${summary.due_soon_count} due soon`,
    actions: `
      <a class="btn btn-secondary" href="#/cheques">${icon('cheque', 16)}<span>Cheques</span></a>
      <button class="btn btn-secondary" data-action="run-due">${icon('refresh', 16)}<span>Run due bills</span></button>
      <button class="btn btn-primary" data-action="new-compliance">${icon('plus', 16)}<span>New item</span></button>
    `,
  });

  function bindNewItem() {
    document.querySelectorAll('[data-action="new-compliance"]').forEach((button) => {
      button.addEventListener('click', () => openComplianceModal({
        defaults: button.dataset.kind ? { kind: button.dataset.kind, category: button.dataset.category } : {},
        onSaved: () => render(container),
      }));
    });
  }

  if (!items.length && !summary.active_count && !summary.overdue_count) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
          iconName: 'check',
          title: 'No compliance items yet',
          message: 'Track office rent and utilities as recurring bills, and keep VAT, corporate tax, licence, lease and insurance deadlines in one calendar.',
          action: `
            <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
              <button class="btn btn-primary" data-action="new-compliance" data-kind="recurring_bill" data-category="Office rent">${icon('plus', 15)} Add office rent</button>
              <button class="btn btn-secondary" data-action="new-compliance" data-kind="filing" data-category="VAT return">${icon('check', 15)} Add VAT reminder</button>
            </div>
          `,
        })}
      </div>
    `;
    bindNewItem();
    return;
  }

  const notice = data.generated?.length
    ? `<div class="callout" style="border-color:var(--green-soft);background:var(--green-soft)">
        <div class="callout-icon" style="background:var(--surface);color:var(--green)">${icon('check', 20)}</div>
        <div class="callout-text"><h3>Draft bills created</h3><p>${data.generated.map((row) => `<a href="#/bills/${row.bill_id}">${esc(row.bill_number)}</a>`).join(' · ')}</p></div>
      </div>`
    : '';
  const errorNotice = data.errors?.length
    ? `<div class="callout" style="border-color:var(--red-soft);background:var(--red-soft)">
        <div class="callout-icon" style="background:var(--surface);color:var(--red)">${icon('alert', 20)}</div>
        <div class="callout-text"><h3>Some bills could not be generated</h3><p>${data.errors.map((row) => `${esc(row.name)}: ${esc(row.error)}`).join(' · ')}</p></div>
      </div>`
    : '';

  container.innerHTML = `
    ${notice}
    ${errorNotice}
    <div class="kpi-grid">
      ${kpi('Overdue', String(summary.overdue_count), 'Needs attention now', 'alert', summary.overdue_count ? 'red' : 'green')}
      ${kpi('Due soon', String(summary.due_soon_count), 'Within the reminder window', 'clock', 'amber')}
      ${kpi('Monthly recurring', fmtMoney(summary.recurring_monthly_cents), `${summary.recurring_count} recurring item${summary.recurring_count === 1 ? '' : 's'}${summary.variable_count ? ` · ${summary.variable_count} variable` : ''}`, 'bill', 'blue')}
      ${kpi('Calendar', String(summary.calendar_count), `${summary.calendar_count} active filing${summary.calendar_count === 1 ? '' : 's'} / renewal${summary.calendar_count === 1 ? '' : 's'}`, 'check', 'indigo')}
    </div>

    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="compliance-search" type="search" placeholder="Search compliance items…" autocomplete="off">
      </div>
      <select class="input" id="compliance-kind" style="max-width:190px">
        <option value="all">All types</option>
        <option value="recurring_bill">Recurring bills</option>
        <option value="filing">Filings</option>
        <option value="renewal">Renewals</option>
      </select>
      <select class="input" id="compliance-due" style="max-width:160px">
        <option value="all">All due dates</option>
        <option value="attention">Needs attention</option>
        <option value="overdue">Overdue</option>
        <option value="soon">Due soon</option>
      </select>
      <select class="input" id="compliance-status" style="max-width:150px">
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="paused">Paused</option>
        <option value="done">Done</option>
      </select>
      <div class="spacer"></div>
      <span class="muted" id="compliance-count" style="font-size:12px"></span>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Item</th>
              <th>Type</th>
              <th>Schedule</th>
              <th>Next due</th>
              <th class="num">Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="compliance-body"></tbody>
        </table>
      </div>
    </div>
  `;

  const searchInput = container.querySelector('#compliance-search');
  const kindSelect = container.querySelector('#compliance-kind');
  const dueSelect = container.querySelector('#compliance-due');
  const statusSelect = container.querySelector('#compliance-status');
  const body = container.querySelector('#compliance-body');
  const countEl = container.querySelector('#compliance-count');

  function applyFilters() {
    const term = searchInput.value.trim().toLowerCase();
    const kind = kindSelect.value;
    const due = dueSelect.value;
    const status = statusSelect.value;
    const filtered = items.filter((item) => {
      if (kind !== 'all' && item.kind !== kind) return false;
      if (status !== 'all' && item.status !== status) return false;
      if (due === 'overdue' && item.due_state !== 'overdue') return false;
      if (due === 'soon' && !['due', 'soon'].includes(item.due_state)) return false;
      if (due === 'attention' && !['overdue', 'due', 'soon'].includes(item.due_state)) return false;
      if (!term) return true;
      return [item.name, item.category, item.vendor_name, item.notes, item.kind_label, item.frequency_label]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    countEl.textContent = `${filtered.length} shown`;
    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="7">${emptyState({
        iconName: 'search',
        title: 'No matching compliance items',
        message: 'Try a different search, type, status or due filter.',
      })}</td></tr>`;
      return;
    }
    body.innerHTML = filtered.map(rowHtml).join('');
  }

  searchInput.addEventListener('input', applyFilters);
  kindSelect.addEventListener('change', applyFilters);
  dueSelect.addEventListener('change', applyFilters);
  statusSelect.addEventListener('change', applyFilters);

  bindNewItem();

  const runDue = document.querySelector('[data-action="run-due"]');
  if (runDue) {
    runDue.addEventListener('click', async () => {
      try {
        const result = await api.post('/compliance/run-due', {});
        if (result.generated?.length) {
          toast(`${result.generated.length} draft bill${result.generated.length === 1 ? '' : 's'} created`);
        } else {
          toast('No auto due bills to create');
        }
        if (result.errors?.length) toast(`${result.errors.length} item${result.errors.length === 1 ? '' : 's'} failed`, 'error');
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  body.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      const item = items.find((row) => row.id === Number(edit.dataset.edit));
      if (!item) return;
      try {
        await openComplianceModal({ item, onSaved: () => render(container) });
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const generate = event.target.closest('[data-generate]');
    if (generate) {
      const item = items.find((row) => row.id === Number(generate.dataset.generate));
      if (!item) return;
      try {
        await openGenerateBillModal(item, () => render(container));
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const complete = event.target.closest('[data-complete]');
    if (complete) {
      const item = items.find((row) => row.id === Number(complete.dataset.complete));
      if (!item) return;
      const confirmed = await confirmDialog({
        title: 'Mark this item complete?',
        message: `${item.name} will be marked complete and the next due date will move forward.`,
        confirmLabel: 'Mark complete',
        danger: false,
      });
      if (!confirmed) return;
      try {
        await api.post(`/compliance/${item.id}/complete`, {});
        toast(`${item.name} marked complete`);
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const skip = event.target.closest('[data-skip]');
    if (skip) {
      const item = items.find((row) => row.id === Number(skip.dataset.skip));
      if (!item) return;
      const confirmed = await confirmDialog({
        title: 'Skip this period?',
        message: `${item.name} will move to its next scheduled date without creating a bill or changing the ledger.`,
        confirmLabel: 'Skip period',
        danger: false,
      });
      if (!confirmed) return;
      try {
        await api.post(`/compliance/${item.id}/skip`, {});
        toast(`${item.name} skipped to the next period`);
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const del = event.target.closest('[data-delete]');
    if (del) {
      const item = items.find((row) => row.id === Number(del.dataset.delete));
      if (!item) return;
      const confirmed = await confirmDialog({
        title: `Delete ${item.name}?`,
        message: 'The compliance item and its activity log will be deleted. Bills already generated stay in the ledger.',
        confirmLabel: 'Delete item',
      });
      if (!confirmed) return;
      try {
        await api.del(`/compliance/${item.id}`);
        toast(`${item.name} deleted`);
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  });

  applyFilters();
}
