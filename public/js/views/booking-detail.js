import { api } from '../api.js';
import { store } from '../store.js';
import {
  confirmDialog,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  fmtNumber,
  icon,
  openModal,
  setHeader,
  statusBadge,
  todayISO,
  toast,
  toCents,
  voidDialog,
} from '../ui.js';
import { openBookingModal } from './bookings.js';
import { openCancellationModal } from './cancellation-modal.js';
import { attachmentSection, bindAttachmentSection, loadAttachments } from '../attachments.js';

import { advanceModalBody, applyModalBody, depositAccounts, postingPreview, refundModalBody } from './job-modals.js';

const STATUS_HISTORY_EMPTY = 'No status changes recorded yet.';

// When the job moved between statuses, and why. Shown on screen only.
function statusHistoryCard(history = []) {
  return `
    <div class="card no-print" style="margin-top:16px" data-status-history>
      <div class="card-head"><div class="card-title"><h2>Status history</h2><p>When this job changed status</p></div></div>
      <div class="table-wrap">
        <table class="data">
          <caption class="sr-only">Status history</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Remarks</th></tr></thead>
          <tbody>
            ${history.length ? history.map((row) => `
              <tr>
                <td class="nowrap">${esc(fmtDate(row.event_date))}</td>
                <td>${row.from_status ? statusBadge(row.from_status) : '—'}</td>
                <td>${statusBadge(row.to_status)}</td>
                <td class="muted">${esc(row.remarks || '')}</td>
              </tr>
            `).join('') : `<tr><td colspan="4" class="muted">${STATUS_HISTORY_EMPTY}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export async function render(container, { params } = {}) {
  const id = Number(params?.[0]);
  const booking = await api.get(`/bookings/${id}`);
  const attachments = await loadAttachments('booking', id);

  const isDraft = booking.status === 'draft';
  const isConfirmed = booking.status === 'confirmed';
  const isCancelled = booking.status === 'cancelled';
  const invoice = booking.invoice;
  const canApplyAdvance = Boolean(invoice && invoice.status === 'sent' && invoice.balance_cents > 0 && booking.advances.some((advance) => advance.remaining_cents > 0));

  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const marginClass = booking.margin_cents >= 0 ? 'margin-positive' : 'margin-negative';
  const marginPercent = booking.sale_total_cents ? (booking.margin_cents / booking.sale_total_cents) * 100 : 0;

  const actions = [];
  actions.push(`<a class="btn btn-ghost" href="#/bookings"><span>All bookings</span></a>`);
  actions.push(`<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>`);
  if (isDraft) {
    actions.push(`<button class="btn btn-secondary" data-action="edit">${icon('edit', 15)}<span>Edit</span></button>`);
    actions.push(`<button class="icon-btn danger" data-action="delete" title="Delete draft">${icon('trash', 17)}</button>`);
    actions.push(`<button class="btn btn-primary" data-action="confirm">${icon('check', 15)}<span>Confirm &amp; post</span></button>`);
  }
  if (isConfirmed) {
    const travelAhead = booking.travel_date && booking.travel_date > todayISO();
    actions.push(`<button class="btn btn-secondary" data-action="travel" ${travelAhead ? `disabled title="Available from the travel date (${esc(fmtDate(booking.travel_date))})"` : ''}>${icon('check', 15)}<span>Mark travelled</span></button>`);
  }
  if (!isCancelled) {
    actions.push(`<button class="btn btn-danger-ghost" data-action="cancel"><span>Cancel booking</span></button>`);
  }

  actions.push(`<a class="btn btn-ghost" href="#/audit-chain/booking/${id}">${icon('shield', 15)}<span>Audit chain</span></a>`);
  setHeader({
    title: booking.number,
    subtitle: `${booking.customer_name} · ${booking.destination || 'No destination'} · ${booking.status.charAt(0).toUpperCase()}${booking.status.slice(1)}`,
    actions: actions.join(''),
  });

  const saleRows = booking.sale_items.map((item) => `
    <tr>
      <td>${esc(item.description)}</td>
      <td class="num">${fmtNumber(item.quantity)}</td>
      <td class="num">${fmtMoney(item.unit_price_cents)}</td>
      <td class="muted">${esc(item.account_code)} · ${esc(item.account_name)}</td>
      <td class="num amount">${fmtMoney(item.amount_cents)}</td>
    </tr>
  `).join('') || `<tr><td colspan="5" class="muted">No sale items</td></tr>`;

  const costRows = booking.cost_items.map((item) => `
    <tr>
      <td>${esc(item.description)}</td>
      <td class="num">${fmtNumber(item.quantity)}</td>
      <td class="num">${fmtMoney(item.unit_price_cents)}</td>
      <td class="muted">${esc(item.account_code)} · ${esc(item.account_name)}</td>
      <td>${esc(item.vendor_name || '—')}${item.supplier_ref ? `<small class="cell-sub"> · ${esc(item.supplier_ref)}</small>` : ''}</td>
      <td class="num amount">${fmtMoney(item.amount_cents)}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" class="muted">No cost items</td></tr>`;

  const advanceRows = booking.advances.map((advance) => `
    <div class="payment-item">
      <div class="payment-icon">${icon('wallet', 15)}</div>
      <div class="payment-main">
        <strong>${esc(advance.number)} · ${statusBadge(advance.status_display || advance.status)}</strong>
        <span>${esc(fmtDate(advance.advance_date))} · ${esc(advance.method || 'Advance')}${advance.reference ? ` · ${esc(advance.reference)}` : ''} · Received ${fmtMoney(advance.amount_cents)}</span>
      </div>
      <div class="payment-amount">${fmtMoney(advance.remaining_cents)} <small class="muted">left</small></div>
      <div style="display:flex;gap:4px">
        ${advance.remaining_cents > 0 ? `<button class="icon-btn" data-refund-advance="${advance.id}" title="Refund remaining">${icon('arrowUp', 16)}</button>` : ''}
        ${!advance.voided ? `<button class="icon-btn danger" data-void-advance="${advance.id}" title="Void advance">${icon('trash', 16)}</button>` : ''}
      </div>
    </div>
  `).join('');

  const paymentRows = booking.payments.length
    ? booking.payments.map((payment) => `
        <div class="payment-item">
          <div class="payment-icon">${icon('cash', 15)}</div>
          <div class="payment-main">
            <strong>${esc(payment.method || 'Payment')}</strong>
            <span>${esc(fmtDate(payment.payment_date))} · ${esc(payment.number)}${payment.reference ? ` · ${esc(payment.reference)}` : ''}${payment.status === 'void' ? ` · ${statusBadge('void')}` : ''}</span>
          </div>
          <div class="payment-amount">${fmtMoney(payment.amount_cents)}</div>
        </div>
      `).join('')
    : emptyState({
      iconName: 'cash',
      title: 'No payments yet',
      message: invoice && invoice.balance_cents > 0 ? 'Record a payment or apply an advance to reduce the balance.' : 'Payments will appear here once recorded.',
    });

  const billRows = booking.bills.length
    ? booking.bills.map((bill) => `
        <div class="payment-item">
          <div class="payment-icon">${icon('bill', 15)}</div>
          <div class="payment-main">
            <strong>${esc(bill.number)} · ${esc(bill.vendor_name)}</strong>
            <span>${esc(fmtDate(bill.bill_date))} · Total ${fmtMoney(bill.total_cents)} · ${statusBadge(bill.status_display || bill.status)}${bill.portal_name ? ` · Paid from ${esc(bill.portal_name)}` : ''}</span>
          </div>
          <div class="payment-amount">${fmtMoney(bill.balance_cents)} <small class="muted">due</small></div>
          <a class="icon-btn" href="#/bills/${bill.id}" title="Open bill">${icon('chevron', 16)}</a>
        </div>
      `).join('')
    : `<div class="muted" style="font-size:12.5px;padding:6px 0">${isDraft ? 'Supplier bills are created automatically when you confirm this booking.' : 'No supplier bills linked.'}</div>`;

  const cancellation = booking.cancellation;
  const cancellationCard = cancellation
    ? `
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Cancellation</h2><p>${esc(cancellation.number)} · ${esc(fmtDate(cancellation.cancellation_date))}</p></div>
          <a class="card-link" href="#/cancellations/${cancellation.id}">Open note ${icon('chevron', 12)}</a>
        </div>
        <div class="card-body">
          <div class="detail-list">
            <div><span>Cancellation charges</span><strong>${fmtMoney(cancellation.customer_charges_cents)}</strong></div>
            <div><span>Money held</span><strong>${fmtMoney(cancellation.received_cents)}</strong></div>
            <div><span>Supplier credit</span><strong>${fmtMoney(cancellation.supplier_credit_total_cents)}</strong></div>
            <div><span>Refund remaining</span><strong>${fmtMoney(cancellation.refund_remaining_cents)}</strong></div>
          </div>
          ${cancellation.refund_remaining_cents > 0 ? `
            <div style="margin-top:14px;display:flex;gap:8px">
              <a class="btn btn-primary btn-sm" href="#/cancellations/${cancellation.id}">${icon('arrowUp', 14)} Pay refund or convert to credit</a>
            </div>
          ` : ''}
        </div>
      </div>
    `
    : '';

  const invoiceCard = invoice
    ? `
      <div class="payment-item">
        <div class="payment-icon">${icon('invoice', 15)}</div>
        <div class="payment-main">
          <strong>${esc(invoice.number)} · ${statusBadge(invoice.status_display || invoice.status)}</strong>
          <span>Issued ${esc(fmtDate(invoice.issue_date))} · Total ${fmtMoney(invoice.total_cents)} · Paid ${fmtMoney(invoice.amount_paid_cents)}</span>
        </div>
        <div class="payment-amount">${fmtMoney(invoice.balance_cents)} <small class="muted">due</small></div>
        <a class="icon-btn" href="#/invoices/${invoice.id}" title="Open invoice">${icon('chevron', 16)}</a>
      </div>
    `
    : `<div class="muted" style="font-size:12.5px;padding:6px 0">${isDraft ? 'A customer invoice is created when you confirm this booking.' : 'No customer invoice linked.'}</div>`;

  container.innerHTML = `
    ${booking.notes ? `
      <div class="callout internal-notes no-print" data-internal-notes>
        <div class="callout-text">
          <h3>Internal notes</h3>
          <p>${esc(booking.notes)}</p>
          <p class="muted">Only staff see these notes. They are not printed or copied to the customer invoice.</p>
        </div>
      </div>` : ''}
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
            <div class="doc-kind">Booking confirmation</div>
            <div class="doc-number">${esc(booking.number)}</div>
            <div class="doc-status">${statusBadge(booking.status)}</div>
            <dl class="doc-meta-grid">
              <dt>Booking date</dt><dd>${esc(fmtDate(booking.booking_date))}</dd>
              <dt>Travel date</dt><dd>${booking.travel_date ? esc(fmtDate(booking.travel_date)) : '—'}</dd>
              <dt>Return date</dt><dd>${booking.return_date ? esc(fmtDate(booking.return_date)) : '—'}</dd>
              <dt>PNR / ticket</dt><dd>${esc(booking.pnr || '—')}</dd>
            </dl>
          </div>
        </div>

        <div class="doc-parties">
          <div>
            <div class="doc-label">Traveller / customer</div>
            <div class="doc-party-name">${esc(booking.customer_name)}</div>
            <div class="doc-party-detail">${esc([booking.customer_address, booking.customer_email, booking.customer_phone].filter(Boolean).join('\n'))}</div>
          </div>
          <div>
            <div class="doc-label">Itinerary</div>
            <div class="doc-terms">${esc(booking.destination ? `Destination: ${booking.destination}` : 'No destination recorded.')}${booking.invoice_notes ? esc(`\n${booking.invoice_notes}`) : ''}</div>
          </div>
        </div>

        <div class="doc-items-wrap">
          <div class="doc-label" style="margin-bottom:8px">Sale items</div>
          <table class="doc-items"><caption class="sr-only">Booking sale items</caption>
            <thead>
              <tr>
                <th scope="col" style="width:38%">Description</th>
                <th scope="col" class="num">Qty</th>
                <th scope="col" class="num">Unit price</th>
                <th scope="col">Revenue account</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>${saleRows}</tbody>
          </table>

          <div class="doc-label" style="margin:18px 0 8px">Supplier cost items</div>
          <table class="doc-items"><caption class="sr-only">Booking supplier costs</caption>
            <thead>
              <tr>
                <th scope="col" style="width:30%">Description</th>
                <th scope="col" class="num">Qty</th>
                <th scope="col" class="num">Unit cost</th>
                <th scope="col">Cost account</th>
                <th scope="col">Supplier</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>${costRows}</tbody>
          </table>
        </div>

        <div class="doc-total-area">
          <div class="doc-notes"></div>
          <div class="doc-totals">
            <div class="totals-row"><span>Total sale</span><span>${fmtMoney(booking.sale_total_cents)}</span></div>
            <div class="totals-row"><span>Total cost</span><span>${fmtMoney(booking.cost_total_cents)}</span></div>
            <div class="totals-row total"><span>Margin</span><span class="${marginClass}">${fmtMoney(booking.margin_cents)}</span></div>
            <div class="totals-row"><span class="muted">Profitability</span><span class="muted">${marginPercent.toFixed(1)}%</span></div>
            <div class="totals-row balance"><span>Customer balance</span><span>${fmtMoney(booking.balance_cents)}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="detail-grid no-print">
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Customer invoice</h2><p>${invoice ? fmtMoney(invoice.balance_cents) + ' outstanding' : 'Created on confirmation'}</p></div>
          ${invoice && invoice.status === 'sent' && invoice.balance_cents > 0 ? `<a class="card-link" href="#/invoices/${invoice.id}">Record payment ${icon('chevron', 12)}</a>` : ''}
        </div>
        <div class="card-body" style="padding:6px 20px">${invoiceCard}</div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Supplier bills</h2><p>${booking.bills.length} bill${booking.bills.length === 1 ? '' : 's'} · ${fmtMoney(booking.cost_total_cents)} cost</p></div>
        </div>
        <div class="card-body" style="padding:6px 20px">${billRows}</div>
      </div>

      ${cancellationCard}

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Customer advances</h2><p>${booking.advances.length ? `${booking.advances.length} advance${booking.advances.length === 1 ? '' : 's'}` : 'No advances recorded'}</p></div>
          <div style="display:flex;gap:6px">
            ${canApplyAdvance ? `<button class="btn btn-secondary btn-sm" data-action="apply-advance">${icon('check', 14)} Apply</button>` : ''}
            ${!isCancelled ? `<button class="btn btn-primary btn-sm" data-action="record-advance">${icon('plus', 14)} Record</button>` : ''}
          </div>
        </div>
        <div class="card-body" ${booking.advances.length ? 'style="padding:4px 20px"' : ''}>
          ${booking.advances.length ? advanceRows : emptyState({
    iconName: 'wallet',
    title: 'No advances recorded',
    message: 'Record a deposit if the customer pays before the trip.',
  })}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Payments received</h2><p>${invoice ? `${fmtMoney(invoice.amount_paid_cents)} received` : 'No invoice yet'}</p></div>
        </div>
        <div class="card-body" ${booking.payments.length ? 'style="padding:4px 20px"' : ''}>${paymentRows}</div>
      </div>
    </div>

    ${statusHistoryCard(booking.status_history)}
    ${attachmentSection({ entityType: 'booking', entityId: id, attachments })}
  `;

  bindAttachmentSection(container, { entityType: 'booking', entityId: id });

  function refresh() {
    return render(container, { params: [String(id)] });
  }

  function on(selector, handler) {
    document.querySelectorAll(selector).forEach((element) => element.addEventListener('click', handler));
  }

  on('[data-action="print"]', () => window.print());

  const editButton = document.querySelector('[data-action="edit"]');
  if (editButton) {
    editButton.addEventListener('click', () => openBookingModal({ booking, onSaved: () => refresh() }));
  }

  const confirmButton = document.querySelector('[data-action="confirm"]');
  if (confirmButton) {
    confirmButton.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: `Confirm ${booking.number}?`,
        message: 'Check what will be posted to your ledger. Once confirmed, the booking can only be changed by cancelling it.',
        preview: postingPreview(booking, await api.get('/portals').catch(() => null)),
        confirmLabel: 'Confirm & post',
        danger: false,
      });
      if (!confirmed) return;
      try {
        const result = await api.post(`/bookings/${id}/confirm`, {});
        toast(`${booking.number} confirmed and posted`);
        if (Array.isArray(result?.warnings)) {
          result.warnings.forEach((warning) => toast(warning, 'error'));
        }
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  const travelButton = document.querySelector('[data-action="travel"]');
  if (travelButton) {
    travelButton.addEventListener('click', async () => {
      try {
        await api.post(`/bookings/${id}/travel`, {});
        toast(`${booking.number} marked as travelled`);
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  const deleteButton = document.querySelector('[data-action="delete"]');
  if (deleteButton) {
    deleteButton.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: 'Delete this draft booking?',
        message: `${booking.number} and its line items will be permanently deleted. Nothing has been posted to the ledger yet.`,
        confirmLabel: 'Delete booking',
      });
      if (!confirmed) return;
      try {
        await api.del(`/bookings/${id}`);
        toast('Draft booking deleted');
        location.hash = '#/bookings';
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  const cancelButton = document.querySelector('[data-action="cancel"]');
  if (cancelButton) {
    cancelButton.addEventListener('click', () => {
      openCancellationModal({
        job: booking,
        sourceType: 'booking',
        onDone: (saved) => {
          if (saved?.cancellation) {
            location.hash = `#/cancellations/${saved.cancellation.id}?settle=1`;
            return;
          }
          refresh();
        },
      });
    });
  }

  on('[data-action="record-advance"]', () => {
    openModal({
      title: 'Record customer advance',
      subtitle: `${booking.number} · ${booking.customer_name}`,
      body: advanceModalBody(booking, 'booking'),
      submitLabel: 'Record advance',
      onMount(overlay) {
        const method = overlay.querySelector('#adv-method');
        const account = overlay.querySelector('#adv-account');
        if (!method || !account) return;
        method.addEventListener('change', () => {
          const { accounts } = depositAccounts();
          const code = method.value === 'Cash' ? '1000' : '1010';
          const target = accounts.find((candidate) => candidate.code === code);
          if (target) account.value = String(target.id);
        });
      },
      async onSubmit(form) {
        const values = new FormData(form);
        const amount = toCents(values.get('amount'));
        if (amount <= 0) throw new Error('Enter an advance amount');
        await api.post('/advances', {
          customer_id: booking.customer_id,
          booking_id: booking.id,
          amount_cents: amount,
          advance_date: values.get('advance_date'),
          method: values.get('method'),
          reference: values.get('reference'),
          deposit_account_id: Number(values.get('deposit_account_id')),
        });
        toast(`Advance of ${fmtMoney(amount)} recorded`);
        refresh();
      },
    });
  });

  const applyButton = document.querySelector('[data-action="apply-advance"]');
  if (applyButton) {
    applyButton.addEventListener('click', () => {
      const openAdvances = booking.advances.filter((advance) => advance.remaining_cents > 0);
      openModal({
        title: 'Apply advance to invoice',
        subtitle: `${booking.invoice.number} · ${fmtMoney(booking.invoice.balance_cents)} due`,
        body: applyModalBody(booking, openAdvances),
        submitLabel: 'Apply advance',
        async onSubmit(form) {
          const values = new FormData(form);
          const advanceId = Number(values.get('advance_id'));
          if (!advanceId) throw new Error('Choose an advance');
          await api.post(`/advances/${advanceId}/apply`, {
            invoice_id: booking.invoice.id,
            payment_date: values.get('payment_date'),
          });
          toast('Advance applied to the invoice');
          refresh();
        },
      });
    });
  }

  document.querySelectorAll('[data-refund-advance]').forEach((button) => {
    button.addEventListener('click', () => {
      const advance = booking.advances.find((item) => item.id === Number(button.dataset.refundAdvance));
      if (!advance) return;
      openModal({
        title: `Refund ${advance.number}`,
        subtitle: `${booking.customer_name} · ${fmtMoney(advance.remaining_cents)} available`,
        body: refundModalBody(advance),
        submitLabel: 'Record refund',
        async onSubmit(form) {
          const values = new FormData(form);
          const amount = toCents(values.get('amount'));
          if (amount <= 0) throw new Error('Enter a refund amount');
          await api.post(`/advances/${advance.id}/refund`, {
            amount_cents: amount,
            refund_date: values.get('refund_date'),
            payment_account_id: Number(values.get('payment_account_id')),
          });
          toast(`Refund of ${fmtMoney(amount)} recorded`);
          refresh();
        },
      });
    });
  });

  document.querySelectorAll('[data-void-advance]').forEach((button) => {
    button.addEventListener('click', async () => {
      const advance = booking.advances.find((item) => item.id === Number(button.dataset.voidAdvance));
      const result = await voidDialog({
        title: `Void ${advance ? advance.number : 'this advance'}?`,
        message: 'The advance will be reversed. Any refunds or invoice applications funded by this advance will also be reversed.',
        warning: 'This cannot be undone. The advance stays in history as void and the reversal is written to the audit log.',
        preview: advance ? {
          heading: 'Void preview',
          items: [
            {
              label: `Advance ${advance.number}`,
              value: fmtMoney(advance.amount_cents),
              note: `${fmtDate(advance.advance_date)} · ${advance.method || 'Advance'}`,
            },
            {
              label: 'Applied to invoices',
              value: fmtMoney(advance.applied_cents),
              note: 'Invoice applications will be reversed',
            },
            {
              label: 'Refunded to customer',
              value: fmtMoney(advance.refunded_cents),
              note: 'Advance refunds will be reversed',
            },
          ],
          note: 'The advance stays in history as void and the reversal is written to the audit log.',
        } : null,
        confirmLabel: 'Void advance',
      });
      if (!result.confirmed) return;
      try {
        await api.post(`/advances/${button.dataset.voidAdvance}/void`, { remarks: result.remarks });
        toast('Advance voided with a reversing entry');
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  return () => {};
}
