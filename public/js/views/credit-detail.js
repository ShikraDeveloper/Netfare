import { api } from '../api.js';
import { attachmentSection, bindAttachmentSection, loadAttachments } from '../attachments.js';
import { cashAccounts } from '../store.js';
import {
  centsToInput,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  openModal,
  optionsHtml,
  setHeader,
  statusBadge,
  toast,
  todayISO,
  toCents,
  voidDialog,
} from '../ui.js';

export async function render(container, { params = [] } = {}) {
  const id = Number(params[0]);
  const credit = await api.get(`/credits/${id}`);
  const attachments = await loadAttachments('credit_note', id);
  const issued = credit.status === 'issued';
  const canApply = issued && credit.remaining_cents > 0;
  const canRefund = canApply;
  const canVoid = issued;
  const isCancellation = Boolean(credit.cancellation_id);

  setHeader({
    title: credit.number,
    subtitle: `${credit.customer_name} · ${fmtDate(credit.credit_date, { long: true })}`,
    actions: `
      <a class="btn btn-ghost" href="#/audit-chain/credit/${id}">${icon('shield', 15)}<span>Audit chain</span></a>
      <a class="btn btn-ghost" href="#/credits"><span>All credit notes</span></a>
      ${isCancellation ? `<a class="btn btn-secondary" href="#/cancellations/${credit.cancellation_id}">${icon('x', 15)}<span>Cancellation</span></a>` : ''}
      ${canRefund ? `<button class="btn btn-secondary" data-action="refund-credit">${icon('arrowUp', 15)}<span>Refund credit</span></button>` : ''}
      ${canApply ? `<button class="btn btn-primary" data-action="apply-credit">${icon('invoice', 15)}<span>Apply to invoice</span></button>` : ''}
      ${canVoid ? `<button class="icon-btn danger" data-action="void-credit" title="Void credit note">${icon('trash', 17)}</button>` : ''}
    `,
  });

  const applications = credit.applications || [];
  const refunds = credit.refunds || [];
  const activeRefunds = refunds.filter((refund) => refund.status === 'paid');
  const refundedCents = activeRefunds.reduce((sum, refund) => sum + refund.amount_cents, 0);
  container.innerHTML = `
    <div class="credit-summary">
      <div><span>Credit amount</span><strong>${fmtMoney(credit.amount_cents)}</strong></div>
      <div><span>Applied</span><strong>${fmtMoney(credit.applied_cents)}</strong></div>
      <div><span>Refunded</span><strong>${fmtMoney(refundedCents)}</strong></div>
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

    <div class="card" style="margin-top:16px" data-applications-card>
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
        message: canApply ? 'Apply this credit to an open invoice, refund it in cash, or leave it on the customer account.' : 'This credit has no invoice applications.',
      })}</div>`}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div class="card-title"><h2>Cash refunds</h2><p>${refunds.length ? `${fmtMoney(refundedCents)} paid back to the customer` : 'No cash has been refunded from this credit'}</p></div>
        ${canRefund ? `<button class="btn btn-secondary btn-sm" data-action="refund-credit">${icon('arrowUp', 14)} Refund</button>` : ''}
      </div>
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Cash refunds of this customer credit</caption>
          <thead><tr><th scope="col">Refund</th><th scope="col">Date</th><th scope="col">Account</th><th scope="col" class="num">Amount</th><th scope="col">Status</th></tr></thead>
          <tbody>
            ${refunds.length ? refunds.map((refund) => `
              <tr>
                <td><a href="#/refunds/${refund.id}">${esc(refund.number)}</a></td>
                <td class="nowrap">${esc(fmtDate(refund.refund_date))}</td>
                <td>${esc(refund.method || '—')} · ${esc(refund.account_name || '')}</td>
                <td class="num">${fmtMoney(refund.amount_cents)}</td>
                <td>${statusBadge(refund.status)}</td>
              </tr>
            `).join('') : '<tr><td colspan="5" class="muted">No cash refund has been paid.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    ${attachmentSection({ entityType: 'credit_note', entityId: id, attachments, hint: 'Credit note PDF or the customer approval' })}
  `;
  bindAttachmentSection(container, { entityType: 'credit_note', entityId: id });

  const apply = async () => {
    try {
      await openApplyModal(credit, () => render(container, { params: [String(id)] }));
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  document.querySelectorAll('[data-action="apply-credit"]').forEach((button) => button.addEventListener('click', apply));
  document.querySelectorAll('[data-action="refund-credit"]').forEach((button) => button.addEventListener('click', () => {
    openRefundModal(credit, () => render(container, { params: [String(id)] }));
  }));

  const voidButton = document.querySelector('[data-action="void-credit"]');
  if (voidButton) {
    voidButton.addEventListener('click', async () => {
      const result = await voidDialog({
        title: `Void ${credit.number}?`,
        message: 'A reversing journal entry will be posted and any invoice applications and cash refunds will be reversed automatically.',
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
            ...(activeRefunds.length ? [{
              label: `${activeRefunds.length} cash refund${activeRefunds.length === 1 ? '' : 's'}`,
              value: fmtMoney(refundedCents),
              note: 'Cash refunds will be reversed',
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

  const applicationsCard = container.querySelector('[data-applications-card]');
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

function openRefundModal(credit, onSaved) {
  const accounts = cashAccounts().sort((a, b) => (b.is_cash - a.is_cash) || a.code.localeCompare(b.code));
  if (!accounts.length) {
    toast('Add an active bank or cash account before refunding a customer credit.', 'error');
    return;
  }
  const preferred = accounts.find((account) => account.code === '1010') || accounts[0];
  openModal({
    title: `Cash refund of ${credit.number}`,
    subtitle: `${credit.customer_name} · ${fmtMoney(credit.remaining_cents)} available`,
    submitLabel: 'Record refund',
    body: `
      <div class="form-grid">
        <div class="field">
          <label for="cn-refund-amount">Amount paid</label>
          <div class="money-input"><span>AED</span>
            <input class="input" id="cn-refund-amount" name="amount" type="number" min="0.01" step="0.01"
              max="${centsToInput(credit.remaining_cents)}" value="${centsToInput(credit.remaining_cents)}" required inputmode="decimal">
          </div>
          <div class="hint">Available ${fmtMoney(credit.remaining_cents)}</div>
        </div>
        <div class="field">
          <label for="cn-refund-date">Refund date</label>
          <input class="input" id="cn-refund-date" name="refund_date" type="date" value="${todayISO()}" required>
        </div>
        <div class="field">
          <label for="cn-refund-method">Method</label>
          <select class="input" id="cn-refund-method" name="method">
            ${['Bank transfer', 'Cash', 'Cheque', 'Other'].map((method) => `<option>${method}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="cn-refund-reference">Reference</label>
          <input class="input" id="cn-refund-reference" name="reference" placeholder="Transfer or receipt reference">
        </div>
        <div class="field full">
          <label for="cn-refund-account">Pay from</label>
          <select class="input" id="cn-refund-account" name="account_id" required>
            ${optionsHtml(accounts, { selected: preferred.id, placeholder: 'Choose bank or cash account…', labelKey: (account) => `${account.code} · ${account.name}` })}
          </select>
        </div>
        <div class="field full">
          <div class="form-note">This debits 2450 Customer Credits and credits the bank or cash account. Revenue is not changed again.</div>
        </div>
      </div>
    `,
    async onSubmit(form) {
      const values = new FormData(form);
      const amount = toCents(values.get('amount'));
      if (amount <= 0) throw new Error('Enter an amount');
      const saved = await api.post(`/credits/${credit.id}/refund`, {
        amount_cents: amount,
        refund_date: values.get('refund_date'),
        method: values.get('method'),
        reference: values.get('reference'),
        account_id: Number(values.get('account_id')),
      });
      toast(`Refund of ${fmtMoney(amount)} recorded · ${fmtMoney(saved.remaining_cents)} credit left`);
      onSaved(saved);
    },
  });
}
