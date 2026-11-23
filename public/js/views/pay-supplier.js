import { api } from '../api.js';
import { bankChargesFieldHtml, bindBankCharges, readBankCharges } from '../bank-charges.js';
import { bindMethodAccount } from '../payment-methods.js';
import { particulars } from '../statement-lines.js';
import { centsToInput, currencySymbol, esc, fmtMoney, openModal, optionsHtml, todayISO, toast, toCents } from '../ui.js';
import { depositAccounts } from './job-modals.js';

// Pay supplier: one transfer for several bills, shared out oldest first
// (each share can be changed), with the bank charges on the transfer. The
// whole amount must go on bills.
const METHODS = ['Bank transfer', 'Cash', 'Credit card', 'Other'];

// The supplier's open bills, each named as on the supplier statement.
async function openBills(vendorId) {
  const [list, statement] = await Promise.all([
    api.get('/bills', { status: 'outstanding' }),
    api.get(`/vendors/${vendorId}/statement`),
  ]);
  const lines = new Map(statement.transactions.filter((row) => row.kind === 'bill').map((row) => [row.id, row]));
  return list
    .filter((bill) => bill.vendor_id === Number(vendorId) && bill.status === 'received' && bill.balance_cents > 0)
    .sort((a, b) => (a.due_date || a.bill_date).localeCompare(b.due_date || b.bill_date) || a.bill_date.localeCompare(b.bill_date) || a.id - b.id)
    .map((bill) => {
      const line = lines.get(bill.id);
      const what = line ? particulars(line, 'vendor').top.filter(Boolean).join(' · ') : '';
      return { ...bill, what };
    });
}

function billRowsHtml(bills) {
  if (!bills.length) return '<div class="muted" style="font-size:13px">No open bills for this supplier.</div>';
  return `<div class="table-wrap"><table class="data compact">
    <thead><tr><th scope="col">Bill</th><th scope="col" class="num">Due</th><th scope="col" class="num">This payment</th></tr></thead>
    <tbody>${bills.map((bill) => `
      <tr>
        <td><div class="cell-main">${esc(bill.number)}</div><div class="cell-sub">${esc(bill.what || bill.bill_date)}</div></td>
        <td class="num">${fmtMoney(bill.balance_cents)}</td>
        <td class="num" style="width:150px"><input class="input" type="number" min="0" step="0.01" inputmode="decimal"
          data-bill-share="${bill.id}" data-due="${bill.balance_cents}" data-dated="${esc(bill.bill_date)}" aria-label="Amount for ${esc(bill.number)}"></td>
      </tr>`).join('')}</tbody>
  </table></div>`;
}

// vendor: { id, name } when opened from a supplier; without it, a supplier
// list comes first.
export async function openPaySupplier({ vendor = null, onDone = () => {} } = {}) {
  const vendors = vendor ? [] : (await api.get('/vendors')).filter((row) => row.outstanding_cents > 0);
  if (!vendor && !vendors.length) {
    toast('No supplier has an open bill');
    return;
  }
  const { accounts, preferred } = depositAccounts();
  let bills = vendor ? await openBills(vendor.id) : [];
  openModal({
    title: vendor ? `Pay ${vendor.name}` : 'Pay supplier',
    size: 'modal-md',
    body: `<div class="form-grid">
      ${vendor ? '' : `<div class="field full"><label for="ps-vendor">Supplier</label>
        <select class="input" id="ps-vendor" required>${optionsHtml(vendors, { placeholder: 'Choose a supplier…', labelKey: (v) => `${v.name} · ${fmtMoney(v.outstanding_cents)} payable` })}</select></div>`}
      <div class="field">
        <label for="ps-amount">Amount paid</label>
        <div class="money-input"><span>${esc(currencySymbol())}</span><input class="input" id="ps-amount" type="number" min="0.01" step="0.01" required></div>
      </div>
      <div class="field"><label for="ps-date">Payment date</label><input class="input" id="ps-date" type="date" value="${todayISO()}" max="${todayISO()}" required></div>
      <div class="field"><label for="ps-method">Method</label><select class="input" id="ps-method">${METHODS.map((m) => `<option>${m}</option>`).join('')}</select></div>
      <div class="field"><label for="ps-account">Paid from</label><select class="input" id="ps-account">${optionsHtml(accounts, { selected: preferred?.id, labelKey: (a) => `${a.code} · ${a.name}` })}</select></div>
      <div class="field"><label for="ps-ref">Reference</label><input class="input" id="ps-ref" autocomplete="off" placeholder="Transfer number"></div>
      ${bankChargesFieldHtml('paid')}
      <div class="field full">
        <label>Pays these bills</label>
        <div data-ps-bills>${vendor ? billRowsHtml(bills) : ''}</div>
      </div>
    </div>`,
    submitLabel: 'Pay supplier',
    onMount(overlay) {
      bindMethodAccount(overlay.querySelector('#ps-method'), overlay.querySelector('#ps-account'), accounts);
      bindBankCharges(overlay, overlay.querySelector('#ps-method'), overlay.querySelector('#ps-account'));
      const amountInput = overlay.querySelector('#ps-amount');
      const dateInput = overlay.querySelector('#ps-date');
      const shareInputs = () => [...overlay.querySelectorAll('[data-bill-share]')];
      // Oldest first, never more than a bill owes; bills dated after the payment take nothing.
      const shareOut = () => {
        let rest = toCents(amountInput.value || 0);
        for (const input of shareInputs()) {
          const usable = input.dataset.dated <= dateInput.value;
          input.disabled = !usable;
          const share = usable ? Math.max(0, Math.min(rest, Number(input.dataset.due))) : 0;
          input.value = share ? centsToInput(share) : '';
          rest -= share;
        }
      };
      amountInput.addEventListener('input', shareOut);
      dateInput.addEventListener('change', shareOut);
      overlay.querySelector('#ps-vendor')?.addEventListener('change', async (event) => {
        bills = event.target.value ? await openBills(event.target.value) : [];
        overlay.querySelector('[data-ps-bills]').innerHTML = billRowsHtml(bills);
        shareOut();
      });
    },
    async onSubmit(form) {
      const vendorId = vendor ? vendor.id : Number(form.querySelector('#ps-vendor').value);
      if (!vendorId) throw new Error('Choose a supplier');
      const amount = toCents(form.querySelector('#ps-amount').value);
      if (amount <= 0) throw new Error('Enter the amount paid');
      const allocations = [...form.querySelectorAll('[data-bill-share]')]
        .map((input) => ({ bill_id: Number(input.dataset.billShare), amount_cents: toCents(input.value || 0) }))
        .filter((row) => row.amount_cents > 0);
      const shared = allocations.reduce((sum, row) => sum + row.amount_cents, 0);
      if (shared !== amount) throw new Error(shared < amount ? `${fmtMoney(amount - shared)} is not on a bill. Put it on a bill, or pay less.` : 'The bill amounts add up to more than the amount paid');
      const payment = await api.post('/bills/supplier-payments', {
        vendor_id: vendorId,
        amount_cents: amount,
        payment_date: form.querySelector('#ps-date').value,
        method: form.querySelector('#ps-method').value,
        payment_account_id: Number(form.querySelector('#ps-account').value),
        reference: form.querySelector('#ps-ref').value,
        bank_charges_cents: readBankCharges(form),
        allocations,
      });
      toast(`${payment.number} paid · ${payment.bills.length} bill${payment.bills.length === 1 ? '' : 's'}`);
      onDone(payment);
    },
  });
}
