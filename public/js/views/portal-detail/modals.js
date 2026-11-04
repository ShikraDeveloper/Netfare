import { bankChargesFieldHtml } from '../../bank-charges.js';
import { cashAccounts } from '../../store.js';
import {
  centsToInput,
  currencySymbol,
  esc,
  fmtMoney,
  optionsHtml,
  todayISO,
} from '../../ui.js';

export function depositAccounts() {
  const accounts = cashAccounts()
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));
  const preferred = accounts.find((account) => account.code === '1010')
    || accounts[0];
  return { accounts, preferred };
}

// Top-up: on a credit portal it pays the supplier's oldest open bills dated on
// or before it, and the rest stays as an advance; on a prepaid portal it
// moves money from the bank into Advances to Suppliers (an asset, a cost only
// once a booking uses it).
export function topUpModalBody(portal) {
  const { accounts, preferred } = depositAccounts();
  return `
    <div class="form-grid">
      <div class="field">
        <label for="tu-amount">Top-up amount</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="tu-amount" name="amount" type="number" min="0.01" step="0.01" required>
        </div>
      </div>
      <div class="field">
        <label for="tu-date">Date</label>
        <input class="input" id="tu-date" name="topup_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label for="tu-method">Method</label>
        <select class="input" id="tu-method" name="method">
          <option>Bank transfer</option><option>Cheque</option><option>Credit card</option><option>Cash</option><option>Other</option>
        </select>
      </div>
      <div class="field">
        <label for="tu-ref">Reference</label>
        <input class="input" id="tu-ref" name="reference" placeholder="Portal ref / receipt no." autocomplete="off">
      </div>
      <div class="field full">
        <label for="tu-account">Paid from</label>
        <select class="input" id="tu-account" name="deposit_account_id">
          ${optionsHtml(accounts, { selected: preferred?.id, placeholder: 'Choose account…', labelKey: (account) => `${account.code} · ${account.name}` })}
        </select>
      </div>
      ${bankChargesFieldHtml('paid')}
    </div>
  `;
}

// Withdrawal: the portal refunds unused money (credits Advances to Suppliers).
export function withdrawModalBody(portal) {
  const { accounts, preferred } = depositAccounts();
  return `
    <div class="form-grid">
      <div class="field">
        <label for="wd-amount">Amount · ${fmtMoney(portal.balance_cents)} available</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="wd-amount" name="amount" type="number" min="0.01" step="0.01" value="${esc(centsToInput(portal.balance_cents))}" required>
        </div>
      </div>
      <div class="field">
        <label for="wd-date">Date</label>
        <input class="input" id="wd-date" name="refund_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label for="wd-method">Method</label>
        <select class="input" id="wd-method" name="method">
          <option>Bank transfer</option><option>Credit card refund</option><option>Cash</option><option>Other</option>
        </select>
      </div>
      <div class="field">
        <label for="wd-ref">Reference</label>
        <input class="input" id="wd-ref" name="reference" placeholder="Optional" autocomplete="off">
      </div>
      <div class="field full">
        <label for="wd-account">Refund to</label>
        <select class="input" id="wd-account" name="payment_account_id">
          ${optionsHtml(accounts, { selected: preferred?.id, placeholder: 'Choose account…', labelKey: (account) => `${account.code} · ${account.name}` })}
        </select>
      </div>
    </div>
  `;
}

// Settle: the bill is paid from Advances to Suppliers; no new money leaves the bank.
export function settleModalBody(portal) {
  return `
    <div class="form-grid">
      <div class="field full">
        <label for="st-bill">Supplier bill</label>
        <select class="input" id="st-bill" name="bill_id">
          ${optionsHtml(portal.open_bills, { placeholder: 'Choose an open bill…', labelKey: (bill) => `${bill.number} · ${fmtMoney(bill.balance_cents)} due` })}
        </select>
      </div>
      <div class="field">
        <label for="st-amount">Amount · ${fmtMoney(portal.balance_cents)} available</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="st-amount" name="amount" type="number" min="0.01" step="0.01" required>
        </div>
      </div>
      <div class="field">
        <label for="st-date">Date</label>
        <input class="input" id="st-date" name="settle_date" type="date" value="${todayISO()}" required>
      </div>
    </div>
  `;
}

