import { api } from '../api.js';
import { bankChargesFieldHtml, bindBankCharges, readBankCharges } from '../bank-charges.js';
import { cashAccounts } from '../store.js';
import {
  centsToInput,
  currencySymbol,
  esc,
  fmtDate,
  fmtMoney,
  openModal,
  optionsHtml,
  todayISO,
  toast,
  toCents,
} from '../ui.js';

const REFUND_METHODS = ['Bank transfer', 'Cheque', 'Cash', 'Credit card', 'Payment link', 'Other'];

function sourceKey(source) {
  return String(source.payment_id || source.bill_payment_id || '');
}

function sourceLabel(source) {
  return `${source.document_number} · ${source.party_name} · ${source.payment_number} · ${fmtMoney(source.refundable_cents)} available`;
}

function sourceSummary(source) {
  if (!source) return '';
  const refunded = Number(source.refunded_cents || 0);
  return `
    <div class="form-note">
      <strong>${esc(source.document_number)}</strong> · ${esc(source.party_name)}<br>
      Payment ${esc(source.payment_number)} on ${esc(fmtDate(source.payment_date))}<br>
      Refundable <strong>${fmtMoney(source.refundable_cents)}</strong> of ${fmtMoney(source.amount_cents)}${refunded > 0 ? ` · ${fmtMoney(refunded)} already refunded` : ''}
    </div>
  `;
}

function refundNote(type) {
  return type === 'customer'
    ? 'This posts a debit to Trade Receivables and a credit to the bank or cash account. The invoice balance increases by the refund.'
    : 'This posts a debit to the bank or cash account and a credit to 1450 Supplier Credits. A supplier credit note is created and the original bill stays settled; it is not reopened.';
}

