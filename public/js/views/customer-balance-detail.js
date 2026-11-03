import { api } from '../api.js';
import { openApplyAdvance, openReceivePayment, openRecordAdvance, openRefundAdvance } from './customer-advance-modals.js';
import {
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  setHeader,
  statusBadge,
  todayISO,
} from '../ui.js';

function summaryCard(label, valueCents, meta, iconName, color) {
  return `
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">${esc(label)}</span>
        <span class="kpi-icon ${color}">${icon(iconName, 17)}</span>
      </div>
      <div class="kpi-value">${fmtMoney(valueCents)}</div>
      <div class="kpi-meta">${esc(meta)}</div>
    </div>
  `;
}

function invoiceStatus(invoice) {
  if (invoice.due_date && invoice.due_date < todayISO()) {
    return '<span class="badge badge-overdue">Overdue</span>';
  }
  return statusBadge('sent');
}

function invoiceRows(invoices) {
  if (!invoices.length) {
    return `<tr><td colspan="7">${emptyState({
      iconName: 'invoice',
      title: 'No open invoices',
      message: 'Every sent invoice for this customer is fully paid or has been voided.',
    })}</td></tr>`;
  }
  return invoices.map((invoice) => `
    <tr class="clickable" data-href="#/invoices/${invoice.id}" tabindex="0">
      <td><div class="cell-main">${esc(invoice.number)}</div><div class="cell-sub">${esc(fmtDate(invoice.issue_date))}</div></td>
      <td class="nowrap">${esc(fmtDate(invoice.due_date))}</td>
      <td class="num">${fmtMoney(invoice.total_cents)}</td>
      <td class="num">${fmtMoney(invoice.amount_paid_cents)}</td>
      <td class="num">${fmtMoney(invoice.credit_applied_cents)}</td>
      <td class="num amount-due">${fmtMoney(invoice.balance_cents)}</td>
      <td>${invoiceStatus(invoice)}</td>
    </tr>
  `).join('');
}

function creditRows(credits) {
  return credits.map((credit) => `
    <tr class="clickable" data-href="#/credits/${credit.id}" tabindex="0">
      <td>
        <div class="cell-main">${esc(credit.number)}</div>
        <div class="cell-sub">${credit.cancellation_number
          ? `From cancellation ${esc(credit.cancellation_number)}`
          : 'Standalone credit'}</div>
      </td>
      <td class="nowrap">${esc(fmtDate(credit.credit_date))}</td>
      <td class="num">${fmtMoney(credit.amount_cents)}</td>
      <td class="num">${fmtMoney(credit.applied_cents)}</td>
      <td class="num amount-ok">${fmtMoney(credit.remaining_cents)}</td>
      <td><a class="card-link" href="#/credits/${credit.id}">Open ${icon('chevron', 12)}</a></td>
    </tr>
  `).join('');
}

function advanceRows(advances) {
  return advances.map((advance) => {
    const source = advance.booking_id
      ? `<a href="#/bookings/${advance.booking_id}">${esc(advance.booking_number)}</a>`
      : advance.visa_id
        ? `<a href="#/visas/${advance.visa_id}">${esc(advance.visa_number)}</a>`
        : '<span class="muted">Unallocated</span>';
    return `
      <tr>
        <td><div class="cell-main">${advance.is_receipt ? `<a href="#/customer-receipts/${advance.id}">${esc(advance.number)}</a>` : esc(advance.number)}</div><div class="cell-sub">${advance.is_receipt ? 'Left from a receipt · ' : ''}${esc(fmtDate(advance.advance_date))}</div></td>
        <td>${source}</td>
        <td class="num">${fmtMoney(advance.amount_cents)}</td>
        <td class="num">${fmtMoney(advance.applied_cents)}</td>
        <td class="num">${fmtMoney(advance.refunded_cents)}</td>
        <td class="num amount-ok">${fmtMoney(advance.remaining_cents)}</td>
        <td class="nowrap">${advance.remaining_cents > 0 ? `
          <button class="btn btn-ghost btn-sm" data-advance-apply="${advance.id}">Use for invoice</button>
          <button class="btn btn-ghost btn-sm" data-advance-refund="${advance.id}">Refund</button>` : ''}</td>
      </tr>
    `;
  }).join('');
}

