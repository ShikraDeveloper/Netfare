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

export function methodOptionsHtml(methods, selected = '') {
  return methods.map((method) => `<option ${method === selected ? 'selected' : ''}>${method}</option>`).join('');
}
