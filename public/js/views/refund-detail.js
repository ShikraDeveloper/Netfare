import { bindCorrections, correctButtonHtml } from '../corrections.js';
import { api } from '../api.js';
import { attachmentSection, bindAttachmentSection, loadAttachments } from '../attachments.js';
import { store } from '../store.js';
import {
  companyMark,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  setHeader,
  statusBadge,
  toast,
  voidDialog,
  pageRecord,
  printPage,
} from '../ui.js';

function sourceInfo(refund, isCustomer) {
  switch (refund.source_type) {
    case 'cancellation':
      return {
        label: 'Cancellation note',
        href: `#/cancellations/${refund.document_id}`,
        icon: 'x',
        amountLabel: 'Refund due at cancellation',
        description: 'Refund of cancellation balance',
        voidMessage: 'the cancellation refund will become available again by {amount}.',
      };
    case 'supplier_credit':
      return {
        label: 'Supplier credit',
        href: `#/supplier-credits/${refund.document_id}`,
        icon: 'bill',
        amountLabel: 'Supplier credit',
        description: 'Cash refund of supplier credit',
        voidMessage: 'the supplier credit will become available again by {amount}.',
      };
    case 'credit':
      return {
        label: 'Customer credit',
        href: `#/credits/${refund.document_id}`,
        icon: 'invoice',
        amountLabel: 'Credit amount',
        description: 'Cash refund of customer credit',
        voidMessage: 'the customer credit will become available again by {amount}.',
      };
    case 'deposit':
      return {
        label: 'Visa security deposit',
        href: `#/visas/${refund.document_id}`,
        icon: 'visa',
        amountLabel: 'Deposit refund',
        description: 'Refund of visa security deposit',
        voidMessage: '',
        voidElsewhere: 'Void deposit refunds from the Security deposit card on the visa page, so the deposit held is restored.',
      };
    case 'advance':
      return {
        label: 'Customer advance',
        href: '',
        icon: 'wallet',
        amountLabel: 'Advance amount',
        description: 'Refund of customer advance',
        voidMessage: 'the advance balance will be restored by {amount}.',
      };
    case 'bill':
      return {
        label: 'Bill',
        href: `#/bills/${refund.document_id}`,
        icon: 'bill',
        amountLabel: 'Original payment',
        description: 'Refund received from supplier',
        voidMessage: 'the bill balance will be restored by {amount}.',
      };
    default:
      return {
        label: isCustomer ? 'Invoice' : 'Bill',
        href: isCustomer ? `#/invoices/${refund.document_id}` : `#/bills/${refund.document_id}`,
        icon: isCustomer ? 'invoice' : 'bill',
        amountLabel: 'Original payment',
        description: isCustomer ? 'Refund of customer payment' : 'Refund received from supplier',
        voidMessage: `the ${isCustomer ? 'invoice' : 'bill'} balance will be restored by {amount}.`,
      };
  }
}

function entryHtml(entry, emptyText) {
  if (!entry) {
    return `<div class="muted" style="font-size:12.5px;line-height:1.6">${esc(emptyText)}</div>`;
  }
  return `
    <div class="entry-lines">
      <div class="entry-line" style="color:var(--muted-2);font-size:10px;text-transform:uppercase;letter-spacing:.05em">
        <div>Account</div><div class="dr">Debit</div><div class="cr">Credit</div>
      </div>
      ${entry.lines.map((line) => `
        <div class="entry-line">
          <div class="acct">${esc(line.account_name)}<small>${esc(line.account_code)}</small></div>
          <div class="dr">${line.debit_cents ? fmtMoney(line.debit_cents) : ''}</div>
          <div class="cr">${line.credit_cents ? fmtMoney(line.credit_cents) : ''}</div>
        </div>
      `).join('')}
      <div class="entry-total">
        <span>Total</span>
        <span>${fmtMoney(entry.total_cents)}</span>
        <span>${fmtMoney(entry.total_cents)}</span>
      </div>
    </div>
  `;
}

