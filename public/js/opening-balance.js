import { store } from './store.js';
import { currencySymbol, esc, toCents, todayISO } from './ui.js';

// "Opening balance" on the new customer, supplier and portal forms, for the
// admin only. The server turns it into an opening invoice, bill, credit or
// portal balance (services/party-opening.js).

const CHOICES = {
  customer: [
    ['they_owe', 'Customer owes us', 'Recorded as an opening invoice they can pay.'],
    ['we_owe', 'We owe the customer', 'Recorded as a customer credit you can apply or refund.'],
  ],
  vendor: [
    ['we_owe', 'We owe the supplier', 'Recorded as an opening bill you can pay.'],
    ['they_owe', 'Supplier owes us', 'Recorded as a supplier credit you can apply to bills or get refunded.'],
  ],
  portal: [
    ['they_owe', 'Balance held on the portal', 'Added to the portal balance, ready for bookings.'],
    ['we_owe', 'We owe the supplier', 'Recorded as an opening bill for the portal\'s supplier.'],
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
      <summary>Opening balance <span class="muted">(optional, admin only)</span></summary>
      <div class="form-grid" style="margin-top:10px">
        <div class="field full">
          <div class="radio-row" role="radiogroup" aria-label="Who owes the opening balance">
            ${choices.map(([value, label, hint], index) => `
              <label class="radio-option">
                <input type="radio" name="opening_direction" value="${value}" ${index === 0 ? 'checked' : ''}>
                <span><strong>${esc(label)}</strong><span class="hint">${esc(hint)}</span></span>
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
        <div class="field full">
          <div class="hint">The other side goes to 3900 Opening Balance Equity. It is not counted as a sale or a purchase.</div>
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
