import { api } from '../api.js';
import { attachmentSection, bindAttachmentSection, loadAttachments } from '../attachments.js';
import { cashAccounts, store } from '../store.js';
import {
  centsToInput,
  companyMark,
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
  toCents,
  todayISO,
  pageRecord
} from '../ui.js';

function sourceHref(cancellation) {
  return cancellation.source_type === 'booking'
    ? `#/bookings/${cancellation.source_id}`
    : `#/visas/${cancellation.source_id}`;
}

function statusLabel(cancellation) {
  const status = cancellation.source_type === 'visa'
    ? cancellation.visa_status
    : cancellation.booking_status;
  return statusBadge(status || 'cancelled');
}

export async function render(container, { params, query } = {}) {
  const id = Number(params?.[0]);
  const cancellation = await api.get(`/cancellations/${id}`);
  const attachments = await loadAttachments('cancellation', id);
  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const remaining = Number(cancellation.refund_remaining_cents || 0);
  const canSettle = remaining > 0;
  const showSettlementChoice = canSettle && query?.get('settle') === '1';
  const href = sourceHref(cancellation);
  const sourceLabel = cancellation.source_type === 'booking' ? 'Booking' : 'Visa application';
  // A visa rejected by immigration uses the same note, worded as a rejection.
  const isRejected = cancellation.source_type === 'visa' && cancellation.visa_status === 'rejected';
  // A rejection keeps the invoice; what goes back is a credit note on it.
  const keeps = Boolean(cancellation.keeps_invoice);
  const invoiceTotal = Number(cancellation.customer_charges_cents || 0) + Number(cancellation.customer_credited_cents || 0);

  pageRecord(cancellation);
  setHeader({
    title: cancellation.number,
    badge: statusBadge(isRejected ? 'rejected' : 'cancelled'),
    actions: `
      <a class="btn btn-ghost" href="#/audit-chain/cancellation/${id}">${icon('shield', 15)}<span>Audit chain</span></a>
      <a class="btn btn-ghost" href="${href}"><span>${sourceLabel}</span></a>
      <button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>
      <button class="btn btn-secondary" data-action="supplier-refund">${icon('arrowUp', 15)}<span>Supplier refund</span></button>
      ${canSettle ? `<button class="btn btn-primary" data-action="refund">${icon('arrowUp', 15)}<span>Pay refund</span></button>` : ''}
      ${canSettle ? `<button class="btn btn-secondary" data-action="convert">${icon('invoice', 15)}<span>Convert to credit</span></button>` : ''}
    `,
  });

  const supplierCreditRows = cancellation.supplier_credits.length
    ? cancellation.supplier_credits.map((credit) => `
        <tr>
          <td><a href="#/supplier-credits/${credit.id}">${esc(credit.number)}</a><div class="cell-sub">${esc(credit.bill_number || 'Standalone')}</div></td>
          <td>${esc(credit.vendor_name)}</td>
          <td class="num">${fmtMoney(credit.amount_cents)}</td>
          <td class="num">${fmtMoney(credit.applied_cents)}</td>
          <td class="num">${fmtMoney(credit.remaining_cents)}</td>
          <td>${statusBadge(credit.status_display)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="6">${emptyState({
    iconName: 'bill',
    title: 'Supplier cost kept in full',
  })}</td></tr>`;

  const refundRows = cancellation.refunds.length
    ? cancellation.refunds.map((refund) => `
        <tr>
          <td><a href="#/refunds/${refund.id}">${esc(refund.number)}</a></td>
          <td>${esc(fmtDate(refund.refund_date))}</td>
          <td>${esc(refund.method || '—')} · ${esc(refund.account_name || '')}</td>
          <td class="num">${fmtMoney(refund.amount_cents)}</td>
          <td>${statusBadge(refund.status)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="5" class="muted">No refund has been paid yet.</td></tr>`;

  const creditRows = cancellation.credits.length
    ? cancellation.credits.map((credit) => `
        <tr>
          <td><a href="#/credits/${credit.id}">${esc(credit.number)}</a></td>
          <td>${esc(fmtDate(credit.credit_date))}</td>
          <td>${esc(credit.revenue_account_name)}</td>
          <td class="num">${fmtMoney(credit.amount_cents)}</td>
          <td>${statusBadge(credit.status)}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="5" class="muted">${keeps ? 'Nothing given back to the customer.' : 'No part of the refund has been converted to customer credit.'}</td></tr>`;

  container.innerHTML = `
    ${showSettlementChoice ? `
      <div class="callout settlement-choice no-print" data-settlement-choice>
        <div class="callout-icon">${icon('wallet', 18)}</div>
        <div class="callout-text">
          <h3>Choose how to settle ${fmtMoney(remaining)}</h3>
        </div>
        <div class="callout-actions">
          <button class="btn btn-primary" data-choice="refund">${icon('arrowUp', 15)}<span>Pay refund</span></button>
          <button class="btn btn-secondary" data-choice="credit">${icon('invoice', 15)}<span>Convert to credit</span></button>
          <button class="btn btn-ghost" data-choice="defer">Decide later</button>
        </div>
      </div>
    ` : ''}
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
            <div class="doc-kind">${isRejected ? 'Rejection note' : 'Cancellation note'}</div>
            <div class="doc-number">${esc(cancellation.number)}</div>
            <div class="doc-status">${statusLabel(cancellation)}</div>
            <dl class="doc-meta-grid">
              <dt>${isRejected ? 'Rejection date' : 'Cancellation date'}</dt><dd>${esc(fmtDate(cancellation.cancellation_date))}</dd>
              <dt>${sourceLabel}</dt><dd>${esc(cancellation.source_number || '—')}</dd>
              <dt>${keeps ? 'Invoice' : 'Original invoice'}</dt><dd>${cancellation.invoice_id
                ? `<a href="#/invoices/${cancellation.invoice_id}">${esc(cancellation.invoice_number || 'Open invoice')}</a>`
                : '—'}</dd>
              ${keeps ? '' : `<dt>Charges invoice</dt><dd>${esc(cancellation.cancellation_invoice_number || '—')}</dd>`}
            </dl>
          </div>
        </div>

        <div class="doc-parties">
          <div>
            <div class="doc-label">Customer</div>
            <div class="doc-party-name">${esc(cancellation.customer_name)}</div>
            <div class="doc-party-detail">${esc([cancellation.customer_address, cancellation.customer_email, cancellation.customer_phone].filter(Boolean).join('\n'))}</div>
          </div>
          <div>
            <div class="doc-label">${isRejected ? 'Reason' : 'Cancellation'}</div>
            <div class="doc-terms">${esc(cancellation.reason || (isRejected ? 'Rejected by immigration.' : `Cancellation of ${sourceLabel.toLowerCase()} ${cancellation.source_number || ''}.`))}${cancellation.notes ? esc(`\n${cancellation.notes}`) : ''}</div>
          </div>
        </div>

        <div class="doc-items-wrap" tabindex="0" role="region" aria-label="Line items">
          <table class="doc-items"><caption class="sr-only">Cancellation settlement</caption>
            <thead>
              <tr>
                <th scope="col" style="width:64%">Settlement</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${keeps ? `
              <tr><td>Invoice ${esc(cancellation.invoice_number || '')}</td><td class="num amount">${fmtMoney(invoiceTotal)}</td></tr>
              <tr><td>Refund to customer (credit note)</td><td class="num amount">${fmtMoney(cancellation.customer_credited_cents)}</td></tr>
              <tr><td>Refund from suppliers</td><td class="num amount">${fmtMoney(cancellation.supplier_credit_total_cents)}</td></tr>
              ` : `
              <tr><td>${isRejected ? 'Kept by us' : 'Cancellation charges to customer'}</td><td class="num amount">${fmtMoney(cancellation.customer_charges_cents)}</td></tr>
              <tr><td>Money held from the customer</td><td class="num amount">${fmtMoney(cancellation.received_cents)}</td></tr>
              <tr><td>${isRejected ? 'Refund from suppliers' : 'Supplier credit recorded'}</td><td class="num amount">${fmtMoney(cancellation.supplier_credit_total_cents)}</td></tr>
              `}
            </tbody>
          </table>
        </div>

        <div class="doc-total-area">
          <div class="doc-notes"></div>
          <div class="doc-totals">
            ${keeps ? `
            <div class="totals-row total"><span>Kept by us</span><span>${fmtMoney(cancellation.customer_charges_cents)}</span></div>
            ` : `
            <div class="totals-row"><span>${isRejected ? 'Kept by us' : 'Charges to customer'}</span><span>${fmtMoney(cancellation.customer_charges_cents)}</span></div>
            <div class="totals-row"><span>Refund due</span><span>${fmtMoney(cancellation.refund_due_cents)}</span></div>
            <div class="totals-row"><span>Refunded</span><span>${fmtMoney(cancellation.customer_refunded_cents)}</span></div>
            <div class="totals-row"><span>Converted to credit</span><span>${fmtMoney(cancellation.customer_credited_cents)}</span></div>
            <div class="totals-row total"><span>Refund remaining</span><span>${fmtMoney(remaining)}</span></div>
            `}
          </div>
        </div>
      </div>
    </div>

    <div class="detail-grid no-print">
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Customer settlement</h2></div>
          ${canSettle ? `<button class="btn btn-primary btn-sm" data-action="refund">${icon('arrowUp', 14)} Pay refund</button>` : ''}
          ${canSettle ? `<button class="btn btn-ghost btn-sm" data-action="settlement-options">${icon('wallet', 14)} Settlement options</button>` : ''}
        </div>
        <div class="card-body">
          ${keeps ? `
          <div class="detail-list">
            <div><span>Invoice</span><strong><a href="#/invoices/${cancellation.invoice_id}">${esc(cancellation.invoice_number || '')}</a></strong></div>
            <div><span>Paid by the customer</span><strong>${fmtMoney(cancellation.invoice_paid_cents)}</strong></div>
            <div><span>Refund to customer</span><strong>${fmtMoney(cancellation.customer_credited_cents)}</strong></div>
            <div><span>Kept by us</span><strong>${fmtMoney(cancellation.customer_charges_cents)}</strong></div>
          </div>
          ` : `
          <div class="detail-list">
            <div><span>Money held</span><strong>${fmtMoney(cancellation.received_cents)}</strong></div>
            <div><span>Cancellation charges</span><strong>${fmtMoney(cancellation.customer_charges_cents)}</strong></div>
            <div><span>Refund due</span><strong>${fmtMoney(cancellation.refund_due_cents)}</strong></div>
            <div><span>Refunded</span><strong>${fmtMoney(cancellation.customer_refunded_cents)}</strong></div>
            <div><span>Converted to credit</span><strong>${fmtMoney(cancellation.customer_credited_cents)}</strong></div>
            <div><span>Remaining</span><strong>${fmtMoney(remaining)}</strong></div>
            <div><span>Charges invoice</span><strong>${cancellation.cancellation_invoice_id ? `<a href="#/invoices/${cancellation.cancellation_invoice_id}">${esc(cancellation.cancellation_invoice_number)}</a>` : '—'}</strong></div>
          </div>
          `}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Supplier credits</h2></div>
        </div>
        <div class="table-wrap" tabindex="0" aria-label="Supplier credits from this cancellation">
          <table class="data"><caption class="sr-only">Supplier credits from this cancellation</caption>
            <thead><tr><th scope="col">Credit</th><th scope="col">Supplier</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Applied</th><th scope="col" class="num">Remaining</th><th scope="col">Status</th></tr></thead>
            <tbody>${supplierCreditRows}</tbody>
          </table>
        </div>
      </div>

      ${keeps ? '' : `<div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Refunds paid</h2></div>
        </div>
        <div class="table-wrap" tabindex="0" aria-label="Refunds for this cancellation">
          <table class="data"><caption class="sr-only">Refunds for this cancellation</caption>
            <thead><tr><th scope="col">Refund</th><th scope="col">Date</th><th scope="col">Account</th><th scope="col" class="num">Amount</th><th scope="col">Status</th></tr></thead>
            <tbody>${refundRows}</tbody>
          </table>
        </div>
      </div>`}

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>${keeps ? 'Credit notes' : 'Customer credits'}</h2></div>
        </div>
        <div class="table-wrap" tabindex="0" aria-label="Credits created from this cancellation">
          <table class="data"><caption class="sr-only">Credits created from this cancellation</caption>
            <thead><tr><th scope="col">Credit</th><th scope="col">Date</th><th scope="col">Revenue account</th><th scope="col" class="num">Amount</th><th scope="col">Status</th></tr></thead>
            <tbody>${creditRows}</tbody>
          </table>
        </div>
      </div>
    </div>
    ${attachmentSection({ entityType: 'cancellation', entityId: id, attachments, hint: 'Airline or embassy cancellation proof and the customer request' })}
  `;
  bindAttachmentSection(container, { entityType: 'cancellation', entityId: id });

  function refresh(settle = showSettlementChoice) {
    const nextQuery = new URLSearchParams();
    if (settle) nextQuery.set('settle', '1');
    return render(container, { params: [String(id)], query: nextQuery });
  }

  document.querySelectorAll('[data-action="print"]').forEach((button) => {
    button.addEventListener('click', () => window.print());
  });

  document.querySelectorAll('[data-action="refund"], [data-choice="refund"]').forEach((button) => {
    button.addEventListener('click', () => openRefund(remaining));
  });

  document.querySelectorAll('[data-action="convert"], [data-choice="credit"]').forEach((button) => {
    button.addEventListener('click', () => openConvert(remaining));
  });

  document.querySelectorAll('[data-action="settlement-options"]').forEach((button) => {
    button.addEventListener('click', () => {
      location.hash = `#/cancellations/${id}?settle=1`;
    });
  });

  document.querySelectorAll('[data-choice="defer"]').forEach((button) => {
    button.addEventListener('click', () => {
      history.replaceState(null, '', `#/cancellations/${id}`);
      const panel = document.querySelector('[data-settlement-choice]');
      if (panel) panel.remove();
      toast('Refund kept in 2500 Refund Liabilities');
    });
  });

  function openRefund(maximum) {
    const accounts = cashAccounts().sort((a, b) => (b.is_cash - a.is_cash) || a.code.localeCompare(b.code));
    if (!accounts.length) {
      toast('Add an active bank or cash account before paying a refund.', 'error');
      return;
    }
    const preferred = accounts.find((account) => account.code === '1010') || accounts[0];
    openModal({
      title: `Pay refund for ${cancellation.number}`,
      submitLabel: 'Record refund',
      body: `
        <div class="form-grid">
          <div class="field">
            <label for="cancel-refund-amount">Refund amount · ${fmtMoney(maximum)} available</label>
            <div class="money-input"><span>AED</span>
              <input class="input" id="cancel-refund-amount" name="amount" type="number" min="0.01" step="0.01"
                max="${centsToInput(maximum)}" value="${centsToInput(maximum)}" required inputmode="decimal">
            </div>
          </div>
          <div class="field">
            <label for="cancel-refund-date">Refund date</label>
            <input class="input" id="cancel-refund-date" name="refund_date" type="date" value="${todayISO()}" required>
          </div>
          <div class="field">
            <label for="cancel-refund-method">Method</label>
            <select class="input" id="cancel-refund-method" name="method">
              ${['Bank transfer', 'Cash', 'Cheque', 'Credit card', 'Other'].map((method) => `<option>${method}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="cancel-refund-reference">Reference</label>
            <input class="input" id="cancel-refund-reference" name="reference" placeholder="Transfer or cheque reference">
          </div>
          <div class="field full">
            <label for="cancel-refund-account">Refund from</label>
            <select class="input" id="cancel-refund-account" name="account_id" required>
              ${optionsHtml(accounts, { selected: preferred.id, placeholder: 'Choose bank or cash account…', labelKey: (account) => `${account.code} · ${account.name}` })}
            </select>
          </div>
        </div>
      `,
      async onSubmit(form) {
        const values = new FormData(form);
        const amount = toCents(values.get('amount'));
        if (amount <= 0) throw new Error('Enter a refund amount');
        const saved = await api.post(`/cancellations/${cancellation.id}/refund`, {
          amount_cents: amount,
          refund_date: values.get('refund_date'),
          method: values.get('method'),
          reference: values.get('reference'),
          account_id: Number(values.get('account_id')),
        });
        const stillOpen = Number(saved.refund_remaining_cents) > 0;
        history.replaceState(null, '', `#/cancellations/${id}${stillOpen ? '?settle=1' : ''}`);
        toast(`Refund of ${fmtMoney(amount)} recorded`);
        refresh(stillOpen);
      },
    });
  }

  function openConvert(maximum) {
    openModal({
      title: `Convert refund to credit`,
      submitLabel: 'Create customer credit',
      body: `
        <div class="form-grid">
          <div class="field">
            <label for="cancel-credit-amount">Credit amount · ${fmtMoney(maximum)} available</label>
            <div class="money-input"><span>AED</span>
              <input class="input" id="cancel-credit-amount" name="amount" type="number" min="0.01" step="0.01"
                max="${centsToInput(maximum)}" value="${centsToInput(maximum)}" required inputmode="decimal">
            </div>
          </div>
          <div class="field">
            <label for="cancel-credit-date">Credit date</label>
            <input class="input" id="cancel-credit-date" name="credit_date" type="date" value="${todayISO()}" required>
          </div>
          <div class="field full">
            <label for="cancel-credit-notes">Notes</label>
            <textarea class="input" id="cancel-credit-notes" name="notes" rows="2" placeholder="Internal note for the customer credit"></textarea>
          </div>
        </div>
      `,
      async onSubmit(form) {
        const values = new FormData(form);
        const saved = await api.post(`/cancellations/${cancellation.id}/convert-to-credit`, {
          amount_cents: toCents(values.get('amount')),
          credit_date: values.get('credit_date'),
          notes: values.get('notes'),
        });
        const stillOpen = Number(saved.refund_remaining_cents) > 0;
        history.replaceState(null, '', `#/cancellations/${id}${stillOpen ? '?settle=1' : ''}`);
        toast(`Customer credit created · ${fmtMoney(saved.refund_remaining_cents)} refund remaining`);
        refresh(stillOpen);
      },
    });
  }

  document.querySelector('[data-action="supplier-refund"]')?.addEventListener('click', openSupplierRefund);

  // Money the supplier (immigration, an airline) gives back later. Part of it
  // can go to the customer, up to what was kept from their money.
  async function openSupplierRefund() {
    const job = await api.get(`/${cancellation.source_type === 'booking' ? 'bookings' : 'visas'}/${cancellation.source_id}`);
    const bills = (job.bills || []).filter((bill) => bill.status === 'received');
    if (!bills.length) {
      toast('This job has no supplier bill to refund', 'error');
      return;
    }
    const accounts = cashAccounts().sort((a, b) => (b.is_cash - a.is_cash) || a.code.localeCompare(b.code));
    const preferred = accounts.find((account) => account.code === '1010') || accounts[0];
    const keptFromHeld = keeps
      ? Number(cancellation.customer_charges_cents || 0)
      : Math.min(Number(cancellation.received_cents || 0), Number(cancellation.customer_charges_cents || 0));
    openModal({
      title: 'Supplier refund',
      submitLabel: 'Record refund',
      body: `
        <div class="form-grid">
          <div class="field full">
            <label for="sr-bill">Bill</label>
            <select class="input" id="sr-bill" name="bill_id" required>
              ${bills.map((bill) => `<option value="${bill.id}">${esc(bill.number)} · ${esc(bill.vendor_name || '')} · ${fmtMoney(bill.total_cents)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="sr-amount">Amount the supplier gave back</label>
            <div class="money-input"><span>AED</span>
              <input class="input" id="sr-amount" name="amount" type="number" min="0.01" step="0.01" required inputmode="decimal">
            </div>
          </div>
          <div class="field">
            <label for="sr-date">Date</label>
            <input class="input" id="sr-date" name="date" type="date" value="${todayISO()}" required>
          </div>
          <div class="field full">
            <label for="sr-account">Received into</label>
            <select class="input" id="sr-account" name="account_id">
              <option value="">Not received yet: keep as credit with the supplier</option>
              ${accounts.map((account) => `<option value="${account.id}" ${account.id === preferred?.id ? 'selected' : ''}>${esc(account.code)} · ${esc(account.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field full">
            <label for="sr-customer">Give to the customer${keptFromHeld ? ` · up to ${fmtMoney(keptFromHeld)}` : ''}</label>
            <div class="money-input"><span>AED</span>
              <input class="input" id="sr-customer" name="pass_to_customer" type="number" min="0" step="0.01" value="0.00" max="${centsToInput(keptFromHeld)}"
                ${keptFromHeld ? '' : 'disabled'} inputmode="decimal">
            </div>
          </div>
        </div>
      `,
      async onSubmit(form) {
        const values = new FormData(form);
        const saved = await api.post(`/cancellations/${cancellation.id}/supplier-refund`, {
          bill_id: Number(values.get('bill_id')),
          amount_cents: toCents(values.get('amount')),
          date: values.get('date'),
          account_id: values.get('account_id') ? Number(values.get('account_id')) : null,
          pass_to_customer_cents: toCents(values.get('pass_to_customer') || 0),
        });
        const due = Number(saved.refund_remaining_cents) > 0;
        const credited = Number(saved.customer_credited_cents) - Number(cancellation.customer_credited_cents || 0);
        if (credited > 0) toast(`Supplier refund recorded · credit note of ${fmtMoney(credited)} for the customer`);
        else toast(due ? `Supplier refund recorded · ${fmtMoney(saved.refund_remaining_cents)} to give the customer` : 'Supplier refund recorded');
        history.replaceState(null, '', `#/cancellations/${id}${due ? '?settle=1' : ''}`);
        refresh(due);
      },
    });
  }

  return () => {};
}
