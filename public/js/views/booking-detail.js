import { voidAdvance } from './customer-advance-modals.js';
import { api } from '../api.js';
import { bindMethodAccount } from '../payment-methods.js';
import { store } from '../store.js';
import {
  companyMark,
  confirmDialog,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  fmtNumber,
  icon,
  moreMenuHtml,
  openModal,
  setHeader,
  statusBadge,
  summaryStripHtml,
  toast,
  toCents,
  todayISO,
  voidDialog,
  pageRecord
} from '../ui.js';
import { bindCorrections, correctButtonHtml } from '../corrections.js';
import { openBookingModal } from './bookings.js';
import { openCancellationModal } from './cancellation-modal.js';
import { attachmentSection, bindAttachmentSection, loadAttachments } from '../attachments.js';
import { bindRefunds, refundsCardHtml } from './job-refunds.js';
import { openReminderForm } from '../reminders.js';

import { advanceModalBody, applyModalBody, depositAccounts, postingPreview, refundModalBody } from './job-modals.js';

const STATUS_HISTORY_EMPTY = 'No status changes recorded yet.';

// When the job moved between statuses, and why. Shown on screen only.
function statusHistoryCard(history = []) {
  return `
    <div class="card no-print" style="margin-top:16px" data-status-history>
      <div class="card-head"><div class="card-title"><h2>Status history</h2></div></div>
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
  // After refunds or a cancellation the profit is the kept sale less the cost
  // left after supplier refunds.
  const result = booking.result || null;
  const saleForMargin = result ? result.sale_cents : booking.sale_total_cents;
  const marginPercent = saleForMargin ? (booking.margin_cents / saleForMargin) * 100 : 0;

  const actions = [];
  const menu = [
    `<a class="btn btn-ghost" href="#/bookings"><span>All bookings</span></a>`,
    `<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>`,
  ];
  if (isDraft) {
    actions.push(`<button class="btn btn-secondary" data-action="edit">${icon('edit', 15)}<span>Edit</span></button>`);
    actions.push(`<button class="icon-btn danger" data-action="delete" title="Delete draft">${icon('trash', 17)}</button>`);
    actions.push(`<button class="btn btn-primary" data-action="confirm">${icon('check', 15)}<span>Confirm &amp; post</span></button>`);
  }
  if (isConfirmed) {
    const travelAhead = booking.travel_date && booking.travel_date > todayISO();
    actions.push(`<button class="btn btn-secondary" data-action="travel" ${travelAhead ? `disabled title="Available from the travel date (${esc(fmtDate(booking.travel_date))})"` : ''}>${icon('check', 15)}<span>Mark travelled</span></button>`);
  }
  if (invoice && invoice.status === 'sent' && invoice.balance_cents > 0) {
    actions.push(`<a class="btn btn-primary" href="#/invoices/${invoice.id}">${icon('plus', 15)}<span>Record payment</span></a>`);
  }
  menu.push(`<button class="btn btn-ghost" data-action="toggle-accounting">${icon('accounts', 15)}<span>Show or hide account codes</span></button>`);
  menu.push(`<button class="btn btn-ghost" data-action="add-reminder">${icon('clock', 15)}<span>Add reminder</span></button>`);
  menu.push(`<a class="btn btn-ghost" href="#/audit-chain/booking/${id}">${icon('shield', 15)}<span>Audit chain</span></a>`);
  if (!isCancelled) {
    menu.push(`<button class="btn btn-danger-ghost" data-action="cancel"><span>Cancel booking</span></button>`);
  }
  // Details that do not touch money: anyone with Edit rights.
  if (!isDraft && !booking.voided_at) {
    menu.push(`<button class="btn btn-ghost" data-action="edit-details">${icon('edit', 15)}<span>Edit details</span></button>`);
  }
  // Admin only: correct the lines, or undo a booking entered by mistake (a
  // cancelled one has a note to void instead).
  if (!isDraft && !isCancelled) {
    menu.push(`<button class="btn btn-ghost" data-action="correct-document">${icon('edit', 15)}<span>Correct</span></button>`);
    menu.push(`<button class="btn btn-danger-ghost" data-action="void-job"><span>Void (entered by mistake)</span></button>`);
  }
  pageRecord(booking);
  setHeader({
    title: booking.number,
    badge: statusBadge(booking.status_display || booking.status),
    actions: actions.join('') + moreMenuHtml(menu),
  });

  const saleRows = booking.sale_items.map((item) => `
    <tr>
      <td>${esc(item.description)}</td>
      <td class="num">${fmtNumber(item.quantity)}</td>
      <td class="num">${fmtMoney(item.unit_price_cents)}</td>
      <td class="muted acct-col">${esc(item.account_code)} · ${esc(item.account_name)}</td>
      <td class="num amount">${fmtMoney(item.amount_cents)}</td>
    </tr>
  `).join('') || `<tr><td colspan="5" class="muted">No sale items</td></tr>`;

  const costRows = booking.cost_items.map((item) => `
    <tr>
      <td>${esc(item.description)}</td>
      <td class="num">${fmtNumber(item.quantity)}</td>
      <td class="num">${fmtMoney(item.unit_price_cents)}</td>
      <td class="muted acct-col">${esc(item.account_code)} · ${esc(item.account_name)}</td>
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
        ${!advance.voided && !advance.applied_cents && !advance.refunded_cents && !advance.is_receipt ? correctButtonHtml('advance', advance) : ''}
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
  const refundsCard = booking.status === 'draft' ? '' : refundsCardHtml(booking);
  const cancellationCard = cancellation
    ? `
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Cancellation ${esc(cancellation.number)}</h2></div>
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
    ${summaryStripHtml([
      { label: 'Total', value: fmtMoney(booking.sale_total_cents) },
      { label: 'Paid', value: fmtMoney(booking.amount_paid_cents || 0) },
      { label: 'Balance', value: fmtMoney(booking.balance_cents || 0), tone: booking.balance_cents > 0 && booking.invoice ? 'due' : '' },
      { label: 'Gross profit', value: fmtMoney(booking.margin_cents), tone: booking.margin_cents >= 0 ? 'good' : 'bad' },
    ])}
    ${booking.notes ? `
      <div class="callout internal-notes no-print" data-internal-notes>
        <div class="callout-text">
          <h3>Internal notes</h3>
          <p>${esc(booking.notes)}</p>
        </div>
      </div>` : ''}
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
            <div class="doc-kind">Booking confirmation</div>
            <div class="doc-number">${esc(booking.number)}</div>
            <div class="doc-status">${statusBadge(booking.status_display || booking.status)}</div>
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

        <div class="doc-items-wrap" tabindex="0" role="region" aria-label="Line items">
          <div class="doc-label" style="margin-bottom:8px">Sale items</div>
          <table class="doc-items"><caption class="sr-only">Booking sale items</caption>
            <thead>
              <tr>
                <th scope="col" style="width:38%">Description</th>
                <th scope="col" class="num">Qty</th>
                <th scope="col" class="num">Unit price</th>
                <th scope="col" class="acct-col">Revenue account</th>
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
                <th scope="col" class="acct-col">Cost account</th>
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
            ${result && result.sale_cents !== booking.sale_total_cents ? `<div class="totals-row" data-result-sale><span>${booking.cancellation ? 'Sale after cancellation' : 'Sale after refund to customer'}</span><span>${fmtMoney(result.sale_cents)}</span></div>` : ''}
            <div class="totals-row"><span>Total cost</span><span>${fmtMoney(booking.cost_total_cents)}</span></div>
            ${result && result.cost_cents !== booking.cost_total_cents ? `<div class="totals-row" data-result-cost><span>Cost after supplier refund</span><span>${fmtMoney(result.cost_cents)}</span></div>` : ''}
            <div class="totals-row total"><span>Gross profit</span><span class="${marginClass}">${fmtMoney(booking.margin_cents)}</span></div>
            <div class="totals-row"><span class="muted">Gross margin</span><span class="muted">${marginPercent.toFixed(1)}%</span></div>
            <div class="totals-row balance"><span>Customer balance</span><span>${fmtMoney(booking.balance_cents)}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="detail-grid no-print">
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Customer invoice</h2></div>
          ${invoice && invoice.status === 'sent' && invoice.balance_cents > 0 ? `<a class="card-link" href="#/invoices/${invoice.id}">Record payment ${icon('chevron', 12)}</a>` : ''}
        </div>
        <div class="card-body" style="padding:6px 20px">${invoiceCard}</div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Supplier bills</h2></div>
        </div>
        <div class="card-body" style="padding:6px 20px">${billRows}</div>
      </div>

      ${cancellationCard}
      ${refundsCard}

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Customer advances</h2></div>
          <div style="display:flex;gap:6px">
            ${canApplyAdvance ? `<button class="btn btn-secondary btn-sm" data-action="apply-advance">${icon('check', 14)} Apply</button>` : ''}
            ${!isCancelled ? `<button class="btn btn-primary btn-sm" data-action="record-advance">${icon('plus', 14)} Record</button>` : ''}
          </div>
        </div>
        <div class="card-body" ${booking.advances.length ? 'style="padding:4px 20px"' : ''}>
          ${booking.advances.length ? advanceRows : emptyState({
    iconName: 'wallet',
    title: 'No advances recorded',
  })}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Payments received</h2></div>
        </div>
        <div class="card-body" ${booking.payments.length ? 'style="padding:4px 20px"' : ''}>${paymentRows}</div>
      </div>
    </div>

    ${statusHistoryCard(booking.status_history)}
    ${attachmentSection({ entityType: 'booking', entityId: id, attachments })}
  `;

  bindAttachmentSection(container, { entityType: 'booking', entityId: id });
  bindCorrections(container, () => render(container, { params: [String(id)] }));
  bindRefunds(container, booking, 'booking', () => render(container, { params: [String(id)] }));
  document.querySelector('[data-action="add-reminder"]')?.addEventListener('click', () => openReminderForm({
    link: { type: 'booking', id: booking.id, label: [booking.number, booking.customer_name].filter(Boolean).join(' · ') },
  }));

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
        const result = await api.post(`/bookings/${id}/confirm`, { apply_advances: true });
        toast(`${booking.number} confirmed and posted`);
        (result?.applied_advances || []).forEach((row) => toast(`Advance ${row.number} applied: ${fmtMoney(row.amount_cents)}`));
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

  document.querySelector('[data-action="edit-details"]')?.addEventListener('click', () => {
    const sale = booking.sale_items || [];
    const cost = booking.cost_items || [];
    openModal({
      title: `Edit details · ${booking.number}`,
      submitLabel: 'Save details',
      body: `
        <div class="form-grid">
          <div class="field"><label for="ed-travel">Travel date</label><input class="input" id="ed-travel" name="travel_date" type="date" value="${esc(booking.travel_date || '')}"></div>
          <div class="field"><label for="ed-return">Return date</label><input class="input" id="ed-return" name="return_date" type="date" value="${esc(booking.return_date || '')}"></div>
          <div class="field"><label for="ed-destination">Destination</label><input class="input" id="ed-destination" name="destination" maxlength="200" value="${esc(booking.destination || '')}"></div>
          <div class="field"><label for="ed-pnr">PNR</label><input class="input" id="ed-pnr" name="pnr" maxlength="60" value="${esc(booking.pnr || '')}"></div>
          ${sale.filter((item) => item.passenger_name).map((item) => `<div class="field full"><label for="ed-pax-${item.id}">Passenger</label><input class="input" id="ed-pax-${item.id}" data-line="${item.id}" data-field="passenger_name" maxlength="160" value="${esc(item.passenger_name || '')}"></div>`).join('')}
          ${cost.map((item) => `<div class="field full"><label for="ed-ticket-${item.id}">Supplier reference · ${esc(item.passenger_name || item.description)}</label><input class="input" id="ed-ticket-${item.id}" data-line="${item.id}" data-field="supplier_ref" maxlength="120" value="${esc(item.supplier_ref || '')}"></div>`).join('')}
          <div class="field full"><label for="ed-notes">Notes</label><textarea class="input" id="ed-notes" name="notes" rows="2" maxlength="2000">${esc(booking.notes || '')}</textarea></div>
        </div>`,
      async onSubmit(form) {
        const values = new FormData(form);
        const items = new Map();
        form.querySelectorAll('[data-line]').forEach((input) => {
          const line = items.get(input.dataset.line) || { id: Number(input.dataset.line) };
          line[input.dataset.field] = input.value;
          items.set(input.dataset.line, line);
        });
        await api.post(`/bookings/${id}/details`, {
          travel_date: values.get('travel_date') || null,
          return_date: values.get('return_date') || null,
          destination: values.get('destination'),
          pnr: values.get('pnr'),
          notes: values.get('notes'),
          items: [...items.values()],
        });
        toast('Details saved');
        render(container, { params: [String(id)] });
      },
    });
  });

  document.querySelector('[data-action="correct-document"]')?.addEventListener('click', () => {
    openBookingModal({ booking, correct: true, onSaved: () => render(container, { params: [String(id)] }) });
  });

  document.querySelector('[data-action="void-job"]')?.addEventListener('click', async () => {
    const result = await voidDialog({
      title: `Void ${booking.number}?`,
      message: 'For a booking entered by mistake. Its invoice and the payments on it, refunds, supplier bills and supplier credits are all reversed. No cancellation note or charges are made.',
      confirmLabel: 'Void booking',
    });
    if (!result.confirmed) return;
    try {
      await api.post(`/bookings/${id}/void`, { remarks: result.remarks });
      toast(`${booking.number} voided`);
      render(container, { params: [String(id)] });
    } catch (error) {
      toast(error.message, 'error');
    }
  });

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
      body: advanceModalBody(booking, 'booking'),
      submitLabel: 'Record advance',
      onMount(overlay) {
        const method = overlay.querySelector('#adv-method');
        const account = overlay.querySelector('#adv-account');
        if (!method || !account) return;
        bindMethodAccount(method, account, depositAccounts().accounts);
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
    button.addEventListener('click', () => {
      const advance = booking.advances.find((item) => item.id === Number(button.dataset.voidAdvance));
      if (advance) voidAdvance(advance, refresh);
    });
  });

  return () => {};
}
