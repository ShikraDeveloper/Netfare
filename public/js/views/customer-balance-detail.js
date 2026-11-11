import { api } from '../api.js';
import { can } from '../store.js';
import { attachmentFoldHtml, bindAttachmentSection, loadAttachments } from '../attachments.js';
import { openApplyAdvance, openReceivePayment, openRecordAdvance, openRefundAdvance, voidAdvance } from './customer-advance-modals.js';
import { bindCorrections, correctButtonHtml } from '../corrections.js';
import {
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  foldHtml,
  foldsHtml,
  icon,
  moreMenuHtml,
  numberCardHtml,
  setHeader,
  statusBadge,
  pageRecord,
} from '../ui.js';

function invoiceRows(invoices) {
  if (!invoices.length) {
    return `<tr><td colspan="7">${emptyState({
      iconName: 'invoice',
      title: 'No open invoices',
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
      <td>${statusBadge(invoice.status_display)}</td>
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
        <td><div class="cell-main">${advance.is_receipt ? `<a href="#/customer-receipts/${advance.id}">${esc(advance.number)}</a>` : esc(advance.number)}</div><div class="cell-sub">${advance.is_receipt ? (advance.remaining_cents > 0 ? 'Left from a receipt · ' : 'Receipt · ') : ''}${esc(fmtDate(advance.advance_date))}</div></td>
        <td>${source}</td>
        <td class="num">${fmtMoney(advance.amount_cents)}</td>
        <td class="num">${fmtMoney(advance.applied_cents)}</td>
        <td class="num">${fmtMoney(advance.refunded_cents)}</td>
        <td class="num amount-ok">${fmtMoney(advance.remaining_cents)}</td>
        <td class="nowrap">${advance.allowed_actions.includes('apply') ? `
          <button class="btn btn-ghost btn-sm" data-advance-apply="${advance.id}">Use for invoice</button>` : ''}${advance.allowed_actions.includes('refund') ? `
          <button class="btn btn-ghost btn-sm" data-advance-refund="${advance.id}">Refund</button>` : ''}
          ${advance.allowed_actions.includes('correct') ? correctButtonHtml('advance', advance) : ''}
          ${advance.allowed_actions.includes('void') ? `<button class="icon-btn danger" data-void-advance="${advance.id}" title="Void advance" aria-label="Void ${esc(advance.number)}">${icon('trash', 16)}</button>` : ''}</td>
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
  // Documents (passport, Emirates ID) are for staff with Customers Edit.
  const showDocuments = can('customers', 'edit');
  const [data, documents] = await Promise.all([
    api.get(`/customer-balances/${id}`),
    showDocuments ? loadAttachments('customer', id) : [],
  ]);
  const { customer, summary } = data;
  const creditTotal = summary.unapplied_credit_cents + summary.advance_cents + summary.cancellation_refund_cents;
  pageRecord(customer);
  setHeader({
    title: customer.name,
    badge: customer.number ? `<span class="page-title-number">${esc(customer.number)}</span>` : '',
    actions: `
      <button class="btn btn-primary" data-action="receive-payment">${icon('check', 15)}<span>Receive payment</span></button>
      ${moreMenuHtml([
    `<button class="btn btn-ghost" data-action="record-advance">${icon('plus', 15)}<span>Record advance</span></button>`,
    `<a class="btn btn-ghost" href="#/customers/${customer.id}/statement">${icon('file', 15)}<span>Statement</span></a>`,
    `<a class="btn btn-ghost" href="#/settlement-queue">${icon('clock', 15)}<span>Settlements</span></a>`,
    `<a class="btn btn-ghost" href="#/customer-balances"><span>All balances</span></a>`,
  ])}
    `,
  });

  container.innerHTML = `
    <div class="kpi-grid">
      ${numberCardHtml({ label: 'To collect', cents: summary.outstanding_cents, overdue: summary.overdue_cents > 0 })}
      ${numberCardHtml({ label: 'Credit', cents: creditTotal - summary.cancellation_refund_cents })}
      ${numberCardHtml({ label: 'Refund due', cents: summary.cancellation_refund_cents })}
      ${numberCardHtml({ label: 'Net', cents: summary.net_balance_cents })}
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title"><h2>Open invoices</h2></div>
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

    ${foldsHtml([
    data.credits.length && foldHtml({
      key: 'credits',
      title: 'Credit notes',
      count: data.credits.length,
      actions: `<a class="card-link" href="#/credits">All credit notes ${icon('chevron', 12)}</a>`,
      body: `<div class="table-wrap">
          <table class="data"><caption class="sr-only">Customer credits for ${esc(customer.name)}</caption>
            <thead><tr><th scope="col">Credit</th><th scope="col">Date</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Applied</th><th scope="col" class="num">Remaining</th><th scope="col"></th></tr></thead>
            <tbody>${creditRows(data.credits)}</tbody>
          </table>
        </div>`,
    }),
    data.advances.length && foldHtml({
      key: 'advances',
      title: 'Advances',
      count: data.advances.length,
      body: `<div class="table-wrap">
          <table class="data"><caption class="sr-only">Customer advances for ${esc(customer.name)}</caption>
            <thead><tr><th scope="col">Advance</th><th scope="col">Job</th><th scope="col" class="num">Received</th><th scope="col" class="num">Applied</th><th scope="col" class="num">Refunded</th><th scope="col" class="num">Remaining</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${advanceRows(data.advances)}</tbody>
          </table>
        </div>`,
    }),
    data.cancellation_refunds.length && foldHtml({
      key: 'cancellation-refunds',
      title: 'Cancellation refunds',
      count: data.cancellation_refunds.length,
      actions: `<a class="card-link" href="#/cancellations">All cancellations ${icon('chevron', 12)}</a>`,
      body: `<div class="table-wrap">
          <table class="data"><caption class="sr-only">Cancellation refunds for ${esc(customer.name)}</caption>
            <thead><tr><th scope="col">Cancellation</th><th scope="col">Source</th><th scope="col" class="num">Refund due</th><th scope="col" class="num">Refunded</th><th scope="col" class="num">Credited</th><th scope="col" class="num">Remaining</th><th scope="col"></th></tr></thead>
            <tbody>${cancellationRows(data.cancellation_refunds)}</tbody>
          </table>
        </div>`,
    }),
    showDocuments && attachmentFoldHtml({ entityType: 'customer', entityId: id, attachments: documents, title: 'Documents' }),
  ])}
  `;

  const refresh = () => render(container, { params: [String(id)] });
  if (showDocuments) bindAttachmentSection(container, { entityType: 'customer', entityId: id });
  document.querySelector('#page-actions [data-action="record-advance"]')?.addEventListener('click', () => openRecordAdvance(customer, refresh));
  document.querySelector('#page-actions [data-action="receive-payment"]')?.addEventListener('click', () => openReceivePayment(
    customer,
    data.open_invoices,
    (receipt) => { location.hash = `#/customer-receipts/${receipt.id}`; },
  ));
  const advanceById = new Map(data.advances.map((advance) => [String(advance.id), advance]));
  bindCorrections(container, refresh);
  container.onclick = (event) => {
    const apply = event.target.closest('[data-advance-apply]');
    if (apply) return openApplyAdvance(advanceById.get(apply.dataset.advanceApply), customer.id, refresh);
    const refund = event.target.closest('[data-advance-refund]');
    if (refund) return openRefundAdvance(advanceById.get(refund.dataset.advanceRefund), refresh);
    const voidButton = event.target.closest('[data-void-advance]');
    if (voidButton) return voidAdvance(advanceById.get(voidButton.dataset.voidAdvance), refresh);
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