export async function render(container, { params } = {}) {
  const id = Number(params?.[0]);
  const refund = await api.get(`/refunds/${id}`);
  const attachments = await loadAttachments('refund', id);
  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const isCustomer = refund.refund_type === 'customer';
  const source = sourceInfo(refund, isCustomer);

  const actions = [
    `<a class="btn btn-ghost" href="#/refunds"><span>All refunds</span></a>`,
    source.href
      ? `<a class="btn btn-secondary" href="${source.href}">${icon(source.icon, 15)}<span>${esc(refund.document_number || source.label)}</span></a>`
      : `<span class="btn btn-secondary" aria-disabled="true">${icon(source.icon, 15)}<span>${esc(refund.document_number || source.label)}</span></span>`,
    `<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>`,
  ];
  if (refund.status === 'paid' && !source.voidElsewhere) {
    const correctable = refund.cancellation_id || refund.credit_note_id || refund.advance_id || refund.supplier_credit_note_id || refund.payment_id;
    if (correctable) actions.push(correctButtonHtml('refund', refund));
    actions.push(`<button class="btn btn-danger-ghost" data-action="void"><span>Void</span></button>`);
  }

  actions.push(`<a class="btn btn-ghost" href="#/audit-chain/refund/${id}">${icon('shield', 15)}<span>Audit chain</span></a>`);
  pageRecord(refund, { print: true });
  setHeader({
    title: refund.number,
    badge: statusBadge(refund.status),
    actions: actions.join(''),
  });

  const details = `
    <div class="card">
      <div class="card-head">
        <div class="card-title"><h2>Refund details</h2></div>
        ${statusBadge(refund.status)}
      </div>
      <div class="card-body">
        <div class="detail-list">
          <div><span>${esc(source.label)}</span><strong>${source.href ? `<a href="${source.href}">${esc(refund.document_number || '—')}</a>` : esc(refund.document_number || '—')}</strong></div>
          ${refund.payment_number ? `<div><span>Payment</span><strong>${esc(refund.payment_number)}</strong></div>` : ''}
          <div><span>Account</span><strong>${esc(refund.account_code ? `${refund.account_code} · ${refund.account_name}` : refund.account_name || '—')}</strong></div>
          <div><span>Reference</span><strong>${esc(refund.reference || '—')}</strong></div>
          <div><span>${esc(source.amountLabel)}</span><strong>${fmtMoney(refund.source_amount_cents)}</strong></div>
          <div><span>Previously refunded</span><strong>${fmtMoney(refund.refunded_before_cents)}</strong></div>
          <div><span>Refunded now</span><strong>${fmtMoney(refund.amount_cents)}</strong></div>
          <div><span>Remaining refundable</span><strong>${fmtMoney(refund.remaining_refundable_cents)}</strong></div>
        </div>
      </div>
    </div>
  `;

  container.innerHTML = `
    ${source.voidElsewhere && refund.status === 'paid' ? `<div class="callout no-print" data-void-elsewhere><div class="callout-text"><p>${esc(source.voidElsewhere)}</p></div></div>` : ''}
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
            <div class="doc-kind">${isCustomer ? 'Payment voucher · customer refund' : 'Receipt voucher · supplier refund'}</div>
            <div class="doc-number">${esc(refund.number)}</div>
            <div class="doc-status">${statusBadge(refund.status)}</div>
            <dl class="doc-meta-grid">
              <dt>Refund date</dt><dd>${esc(fmtDate(refund.refund_date))}</dd>
              <dt>Method</dt><dd>${esc(refund.method || '—')}</dd>
              <dt>Account</dt><dd>${esc(refund.account_name || '—')}</dd>
              <dt>Reference</dt><dd>${esc(refund.reference || '—')}</dd>
              ${refund.bank_charges_cents ? `<dt>Bank charges</dt><dd>${fmtMoney(refund.bank_charges_cents)}</dd>` : ''}
            </dl>
          </div>
        </div>

        <div class="doc-parties">
          <div>
            <div class="doc-label">${isCustomer ? 'Refund to' : 'Received from'}</div>
            <div class="doc-party-name">${esc(refund.party_name)}</div>
            <div class="doc-party-detail">${esc([refund.party_address, refund.party_email, refund.party_phone].filter(Boolean).join('\n'))}</div>
          </div>
          <div>
            <div class="doc-label">${esc(source.label)}</div>
            <div class="doc-party-name">${source.href ? `<a href="${source.href}">${esc(refund.document_number || '—')}</a>` : esc(refund.document_number || '—')}</div>
            <div class="doc-party-detail">${refund.payment_number ? `Payment ${esc(refund.payment_number)}\n` : ''}Refund ${esc(refund.number)}</div>
          </div>
        </div>

        <div class="doc-items-wrap" tabindex="0" role="region" aria-label="Line items">
          <table class="doc-items"><caption class="sr-only">Refund source lines</caption>
            <thead>
              <tr>
                <th scope="col" style="width:56%">Description</th>
                <th scope="col">${esc(source.label)}</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>${esc(source.description)}</td>
                <td>${esc(refund.document_number || '—')}${refund.payment_number ? `<div class="cell-sub">${esc(refund.payment_number)}</div>` : ''}</td>
                <td class="num amount">${fmtMoney(refund.amount_cents)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="doc-total-area">
          <div class="doc-notes">
            ${refund.notes ? `<strong>Notes</strong>${esc(refund.notes)}` : ''}
          </div>
          <div class="doc-totals">
            <div class="totals-row"><span>${esc(source.amountLabel)}</span><span>${fmtMoney(refund.source_amount_cents)}</span></div>
            <div class="totals-row"><span>Previously refunded</span><span>${fmtMoney(refund.refunded_before_cents)}</span></div>
            <div class="totals-row total"><span>Refunded now</span><span>${fmtMoney(refund.amount_cents)}</span></div>
            <div class="totals-row balance"><span>Remaining refundable</span><span>${fmtMoney(refund.remaining_refundable_cents)}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="detail-grid no-print">
      ${details}
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Ledger entry</h2></div>
          ${refund.journal_entry ? `<a class="card-link" href="#/journal?focus=${refund.journal_entry.id}">Open ${icon('chevron', 12)}</a>` : ''}
        </div>
        <div class="card-body">
          ${entryHtml(refund.journal_entry, 'No journal entry is linked to this refund.')}
          ${refund.void_entry ? `
            <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border)">
              <div class="card-title" style="margin-bottom:10px"><h2 style="font-size:14px">Void entry</h2><p>Posted ${esc(fmtDate(refund.void_entry.entry_date))}</p></div>
              ${entryHtml(refund.void_entry, '')}
            </div>
          ` : ''}
        </div>
      </div>
    </div>
    ${attachmentSection({ entityType: 'refund', entityId: id, attachments, hint: 'Bank transfer receipt or signed cash voucher' })}
  `;
  bindAttachmentSection(container, { entityType: 'refund', entityId: id });

  function refresh() {
    return render(container, { params: [String(id)] });
  }

  bindCorrections(document, (result) => { location.hash = `#/refunds/${result.id}`; });
  document.querySelectorAll('[data-action="print"]').forEach((button) => {
    button.addEventListener('click', () => printPage());
  });

  const voidButton = document.querySelector('[data-action="void"]');
  if (voidButton) {
    voidButton.addEventListener('click', async () => {
      const result = await voidDialog({
        title: `Void ${refund.number}?`,
        message: `A reversing journal entry will be posted and ${source.voidMessage.replace('{amount}', fmtMoney(refund.amount_cents))} The refund stays in your records for the audit trail.`,
        warning: 'This cannot be undone.',
        preview: {
          heading: 'Void preview',
          items: [
            {
              label: `Refund ${refund.number}`,
              value: fmtMoney(refund.amount_cents),
              note: `${refund.party_name} · ${refund.method || 'Refund'}`,
            },
            {
              label: source.label,
              value: refund.document_number || '—',
              note: 'Source balance will be restored by the refund amount',
            },
          ],
          note: 'The refund stays in history as void and the reversal is written to the audit log.',
        },
        confirmLabel: 'Void refund',
      });
      if (!result.confirmed) return;
      try {
        await api.post(`/refunds/${id}/void`, { remarks: result.remarks });
        toast(`${refund.number} voided with a reversing entry`);
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  return () => {};
}
