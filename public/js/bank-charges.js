import { currencySymbol, esc, toCents } from './ui.js';

// "Bank charges" on payment and refund forms. The amount is posted to
// 6700 Bank Charges in the same entry as the payment (Dr 6700 · Cr bank).

// The label says which way the charge goes: kept from money received, or
// taken on top of money paid out.
const LABELS = {
  received: 'Bank kept',
  paid: 'Bank charge',
  refund: 'Bank charges',
};

export function bankChargesFieldHtml(mode = 'paid') {
  return `
    <div class="field" data-bank-charges-field>
      <label for="bank-charges">${esc(LABELS[mode] || LABELS.paid)}</label>
      <div class="money-input">
        <span>${esc(currencySymbol())}</span>
        <input class="input" id="bank-charges" name="bank_charges" type="number" min="0" step="0.01" placeholder="0.00" inputmode="decimal">
      </div>
    </div>`;
}

// Cash has no bank charge, and money into 1030 Card & Payment Link Clearing
// has its fee taken at the card settlement: hide and clear the field then.
export function bindBankCharges(overlay, methodSelect, accountSelect = null) {
  const field = overlay.querySelector('[data-bank-charges-field]');
  if (!field || !methodSelect) return;
  const clearingId = accountSelect
    ? [...accountSelect.options].find((option) => /^1030\b/.test(option.textContent))?.value
    : null;
  const sync = () => {
    const hide = methodSelect.value === 'Cash' || (clearingId && accountSelect.value === clearingId);
    field.hidden = Boolean(hide);
    if (hide) field.querySelector('input').value = '';
  };
  methodSelect.addEventListener('change', sync);
  accountSelect?.addEventListener('change', sync);
  sync();
}

export function readBankCharges(form) {
  const value = form.querySelector('#bank-charges')?.value;
  return value ? toCents(value) : 0;
}
