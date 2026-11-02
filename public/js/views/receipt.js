import { api } from '../api.js';
import { store } from '../store.js';
import { companyMark, esc, fmtDate, fmtMoney, icon, setHeader, statusBadge, createdByText } from '../ui.js';
import { amountInWords } from '../amount-words.js';

// Printable receipt voucher for one customer payment.
export async function render(container, { params } = {}) {
  const id = Number(params?.[0]);
  const receipt = await api.get(`/invoices/payments/${id}/receipt`);
  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const isVoid = receipt.status === 'void';
  const source = receipt.booking_number
    ? `Booking ${receipt.booking_number}`
    : receipt.visa_number ? `Visa ${receipt.visa_number}` : '';

  setHeader({
    title: `Receipt ${receipt.number}`,
    subtitle: `${receipt.customer_name} · ${fmtDate(receipt.payment_date)}${createdByText(receipt)}`,
    actions: `
      <a class="btn btn-secondary" href="#/invoices/${receipt.invoice_id}">${icon('invoice', 15)}<span>Invoice ${esc(receipt.invoice_number)}</span></a>
      <button class="btn btn-primary" data-action="print">${icon('print', 15)}<span>Print</span></button>
    `,
  });

  const details = [
    ['Against invoice', `${receipt.invoice_number} · ${fmtDate(receipt.invoice_issue_date)}`],
    source ? ['For', source] : null,
    ['Payment method', receipt.advance_id ? 'Applied from customer advance' : receipt.method],
    receipt.reference ? ['Reference', receipt.reference] : null,
    receipt.cheque_number
      ? ['Cheque', [receipt.cheque_number, receipt.bank_name, receipt.cheque_date ? fmtDate(receipt.cheque_date) : ''].filter(Boolean).join(' · ')]
      : null,
    ['Received into', receipt.deposit_account_name],
  ].filter(Boolean);

  container.innerHTML = `
    ${isVoid ? `
      <div class="callout no-print" style="border-color:var(--red-soft)">
        <div class="callout-text"><h3>This payment was voided</h3><p>The receipt is kept for the record; the amount is no longer counted as received.</p></div>
      </div>` : ''}
    <div class="doc-wrap">
      <div class="doc doc-receipt" data-receipt>
        <div class="doc-head">
          <div class="doc-brand">
            ${companyMark(company)}
            <div>
              <div class="doc-company-name">${esc(company)}</div>
              <div class="doc-company-detail">${esc([settings.company_address, settings.company_email, settings.company_phone].filter(Boolean).join('\n'))}</div>
            </div>
          </div>
          <div class="doc-meta">
            <div class="doc-kind">Receipt voucher</div>
            <div class="doc-number">${esc(receipt.number)}</div>
            ${isVoid ? `<div class="doc-status">${statusBadge('void')}</div>` : ''}
            <dl class="doc-meta-grid">
              <dt>Date</dt><dd>${esc(fmtDate(receipt.payment_date))}</dd>
            </dl>
          </div>
        </div>

        <div class="doc-parties">
          <div>
            <div class="doc-label">Received from</div>
            <div class="doc-party-name">${esc(receipt.customer_name)}</div>
            <div class="doc-party-detail">${esc([receipt.customer_address, receipt.customer_email, receipt.customer_phone].filter(Boolean).join('\n'))}</div>
          </div>
          <div class="receipt-amount">
            <div class="doc-label">Amount received</div>
            <div class="receipt-amount-value">${fmtMoney(receipt.amount_cents)}</div>
          </div>
        </div>

        <div class="doc-amount-words" data-amount-words><span class="doc-label">Amount in words</span>${esc(amountInWords(receipt.amount_cents))}</div>

        <dl class="receipt-details">
          ${details.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}
          ${receipt.refunded_cents > 0 ? `<dt>Refunded</dt><dd>${fmtMoney(receipt.refunded_cents)}</dd>` : ''}
          <dt>Invoice total</dt><dd>${fmtMoney(receipt.invoice_total_cents)}</dd>
          <dt>Invoice balance now</dt><dd><strong>${fmtMoney(receipt.invoice_balance_cents)}</strong></dd>
        </dl>

        <div class="receipt-signatures">
          <div><span></span>Received by</div>
          <div><span></span>Customer signature</div>
        </div>
      </div>
    </div>
  `;

  document.querySelector('#page-actions [data-action="print"]')?.addEventListener('click', () => window.print());
}
