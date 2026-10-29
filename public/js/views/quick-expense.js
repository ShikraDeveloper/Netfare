import { api } from '../api.js';
import { activeVendors, purchaseAccounts } from '../store.js';
import { currencySymbol, esc, openModal, optionsHtml, todayISO, toast, toCents } from '../ui.js';
import { depositAccounts } from './job-modals.js';

// Quick expense (paid now): one form for a small expense already paid, such as
// a taxi, tea or printer paper. It saves a bill and its payment together.

const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;

export function openQuickExpenseModal({ onSaved = () => {}, paidFromCode = '1000' } = {}) {
  const accounts = purchaseAccounts();
  const preferredAccount = accounts.find((account) => account.code === '6900') || accounts[0];
  const { accounts: payFrom } = depositAccounts();
  const cash = payFrom.find((account) => account.code === paidFromCode) || payFrom[0];

  return openModal({
    title: 'Quick expense',
    subtitle: 'For a small expense you have already paid. It is saved as a paid bill in one step.',
    body: `
      <div class="form-grid">
        <div class="field full">
          <label for="qe-description">What was it for</label>
          <input class="input" id="qe-description" maxlength="300" required placeholder="e.g. Taxi to embassy, office tea, printer paper" autocomplete="off">
        </div>
        <div class="field">
          <label for="qe-amount">Amount</label>
          <div class="money-input"><span>${esc(currencySymbol())}</span>
            <input class="input" id="qe-amount" type="number" min="0.01" step="0.01" inputmode="decimal" required placeholder="0.00">
          </div>
        </div>
        <div class="field">
          <label for="qe-date">Date paid</label>
          <input class="input" id="qe-date" type="date" value="${esc(todayISO())}" required>
        </div>
        <div class="field">
          <label for="qe-account">Expense account</label>
          <select class="input" id="qe-account" required>
            ${optionsHtml(accounts, { selected: preferredAccount?.id, placeholder: 'Choose account…', labelKey: (account) => `${account.code} · ${account.name}` })}
          </select>
        </div>
        <div class="field">
          <label for="qe-paid-from">Paid from</label>
          <select class="input" id="qe-paid-from" required>
            ${optionsHtml(payFrom, { selected: cash?.id, placeholder: 'Choose account…', labelKey: (account) => `${account.code} · ${account.name}` })}
          </select>
        </div>
        <div class="field">
          <label for="qe-method">Method</label>
          <select class="input" id="qe-method">
            ${['Cash', 'Credit card', 'Bank transfer', 'Cheque', 'Other'].map((method) => `<option>${method}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="qe-vendor">Supplier <span class="muted">(optional)</span></label>
          <select class="input" id="qe-vendor">
            ${optionsHtml(activeVendors(), { placeholder: 'No supplier (sundry)' })}
          </select>
        </div>
        <div class="field" data-qe-cheque hidden>
          <label for="qe-cheque">Cheque number</label>
          <input class="input" id="qe-cheque" autocomplete="off">
        </div>
        <div class="field">
          <label for="qe-reference">Receipt no. <span class="muted">(optional)</span></label>
          <input class="input" id="qe-reference" autocomplete="off">
        </div>
        <div class="field full">
          <label for="qe-receipt">Receipt photo or PDF <span class="muted">(optional)</span></label>
          <input class="input" id="qe-receipt" type="file" accept="image/*,application/pdf">
        </div>
        <div class="field full"><div class="form-note">Posts the expense and the payment on the same date (Dr expense · Cr cash or bank). For a supplier you will pay later, use <strong>New bill</strong>.</div></div>
      </div>`,
    submitLabel: 'Save expense',
    onMount(overlay) {
      const method = overlay.querySelector('#qe-method');
      const cheque = overlay.querySelector('[data-qe-cheque]');
      method.addEventListener('change', () => { cheque.hidden = method.value !== 'Cheque'; });
    },
    async onSubmit(form) {
      const file = form.querySelector('#qe-receipt').files?.[0];
      if (file && file.size > MAX_RECEIPT_BYTES) throw new Error('The receipt must be 15 MB or smaller');
      const bill = await api.post('/bills/quick-expense', {
        description: form.querySelector('#qe-description').value,
        amount_cents: toCents(form.querySelector('#qe-amount').value),
        expense_date: form.querySelector('#qe-date').value,
        account_id: Number(form.querySelector('#qe-account').value),
        payment_account_id: Number(form.querySelector('#qe-paid-from').value),
        method: form.querySelector('#qe-method').value,
        vendor_id: Number(form.querySelector('#qe-vendor').value) || null,
        cheque_number: form.querySelector('#qe-cheque').value,
        reference: form.querySelector('#qe-reference').value,
      });
      if (file) {
        const query = new URLSearchParams({
          entity_type: 'bill', entity_id: String(bill.id), filename: file.name, type: file.type || 'application/octet-stream',
        });
        const response = await fetch(`/api/attachments?${query}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        });
        if (!response.ok) toast('The expense is saved, but the receipt could not be attached. Add it on the bill page.', 'error');
      }
      toast(`Expense ${bill.number} saved and paid`);
      onSaved(bill);
    },
  });
}