function cancellationRows(cancellations) {
  return cancellations.map((cancellation) => `
    <tr class="clickable" data-href="#/cancellations/${cancellation.id}" tabindex="0">
      <td><div class="cell-main">${esc(cancellation.number)}</div><div class="cell-sub">${esc(fmtDate(cancellation.cancellation_date))}</div></td>
      <td>${esc(cancellation.source_type === 'booking' ? 'Booking' : 'Visa')}</td>
      <td class="num">${fmtMoney(cancellation.refund_due_cents)}</td>
      <td class="num">${fmtMoney(cancellation.refunded_cents)}</td>
      <td class="num">${fmtMoney(cancellation.credited_cents)}</td>
      <td class="num amount-ok">${fmtMoney(cancellation.remaining_cents)}</td>
      <td><a class="card-link" href="#/cancellations/${cancellation.id}">Settle ${icon('chevron', 12)}</a></td>
    </tr>
  `).join('');
}

export async function render(container, { params } = {}) {
  const id = Number(params?.[0]);
  const data = await api.get(`/customer-balances/${id}`);
  const { customer, summary } = data;
  const creditTotal = summary.unapplied_credit_cents + summary.advance_cents + summary.cancellation_refund_cents;
  const netLabel = summary.net_balance_cents > 0
    ? 'Customer owes'
    : summary.net_balance_cents < 0
      ? 'You owe customer'
      : 'Settled';
  const netMeta = summary.net_balance_cents > 0
    ? `${fmtMoney(summary.net_balance_cents)} receivable after available credit`
    : summary.net_balance_cents < 0
      ? `${fmtMoney(Math.abs(summary.net_balance_cents))} credit held for the customer`
      : 'No receivable or credit balance';

  setHeader({
    title: `${customer.name} balance`,
    subtitle: `${customer.email || customer.phone || 'Customer account'} · ${summary.open_invoice_count} open invoice${summary.open_invoice_count === 1 ? '' : 's'}`,
    actions: `
      <a class="btn btn-ghost" href="#/customer-balances">${icon('chevron', 15)}<span>All balances</span></a>
      <a class="btn btn-secondary" href="#/customers/${customer.id}/statement">${icon('file', 15)}<span>Statement</span></a>
      <button class="btn btn-secondary" data-action="record-advance">${icon('plus', 15)}<span>Record advance</span></button>
      <button class="btn btn-primary" data-action="receive-payment">${icon('check', 15)}<span>Receive payment</span></button>
    `,
  });

  container.innerHTML = `
    <div class="kpi-grid">
      ${summaryCard('A/R due', summary.outstanding_cents, `${summary.open_invoice_count} open · ${fmtMoney(summary.overdue_cents)} overdue`, 'invoice', 'blue')}
      ${summaryCard('Available credit', creditTotal, `${fmtMoney(summary.unapplied_credit_cents)} credit notes · ${fmtMoney(summary.advance_cents)} advances`, 'wallet', 'amber')}
      ${summaryCard('Refund payable', summary.cancellation_refund_cents, `${data.cancellation_refunds.length} cancellation${data.cancellation_refunds.length === 1 ? '' : 's'} awaiting settlement`, 'arrowUp', 'indigo')}
      ${summaryCard('Net position', summary.net_balance_cents, netMeta, 'trendUp', summary.net_balance_cents > 0 ? 'green' : 'amber')}
    </div>

    ${creditTotal > 0 ? `
      <div class="callout no-print">
        <div class="callout-icon">${icon('wallet', 18)}</div>
        <div class="callout-text">
          <h3>${netLabel} ${fmtMoney(Math.abs(summary.net_balance_cents))}</h3>
          <p>Credits, advances and cancellation refunds are held on this customer account. Use the settlement queue to apply or refund them.</p>
        </div>
        <div class="callout-actions">
          <a class="btn btn-secondary btn-sm" href="#/settlement-queue">Open settlement queue</a>
        </div>
      </div>
    ` : ''}

    <div class="card">
      <div class="card-head">
        <div class="card-title"><h2>Open invoices</h2><p>${fmtMoney(summary.outstanding_cents)} receivable · ${fmtMoney(summary.overdue_cents)} overdue</p></div>
        <a class="card-link" href="#/invoices">All invoices ${icon('chevron', 12)}</a>
      </div>
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Open invoices for ${esc(customer.name)}</caption>
          <thead>
            <tr>
              <th scope="col">Invoice</th>
              <th scope="col">Due</th>
              <th scope="col" class="num">Total</th>
              <th scope="col" class="num">Paid</th>
              <th scope="col" class="num">Credits</th>
              <th scope="col" class="num">Balance</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>${invoiceRows(data.open_invoices)}</tbody>
        </table>
      </div>
    </div>

    ${data.credits.length ? `
      <div class="card" style="margin-top:16px">
        <div class="card-head">
          <div class="card-title"><h2>Customer credits</h2><p>${fmtMoney(summary.unapplied_credit_cents)} available to apply</p></div>
          <a class="card-link" href="#/credits">All credit notes ${icon('chevron', 12)}</a>
        </div>
        <div class="table-wrap">
          <table class="data"><caption class="sr-only">Customer credits for ${esc(customer.name)}</caption>
            <thead><tr><th scope="col">Credit</th><th scope="col">Date</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Applied</th><th scope="col" class="num">Remaining</th><th scope="col"></th></tr></thead>
            <tbody>${creditRows(data.credits)}</tbody>
          </table>
        </div>
      </div>
    ` : ''}

    ${data.advances.length ? `
      <div class="card" style="margin-top:16px">
        <div class="card-head">
          <div class="card-title"><h2>Customer advances</h2><p>${fmtMoney(summary.advance_cents)} unapplied</p></div>
        </div>
        <div class="table-wrap">
          <table class="data"><caption class="sr-only">Customer advances for ${esc(customer.name)}</caption>
            <thead><tr><th scope="col">Advance</th><th scope="col">Job</th><th scope="col" class="num">Received</th><th scope="col" class="num">Applied</th><th scope="col" class="num">Refunded</th><th scope="col" class="num">Remaining</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${advanceRows(data.advances)}</tbody>
          </table>
        </div>
      </div>
    ` : ''}

    ${data.cancellation_refunds.length ? `
      <div class="card" style="margin-top:16px">
        <div class="card-head">
          <div class="card-title"><h2>Cancellation refunds</h2><p>${fmtMoney(summary.cancellation_refund_cents)} still to refund or credit</p></div>
          <a class="card-link" href="#/cancellations">All cancellations ${icon('chevron', 12)}</a>
        </div>
        <div class="table-wrap">
          <table class="data"><caption class="sr-only">Cancellation refunds for ${esc(customer.name)}</caption>
            <thead><tr><th scope="col">Cancellation</th><th scope="col">Source</th><th scope="col" class="num">Refund due</th><th scope="col" class="num">Refunded</th><th scope="col" class="num">Credited</th><th scope="col" class="num">Remaining</th><th scope="col"></th></tr></thead>
            <tbody>${cancellationRows(data.cancellation_refunds)}</tbody>
          </table>
        </div>
      </div>
    ` : ''}
  `;

  const refresh = () => render(container, { params: [String(id)] });
  document.querySelector('#page-actions [data-action="record-advance"]')?.addEventListener('click', () => openRecordAdvance(customer, refresh));
  document.querySelector('#page-actions [data-action="receive-payment"]')?.addEventListener('click', () => openReceivePayment(
    customer,
    data.open_invoices,
    (receipt) => { location.hash = `#/customer-receipts/${receipt.id}`; },
  ));
  const advanceById = new Map(data.advances.map((advance) => [String(advance.id), advance]));
  container.onclick = (event) => {
    const apply = event.target.closest('[data-advance-apply]');
    if (apply) return openApplyAdvance(advanceById.get(apply.dataset.advanceApply), customer.id, refresh);
    const refund = event.target.closest('[data-advance-refund]');
    if (refund) return openRefundAdvance(advanceById.get(refund.dataset.advanceRefund), refresh);
    if (event.target.closest('a, button')) return;
    const row = event.target.closest('tr[data-href]');
    if (row) location.hash = row.dataset.href;
  };
  container.onkeydown = (event) => {
    if (event.key !== 'Enter' || !event.target.matches('tr[data-href]')) return;
    location.hash = event.target.dataset.href;
  };
  return () => {
    container.onclick = null;
    container.onkeydown = null;
  };
}
