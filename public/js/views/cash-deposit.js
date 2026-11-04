import { api } from '../api.js';
import {
  centsToInput,
  currencySymbol,
  esc,
  fmtMoney,
  openModal,
  optionsHtml,
  todayISO,
  toast,
  toCents,
} from '../ui.js';

function accountOptions(accounts, selected) {
  return optionsHtml(accounts, {
    selected,
    placeholder: 'Choose account…',
    labelKey: (account) => `${account.code} · ${account.name} (${fmtMoney(account.balance_cents)})`,
  });
}

export async function openCashDepositModal({ onSaved = null } = {}) {
  const accounts = await api.get('/cash/accounts');
  const cash = accounts.find((account) => account.code === '1000') || accounts[0];
  if (!cash) {
    toast('Add an active cash account first.', 'error');
    return null;
  }
  const bank = accounts.find((account) => account.code === '1010')
    || accounts.find((account) => account.id !== cash.id);
  if (!bank) {
    toast('Add a bank account under Chart of accounts first.', 'error');
    return null;
  }

  return openModal({
    title: 'Deposit cash to bank',
    body: `
      <div class="form-grid">
        <div class="field">
          <label for="cash-amount">Amount to deposit</label>
          <div class="money-input">
            <span>${esc(currencySymbol())}</span>
            <input class="input" id="cash-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(cash.balance_cents)}" required>
          </div>
        </div>
        <div class="field">
          <label for="cash-date">Deposit date</label>
          <input class="input" id="cash-date" name="deposit_date" type="date" value="${todayISO()}" required>
        </div>
        <div class="field">
          <label for="cash-from">From cash account</label>
          <select class="input" id="cash-from" name="from_account_id">
            ${accountOptions([cash], cash.id)}
          </select>
        </div>
        <div class="field">
          <label for="cash-to">Deposit to bank account</label>
          <select class="input" id="cash-to" name="to_account_id">
            ${accountOptions(accounts.filter((account) => account.id !== cash.id), bank.id)}
          </select>
        </div>
        <div class="field">
          <label for="cash-reference">Deposit slip / reference</label>
          <input class="input" id="cash-reference" name="reference" placeholder="e.g. deposit slip number" autocomplete="off">
        </div>
        <div class="field">
          <label for="cash-notes">Notes</label>
          <input class="input" id="cash-notes" name="notes" placeholder="Optional" autocomplete="off">
        </div>
        <div class="field full">
          <div class="hint" id="cash-balance-hint"></div>
        </div>
        <div class="field full">
        </div>
      </div>
    `,
    submitLabel: 'Record deposit',
    onMount(overlay) {
      const fromSelect = overlay.querySelector('#cash-from');
      const toSelect = overlay.querySelector('#cash-to');
      const amountInput = overlay.querySelector('#cash-amount');
      const hint = overlay.querySelector('#cash-balance-hint');

      const selectedFrom = () => accounts.find((account) => account.id === Number(fromSelect.value));
      const selectedTo = () => accounts.find((account) => account.id === Number(toSelect.value));

      const syncToOptions = () => {
        const from = selectedFrom();
        const current = Number(toSelect.value);
        const options = accounts.filter((account) => account.id !== from.id);
        toSelect.innerHTML = accountOptions(options, options.some((account) => account.id === current) ? current : options[0]?.id);
      };

      const syncHint = () => {
        const from = selectedFrom();
        const to = selectedTo();
        const amount = toCents(amountInput.value);
        if (!from || !to || !hint) return;
        hint.innerHTML = `${esc(from.name)}: ${fmtMoney(from.balance_cents)} → <strong>${fmtMoney(from.balance_cents - amount)}</strong><br>${esc(to.name)}: ${fmtMoney(to.balance_cents)} → <strong>${fmtMoney(to.balance_cents + amount)}</strong>`;
        hint.style.color = amount > from.balance_cents ? 'var(--red)' : '';
      };

      fromSelect.addEventListener('change', () => {
        syncToOptions();
        syncHint();
      });
      toSelect.addEventListener('change', syncHint);
      amountInput.addEventListener('input', syncHint);
      syncHint();
    },
    async onSubmit(form) {
      const values = new FormData(form);
      const amount = toCents(values.get('amount'));
      if (amount <= 0) throw new Error('Enter a deposit amount');
      const fromId = Number(values.get('from_account_id'));
      const toId = Number(values.get('to_account_id'));
      if (fromId === toId) throw new Error('Choose a different bank account');
      const result = await api.post('/cash/deposits', {
        amount_cents: amount,
        deposit_date: values.get('deposit_date'),
        from_account_id: fromId,
        to_account_id: toId,
        reference: values.get('reference'),
        notes: values.get('notes'),
      });
      toast(`${result.number} · Deposited ${fmtMoney(amount)} to ${result.to_name}`);
      if (onSaved) await onSaved(result);
    },
  });
}
