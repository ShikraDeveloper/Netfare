import { api } from '../api.js';
import { centsToInput, currencySymbol, esc, fmtDate, fmtMoney, openModal, optionsHtml, todayISO, toast, toCents, voidDialog } from '../ui.js';
import { depositAccounts } from './job-modals.js';
import { bindMethodAccount } from '../payment-methods.js';
import { bankChargesFieldHtml, bindBankCharges, readBankCharges } from '../bank-charges.js';

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
    body: `<div class="form-grid">
      <div class="field">
        <label for="ca-amount">Amount</label>
        <div class="money-input"><span>${esc(currencySymbol())}</span><input class="input" id="ca-amount" type="number" min="0.01" step="0.01" required></div>
      </div>
      <div class="field"><label for="ca-date">Date received</label><input class="input" id="ca-date" type="date" value="${todayISO()}" required></div>
      <div class="field"><label for="ca-method">Method</label><select class="input" id="ca-method">${METHODS.map((m) => `<option>${m}</option>`).join('')}</select></div>
      <div class="field"><label for="ca-account">Received into</label><select class="input" id="ca-account">${accountOptions('1010')}</select></div>
      <div class="field full"><label for="ca-ref">Reference</label><input class="input" id="ca-ref" autocomplete="off" placeholder="Optional"></div>
    </div>`,
    submitLabel: 'Record advance',
    onMount(overlay) {
      bindMethodAccount(overlay.querySelector('#ca-method'), overlay.querySelector('#ca-account'), depositAccounts().accounts);
    },
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

