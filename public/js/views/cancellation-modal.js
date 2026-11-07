import { api } from '../api.js';
import {
  centsToInput,
  esc,
  fmtMoney,
  openModal,
  todayISO,
  toast,
  toCents,
} from '../ui.js';

function billCreditRow(bill) {
  const available = Number(bill.supplier_credit_available_cents ?? bill.total_cents) || 0;
  return `
    <div class="form-note" style="margin-bottom:10px" data-bill-row="${bill.id}" data-available="${available}">
      <div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:6px">
        <strong>${esc(bill.number)} · ${esc(bill.vendor_name)}</strong>
        <span class="muted">${fmtMoney(bill.total_cents)}${bill.portal_name ? ` · ${esc(bill.portal_name)}` : ''}</span>
      </div>
      <div class="form-grid" style="margin-top:6px">
        <div class="field full">
          <label for="cancel-credit-${bill.id}">Supplier credit · up to ${fmtMoney(available)}</label>
          <div class="money-input">
            <span>AED</span>
            <input class="input" id="cancel-credit-${bill.id}" name="credit_${bill.id}" type="number"
              min="0" max="${centsToInput(available)}" step="0.01"
              value="0.00" data-credit-input="${bill.id}" inputmode="decimal">
          </div>
        </div>
      </div>
    </div>
  `;
}

export function cancellationModalBody(job) {
  const bills = (job.bills || []).filter((bill) => bill.status === 'received');
  return `
    <div class="form-grid">
      <div class="field">
        <label for="cancel-date">Cancellation date</label>
        <input class="input" id="cancel-date" name="cancellation_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label for="cancel-charges">Cancellation charges to customer</label>
        <div class="money-input">
          <span>AED</span>
          <input class="input" id="cancel-charges" name="customer_charges" type="number" min="0" step="0.01"
            value="0.00" data-charges inputmode="decimal">
        </div>
      </div>
      <div class="field full">
        <label for="cancel-reason">Reason</label>
        <input class="input" id="cancel-reason" name="reason" maxlength="500" placeholder="e.g. Customer cancelled travel">
      </div>
      <div class="field full">
        <label for="cancel-notes">Notes</label>
        <textarea class="input" id="cancel-notes" name="notes" rows="2" maxlength="2000" placeholder="Internal notes for the cancellation note"></textarea>
      </div>
      <div class="field full">
        <div class="form-note">
          <strong>This cannot be undone.</strong> For a mistake, void instead.
        </div>
      </div>
      <div class="field full">
        <label>Supplier bills</label>
        ${bills.length
    ? `${bills.map(billCreditRow).join('')}
`
    : '<div class="muted">No supplier bills to credit.</div>'}
      </div>
      <div class="field full">
        <div class="form-note" data-cancel-summary>
          <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 16px;margin-bottom:8px">
            <span>Money held from customer</span><strong data-summary-received>${fmtMoney(0)}</strong>
            <span>Cancellation charges</span><strong data-summary-charges>${fmtMoney(0)}</strong>
            <span>Refund due to customer</span><strong data-summary-refund>${fmtMoney(0)}</strong>
            <span>Cancellation invoice (shortfall)</span><strong data-summary-shortfall>${fmtMoney(0)}</strong>
            <span>Supplier credits</span><strong data-summary-credits>${fmtMoney(0)}</strong>
            <span>Retained supplier cost</span><strong data-summary-retained>${fmtMoney(0)}</strong>
          </div>
          <div class="hint" data-summary-note></div>
        </div>
      </div>
    </div>
  `;
}

