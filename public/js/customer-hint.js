import { store } from './store.js';
import { addDaysISO } from './ui.js';

const customerById = (id) => store.customers.find((row) => String(row.id) === String(id));
const daysLabel = (days) => (Number(days) === 0 ? 'Due now' : `Pays in ${days} days`);

// One line under a customer picker: number, first address line and TRN (or
// phone), and their own payment days, so staff can see they picked the right one.
function customerLine(id) {
  const customer = customerById(id);
  if (!customer) return '';
  const place = String(customer.address || '').split('\n')[0].trim();
  return [customer.number, place, customer.trn ? `TRN ${customer.trn}` : customer.phone,
    customer.payment_days != null ? daysLabel(customer.payment_days) : ''].filter(Boolean).join(' · ');
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

// Days a customer has to pay: their own, else the usual terms in Settings.
export function customerDueDays(id) {
  const own = customerById(id)?.payment_days;
  return Number(own ?? store.settings?.payment_terms_days ?? 0);
}

export const dueDateFor = (date, customerId) => addDaysISO(date, customerDueDays(customerId));

// A new document's due date follows its date and customer until it is typed.
export function bindDueDate(customer, date, due) {
  let typed = false;
  due.addEventListener('change', () => { typed = true; });
  const follow = () => { if (!typed && date.value) due.value = dueDateFor(date.value, customer.value); };
  customer.addEventListener('change', follow);
  date.addEventListener('change', follow);
}