function bodyHtml({ type, source, allowTypeChange }) {
  const accounts = cashAccounts().sort((a, b) => (b.is_cash - a.is_cash) || a.code.localeCompare(b.code));
  const preferred = accounts.find((account) => account.code === '1010') || accounts[0];
  const fixed = Boolean(source);
  return `
    <div class="form-grid">
      ${allowTypeChange ? `
        <div class="field full">
          <label for="refund-type">Refund type</label>
          <select class="input" id="refund-type" name="refund_type">
            <option value="customer" ${type === 'customer' ? 'selected' : ''}>Customer refund — money paid back to a customer</option>
            <option value="supplier" ${type === 'supplier' ? 'selected' : ''}>Supplier refund — money returned by a supplier</option>
          </select>
        </div>
      ` : ''}
      ${fixed ? `
        <div class="field full">${sourceSummary(source)}</div>
      ` : `
        <div class="field full">
          <label for="refund-source-search">Original payment</label>
          <input class="input" id="refund-source-search" type="search" placeholder="Search invoice/bill, customer or payment number…" autocomplete="off" disabled>
          <div class="hint" id="refund-source-search-hint">Type to narrow the list, then choose the payment below.</div>
          <select class="input" id="refund-source" aria-label="Matching payments" disabled style="margin-top:8px">
            <option>Loading refundable payments…</option>
          </select>
          <div class="hint" id="refund-source-hint">Choose the payment this refund belongs to.</div>
        </div>
      `}
      <div class="field">
        <label for="refund-amount" id="refund-amount-label">${type === 'customer' ? 'Refund amount' : 'Amount received back'}</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="refund-amount" name="amount" type="number" min="0.01" step="0.01" value="${source ? centsToInput(source.refundable_cents) : ''}" required>
        </div>
        <div class="hint" id="refund-available">${source ? `Available ${fmtMoney(source.refundable_cents)}` : 'Choose a payment to see the available amount.'}</div>
      </div>
      <div class="field">
        <label for="refund-date">Refund date</label>
        <input class="input" id="refund-date" name="refund_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label for="refund-method">Method</label>
        <select class="input" id="refund-method" name="method">
          ${REFUND_METHODS.map((method) => `<option ${source && source.method === method ? 'selected' : ''}>${method}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="refund-reference">Reference</label>
        <input class="input" id="refund-reference" name="reference" placeholder="e.g. transfer reference" autocomplete="off">
      </div>
      ${bankChargesFieldHtml('refund')}
      <div class="field full">
        <label for="refund-account" id="refund-account-label">${type === 'customer' ? 'Refund from' : 'Deposit to'}</label>
        <select class="input" id="refund-account" name="account_id">
          ${optionsHtml(accounts, {
            selected: source?.account_id || preferred?.id,
            placeholder: 'Choose bank or cash account…',
            labelKey: (account) => `${account.code} · ${account.name}`,
          })}
        </select>
      </div>
      <div class="field full">
        <label for="refund-notes">Notes</label>
        <textarea class="input" id="refund-notes" name="notes" rows="2" placeholder="Reason for the refund, cancellation reference, or internal note"></textarea>
      </div>
      <div class="field full">
        <div class="form-note">
          <strong>Payment refunds only.</strong> This form refunds an invoice or bill payment. Cancellation refunds and advance refunds are recorded from their own source screens so the correct balance is reduced.
        </div>
      </div>
      <div class="field full">
        <div class="form-note" id="refund-note">${refundNote(type)}</div>
      </div>
    </div>
  `;
}

export function openRefundModal({
  type = 'customer',
  source = null,
  allowTypeChange = false,
  onSaved = null,
} = {}) {
  const accounts = cashAccounts().sort((a, b) => (b.is_cash - a.is_cash) || a.code.localeCompare(b.code));
  if (!accounts.length) {
    toast('Add an active bank or cash account before recording refunds.', 'error');
    return null;
  }

  const fixed = Boolean(source);
  let currentType = type;
  let currentSources = fixed ? [source] : [];
  let selectedSource = source || null;

  return openModal({
    title: fixed
      ? (type === 'customer' ? 'Refund customer payment' : 'Record supplier refund')
      : 'New refund',
    subtitle: fixed
      ? `${source.document_number} · ${source.party_name}`
      : 'Refund a customer payment or record money returned by a supplier.',
    body: bodyHtml({ type, source, allowTypeChange }),
    submitLabel: type === 'customer' ? 'Refund payment' : 'Record refund',
    onMount(overlay) {
      const amount = overlay.querySelector('#refund-amount');
      const method = overlay.querySelector('#refund-method');
      const account = overlay.querySelector('#refund-account');
      const available = overlay.querySelector('#refund-available');
      const note = overlay.querySelector('#refund-note');
      const amountLabel = overlay.querySelector('#refund-amount-label');
      const accountLabel = overlay.querySelector('#refund-account-label');
      const sourceSelect = overlay.querySelector('#refund-source');
      const sourceSearch = overlay.querySelector('#refund-source-search');
      const sourceSearchHint = overlay.querySelector('#refund-source-search-hint');
      const sourceHint = overlay.querySelector('#refund-source-hint');
      const typeSelect = overlay.querySelector('#refund-type');
      const submit = overlay.querySelector('[data-submit]');

      function selectSource(nextSource) {
        selectedSource = nextSource;
        if (!nextSource) {
          if (amount) amount.value = '';
          if (available) available.textContent = 'Choose a payment to see the available amount.';
          if (sourceHint) sourceHint.textContent = 'Choose the payment this refund belongs to.';
          return;
        }
        if (amount) amount.value = centsToInput(nextSource.refundable_cents);
        if (available) {
          const refunded = Number(nextSource.refunded_cents || 0);
          available.textContent = `Available ${fmtMoney(nextSource.refundable_cents)} of ${fmtMoney(nextSource.amount_cents)}${refunded > 0 ? ` · ${fmtMoney(refunded)} already refunded` : ''}`;
        }
        if (sourceHint) {
          sourceHint.innerHTML = sourceSummary(nextSource);
        }
        if (account) {
          const hasAccount = Array.from(account.options).some((option) => String(option.value) === String(nextSource.account_id));
          if (hasAccount) account.value = String(nextSource.account_id);
        }
        if (method && REFUND_METHODS.includes(nextSource.method)) method.value = nextSource.method;
      }

      function syncType(nextType) {
        currentType = nextType;
        if (amountLabel) amountLabel.textContent = nextType === 'customer' ? 'Refund amount' : 'Amount received back';
        if (accountLabel) accountLabel.textContent = nextType === 'customer' ? 'Refund from' : 'Deposit to';
        if (note) note.textContent = refundNote(nextType);
        if (submit) submit.textContent = nextType === 'customer' ? 'Refund payment' : 'Record refund';
      }

      function matchesSource(source, term) {
        if (!term) return true;
        const haystack = [
          source.document_number,
          source.party_name,
          source.payment_number,
          source.method,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(term);
      }

      function renderSourceOptions() {
        if (!sourceSelect) return;
        const term = (sourceSearch?.value || '').trim().toLowerCase();
        const matches = currentSources.filter((source) => matchesSource(source, term));
        if (sourceSearchHint) {
          if (!currentSources.length) {
            sourceSearchHint.textContent = 'No refundable payments found.';
          } else if (!term) {
            sourceSearchHint.textContent = `${currentSources.length} refundable payment${currentSources.length === 1 ? '' : 's'}. Type to narrow the list.`;
          } else {
            sourceSearchHint.textContent = `${matches.length} of ${currentSources.length} payment${currentSources.length === 1 ? '' : 's'} match.`;
          }
        }
        if (!matches.length) {
          sourceSelect.innerHTML = '<option value="">No matching payments</option>';
          sourceSelect.disabled = true;
          selectSource(null);
          return;
        }
        sourceSelect.innerHTML = `<option value="">Choose a payment…</option>${matches.map((row) => `
          <option value="${esc(sourceKey(row))}">${esc(sourceLabel(row))}</option>
        `).join('')}`;
        sourceSelect.disabled = false;
        const selectedKey = selectedSource ? sourceKey(selectedSource) : '';
        if (selectedKey && matches.some((row) => sourceKey(row) === selectedKey)) {
          sourceSelect.value = selectedKey;
          return;
        }
        if (matches.length === 1) {
          sourceSelect.value = sourceKey(matches[0]);
          selectSource(matches[0]);
          return;
        }
        sourceSelect.value = '';
        selectSource(null);
      }

      async function loadSources(nextType) {
        if (!sourceSelect) return;
        sourceSelect.disabled = true;
        if (sourceSearch) {
          sourceSearch.disabled = true;
          sourceSearch.value = '';
        }
        sourceSelect.innerHTML = '<option>Loading refundable payments…</option>';
        if (sourceSearchHint) sourceSearchHint.textContent = 'Loading refundable payments…';
        if (sourceHint) sourceHint.textContent = 'Choose the payment this refund belongs to.';
        try {
          const rows = await api.get('/refunds/sources', { type: nextType });
          currentSources = rows;
          selectedSource = null;
          if (!rows.length) {
            sourceSelect.innerHTML = '<option value="">No refundable payments</option>';
            sourceSelect.disabled = true;
            if (sourceSearch) sourceSearch.disabled = true;
            if (sourceSearchHint) sourceSearchHint.textContent = 'No refundable payments found.';
            selectSource(null);
            return;
          }
          if (sourceSearch) sourceSearch.disabled = false;
          renderSourceOptions();
        } catch (error) {
          currentSources = [];
          sourceSelect.innerHTML = '<option value="">Could not load payments</option>';
          sourceSelect.disabled = true;
          if (sourceSearch) sourceSearch.disabled = true;
          if (sourceSearchHint) sourceSearchHint.textContent = 'Could not load payments.';
          toast(error.message, 'error');
        }
      }

      if (method) {
        method.addEventListener('change', () => {
          if (!account) return;
          const code = method.value === 'Cash' ? '1000' : '1010';
          const target = accounts.find((candidate) => candidate.code === code);
          if (target) account.value = String(target.id);
        });
        bindBankCharges(overlay, method);
      }

      if (sourceSelect) {
        sourceSelect.addEventListener('change', () => {
          const next = currentSources.find((row) => sourceKey(row) === sourceSelect.value) || null;
          selectSource(next);
        });
      }

      if (sourceSearch) {
        sourceSearch.addEventListener('input', () => renderSourceOptions());
      }

      if (typeSelect) {
        typeSelect.addEventListener('change', async () => {
          syncType(typeSelect.value);
          await loadSources(typeSelect.value);
        });
      }

      if (fixed) {
        selectSource(source);
      } else {
        syncType(currentType);
        loadSources(currentType);
      }
    },
    async onSubmit(form) {
      const values = new FormData(form);
      const refundType = fixed ? type : values.get('refund_type');
      const chosen = fixed
        ? source
        : currentSources.find((row) => sourceKey(row) === (form.querySelector('#refund-source')?.value || ''));
      if (!chosen) throw new Error('Choose the original payment to refund');
      const amount = toCents(values.get('amount'));
      if (amount <= 0) throw new Error('Enter a refund amount');
      if (amount > Number(chosen.refundable_cents)) {
        throw new Error(`Refund cannot exceed ${fmtMoney(chosen.refundable_cents)}`);
      }
      const accountId = Number(values.get('account_id'));
      if (!accountId) throw new Error('Choose a bank or cash account');
      const refund = await api.post('/refunds', {
        refund_type: refundType,
        payment_id: refundType === 'customer' ? chosen.payment_id : undefined,
        bill_payment_id: refundType === 'supplier' ? chosen.bill_payment_id : undefined,
        amount_cents: amount,
        refund_date: values.get('refund_date'),
        method: values.get('method'),
        reference: values.get('reference'),
        notes: values.get('notes'),
        account_id: accountId,
        bank_charges_cents: readBankCharges(form),
      });
      toast(`${refund.number} · ${fmtMoney(amount)} refunded`);
      if (onSaved) await onSaved(refund);
    },
  });
}