// One payment for several invoices (two visas paid together, say): one receipt
// and one bank entry, shared out oldest invoice first. The shares can be
// changed; anything not shared stays as the customer's advance.
export function openReceivePayment(customer, invoices, onDone) {
  const rows = invoices.map((invoice) => {
    const about = [invoice.visa_number ? `Visa ${invoice.visa_number}` : '', invoice.applicant_name, invoice.booking_number ? `Booking ${invoice.booking_number}` : '']
      .filter(Boolean).join(' · ');
    return `
      <tr>
        <td><div class="cell-main">${esc(invoice.number)}</div><div class="cell-sub">${esc(about || invoice.issue_date)}</div></td>
        <td class="num">${fmtMoney(invoice.balance_cents)}</td>
        <td class="num" style="width:150px">
          <input class="input" type="number" min="0" step="0.01" inputmode="decimal" data-share="${invoice.id}"
            data-due="${invoice.balance_cents}" data-issued="${esc(invoice.issue_date)}" aria-label="Amount for ${esc(invoice.number)}">
        </td>
      </tr>`;
  }).join('');
  openModal({
    title: 'Receive payment',
    size: 'modal-md',
    body: `<div class="form-grid">
      <div class="field">
        <label for="rp-amount">Amount received</label>
        <div class="money-input"><span>${esc(currencySymbol())}</span><input class="input" id="rp-amount" type="number" min="0.01" step="0.01" required></div>
      </div>
      <div class="field"><label for="rp-date">Date received</label><input class="input" id="rp-date" type="date" value="${todayISO()}" required></div>
      <div class="field"><label for="rp-method">Method</label><select class="input" id="rp-method">${METHODS.map((m) => `<option>${m}</option>`).join('')}</select></div>
      <div class="field"><label for="rp-account">Received into</label><select class="input" id="rp-account">${accountOptions('1010')}</select></div>
      <div class="field full"><label for="rp-ref">Reference</label><input class="input" id="rp-ref" autocomplete="off" placeholder="Optional"></div>
      ${bankChargesFieldHtml('received')}
      <div class="field full">
        <label>Pays these invoices</label>
        ${invoices.length ? `
          <div class="table-wrap"><table class="data compact">
            <thead><tr><th scope="col">Invoice</th><th scope="col" class="num">Due</th><th scope="col" class="num">This payment</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>` : '<div class="muted" style="font-size:13px">No unpaid invoices: kept as an advance.</div>'}
        <div class="hint" id="rp-left" aria-live="polite"></div>
      </div>
    </div>`,
    submitLabel: 'Record payment',
    onMount(overlay) {
      bindMethodAccount(overlay.querySelector('#rp-method'), overlay.querySelector('#rp-account'), depositAccounts().accounts);
      bindBankCharges(overlay, overlay.querySelector('#rp-method'), overlay.querySelector('#rp-account'));
      const amountInput = overlay.querySelector('#rp-amount');
      const dateInput = overlay.querySelector('#rp-date');
      const shareInputs = [...overlay.querySelectorAll('[data-share]')];
      const left = overlay.querySelector('#rp-left');
      const sync = () => {
        const shared = shareInputs.reduce((sum, input) => sum + toCents(input.value || 0), 0);
        const rest = toCents(amountInput.value || 0) - shared;
        left.textContent = rest > 0
          ? `${fmtMoney(rest)} not used for an invoice: it stays as the customer's advance.`
          : rest < 0 ? `The invoice amounts are ${fmtMoney(-rest)} more than the amount received.` : '';
      };
      // Oldest first, never more than each invoice's balance. Invoices dated
      // after the payment cannot take a share.
      const shareOut = () => {
        let rest = toCents(amountInput.value || 0);
        for (const input of shareInputs) {
          const usable = input.dataset.issued <= dateInput.value;
          input.disabled = !usable;
          const share = usable ? Math.max(0, Math.min(rest, Number(input.dataset.due))) : 0;
          input.value = share ? centsToInput(share) : '';
          rest -= share;
        }
        sync();
      };
      amountInput.addEventListener('input', shareOut);
      dateInput.addEventListener('change', shareOut);
      shareInputs.forEach((input) => input.addEventListener('input', sync));
    },
    async onSubmit(form) {
      const amount = toCents(form.querySelector('#rp-amount').value);
      if (amount <= 0) throw new Error('Enter the amount received');
      const allocations = [...form.querySelectorAll('[data-share]')]
        .map((input) => ({ invoice_id: Number(input.dataset.share), amount_cents: toCents(input.value || 0) }))
        .filter((row) => row.amount_cents > 0);
      if (allocations.reduce((sum, row) => sum + row.amount_cents, 0) > amount) {
        throw new Error('The invoice amounts add up to more than the amount received');
      }
      const receipt = await api.post('/advances/receipts', {
        customer_id: customer.id,
        amount_cents: amount,
        receipt_date: form.querySelector('#rp-date').value,
        method: form.querySelector('#rp-method').value,
        deposit_account_id: Number(form.querySelector('#rp-account').value),
        reference: form.querySelector('#rp-ref').value,
        bank_charges_cents: readBankCharges(form),
        allocations,
      });
      toast(`Receipt ${receipt.number} recorded · ${receipt.invoices.length} invoice${receipt.invoices.length === 1 ? '' : 's'} paid`);
      onDone(receipt);
    },
  });
}

// Void (admin only): reverses the advance and everything it paid for.
export async function voidAdvance(advance, onDone) {
  const result = await voidDialog({
    title: `Void ${advance.number}?`,
    message: 'The advance will be reversed. Any refunds or invoice applications funded by this advance will also be reversed.',
    warning: 'This cannot be undone. The advance stays in history as void and the reversal is written to the audit log.',
    preview: {
      heading: 'Void preview',
      items: [
        { label: `Advance ${advance.number}`, value: fmtMoney(advance.amount_cents), note: `${fmtDate(advance.advance_date)} · ${advance.method || 'Advance'}` },
        { label: 'Applied to invoices', value: fmtMoney(advance.applied_cents), note: 'Invoice applications will be reversed' },
        { label: 'Refunded to customer', value: fmtMoney(advance.refunded_cents), note: 'Advance refunds will be reversed' },
      ],
      note: 'The advance stays in history as void and the reversal is written to the audit log.',
    },
    confirmLabel: 'Void advance',
  });
  if (!result.confirmed) return;
  try {
    await api.post(`/advances/${advance.id}/void`, { remarks: result.remarks });
    toast('Advance voided with a reversing entry');
    onDone();
  } catch (error) {
    toast(error.message, 'error');
  }
}
