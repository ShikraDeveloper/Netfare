import { api } from '../api.js';
import { store } from '../store.js';
import {
  confirmDialog,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  setHeader,
  statusBadge,
  toast,
} from '../ui.js';

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
  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const isCustomer = refund.refund_type === 'customer';
  const sourceHref = isCustomer ? `#/invoices/${refund.invoice_id}` : `#/bills/${refund.bill_id}`;
  const sourceLabel = isCustomer ? 'Invoice' : 'Bill';

  const actions = [
    `<a class="btn btn-ghost" href="#/refunds"><span>All refunds</span></a>`,
    `<a class="btn btn-secondary" href="${sourceHref}">${icon(isCustomer ? 'invoice' : 'bill', 15)}<span>${esc(refund.document_number || sourceLabel)}</span></a>`,
    `<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>`,
  ];
  if (refund.status === 'paid') {
    actions.push(`<button class="btn btn-danger-ghost" data-action="void"><span>Void</span></button>`);
  }

  setHeader({
    title: refund.number,
    subtitle: `${refund.party_name} · ${fmtDate(refund.refund_date)}`,
    actions: actions.join(''),
  });

  const details = `
    <div class="card">
      <div class="card-head">
        <div class="card-title"><h2>Refund details</h2><p>${esc(refund.method || 'Refund')}</p></div>
        ${statusBadge(refund.status)}
      </div>
      <div class="card-body">
        <div class="detail-list">
          <div><span>Original ${sourceLabel.toLowerCase()}</span><strong><a href="${sourceHref}">${esc(refund.document_number || '—')}</a></strong></div>
          <div><span>Payment</span><strong>${esc(refund.payment_number || '—')}</strong></div>
          <div><span>Account</span><strong>${esc(refund.account_code ? `${refund.account_code} · ${refund.account_name}` : refund.account_name || '—')}</strong></div>
          <div><span>Reference</span><strong>${esc(refund.reference || '—')}</strong></div>
          <div><span>Original payment</span><strong>${fmtMoney(refund.source_amount_cents)}</strong></div>
          <div><span>Previously refunded</span><strong>${fmtMoney(refund.refunded_before_cents)}</strong></div>
          <div><span>Refunded now</span><strong>${fmtMoney(refund.amount_cents)}</strong></div>
          <div><span>Remaining refundable</span><strong>${fmtMoney(refund.remaining_refundable_cents)}</strong></div>
        </div>
      </div>
    </div>
  `;

  container.innerHTML = `
    <div class="doc-wrap">
      <div class="doc">
        <div class="doc-head">
          <div class="doc-brand">
            <span class="brand-mark">L</span>
            <div>
              <div class="doc-company-name">${esc(company)}</div>
              <div class="doc-company-detail">${esc([settings.company_address, settings.company_email, settings.company_phone].filter(Boolean).join('\n'))}</div>
            </div>
          </div>
          <div class="doc-meta">
            <div class="doc-kind">${isCustomer ? 'Customer refund' : 'Supplier refund'}</div>
            <div class="doc-number">${esc(refund.number)}</div>
            <div class="doc-status">${statusBadge(refund.status)}</div>
            <dl class="doc-meta-grid">
              <dt>Refund date</dt><dd>${esc(fmtDate(refund.refund_date))}</dd>
              <dt>Method</dt><dd>${esc(refund.method || '—')}</dd>
              <dt>Account</dt><dd>${esc(refund.account_name || '—')}</dd>
              <dt>Reference</dt><dd>${esc(refund.reference || '—')}</dd>
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
            <div class="doc-label">Original ${sourceLabel.toLowerCase()}</div>
            <div class="doc-party-name"><a href="${sourceHref}">${esc(refund.document_number || '—')}</a></div>
            <div class="doc-party-detail">Payment ${esc(refund.payment_number || '—')}\nRefund ${esc(refund.number)}</div>
          </div>
        </div>

        <div class="doc-items-wrap">
          <table class="doc-items"><caption class="sr-only">Refund source lines</caption>
            <thead>
              <tr>
                <th scope="col" style="width:56%">Description</th>
                <th scope="col">Original ${sourceLabel.toLowerCase()}</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>${isCustomer ? 'Refund of customer payment' : 'Refund received from supplier'}</td>
                <td>${esc(refund.document_number || '—')}<div class="cell-sub">${esc(refund.payment_number || '')}</div></td>
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
            <div class="totals-row"><span>Original payment</span><span>${fmtMoney(refund.source_amount_cents)}</span></div>
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
          <div class="card-title"><h2>Ledger entry</h2><p>${refund.journal_entry ? `Posted ${esc(fmtDate(refund.journal_entry.entry_date))}` : 'Not posted'}</p></div>
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
  `;

  function refresh() {
    return render(container, { params: [String(id)] });
  }

  document.querySelectorAll('[data-action="print"]').forEach((button) => {
    button.addEventListener('click', () => window.print());
  });

  const voidButton = document.querySelector('[data-action="void"]');
  if (voidButton) {
    voidButton.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: `Void ${refund.number}?`,
        message: `A reversing journal entry will be posted and the ${sourceLabel.toLowerCase()} balance will be restored by ${fmtMoney(refund.amount_cents)}. The refund stays in your records for the audit trail.`,
        confirmLabel: 'Void refund',
      });
      if (!confirmed) return;
      try {
        await api.post(`/refunds/${id}/void`, {});
        toast(`${refund.number} voided with a reversing entry`);
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  return () => {};
}
