import { store } from './store.js';
import { currencySymbol, esc, toCents, todayISO } from './ui.js';

// "Opening balance" on the new customer, supplier and portal forms, for the
// admin only. The server turns it into an opening invoice, bill, credit or
// portal balance (services/party-opening.js): "owes us" becomes an opening
// invoice, credit or portal balance, "we owe" an opening bill or customer
// credit, and the other side goes to 3900 Opening Balance Equity, never to
// sales or purchases.

const CHOICES = {
  customer: [
    ['they_owe', 'Customer owes us'],
    ['we_owe', 'We owe the customer'],
  ],
  vendor: [
    ['we_owe', 'We owe the supplier'],
    ['they_owe', 'Supplier owes us'],
  ],
  portal: [
    ['they_owe', 'Balance held on the portal'],
    ['we_owe', 'We owe the supplier'],
  ],
};

export function canEnterOpening() {
  return Boolean(store.user?.is_admin);
}

export function openingFieldsHtml(kind) {
  if (!canEnterOpening()) return '';
  const choices = CHOICES[kind];
  return `
    <details class="field full opening-fields">
      <summary>Opening balance</summary>
      <div class="form-grid" style="margin-top:10px">
        <div class="field full">
          <div class="radio-row" role="radiogroup" aria-label="Who owes the opening balance">
            ${choices.map(([value, label], index) => `
              <label class="radio-option">
                <input type="radio" name="opening_direction" value="${value}" ${index === 0 ? 'checked' : ''}>
                <span><strong>${esc(label)}</strong></span>
              </label>`).join('')}
          </div>
        </div>
        <div class="field">
          <label for="opening-amount">Amount</label>
          <div class="money-input">
            <span>${esc(currencySymbol())}</span>
            <input class="input" id="opening-amount" name="opening_amount" type="number" min="0" step="0.01" placeholder="0.00" inputmode="decimal">
          </div>
        </div>
        <div class="field">
          <label for="opening-date">As of</label>
          <input class="input" id="opening-date" name="opening_as_of" type="date" value="${todayISO()}">
        </div>
      </div>
    </details>`;
}

// null when no amount was entered.
export function readOpening(form) {
  const amount = form.querySelector('#opening-amount')?.value;
  if (!amount || toCents(amount) <= 0) return null;
  return {
    direction: form.querySelector('input[name="opening_direction"]:checked')?.value,
    amount_cents: toCents(amount),
    as_of: form.querySelector('#opening-date')?.value,
  };
}
