import { api } from '../api.js';
import { store } from '../store.js';
import { companyMark, esc, fmtDate, fmtMoney, icon, setHeader, statusBadge, pageRecord, printPage } from '../ui.js';
import { amountInWords } from '../amount-words.js';

// Printable receipt for one customer payment shared over several invoices
// (Receive payment on the customer's balance page).
export async function render(container, { params } = {}) {
  const id = Number(params?.[0]);
  const receipt = await api.get(`/advances/${id}/receipt`);
  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const isVoid = Boolean(receipt.voided);
  const used = receipt.invoices.reduce((sum, row) => sum + row.amount_cents, 0);

  pageRecord(receipt, { print: true });
  setHeader({
    title: `Receipt ${receipt.number}`,
    actions: `
      <a class="btn btn-secondary" href="#/customer-balances/${receipt.customer_id}">${icon('wallet', 15)}<span>Customer balance</span></a>
      <button class="btn btn-primary" data-action="print">${icon('print', 15)}<span>Print</span></button>
    `,
  });

  const details = [
    ['Payment method', receipt.method],
    receipt.reference ? ['Reference', receipt.reference] : null,
    ['Received into', receipt.deposit_account_name],
  ].filter(Boolean);

  const lines = receipt.invoices.map((row) => {
    const about = [row.visa_number ? `Visa ${row.visa_number}` : '', row.applicant_name, row.booking_number ? `Booking ${row.booking_number}` : '']
      .filter(Boolean).join(' · ');
    return `
      <tr>
        <td><a href="#/invoices/${row.invoice_id}">${esc(row.invoice_number)}</a><div class="cell-sub">${esc(about || fmtDate(row.issue_date))}</div></td>
        <td class="num">${fmtMoney(row.total_cents)}</td>
        <td class="num">${fmtMoney(row.amount_cents)}</td>
        <td class="num">${fmtMoney(row.balance_cents)}</td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    ${isVoid ? `
      <div class="callout no-print" style="border-color:var(--red-soft)">
        <div class="callout-text"><h3>This receipt was voided</h3></div>
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
              <dt>Date</dt><dd>${esc(fmtDate(receipt.advance_date))}</dd>
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

        ${lines ? `
          <table class="doc-items">
            <thead><tr><th scope="col">Against invoice</th><th scope="col" class="num">Invoice total</th><th scope="col" class="num">Paid now</th><th scope="col" class="num">Balance now</th></tr></thead>
            <tbody>${lines}</tbody>
          </table>` : ''}

        <dl class="receipt-details">
          ${details.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}
          ${receipt.remaining_cents > 0 ? `<dt>Kept as advance</dt><dd><strong>${fmtMoney(receipt.remaining_cents)}</strong></dd>` : ''}
          ${receipt.refunded_cents > 0 ? `<dt>Refunded</dt><dd>${fmtMoney(receipt.refunded_cents)}</dd>` : ''}
          ${used && used !== receipt.amount_cents ? `<dt>Used for invoices</dt><dd>${fmtMoney(used)}</dd>` : ''}
        </dl>

      </div>
    </div>
  `;

  document.querySelector('#page-actions [data-action="print"]')?.addEventListener('click', () => printPage());
}
