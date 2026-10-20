import { cashAccounts } from '../store.js';
import {
  centsToInput,
  currencySymbol,
  esc,
  fmtMoney,
  optionsHtml,
  todayISO,
} from '../ui.js';

export function depositAccounts() {
  const accounts = cashAccounts().slice().sort((a, b) => a.code.localeCompare(b.code));
  const preferred = accounts.find((account) => account.code === '1010')
    || accounts.find((account) => account.is_cash)
    || accounts[0];
  return { accounts, preferred };
}

export function advanceModalBody(job, kind = 'booking') {
  const { accounts, preferred } = depositAccounts();
  return `
    <div class="form-grid">
      <div class="field">
        <label for="adv-amount">Advance amount</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="adv-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(job.balance_cents)}" required>
        </div>
        <div class="hint">${kind === 'visa' ? 'Application balance' : 'Booking balance'} ${fmtMoney(job.balance_cents)}</div>
      </div>
      <div class="field">
        <label for="adv-date">Date received</label>
        <input class="input" id="adv-date" name="advance_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label for="adv-method">Method</label>
        <select class="input" id="adv-method" name="method">
          <option>Bank transfer</option><option>Cheque</option><option>Cash</option><option>Credit card</option><option>Other</option>
        </select>
      </div>
      <div class="field">
        <label for="adv-ref">Reference</label>
        <input class="input" id="adv-ref" name="reference" placeholder="e.g. deposit slip no." autocomplete="off">
      </div>
      <div class="field full">
        <label for="adv-account">Deposit to</label>
        <select class="input" id="adv-account" name="deposit_account_id">
          ${optionsHtml(accounts, { selected: preferred?.id, placeholder: 'Choose account…', labelKey: (account) => `${account.code} · ${account.name}` })}
        </select>
      </div>
      <div class="field full">
        <div class="form-note">${kind === 'visa' ? 'Money received before the application is invoiced.' : 'Money received before the trip.'} It is held as a <strong>Customer Advances</strong> liability until you apply it to an invoice.</div>
      </div>
    </div>
  `;
}

export function applyModalBody(job, advances) {
  return `
    <div class="form-grid">
      <div class="field full">
        <label for="apply-advance">Advance to apply</label>
        <select class="input" id="apply-advance" name="advance_id">
          ${optionsHtml(advances, { placeholder: 'Choose an advance…', labelKey: (advance) => `${advance.number} · ${fmtMoney(advance.remaining_cents)} available` })}
        </select>
      </div>
      <div class="field">
        <label for="apply-date">Application date</label>
        <input class="input" id="apply-date" name="payment_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label>Invoice</label>
        <input class="input" value="${esc(job.invoice.number)} · ${fmtMoney(job.invoice.balance_cents)} due" disabled>
      </div>
      <div class="field full">
        <div class="form-note">Applying the advance reduces the invoice balance and moves the amount from Customer Advances to Accounts Receivable.</div>
      </div>
    </div>
  `;
}

export function refundModalBody(advance) {
  const { accounts, preferred } = depositAccounts();
  return `
    <div class="form-grid">
      <div class="field">
        <label for="ref-amount">Refund amount</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="ref-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(advance.remaining_cents)}" required>
        </div>
        <div class="hint">${fmtMoney(advance.remaining_cents)} available on ${esc(advance.number)}</div>
      </div>
      <div class="field">
        <label for="ref-date">Refund date</label>
        <input class="input" id="ref-date" name="refund_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field full">
        <label for="ref-account">Refund from</label>
        <select class="input" id="ref-account" name="payment_account_id">
          ${optionsHtml(accounts, { selected: preferred?.id, placeholder: 'Choose account…', labelKey: (account) => `${account.code} · ${account.name}` })}
        </select>
      </div>
      <div class="field full">
        <div class="form-note">Refunding debits Customer Advances and credits your bank or cash account.</div>
      </div>
    </div>
  `;
}

