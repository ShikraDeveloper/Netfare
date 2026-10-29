import { currencySymbol, esc, toCents } from './ui.js';

// "Bank charges" on payment and refund forms. The amount is posted to
// 6700 Bank Charges in the same entry as the payment (Dr 6700 · Cr bank).

const HINTS = {
  received: 'What the bank kept from this money. The document is still settled in full.',
  paid: 'What the bank took on top for this transfer.',
  refund: 'Paying a customer: what the bank took on top. Money from a supplier: what the bank kept.',
};

export function bankChargesFieldHtml(mode = 'paid') {
  return `
    <div class="field" data-bank-charges-field>
      <label for="bank-charges">Bank charges <span class="muted">(optional)</span></label>
      <div class="money-input">
        <span>${esc(currencySymbol())}</span>
        <input class="input" id="bank-charges" name="bank_charges" type="number" min="0" step="0.01" placeholder="0.00" inputmode="decimal">
      </div>
      <div class="hint">${esc(HINTS[mode] || HINTS.paid)} Posted to 6700 Bank Charges.</div>
    </div>`;
}

// Cash has no bank charge: hide and clear the field for Cash.
export function bindBankCharges(overlay, methodSelect) {
  const field = overlay.querySelector('[data-bank-charges-field]');
  if (!field || !methodSelect) return;
  const sync = () => {
    const cash = methodSelect.value === 'Cash';
    field.hidden = cash;
    if (cash) field.querySelector('input').value = '';
  };
  methodSelect.addEventListener('change', sync);
  sync();
}

export function readBankCharges(form) {
  const value = form.querySelector('#bank-charges')?.value;
  return value ? toCents(value) : 0;
}
