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

// The "paid by" filter on lists (invoices, bills, refunds): each choice and
// the stored methods it covers. Anything else counts as Other.
const PAID_BY = [
  ['cash', 'Cash', ['Cash']],
  ['card', 'Card', ['Credit card']],
  ['link', 'Payment link', ['Payment link']],
  ['bank', 'Bank transfer', ['Bank transfer', 'Bank debit']],
  ['cheque', 'Cheque', ['Cheque']],
  ['advance', 'Advance or credit', ['Advance applied', 'Deposit applied', 'Credit note', 'Supplier credit']],
  ['portal', 'Portal wallet', ['Portal wallet']],
];
const KNOWN = new Set(PAID_BY.flatMap(([, , methods]) => methods));

// `keys` picks the choices a list needs; "none" adds Not paid yet.
export function paidByHtml(id, ariaLabel, keys = ['cash', 'card', 'link', 'bank', 'cheque', 'advance', 'other', 'none']) {
  const options = keys.map((key) => {
    if (key === 'other') return '<option value="other">Other</option>';
    if (key === 'none') return '<option value="none">Not paid yet</option>';
    const [, label] = PAID_BY.find(([value]) => value === key);
    return `<option value="${key}">${label}</option>`;
  }).join('');
  return `<select class="input" id="${id}" aria-label="${ariaLabel}" style="max-width:190px"><option value="all">All payment methods</option>${options}</select>`;
}

// True when `methods` (how a document was paid) fits the chosen filter.
export function paidByMatches(methods = [], key = 'all') {
  if (key === 'all') return true;
  if (key === 'none') return !methods.length;
  if (key === 'other') return methods.some((method) => !KNOWN.has(method));
  const covered = PAID_BY.find(([value]) => value === key)?.[2] || [];
  return methods.some((method) => covered.includes(method));
}

// How much of `paidBy` ({ method: cents }) the chosen "paid by" filter covers.
export function paidByAmount(paidBy = {}, key = 'all') {
  return Object.entries(paidBy).reduce((sum, [method, cents]) => (key === 'all' || paidByMatches([method], key) ? sum + cents : sum), 0);
}
