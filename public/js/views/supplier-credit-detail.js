import { api } from '../api.js';
import { attachmentSection, bindAttachmentSection, loadAttachments } from '../attachments.js';
import { cashAccounts, store } from '../store.js';
import {
  centsToInput,
  companyMark,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  openModal,
  optionsHtml,
  setHeader,
  statusBadge,
  toast,
  toCents,
  todayISO,
  voidDialog,
  pageRecord
} from '../ui.js';

export async function render(container, { params } = {}) {
  const id = Number(params?.[0]);
  const credit = await api.get(`/supplier-credits/${id}`);
  const attachments = await loadAttachments('supplier_credit', id);
  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const issued = credit.status === 'issued';
  const canApply = issued && credit.remaining_cents > 0;
  const canVoid = issued;

  const sourceLink = credit.bill_id
    ? `<a href="#/bills/${credit.bill_id}">${esc(credit.bill_number)}</a>`
    : '<span class="muted">Standalone supplier credit</span>';
  const contextLink = credit.cancellation_id
    ? `<a href="#/cancellations/${credit.cancellation_id}">${esc(credit.cancellation_number)}</a>`
    : credit.booking_id
      ? `<a href="#/bookings/${credit.booking_id}">${esc(credit.booking_number)}</a>`
      : credit.visa_id
        ? `<a href="#/visas/${credit.visa_id}">${esc(credit.visa_number)}</a>`
        : '<span class="muted">No booking, visa or cancellation</span>';

  pageRecord(credit);
  setHeader({
    title: credit.number,
    subtitle: `${credit.vendor_name} · ${fmtDate(credit.credit_date, { long: true })}`,
    actions: `
      <a class="btn btn-ghost" href="#/audit-chain/supplier_credit/${id}">${icon('shield', 15)}<span>Audit chain</span></a>
      <a class="btn btn-ghost" href="#/supplier-credits"><span>All supplier credits</span></a>
      <button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>
      ${canApply ? `<button class="btn btn-primary" data-action="apply">${icon('bill', 15)}<span>Apply to bill</span></button>` : ''}
      ${canApply ? `<button class="btn btn-secondary" data-action="refund">${icon('arrowUp', 15)}<span>Cash refund</span></button>` : ''}
      ${canVoid ? `<button class="btn btn-danger-ghost" data-action="void"><span>Void</span></button>` : ''}
    `,
  });

  const items = credit.items || [];
  const applications = credit.applications || [];
  const refunds = credit.refunds || [];
  const portalCredits = credit.portal_credits || [];

  const itemRows = items.length
    ? items.map((item) => `
        <tr>
          <td>${esc(item.description)}</td>
          <td><span class="cell-sub">${esc(item.account_code)}</span> ${esc(item.account_name)}</td>
          <td class="num">${fmtMoney(item.amount_cents)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="3" class="muted">No credit lines.</td></tr>`;

  const applicationRows = applications.length
    ? applications.map((application) => `
        <tr>
          <td>${esc(fmtDate(application.applied_date))}</td>
          <td><a href="#/bills/${application.bill_id}">${esc(application.bill_number)}</a></td>
          <td class="num">${fmtMoney(application.amount_cents)}</td>
          <td>${application.journal_entry_id ? `<a href="#/journal?focus=${application.journal_entry_id}">Entry #${application.journal_entry_id}</a>` : '—'}</td>
          <td><button class="icon-btn danger" data-remove-application="${application.id}" title="Reverse application">${icon('trash', 15)}</button></td>
        </tr>
      `).join('')
    : `<tr><td colspan="5" class="muted">This credit has not been applied to a bill.</td></tr>`;

  const refundRows = refunds.length
    ? refunds.map((refund) => `
        <tr>
          <td><a href="#/refunds/${refund.id}">${esc(refund.number)}</a></td>
          <td>${esc(fmtDate(refund.refund_date))}</td>
          <td>${esc(refund.method || '—')} · ${esc(refund.account_name || '')}</td>
          <td class="num">${fmtMoney(refund.amount_cents)}</td>
          <td>${statusBadge(refund.status)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="5" class="muted">No cash refund has been received.</td></tr>`;

  const portalRows = portalCredits.length
    ? portalCredits.map((movement) => `
        <tr>
          <td><a href="#/portals/${movement.portal_id}">${esc(movement.portal_name)}</a></td>
          <td>${esc(fmtDate(movement.credit_date))}</td>
          <td class="num">${fmtMoney(movement.amount_cents)}</td>
          <td>${esc(movement.notes || '—')}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="4" class="muted">No part of this credit was moved to a prepaid portal wallet.</td></tr>`;

  container.innerHTML = `
    <div class="doc-wrap">
      <div class="doc">
        <div class="doc-head">
          <div class="doc-brand">
            ${companyMark(company)}
            <div>
              <div class="doc-company-name">${esc(company)}</div>
              <div class="doc-company-detail">${esc([settings.company_address, settings.company_email, settings.company_phone].filter(Boolean).join('\n'))}</div>
            </div>
          </div>
          <div class="doc-meta">
            <div class="doc-kind">Supplier credit note</div>
            <div class="doc-number">${esc(credit.number)}</div>
            <div class="doc-status">${statusBadge(credit.status_display)}</div>
            <dl class="doc-meta-grid">
              <dt>Credit date</dt><dd>${esc(fmtDate(credit.credit_date))}</dd>
              <dt>Supplier</dt><dd>${esc(credit.vendor_name)}</dd>
              <dt>Bill</dt><dd>${credit.bill_number ? esc(credit.bill_number) : '—'}</dd>
              <dt>Context</dt><dd>${esc(credit.cancellation_number || credit.booking_number || credit.visa_number || '—')}</dd>
            </dl>
          </div>
        </div>

        <div class="doc-parties">
          <div>
            <div class="doc-label">Supplier</div>
            <div class="doc-party-name">${esc(credit.vendor_name)}</div>
            <div class="doc-party-detail">${esc([credit.vendor_address, credit.vendor_email, credit.vendor_phone].filter(Boolean).join('\n'))}</div>
          </div>
          <div>
            <div class="doc-label">Credit applies to</div>
            <div class="doc-terms">${esc(credit.bill_number || 'No specific bill')}${credit.notes ? esc(`\n${credit.notes}`) : ''}</div>
          </div>
        </div>

        <div class="doc-items-wrap" tabindex="0" role="region" aria-label="Line items">
          <table class="doc-items"><caption class="sr-only">Supplier credit lines</caption>
            <thead><tr><th scope="col" style="width:56%">Description</th><th scope="col">Cost account</th><th scope="col" class="num">Amount</th></tr></thead>
            <tbody>${items.map((item) => `<tr><td>${esc(item.description)}</td><td>${esc(item.account_code)} · ${esc(item.account_name)}</td><td class="num amount">${fmtMoney(item.amount_cents)}</td></tr>`).join('')}</tbody>
          </table>
        </div>

        <div class="doc-total-area">
          <div class="doc-notes">
            <strong>Supplier credit</strong>
            This credit is held in 1450 Supplier Credits until it is applied to a bill, refunded in cash or moved to a prepaid portal wallet. It does not delete or reopen the original supplier bill or its payments.
          </div>
          <div class="doc-totals">
            <div class="totals-row"><span>Credit amount</span><span>${fmtMoney(credit.amount_cents)}</span></div>
            <div class="totals-row"><span>Applied to bills</span><span>${fmtMoney(credit.applied_cents)}</span></div>
            <div class="totals-row"><span>Cash refunded</span><span>${fmtMoney(credit.refunded_cents)}</span></div>
            <div class="totals-row"><span>Moved to portal</span><span>${fmtMoney(credit.portal_settled_cents)}</span></div>
            <div class="totals-row total"><span>Remaining credit</span><span>${fmtMoney(credit.remaining_cents)}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="detail-grid no-print">
      <div class="card">
        <div class="card-head"><div class="card-title"><h2>Credit summary</h2><p>${issued ? 'Issued and available' : 'Void'}</p></div></div>
        <div class="card-body">
          <div class="detail-list">
            <div><span>Supplier</span><strong>${esc(credit.vendor_name)}</strong></div>
            <div><span>Original bill</span><strong>${sourceLink}</strong></div>
            <div><span>Context</span><strong>${contextLink}</strong></div>
            <div><span>Credit amount</span><strong>${fmtMoney(credit.amount_cents)}</strong></div>
            <div><span>Applied</span><strong>${fmtMoney(credit.applied_cents)}</strong></div>
            <div><span>Refunded</span><strong>${fmtMoney(credit.refunded_cents)}</strong></div>
            <div><span>Portal settled</span><strong>${fmtMoney(credit.portal_settled_cents)}</strong></div>
            <div><span>Remaining</span><strong>${fmtMoney(credit.remaining_cents)}</strong></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title"><h2>Credit lines</h2><p>Posted to 1450 Supplier Credits</p></div></div>
        <div class="table-wrap">
          <table class="data"><caption class="sr-only">Supplier credit lines</caption>
            <thead><tr><th scope="col">Description</th><th scope="col">Cost account</th><th scope="col" class="num">Amount</th></tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card no-print" style="margin-top:16px">
      <div class="card-head">
        <div class="card-title"><h2>Applications</h2><p>${applications.length ? `${fmtMoney(credit.applied_cents)} applied to supplier bills` : 'Not applied yet'}</p></div>
        ${canApply ? `<button class="btn btn-secondary btn-sm" data-action="apply">${icon('plus', 14)} Apply</button>` : ''}
      </div>
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Supplier credit applications</caption>
          <thead><tr><th scope="col">Applied date</th><th scope="col">Bill</th><th scope="col" class="num">Amount</th><th scope="col">Journal</th><th scope="col"></th></tr></thead>
          <tbody>${applicationRows}</tbody>
        </table>
      </div>
    </div>

    <div class="detail-grid no-print" style="margin-top:16px">
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Cash refunds</h2><p>${refunds.length} refund${refunds.length === 1 ? '' : 's'}</p></div>
          ${canApply ? `<button class="btn btn-secondary btn-sm" data-action="refund">${icon('arrowUp', 14)} Refund</button>` : ''}
        </div>
        <div class="table-wrap">
          <table class="data"><caption class="sr-only">Cash refunds of this supplier credit</caption>
            <thead><tr><th scope="col">Refund</th><th scope="col">Date</th><th scope="col">Account</th><th scope="col" class="num">Amount</th><th scope="col">Status</th></tr></thead>
            <tbody>${refundRows}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title"><h2>Portal credits</h2><p>Moved to prepaid wallet</p></div></div>
        <div class="table-wrap">
          <table class="data"><caption class="sr-only">Portal credit movements</caption>
            <thead><tr><th scope="col">Portal</th><th scope="col">Date</th><th scope="col" class="num">Amount</th><th scope="col">Notes</th></tr></thead>
            <tbody>${portalRows}</tbody>
          </table>
        </div>
      </div>
    </div>
    ${attachmentSection({ entityType: 'supplier_credit', entityId: id, attachments, hint: 'Supplier credit memo or refund confirmation' })}
  `;
  bindAttachmentSection(container, { entityType: 'supplier_credit', entityId: id });

  function refresh() {
    return render(container, { params: [String(id)] });
  }

  document.querySelectorAll('[data-action="print"]').forEach((button) => button.addEventListener('click', () => window.print()));

  document.querySelectorAll('[data-action="apply"]').forEach((button) => {
    button.addEventListener('click', () => openApply());
  });

  document.querySelectorAll('[data-action="refund"]').forEach((button) => {
    button.addEventListener('click', () => openRefund());
  });

  const voidButton = document.querySelector('[data-action="void"]');
  if (voidButton) {
    voidButton.addEventListener('click', async () => {
      const activeRefunds = refunds.filter((refund) => refund.status === 'paid');
      const activePortalCredits = portalCredits.filter((portalCredit) => portalCredit.status !== 'void');
      const result = await voidDialog({
        title: `Void ${credit.number}?`,
        message: 'The supplier credit will be reversed and any linked bill applications, refunds and portal credits will be reversed automatically.',
        warning: 'This cannot be undone. The supplier credit and every linked reversal are kept in the audit trail.',
        preview: {
          heading: 'Void preview',
          items: [
            {
              label: `Supplier credit ${credit.number}`,
              value: fmtMoney(credit.amount_cents),
              note: `${credit.vendor_name} · ${fmtMoney(credit.remaining_cents)} still open`,
            },
            ...(applications.length ? [{
              label: `${applications.length} bill application${applications.length === 1 ? '' : 's'}`,
              value: fmtMoney(credit.applied_cents),
              note: 'Bills reopen by the applied amount',
            }] : []),
            ...(activeRefunds.length ? [{
              label: `${activeRefunds.length} cash refund${activeRefunds.length === 1 ? '' : 's'}`,
              value: fmtMoney(activeRefunds.reduce((sum, refund) => sum + refund.amount_cents, 0)),
              note: 'Cash refunds will be reversed',
            }] : []),
            ...(activePortalCredits.length ? [{
              label: `${activePortalCredits.length} wallet credit${activePortalCredits.length === 1 ? '' : 's'}`,
              value: fmtMoney(activePortalCredits.reduce((sum, portalCredit) => sum + portalCredit.amount_cents, 0)),
              note: 'Supplier wallet credits will be reversed',
            }] : []),
          ],
          note: 'The supplier credit and its reversals stay in the audit trail.',
        },
        confirmLabel: 'Void supplier credit',
      });
      if (!result.confirmed) return;
      try {
        await api.post(`/supplier-credits/${id}/void`, { remarks: result.remarks });
        toast(`${credit.number} voided`);
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  document.querySelectorAll('[data-remove-application]').forEach((button) => {
    button.addEventListener('click', async () => {
      const application = applications.find((row) => row.id === Number(button.dataset.removeApplication));
      if (!application) return;
      const result = await voidDialog({
        title: 'Void this supplier credit application?',
        message: `${fmtMoney(application.amount_cents)} will be removed from ${application.bill_number} and returned to this supplier credit.`,
        warning: 'A reversing journal entry will be posted. This cannot be undone.',
        preview: {
          heading: 'Void preview',
          items: [
            {
              label: `Supplier credit ${credit.number}`,
              value: fmtMoney(application.amount_cents),
              note: 'Returns to the unapplied supplier credit',
            },
            {
              label: `Bill ${application.bill_number}`,
              value: fmtMoney(application.amount_cents),
              note: 'Bill balance reopens by this amount',
            },
          ],
        },
        confirmLabel: 'Void application',
      });
      if (!result.confirmed) return;
      try {
        await api.post(`/supplier-credits/applications/${application.id}/void`, { remarks: result.remarks });
        toast('Supplier credit application reversed');
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  async function openApply() {
    const bills = (await api.get('/bills', { status: 'received' }))
      .filter((bill) => bill.vendor_id === credit.vendor_id && bill.balance_cents > 0);
    if (!bills.length) {
      toast('This supplier has no open bills to apply the credit to.', 'error');
      return;
    }
    const first = bills[0];
    const maxFirst = Math.min(credit.remaining_cents, first.balance_cents);
    openModal({
      title: 'Apply supplier credit',
      subtitle: `${credit.number} · ${fmtMoney(credit.remaining_cents)} remaining`,
      submitLabel: 'Apply credit',
      body: `
        <div class="form-grid">
          <div class="field full">
            <label for="sc-apply-bill">Bill</label>
            <select class="input" id="sc-apply-bill" name="bill_id" required>
              ${bills.map((bill) => `<option value="${bill.id}" data-balance="${bill.balance_cents}" ${bill.id === first.id ? 'selected' : ''}>${esc(bill.number)} · ${fmtMoney(bill.balance_cents)} due · ${esc(bill.bill_date)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="sc-apply-amount">Amount</label>
            <div class="money-input"><span>AED</span>
              <input class="input" id="sc-apply-amount" name="amount" type="number" min="0.01" step="0.01"
                max="${centsToInput(maxFirst)}" value="${centsToInput(maxFirst)}" required inputmode="decimal">
            </div>
          </div>
          <div class="field">
            <label for="sc-apply-date">Applied date</label>
            <input class="input" id="sc-apply-date" name="applied_date" type="date" value="${todayISO()}" required>
          </div>
          <div class="field full">
            <div class="form-note">This debits Trade Payables and credits 1450 Supplier Credits. The bill balance drops without recording a cash payment.</div>
          </div>
        </div>
      `,
      onMount(overlay) {
        const billSelect = overlay.querySelector('#sc-apply-bill');
        const amount = overlay.querySelector('#sc-apply-amount');
        billSelect.addEventListener('change', () => {
          const selected = billSelect.selectedOptions[0];
          const maximum = Math.min(credit.remaining_cents, Number(selected?.dataset.balance || 0));
          amount.max = centsToInput(maximum);
          amount.value = centsToInput(maximum);
        });
      },
      async onSubmit(form) {
        const values = new FormData(form);
        const saved = await api.post(`/supplier-credits/${credit.id}/apply`, {
          bill_id: Number(values.get('bill_id')),
          amount_cents: toCents(values.get('amount')),
          applied_date: values.get('applied_date'),
        });
        toast(`Supplier credit applied · ${fmtMoney(saved.remaining_cents)} remaining`);
        refresh();
      },
    });
  }

  function openRefund() {
    const accounts = cashAccounts().sort((a, b) => (b.is_cash - a.is_cash) || a.code.localeCompare(b.code));
    if (!accounts.length) {
      toast('Add an active bank or cash account before recording a supplier refund.', 'error');
      return;
    }
    const preferred = accounts.find((account) => account.code === '1010') || accounts[0];
    openModal({
      title: `Cash refund of ${credit.number}`,
      subtitle: `${credit.vendor_name} · ${fmtMoney(credit.remaining_cents)} available`,
      submitLabel: 'Record refund',
      body: `
        <div class="form-grid">
          <div class="field">
            <label for="sc-refund-amount">Amount received</label>
            <div class="money-input"><span>AED</span>
              <input class="input" id="sc-refund-amount" name="amount" type="number" min="0.01" step="0.01"
                max="${centsToInput(credit.remaining_cents)}" value="${centsToInput(credit.remaining_cents)}" required inputmode="decimal">
            </div>
            <div class="hint">Available ${fmtMoney(credit.remaining_cents)}</div>
          </div>
          <div class="field">
            <label for="sc-refund-date">Refund date</label>
            <input class="input" id="sc-refund-date" name="refund_date" type="date" value="${todayISO()}" required>
          </div>
          <div class="field">
            <label for="sc-refund-method">Method</label>
            <select class="input" id="sc-refund-method" name="method">
              ${['Bank transfer', 'Cash', 'Cheque', 'Other'].map((method) => `<option>${method}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="sc-refund-reference">Reference</label>
            <input class="input" id="sc-refund-reference" name="reference" placeholder="Transfer or credit memo reference">
          </div>
          <div class="field full">
            <label for="sc-refund-account">Deposit to</label>
            <select class="input" id="sc-refund-account" name="account_id" required>
              ${optionsHtml(accounts, { selected: preferred.id, placeholder: 'Choose bank or cash account…', labelKey: (account) => `${account.code} · ${account.name}` })}
            </select>
          </div>
          <div class="field full">
            <div class="form-note">This debits the bank or cash account and credits 1450 Supplier Credits. The original bill stays settled and is not reopened.</div>
          </div>
        </div>
      `,
      async onSubmit(form) {
        const values = new FormData(form);
        const amount = toCents(values.get('amount'));
        if (amount <= 0) throw new Error('Enter an amount');
        await api.post(`/supplier-credits/${credit.id}/refund`, {
          amount_cents: amount,
          refund_date: values.get('refund_date'),
          method: values.get('method'),
          reference: values.get('reference'),
          account_id: Number(values.get('account_id')),
        });
        toast(`Supplier refund of ${fmtMoney(amount)} recorded`);
        refresh();
      },
    });
  }

  return () => {};
}
