import { api } from '../api.js';
import {
  centsToInput,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  openModal,
  setHeader,
  toast,
  todayISO,
  toCents,
  voidDialog,
} from '../ui.js';

export async function render(container, { params = [] } = {}) {
  const id = Number(params[0]);
  const credit = await api.get(`/credits/${id}`);
  const issued = credit.status === 'issued';
  const canApply = issued && credit.remaining_cents > 0;
  const canVoid = issued;
  const isCancellation = Boolean(credit.cancellation_id);

  setHeader({
    title: credit.number,
    subtitle: `${credit.customer_name} · ${fmtDate(credit.credit_date, { long: true })}`,
    actions: `
      <a class="btn btn-ghost" href="#/credits"><span>All credit notes</span></a>
      ${isCancellation ? `<a class="btn btn-secondary" href="#/cancellations/${credit.cancellation_id}">${icon('x', 15)}<span>Cancellation</span></a>` : ''}
      ${canApply ? `<button class="btn btn-primary" data-action="apply-credit">${icon('invoice', 15)}<span>Apply to invoice</span></button>` : ''}
      ${canVoid ? `<button class="icon-btn danger" data-action="void-credit" title="Void credit note">${icon('trash', 17)}</button>` : ''}
    `,
  });

  const applications = credit.applications || [];
  container.innerHTML = `
    <div class="credit-summary">
      <div><span>Credit amount</span><strong>${fmtMoney(credit.amount_cents)}</strong></div>
      <div><span>Applied</span><strong>${fmtMoney(credit.applied_cents)}</strong></div>
      <div><span>Remaining</span><strong class="${credit.remaining_cents ? 'amount-due' : 'amount-ok'}">${fmtMoney(credit.remaining_cents)}</strong></div>
      <div><span>Status</span><strong><span class="badge badge-${issued ? 'issued' : 'void'}">${issued ? 'Issued' : 'Void'}</span></strong></div>
    </div>

    <div class="detail-grid">
      <div class="card">
        <div class="card-head"><div class="card-title"><h2>Customer</h2><p>Credit issued to</p></div></div>
        <div class="card-body">
          <div class="detail-list">
            <div><span>Name</span><strong>${esc(credit.customer_name)}</strong></div>
            <div><span>Email</span><strong>${esc(credit.customer_email || '—')}</strong></div>
            <div><span>Phone</span><strong>${esc(credit.customer_phone || '—')}</strong></div>
            <div><span>Address</span><strong>${esc(credit.customer_address || '—')}</strong></div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title"><h2>Ledger details</h2><p>Automatic postings</p></div>${credit.journal_entry_id ? `<a class="card-link" href="#/journal?focus=${credit.journal_entry_id}">Open ${icon('chevron', 12)}</a>` : ''}</div>
        <div class="card-body">
          <div class="detail-list">
            <div>
              <span>Source</span>
              <strong>${isCancellation
                ? `<a href="#/cancellations/${credit.cancellation_id}">Cancellation ${esc(credit.cancellation_number || '')}</a>`
                : '<span class="source source-standalone">Standalone credit</span>'}</strong>
            </div>
            ${isCancellation
              ? `<div><span>Accounting</span><strong>Liability transfer: 2500 Refund Payable → 2450 Customer Credits</strong></div>
                 <div><span>Reference account</span><strong>${esc(credit.revenue_account_code)} ${esc(credit.revenue_account_name)}</strong></div>`
              : `<div><span>Revenue account</span><strong>${esc(credit.revenue_account_code)} ${esc(credit.revenue_account_name)}</strong></div>
                 <div><span>Accounting</span><strong>Revenue reduction: Dr revenue / Cr 2450 Customer Credits</strong></div>`}
            <div><span>Credit date</span><strong>${esc(fmtDate(credit.credit_date))}</strong></div>
            <div><span>Credit account</span><strong>2450 Customer Credits</strong></div>
            <div><span>Notes</span><strong>${esc(credit.notes || '—')}</strong></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div class="card-title"><h2>Applications</h2><p>${applications.length ? `${fmtMoney(credit.applied_cents)} applied to invoices` : 'No invoices have used this credit yet'}</p></div>
        ${canApply ? `<button class="btn btn-secondary btn-sm" data-action="apply-credit">${icon('plus', 14)} Apply</button>` : ''}
      </div>
      ${applications.length ? `
        <div class="table-wrap">
          <table class="data"><caption class="sr-only">Credit note applications</caption>
            <thead><tr><th scope="col">Applied date</th><th scope="col">Invoice</th><th scope="col" class="num">Amount</th><th scope="col">Journal</th><th scope="col"></th></tr></thead>
            <tbody>
              ${applications.map((application) => `
                <tr>
                  <td class="nowrap">${esc(fmtDate(application.applied_date))}</td>
                  <td><a href="#/invoices/${application.invoice_id}">${esc(application.invoice_number)}</a></td>
                  <td class="num">${fmtMoney(application.amount_cents)}</td>
                  <td>${application.journal_entry_id ? `<a href="#/journal?focus=${application.journal_entry_id}">Entry #${application.journal_entry_id}</a>` : '—'}</td>
                  <td><button class="icon-btn danger" data-remove-application="${application.id}" title="Reverse application">${icon('trash', 15)}</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `<div class="card-body">${emptyState({
        iconName: 'invoice',
        title: 'Unapplied credit',
        message: canApply ? 'Apply this credit to an open invoice, or leave it on the customer account.' : 'This credit has no invoice applications.',
      })}</div>`}
    </div>
  `;

  const apply = async () => {
    try {
      await openApplyModal(credit, () => render(container, { params: [String(id)] }));
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  document.querySelectorAll('[data-action="apply-credit"]').forEach((button) => button.addEventListener('click', apply));

  const voidButton = document.querySelector('[data-action="void-credit"]');
  if (voidButton) {
    voidButton.addEventListener('click', async () => {
      const result = await voidDialog({
        title: `Void ${credit.number}?`,
        message: 'A reversing journal entry will be posted and any invoice applications will be reversed automatically.',
        warning: 'This cannot be undone. The credit note and every linked reversal are kept in the audit trail.',
        preview: {
          heading: 'Void preview',
          items: [
            {
              label: `Credit ${credit.number}`,
              value: fmtMoney(credit.amount_cents),
              note: `${credit.customer_name} · ${credit.remaining_cents > 0 ? `${fmtMoney(credit.remaining_cents)} unapplied` : 'Fully applied'}`,
            },
            ...(applications.length ? [{
              label: `${applications.length} invoice application${applications.length === 1 ? '' : 's'}`,
              value: fmtMoney(credit.applied_cents),
              note: 'Invoices will reopen by the applied amount',
            }] : []),
          ],
          note: 'The credit note and its reversals stay in the audit trail.',
        },
        confirmLabel: 'Void credit note',
      });
      if (!result.confirmed) return;
      try {
        await api.post(`/credits/${id}/void`, { remarks: result.remarks });
        toast(`${credit.number} voided`);
        render(container, { params: [String(id)] });
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  const applicationsCard = container.lastElementChild;
  if (applicationsCard) applicationsCard.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-application]');
    if (!button) return;
    const application = applications.find((row) => row.id === Number(button.dataset.removeApplication));
    const result = await voidDialog({
      title: 'Void this credit application?',
      message: `${fmtMoney(application.amount_cents)} will be removed from ${application.invoice_number} and returned to this credit note.`,
      warning: 'A reversing journal entry will be posted. This cannot be undone.',
      preview: {
        heading: 'Void preview',
        items: [
          {
            label: `Credit ${credit.number}`,
            value: fmtMoney(application.amount_cents),
            note: 'Returns to the unapplied credit balance',
          },
          {
            label: `Invoice ${application.invoice_number}`,
            value: fmtMoney(application.amount_cents),
            note: 'Invoice balance reopens by this amount',
          },
        ],
      },
      confirmLabel: 'Void application',
    });
    if (!result.confirmed) return;
    try {
      await api.post(`/credits/applications/${application.id}/void`, { remarks: result.remarks });
      toast('Credit application reversed');
      render(container, { params: [String(id)] });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

async function openApplyModal(credit, onSaved) {
  const invoices = (await api.get('/invoices', { status: 'outstanding' }))
    .filter((invoice) => invoice.customer_id === credit.customer_id && invoice.balance_cents > 0);
  if (!invoices.length) {
    toast('This customer has no open invoices to apply the credit to', 'error');
    return;
  }
  const maxAmount = Math.min(credit.remaining_cents, invoices[0].balance_cents);
  openModal({
    title: 'Apply customer credit',
    subtitle: `${credit.number} · ${fmtMoney(credit.remaining_cents)} remaining`,
    submitLabel: 'Apply credit',
    body: `
      <div class="form-grid">
        <div class="field full">
          <label for="apply-invoice">Invoice</label>
          <select class="input" id="apply-invoice" name="invoice_id" required>
            ${invoices.map((invoice) => `<option value="${invoice.id}" data-balance="${invoice.balance_cents}">${esc(invoice.number)} · ${fmtMoney(invoice.balance_cents)} due · ${esc(invoice.issue_date)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="apply-amount">Amount</label>
          <input class="input" id="apply-amount" name="amount" type="number" min="0.01" step="0.01" max="${centsToInput(maxAmount)}" inputmode="decimal" value="${centsToInput(maxAmount)}" required>
        </div>
        <div class="field">
          <label for="apply-date">Applied date</label>
          <input class="input" id="apply-date" name="applied_date" type="date" value="${todayISO()}" required>
        </div>
      </div>
    `,
    onMount(overlay) {
      const invoiceSelect = overlay.querySelector('#apply-invoice');
      const amountInput = overlay.querySelector('#apply-amount');
      invoiceSelect.addEventListener('change', () => {
        const option = invoiceSelect.selectedOptions[0];
        const invoiceBalance = Number(option?.dataset.balance || 0);
        amountInput.max = centsToInput(Math.min(credit.remaining_cents, invoiceBalance));
        amountInput.value = centsToInput(Math.min(credit.remaining_cents, invoiceBalance));
      });
    },
    async onSubmit(form) {
      const values = new FormData(form);
      const saved = await api.post(`/credits/${credit.id}/apply`, {
        invoice_id: Number(values.get('invoice_id')),
        amount_cents: toCents(values.get('amount')),
        applied_date: values.get('applied_date'),
      });
      toast(`Credit applied · ${fmtMoney(saved.remaining_cents)} remaining`);
      onSaved(saved);
    },
  });
}
