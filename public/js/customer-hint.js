import { store } from './store.js';

// One line under a customer picker: number, first address line and TRN (or
// phone), so staff can see they picked the right one.
function customerLine(id) {
  const customer = store.customers.find((row) => String(row.id) === String(id));
  if (!customer) return '';
  const place = String(customer.address || '').split('\n')[0].trim();
  return [customer.number, place, customer.trn ? `TRN ${customer.trn}` : customer.phone].filter(Boolean).join(' · ');
}

export function bindCustomerHint(select) {
  const hint = document.createElement('div');
  hint.className = 'customer-hint';
  hint.dataset.customerHint = '';
  select.after(hint);
  const show = () => { hint.textContent = customerLine(select.value); };
  select.addEventListener('change', show);
  show();
}