export function openCancellationModal({ job, sourceType, action = 'cancel', onDone = null }) {
  if (!['booking', 'visa'].includes(sourceType)) throw new Error('Cancellation source must be a booking or visa');
  if (!['cancel', 'reject'].includes(action)) throw new Error('Cancellation action must be cancel or reject');
  const endpoint = sourceType === 'booking'
    ? `/bookings/${job.id}/cancel`
    : `/visas/${job.id}/${action}`;
  const isReject = action === 'reject';
  const title = isReject ? 'Reject visa application' : (sourceType === 'booking' ? 'Cancel booking' : 'Cancel visa application');
  const submitLabel = isReject ? 'Reject application' : 'Record cancellation';

  return openModal({
    title,
    size: 'modal-lg',
    body: cancellationModalBody(job),
    submitLabel,
    danger: true,
    onMount(overlay) {
      const charges = overlay.querySelector('[data-charges]');
      const creditInputs = [...overlay.querySelectorAll('[data-credit-input]')];
      const summaryReceived = overlay.querySelector('[data-summary-received]');
      const summaryCharges = overlay.querySelector('[data-summary-charges]');
      const summaryRefund = overlay.querySelector('[data-summary-refund]');
      const summaryShortfall = overlay.querySelector('[data-summary-shortfall]');
      const summaryCredits = overlay.querySelector('[data-summary-credits]');
      const summaryRetained = overlay.querySelector('[data-summary-retained]');
      const summaryNote = overlay.querySelector('[data-summary-note]');
      const hasPostedInvoice = Boolean(job.invoice);
      const receivedCents = hasPostedInvoice ? Number(job.invoice.amount_paid_cents || 0) : 0;
      const availableSupplierCost = (job.bills || [])
        .filter((bill) => bill.status === 'received')
        .reduce((sum, bill) => sum + Number(bill.supplier_credit_available_cents ?? bill.total_cents ?? 0), 0);

      function syncSummary() {
        const chargeCents = toCents(charges?.value || 0);
        const creditCents = creditInputs.reduce((sum, input) => sum + toCents(input.value || 0), 0);
        const refundDue = hasPostedInvoice ? Math.max(0, receivedCents - chargeCents) : 0;
        const shortfall = hasPostedInvoice ? Math.max(0, chargeCents - receivedCents) : 0;
        const retainedCost = Math.max(0, availableSupplierCost - creditCents);
        if (summaryReceived) summaryReceived.textContent = fmtMoney(receivedCents);
        if (summaryCharges) summaryCharges.textContent = fmtMoney(chargeCents);
        if (summaryRefund) summaryRefund.textContent = fmtMoney(refundDue);
        if (summaryShortfall) summaryShortfall.textContent = fmtMoney(shortfall);
        if (summaryCredits) summaryCredits.textContent = fmtMoney(creditCents);
        if (summaryRetained) summaryRetained.textContent = fmtMoney(retainedCost);
        if (summaryNote) {
          if (!hasPostedInvoice) {
            summaryNote.textContent = 'Draft job: nothing has been posted to the ledger. Cancelling will only change the job status.';
          } else if (shortfall > 0) {
            summaryNote.textContent = `Charges exceed money held by ${fmtMoney(shortfall)}. A cancellation invoice will be issued for the shortfall.`;
          } else if (refundDue > 0) {
            summaryNote.textContent = 'Refund due will be held in 2500 Refund Liabilities. You can pay it or convert it to customer credit after posting.';
          } else {
            summaryNote.textContent = 'No customer refund is due.';
          }
          if (creditCents > 0) {
            summaryNote.textContent += ' Supplier credits will be created in 1450 Supplier Credits.';
          }
        }
      }

      charges?.addEventListener('input', syncSummary);
      creditInputs.forEach((input) => {
        input.addEventListener('input', () => {
          const max = Number(input.closest('[data-bill-row]')?.dataset.available || 0);
          const value = toCents(input.value || 0);
          if (value > max) {
            input.value = centsToInput(max);
            toast('Supplier credit cannot exceed the available bill amount', 'error');
          }
          syncSummary();
        });
        input.addEventListener('change', syncSummary);
      });
      syncSummary();
    },
    async onSubmit(form) {
      const values = new FormData(form);
      const supplierCredits = [];
      form.querySelectorAll('[data-credit-input]').forEach((input) => {
        const amount = toCents(input.value || 0);
        if (amount > 0) {
          supplierCredits.push({ bill_id: Number(input.dataset.creditInput), amount_cents: amount });
        }
      });
      const saved = await api.post(endpoint, {
        cancellation_date: values.get('cancellation_date'),
        customer_charges_cents: toCents(values.get('customer_charges')),
        supplier_credits: supplierCredits,
        reason: values.get('reason'),
        notes: values.get('notes'),
      });
      if (saved?.cancellation) {
        const cancellation = saved.cancellation;
        toast(cancellation.refund_remaining_cents > 0
          ? `${cancellation.number} recorded · ${fmtMoney(cancellation.refund_remaining_cents)} refundable to the customer`
          : `${cancellation.number} recorded`);
      } else {
        toast('Draft cancelled');
      }
      if (onDone) await onDone(saved);
    },
  });
}
