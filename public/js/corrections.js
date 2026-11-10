// Correct (admin only): a small form, filled with the posted values, that
// voids the original and posts the corrected one in one step on the server
// (server/services/corrections.js). Pages add a Correct button with
// correctButtonHtml() next to Void and call bindCorrections() after rendering.

import { api } from './api.js';
import { MONEY_IN_METHODS, methodOptionsHtml } from './payment-methods.js';
import { cashAccounts } from './store.js';
import { centsToInput, esc, icon, openModal, toast, toCents } from './ui.js';

const MONEY_OUT_METHODS = ['Bank transfer', 'Cash', 'Cheque', 'Credit card', 'Other'];

const FORMS = {
  payment: {
    title: 'Correct payment', path: (id) => `/invoices/payments/${id}/correct`,
    date: 'payment_date', account: 'deposit_account_id', accountLabel: 'Received into', methods: MONEY_IN_METHODS, charges: true,
  },
  bill_payment: {
    title: 'Correct bill payment', path: (id) => `/bills/payments/${id}/correct`,
    date: 'payment_date', account: 'payment_account_id', accountLabel: 'Paid from', methods: MONEY_OUT_METHODS, charges: true,
  },
  topup: {
    title: 'Correct top-up', path: (id) => `/portals/topups/${id}/correct`,
    date: 'topup_date', account: 'deposit_account_id', accountLabel: 'Paid from', methods: MONEY_OUT_METHODS, charges: true, notes: true,
  },
  portal_refund: {
    title: 'Correct withdrawal', path: (id) => `/portals/refunds/${id}/correct`,
    date: 'refund_date', account: 'payment_account_id', accountLabel: 'Received into', methods: MONEY_IN_METHODS, notes: true,
  },
  advance: {
    title: 'Correct advance', path: (id) => `/advances/${id}/correct`,
    date: 'advance_date', account: 'deposit_account_id', accountLabel: 'Received into', methods: MONEY_IN_METHODS, charges: true,
  },
  cash_deposit: {
    title: 'Correct cash deposit', path: (id) => `/cash/deposits/${id}/correct`,
    date: 'deposit_date', transfer: true, notes: true,
  },
  refund: {
    title: 'Correct refund', path: (id) => `/refunds/${id}/correct`,
    date: 'refund_date', account: 'account_id', accountLabel: 'Bank or cash', methods: MONEY_OUT_METHODS, charges: true, notes: true,
  },
  credit_note: {
    title: 'Correct credit note', path: (id) => `/credits/${id}/correct`, date: 'credit_date', credit: true, notes: true,
  },
  supplier_credit: {
    title: 'Correct supplier credit', path: (id) => `/supplier-credits/${id}/correct`, date: 'credit_date', credit: true, notes: true,
  },
};

// The records behind the buttons on the current page, by "kind:id".
const records = new Map();

export function correctButtonHtml(kind, record) {
  records.set(`${kind}:${record.id}`, record);
  return `<button class="icon-btn" data-action="correct" data-correct="${kind}:${record.id}" title="Correct" aria-label="Correct ${esc(record.number || '')}">${icon('edit', 16)}</button>`;
}

function accountOptions(selected) {
  return cashAccounts()
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((account) => `<option value="${account.id}" ${account.id === Number(selected) ? 'selected' : ''}>${esc(account.code)} · ${esc(account.name)}</option>`)
    .join('');
}

function money(name, label, cents, required = false) {
  return `
    <div class="field">
      <label for="cx-${name}">${label}</label>
      <div class="money-input"><span>AED</span>
        <input class="input" id="cx-${name}" name="${name}" type="number" step="0.01" min="${required ? '0.01' : '0'}" ${required ? 'required' : ''}
          value="${centsToInput(cents || 0)}" inputmode="decimal">
      </div>
    </div>`;
}

function formBody(form, record) {
  return `
    <div class="form-grid">
      ${money('amount', 'Amount', record.amount_cents, true)}
      <div class="field">
        <label for="cx-date">Date</label>
        <input class="input" id="cx-date" name="date" type="date" required value="${esc(record[form.date] || '')}">
      </div>
      ${form.credit ? '' : form.transfer ? `
        <div class="field"><label for="cx-from">From</label><select class="input" id="cx-from" name="from_account_id">${accountOptions(record.from_account_id)}</select></div>
        <div class="field"><label for="cx-to">To</label><select class="input" id="cx-to" name="to_account_id">${accountOptions(record.to_account_id)}</select></div>
      ` : `
        <div class="field"><label for="cx-method">Method</label><select class="input" id="cx-method" name="method">${methodOptionsHtml(form.methods, record.method || form.methods[0])}</select></div>
        <div class="field"><label for="cx-account">${form.accountLabel}</label><select class="input" id="cx-account" name="account">${accountOptions(record[form.account])}</select></div>
      `}
      ${form.credit ? '' : `
        <div class="field">
          <label for="cx-reference">Reference</label>
          <input class="input" id="cx-reference" name="reference" maxlength="200" value="${esc(record.reference || '')}">
        </div>`}
      ${form.charges ? money('charges', 'Bank charges', record.bank_charges_cents) : ''}
      ${record.cheque_number ? `
        <div class="field"><label for="cx-cheque">Cheque number</label><input class="input" id="cx-cheque" name="cheque_number" maxlength="100" value="${esc(record.cheque_number)}"></div>
        <div class="field"><label for="cx-cheque-date">Cheque date</label><input class="input" id="cx-cheque-date" name="cheque_date" type="date" value="${esc(record.cheque_date || '')}"></div>
      ` : ''}
      ${form.notes ? `<div class="field full"><label for="cx-notes">Notes</label><input class="input" id="cx-notes" name="notes" maxlength="1000" value="${esc(record.notes || '')}"></div>` : ''}
      <div class="field full">
        <label for="cx-reason">Why</label>
        <input class="input" id="cx-reason" name="remarks" maxlength="500" required placeholder="Amount entered wrong">
      </div>
    </div>`;
}

function readValues(form, data) {
  const values = {
    amount_cents: toCents(data.get('amount')),
    [form.date]: data.get('date'),
  };
  if (!form.credit) values.reference = data.get('reference') || '';
  if (form.credit) {
    // Amount, date and notes only.
  } else if (form.transfer) {
    values.from_account_id = Number(data.get('from_account_id'));
    values.to_account_id = Number(data.get('to_account_id'));
  } else {
    values.method = data.get('method');
    values[form.account] = Number(data.get('account'));
  }
  if (form.charges) values.bank_charges_cents = toCents(data.get('charges') || 0);
  if (data.has('cheque_number')) {
    values.cheque_number = data.get('cheque_number') || '';
    values.cheque_date = data.get('cheque_date') || null;
  }
  if (form.notes) values.notes = data.get('notes') || '';
  return values;
}

function openCorrection(kind, record, onDone) {
  const form = FORMS[kind];
  openModal({
    title: `${form.title}${record.number ? ` ${record.number}` : ''}`,
    submitLabel: 'Save correction',
    body: formBody(form, record),
    async onSubmit(element) {
      const data = new FormData(element);
      const result = await api.post(form.path(record.id), { remarks: data.get('remarks'), values: readValues(form, data) });
      toast(result.number && record.number ? `${record.number} corrected by ${result.number}` : 'Corrected');
      if (onDone) await onDone(result);
    },
  });
}

export function bindCorrections(root, onDone) {
  root.querySelectorAll('[data-correct]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const [kind] = button.dataset.correct.split(':');
      const record = records.get(button.dataset.correct);
      if (FORMS[kind] && record) openCorrection(kind, record, onDone);
    });
  });
}
