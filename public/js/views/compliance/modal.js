import { api } from '../../api.js';
import { activeVendors, expenseAccounts } from '../../store.js';
import { depositAccounts } from '../job-modals.js';
import {
  centsToInput,
  currencySymbol,
  esc,
  openModal,
  optionsHtml,
  recordMetaHtml,
  todayISO,
  toast,
  toCents,
} from '../../ui.js';
import {
  CATEGORIES,
  FREQUENCY_OPTIONS,
  KIND_OPTIONS,
  PAYMENT_METHODS,
  STATUS_OPTIONS,
  categoryOptions,
  logsHtml,
} from './shared.js';

function modalBody(item = null) {
  const vendors = activeVendors().sort((a, b) => a.name.localeCompare(b.name));
  const accounts = expenseAccounts()
    .filter((account) => account.type === 'expense' || account.code === '1200')
    .sort((a, b) => a.code.localeCompare(b.code));
  const kind = item?.kind || 'recurring_bill';
  const category = item?.category || CATEGORIES[kind][0];
  const frequency = item?.frequency || (kind === 'renewal' ? 'yearly' : kind === 'filing' ? 'quarterly' : 'monthly');
  const amount = item?.amount_cents != null ? centsToInput(item.amount_cents) : '';
  const { accounts: bankAccounts, preferred: preferredBank } = depositAccounts();
  const bankDebit = Boolean(item?.auto_debit_account_id);
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
        <label for="ci-vendor" id="ci-vendor-label">Supplier</label>
        <select class="input" id="ci-vendor" name="vendor_id">
          ${optionsHtml(vendors, { selected: item?.vendor_id, placeholder: 'Choose a vendor…' })}
        </select>
      </div>
      <div class="field full" data-ci-recurring>
        <label for="ci-account">Expense account</label>
        <select class="input" id="ci-account" name="account_id">
          ${optionsHtml(accounts, {
            selected: item?.account_id,
            placeholder: 'Choose an expense account…',
            labelKey: (account) => `${account.code} · ${account.name}`,
          })}
        </select>
      </div>
      <div class="field">
        <label for="ci-amount" id="ci-amount-label">${kind === 'recurring_bill' ? (item?.variable_amount ? 'Typical amount (optional)' : 'Amount') : 'Fee / estimate (optional)'}</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="ci-amount" name="amount" type="number" min="0" step="0.01" value="${amount}" placeholder="0.00">
        </div>
      </div>
      <div class="field" data-ci-recurring data-ci-not-debit>
        <label for="ci-payment-method">Payment method</label>
        <select class="input" id="ci-payment-method" name="payment_method">
          ${PAYMENT_METHODS.map((method) => `<option value="${esc(method)}" ${method === (item?.payment_method || 'Bank transfer') ? 'selected' : ''}>${esc(method)}</option>`).join('')}
        </select>
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
        <label for="ci-end">End date</label>
        <input class="input" id="ci-end" name="end_date" type="date" value="${esc(item?.end_date || '')}">
      </div>
      <div class="field">
        <label for="ci-reminder">Remind (days before)</label>
        <input class="input" id="ci-reminder" name="reminder_days" type="number" min="0" max="365" step="1" value="${esc(item?.reminder_days ?? 14)}">
      </div>
      <div class="field full" data-ci-recurring>
        <label class="checkline" style="display:flex;align-items:center;gap:8px;font-size:13px">
          <input type="checkbox" id="ci-variable" name="variable_amount" ${item?.variable_amount ? 'checked' : ''}>
          <span>Amount varies each period</span>
        </label>
      </div>
      <div class="field full" data-ci-recurring>
        <label class="checkline" style="display:flex;align-items:center;gap:8px;font-size:13px">
          <input type="checkbox" id="ci-bank-debit" name="bank_debit" ${bankDebit ? 'checked' : ''}>
          <span>The bank takes this amount itself (bank debit)</span>
        </label>
      </div>
      <div class="field full" data-ci-recurring data-ci-debit>
        <label for="ci-debit-account">Debited from</label>
        <select class="input" id="ci-debit-account" name="auto_debit_account_id">
          ${optionsHtml(bankAccounts, { selected: item?.auto_debit_account_id || preferredBank?.id, labelKey: (account) => `${account.code} · ${account.name}` })}
        </select>
      </div>
      <div class="field full" data-ci-recurring data-ci-not-debit id="ci-auto-field">
        <label class="checkline" style="display:flex;align-items:center;gap:8px;font-size:13px">
          <input type="checkbox" id="ci-auto" name="auto_create_bill" ${item?.auto_create_bill ? 'checked' : ''}>
          <span>Auto-create a draft bill when due</span>
        </label>
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
  const bankDebit = recurring && overlay.querySelector('#ci-bank-debit')?.checked;
  overlay.querySelectorAll('[data-ci-debit]').forEach((el) => { el.hidden = !bankDebit; });
  const vendorEmpty = overlay.querySelector('#ci-vendor option[value=""]');
  if (vendorEmpty) vendorEmpty.textContent = bankDebit ? 'None — the bank itself' : 'Choose a vendor…';
  overlay.querySelectorAll('[data-ci-not-debit]').forEach((el) => { el.hidden = !recurring || bankDebit; });
  const auto = overlay.querySelector('#ci-auto');
  const autoField = overlay.querySelector('#ci-auto-field');
  if (auto && variable) auto.checked = false;
  if (auto) auto.disabled = Boolean(variable);
  if (autoField) autoField.hidden = Boolean(variable) || bankDebit || !recurring;
}

