import { api } from '../api.js';
import { centsToInput, currencySymbol, esc, fmtMoney, openModal, optionsHtml, todayISO, toast, toCents } from '../ui.js';
import { depositAccounts } from './job-modals.js';

// Customer advances handled from the customer side: record money received
// before any booking or visa, then use it for an invoice or refund it.

const METHODS = ['Bank transfer', 'Cash', 'Cheque', 'Credit card', 'Payment link', 'Other'];

function accountOptions(preferCode) {
  const { accounts, preferred } = depositAccounts();
  const chosen = accounts.find((account) => account.code === preferCode) || preferred;
  return optionsHtml(accounts, { selected: chosen?.id, placeholder: 'Choose account…', labelKey: (a) => `${a.code} · ${a.name}` });
}

export function openRecordAdvance(customer, onDone) {
  openModal({
    title: 'Record customer advance',
    subtitle: `${customer.name} · money received before an invoice`,
    body: `<div class="form-grid">
      <div class="field">
        <label for="ca-amount">Amount</label>
        <div class="money-input"><span>${esc(currencySymbol())}</span><input class="input" id="ca-amount" type="number" min="0.01" step="0.01" required></div>
      </div>
      <div class="field"><label for="ca-date">Date received</label><input class="input" id="ca-date" type="date" value="${todayISO()}" required></div>
      <div class="field"><label for="ca-method">Method</label><select class="input" id="ca-method">${METHODS.map((m) => `<option>${m}</option>`).join('')}</select></div>
      <div class="field"><label for="ca-account">Received into</label><select class="input" id="ca-account">${accountOptions('1010')}</select></div>
      <div class="field full"><label for="ca-ref">Reference</label><input class="input" id="ca-ref" autocomplete="off" placeholder="Optional"></div>
      <div class="field full"><div class="form-note">Held in <strong>2400 Contract Liabilities (Customer Advances)</strong> until it is used for an invoice or refunded. To tie it to a trip, record it on the booking or visa instead; it is then used for that invoice automatically.</div></div>
    </div>`,
    submitLabel: 'Record advance',
    async onSubmit(form) {
      const advance = await api.post('/advances', {
        customer_id: customer.id,
        amount_cents: toCents(form.querySelector('#ca-amount').value),
        advance_date: form.querySelector('#ca-date').value,
        method: form.querySelector('#ca-method').value,
        deposit_account_id: Number(form.querySelector('#ca-account').value),
        reference: form.querySelector('#ca-ref').value,
      });
      toast(`Advance ${advance.number} recorded`);
      onDone();
    },
  });
}

export async function openApplyAdvance(advance, customerId, onDone) {
  const invoices = (await api.get('/invoices', { status: 'outstanding' }))
    .filter((invoice) => invoice.customer_id === customerId && invoice.balance_cents > 0);
  if (!invoices.length) {
    toast('This customer has no unpaid invoice to use the advance for.', 'error');
    return;
  }
  openModal({
    title: `Use ${advance.number} for an invoice`,
    body: `<div class="form-grid">
      <div class="field full"><label for="ca-invoice">Invoice</label>
        <select class="input" id="ca-invoice">${invoices.map((invoice) => `<option value="${invoice.id}">${esc(invoice.number)} · ${esc(fmtMoney(invoice.balance_cents))} due</option>`).join('')}</select></div>
      <div class="field"><label for="ca-date">Date</label><input class="input" id="ca-date" type="date" value="${todayISO()}" required></div>
      <div class="field full"><div class="form-note">Uses up to ${esc(fmtMoney(advance.remaining_cents))}, never more than the invoice balance (Dr 2400 · Cr 1100).</div></div>
    </div>`,
    submitLabel: 'Use advance',
    async onSubmit(form) {
      const result = await api.post(`/advances/${advance.id}/apply`, {
        invoice_id: Number(form.querySelector('#ca-invoice').value),
        payment_date: form.querySelector('#ca-date').value,
      });
      toast(`${fmtMoney(result.applied_cents)} of ${advance.number} used`);
      onDone();
    },
  });
}

export function openRefundAdvance(advance, onDone) {
  openModal({
    title: `Refund ${advance.number}`,
    body: `<div class="form-grid">
      <div class="field">
        <label for="ca-amount">Refund amount</label>
        <div class="money-input"><span>${esc(currencySymbol())}</span><input class="input" id="ca-amount" type="number" min="0.01" step="0.01" value="${centsToInput(advance.remaining_cents)}" required></div>
        <div class="hint">Remaining ${esc(fmtMoney(advance.remaining_cents))}</div>
      </div>
      <div class="field"><label for="ca-date">Refund date</label><input class="input" id="ca-date" type="date" value="${todayISO()}" required></div>
      <div class="field"><label for="ca-method">Method</label><select class="input" id="ca-method">${METHODS.map((m) => `<option>${m}</option>`).join('')}</select></div>
      <div class="field"><label for="ca-account">Paid from</label><select class="input" id="ca-account">${accountOptions('1010')}</select></div>
    </div>`,
    submitLabel: 'Refund advance',
    async onSubmit(form) {
      await api.post(`/advances/${advance.id}/refund`, {
        amount_cents: toCents(form.querySelector('#ca-amount').value),
        refund_date: form.querySelector('#ca-date').value,
        method: form.querySelector('#ca-method').value,
        payment_account_id: Number(form.querySelector('#ca-account').value),
      });
      toast(`${advance.number} refunded`);
      onDone();
    },
  });
}
