// Payment methods for money received, and the account each one lands in.
// Card and payment link money reaches the bank days later in a batch, less
// fees, so it waits in 1030 Card & Payment Link Clearing until settled.

export const CLEARING_CODE = '1030';

export const MONEY_IN_METHODS = ['Bank transfer', 'Cash', 'Credit card', 'Payment link', 'Cheque', 'Other'];

export function isClearingMethod(method) {
  return method === 'Credit card' || method === 'Payment link';
}

export function depositCodeFor(method) {
  if (method === 'Cash') return '1000';
  if (isClearingMethod(method)) return CLEARING_CODE;
  return '1010';
}

// Keeps "Received into" in step with the method: Cash → 1000, card and
// payment link → 1030, anything else → 1010. `accounts` are the options.
export function bindMethodAccount(methodSelect, accountSelect, accounts, codeFor = depositCodeFor) {
  if (!methodSelect || !accountSelect) return;
  methodSelect.addEventListener('change', () => {
    const target = accounts.find((account) => account.code === codeFor(methodSelect.value));
    if (target) {
      accountSelect.value = String(target.id);
      accountSelect.dispatchEvent(new Event('change'));
    }
  });
}

export function methodOptionsHtml(methods, selected = '') {
  return methods.map((method) => `<option ${method === selected ? 'selected' : ''}>${method}</option>`).join('');
}