// Choosing "Bank charges" on a new item fills in the usual set-up.
function applyBankChargesDefaults(overlay) {
  if (overlay.querySelector('#ci-category').value !== 'Bank charges') return;
  const account = expenseAccounts().find((row) => row.code === '6700');
  if (account) overlay.querySelector('#ci-account').value = String(account.id);
  overlay.querySelector('#ci-bank-debit').checked = true;
  syncVariableFields(overlay);
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
    body: `${modalBody({ ...seed, kind, category })}${full ? recordMetaHtml(full) : ''}`,
    submitLabel: full ? 'Save changes' : 'Add item',
    onMount(overlay) {
      const kindSelect = overlay.querySelector('#ci-kind');
      kindSelect.addEventListener('change', () => syncKindFields(overlay, { resetCategory: true, isNew: !full }));
      overlay.querySelector('#ci-variable')?.addEventListener('change', () => syncVariableFields(overlay));
      overlay.querySelector('#ci-bank-debit')?.addEventListener('change', () => syncVariableFields(overlay));
      if (!full) overlay.querySelector('#ci-category').addEventListener('change', () => applyBankChargesDefaults(overlay));
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
      const bankDebit = recurring && values.get('bank_debit') === 'on';
      const amount = recurring ? toCents(values.get('amount')) : toCents(values.get('amount') || 0);
      if (recurring && !variable && amount <= 0) throw new Error('Enter an amount greater than zero for a recurring bill');
      if (recurring && !bankDebit && !Number(values.get('vendor_id'))) throw new Error('Choose a vendor');
      if (recurring && !Number(values.get('account_id'))) throw new Error('Choose an expense account');
      const payload = {
        kind: selectedKind,
        name: values.get('name'),
        category: values.get('category'),
        status: values.get('status'),
        vendor_id: recurring ? Number(values.get('vendor_id')) || null : null,
        account_id: recurring ? Number(values.get('account_id')) : null,
        amount_cents: amount,
        variable_amount: variable,
        payment_method: recurring ? (values.get('payment_method') || 'Bank transfer') : 'Bank transfer',
        frequency: values.get('frequency'),
        next_due_date: nextDue,
        end_date: endDate || null,
        reminder_days: Number(values.get('reminder_days') || 14),
        auto_create_bill: recurring && !variable && (bankDebit || values.get('auto_create_bill') === 'on'),
        auto_debit_account_id: bankDebit ? Number(values.get('auto_debit_account_id')) || null : null,
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
  const bankDebit = Boolean(item.auto_debit_account_id);
  return openModal({
    title: bankDebit ? `Record bank debit — ${item.name}` : `Create draft bill — ${item.name}`,
    body: `
      <div class="form-grid">
        <div class="field">
          <label for="gb-amount">Actual amount</label>
          <div class="money-input">
            <span>${esc(currencySymbol())}</span>
            <input class="input" id="gb-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(item.amount_cents)}" required>
          </div>
        </div>
        <div class="field">
          <label for="gb-date">${bankDebit ? 'Date debited' : 'Bill date'}</label>
          <input class="input" id="gb-date" name="bill_date" type="date" value="${esc(item.next_due_date)}" required>
        </div>
        <div class="field" ${bankDebit ? 'hidden' : ''}>
          <label for="gb-due">Due date</label>
          <input class="input" id="gb-due" name="due_date" type="date" value="${esc(item.next_due_date)}" required>
        </div>
        <div class="field full">
          <label for="gb-notes">Notes</label>
          <textarea class="input" id="gb-notes" name="notes" rows="2" placeholder="Optional note for this bill"></textarea>
        </div>
      </div>
    `,
    submitLabel: bankDebit ? 'Record bank debit' : 'Create draft bill',
    async onSubmit(form) {
      const values = new FormData(form);
      const amount = toCents(values.get('amount'));
      if (amount <= 0) throw new Error('Enter the actual amount for this period');
      const billDate = values.get('bill_date');
      const dueDate = bankDebit ? billDate : values.get('due_date');
      if (!billDate) throw new Error('Choose the bill date');
      if (!dueDate) throw new Error('Choose the due date');
      if (dueDate < billDate) throw new Error('Due date cannot be before the bill date');
      const result = await api.post(`/compliance/${item.id}/generate`, {
        amount_cents: amount,
        bill_date: billDate,
        due_date: dueDate,
        notes: values.get('notes'),
      });
      toast(bankDebit ? `Bank debit ${result.bill.number} recorded as paid` : `Draft bill ${result.bill.number} created`);
      if (onSaved) await onSaved(result);
    },
  });
}
