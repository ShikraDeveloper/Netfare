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
  pageRecord,
  printPage,
  internalNotesHtml,
} from '../ui.js';
import { bindCorrections, correctButtonHtml } from '../corrections.js';
import { openVisaModal, visaDurationLabel, visaTypeLabel } from './visas.js';
import { openCancellationModal } from './cancellation-modal.js';
import { bindDepositCard, depositCardHtml } from './visa-deposit-card.js';
import { attachmentSection, bindAttachmentSection, loadAttachments } from '../attachments.js';
import { bindRefunds, refundsCardHtml } from './job-refunds.js';
import { openReminderForm } from '../reminders.js';

import { advanceModalBody, applyModalBody, depositAccounts, postingPreview, refundModalBody } from './job-modals.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// The note for a cancellation (and rejections before 1.0.13); otherwise the
// rejection date and reason from the status history.
function outcomeLine(visa, rejected) {
  if (visa.voided_at) return escapeHtml(visa.void_remarks || 'Entered by mistake');
  if (visa.cancellation) {
    return `<a href="#/cancellations/${visa.cancellation.id}">${rejected ? 'Rejection' : 'Cancellation'} ${escapeHtml(visa.cancellation.number)}</a>`;
  }
  const event = [...(visa.status_history || [])].reverse().find((row) => row.to_status === visa.status);
  if (rejected && event) return escapeHtml([fmtDate(event.event_date), event.remarks].filter(Boolean).join(' · '));
  return 'The customer invoice and supplier bills were reversed under the earlier cancellation logic.';
}

function statusSteps(visa) {
  if (['rejected', 'cancelled'].includes(visa.status)) {
    const rejected = visa.status === 'rejected';
    return `
      <div class="visa-outcome ${rejected ? 'rejected' : 'cancelled'}">
        <div class="visa-outcome-icon">${icon(rejected ? 'alert' : 'x', 18)}</div>
        <div>
          <strong>${visa.voided_at ? 'Application void' : rejected ? 'Application rejected' : 'Application cancelled'}</strong>
          <p>${outcomeLine(visa, rejected)}</p>
        </div>
      </div>
    `;
  }
  const order = ['draft', 'submitted', 'approved', 'issued'];
  const labels = ['Draft', 'Submitted', 'Approved', 'Issued'];
  const current = Math.max(0, order.indexOf(visa.status));
  return `
    <div class="visa-steps">
      ${labels.map((label, index) => {
    const state = index < current ? 'done' : index === current ? 'current' : '';
    return `
          ${index ? '<span class="visa-step-line"></span>' : ''}
          <div class="visa-step ${state}">
            <span class="visa-step-dot">${index < current ? icon('check', 12) : index + 1}</span>
            <span>${label}</span>
          </div>
        `;
  }).join('')}
    </div>
  `;
}

const STATUS_HISTORY_EMPTY = 'No status changes recorded yet.';

// When the job moved between statuses, and why. Shown on screen only.
// Other applications made in the same form, with one button to submit the drafts.
function groupCard(visa) {
  const group = visa.group;
  if (!group) return '';
  const rows = group.applications.map((row) => `
    <tr${row.id === visa.id ? ' class="current-row"' : ''}>
      <td><a href="#/visas/${row.id}">${esc(row.number)}</a></td>
      <td>${esc(row.applicant_name || '—')}${row.id === visa.id ? ' <span class="muted">(this one)</span>' : ''}</td>
      <td>${statusBadge(row.status)}</td>
      <td class="num">${fmtMoney(row.sale_total_cents)}</td>
    </tr>`).join('');
  return `
    <div class="card no-print" style="margin-bottom:16px" data-visa-group>
      <div class="card-head">
        <div class="card-title"><h2>Group ${esc(group.number)}</h2></div>
        ${group.draft_count ? `<button class="btn btn-primary btn-sm" data-action="submit-group">${icon('check', 14)} Submit all ${group.draft_count} draft${group.draft_count === 1 ? '' : 's'}</button>` : ''}
      </div>
      <div class="card-body" style="padding:4px 20px">
        <table class="table">
          <caption class="sr-only">Applications in group ${esc(group.number)}</caption>
          <thead><tr><th scope="col">Application</th><th scope="col">Applicant</th><th scope="col">Status</th><th scope="col" class="num">Sale</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

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
  const visa = await api.get(`/visas/${id}`);
  const attachments = await loadAttachments('visa', id);

  const isDraft = visa.status === 'draft';
  const isRejected = visa.status === 'rejected';
  const isCancelled = visa.status === 'cancelled';
  // Which moves the application allows comes from the server (server/workflows.js).
  const allowed = new Set(visa.allowed_actions || []);
  const invoice = visa.invoice;

  const canApplyAdvance = Boolean(invoice && invoice.status === 'sent' && invoice.balance_cents > 0 && visa.advances.some((advance) => advance.remaining_cents > 0));

  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const marginClass = visa.margin_cents >= 0 ? 'margin-positive' : 'margin-negative';
  // After a rejection or cancellation the profit is what was kept less the
  // cost left after supplier refunds.
  const result = visa.result || null;
  const saleForMargin = result ? result.sale_cents : visa.sale_total_cents;
  const marginPercent = saleForMargin ? (visa.margin_cents / saleForMargin) * 100 : 0;

  const actions = [];
  const menu = [
    `<a class="btn btn-ghost" href="#/visas"><span>All visas</span></a>`,
    `<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>`,
  ];
  if (allowed.has('edit')) actions.push(`<button class="btn btn-secondary" data-action="edit">${icon('edit', 15)}<span>Edit</span></button>`);
  if (allowed.has('delete')) actions.push(`<button class="icon-btn danger" data-action="delete" title="Delete draft">${icon('trash', 17)}</button>`);
  if (allowed.has('submit')) actions.push(`<button class="btn btn-primary" data-action="submit">${icon('check', 15)}<span>Submit &amp; post</span></button>`);
  if (allowed.has('reject')) actions.push(`<button class="btn btn-danger-ghost" data-action="reject"><span>Reject</span></button>`);
  if (allowed.has('approve')) actions.push(`<button class="btn btn-primary" data-action="approve">${icon('check', 15)}<span>Mark approved</span></button>`);
  if (allowed.has('issue')) actions.push(`<button class="btn btn-primary" data-action="issue">${icon('check', 15)}<span>Mark issued</span></button>`);
  if (visa.invoice && visa.invoice.status === 'sent' && visa.invoice.balance_cents > 0) {
    actions.push(`<a class="btn btn-secondary" href="#/invoices/${visa.invoice.id}">${icon('plus', 15)}<span>Record payment</span></a>`);
  }

  const duration = visaDurationLabel(visa.duration_days);
  menu.push(`<button class="btn btn-ghost" data-action="toggle-accounting">${icon('accounts', 15)}<span>Show or hide account codes</span></button>`);
  menu.push(`<button class="btn btn-ghost" data-action="add-reminder">${icon('clock', 15)}<span>Add reminder</span></button>`);
  menu.push(`<a class="btn btn-ghost" href="#/audit-chain/visa/${id}">${icon('shield', 15)}<span>Audit chain</span></a>`);
  if (allowed.has('cancel')) {
    menu.push(`<button class="btn btn-danger-ghost" data-action="cancel"><span>Cancel application</span></button>`);
  }
  // Details that do not touch money: anyone with Edit rights.
  if (allowed.has('edit_details')) {
    menu.push(`<button class="btn btn-ghost" data-action="edit-details">${icon('edit', 15)}<span>Edit details</span></button>`);
  }
  // Admin only: correct the lines, or undo an application entered by mistake
  // (a cancelled one has its cancellation note to void instead).
  if (allowed.has('correct')) menu.push(`<button class="btn btn-ghost" data-action="correct-document">${icon('edit', 15)}<span>Correct</span></button>`);
  // An open visa that still holds a deposit shows Void greyed out with the reason.
  const voidWaiting = !allowed.has('void') && allowed.has('correct') && visa.holds_deposit;
  if (allowed.has('void') || voidWaiting) {
    menu.push(`<button class="btn btn-danger-ghost" data-action="void-job" ${voidWaiting ? 'disabled title="Settle or void the security deposit first"' : ''}><span>Void (entered by mistake)</span></button>`);
  }
  pageRecord(visa);
  setHeader({
    title: visa.number,
    badge: statusBadge(visa.status_display || visa.status),
    actions: actions.join('') + moreMenuHtml(menu),
  });

  const saleRows = visa.sale_items.map((item) => `
    <tr>
      <td>${esc(item.description)}</td>
      <td class="num">${fmtNumber(item.quantity)}</td>
      <td class="num">${fmtMoney(item.unit_price_cents)}</td>
      <td class="muted acct-col">${esc(item.account_code)} · ${esc(item.account_name)}</td>
      <td class="num amount">${fmtMoney(item.amount_cents)}</td>
    </tr>
  `).join('') || `<tr><td colspan="5" class="muted">No sale items</td></tr>`;

  const costRows = visa.cost_items.map((item) => `
    <tr>
      <td>${esc(item.description)}</td>
      <td class="num">${fmtNumber(item.quantity)}</td>
      <td class="num">${fmtMoney(item.unit_price_cents)}</td>
      <td class="muted acct-col">${esc(item.account_code)} · ${esc(item.account_name)}</td>
      <td>${esc(item.vendor_name || '—')}${item.supplier_ref ? `<small class="cell-sub"> · ${esc(item.supplier_ref)}</small>` : ''}</td>
      <td class="num amount">${fmtMoney(item.amount_cents)}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" class="muted">No cost items</td></tr>`;

  const advanceRows = visa.advances.map((advance) => `
    <div class="payment-item">
      <div class="payment-icon">${icon('wallet', 15)}</div>
      <div class="payment-main">
        <strong>${esc(advance.number)} · ${statusBadge(advance.status_display || advance.status)}</strong>
        <span>${esc(fmtDate(advance.advance_date))} · ${esc(advance.method || 'Advance')}${advance.reference ? ` · ${esc(advance.reference)}` : ''} · Received ${fmtMoney(advance.amount_cents)}</span>
      </div>
      <div class="payment-amount">${fmtMoney(advance.remaining_cents)} <small class="muted">left</small></div>
      <div style="display:flex;gap:4px">
        ${advance.allowed_actions.includes('refund') ? `<button class="icon-btn" data-refund-advance="${advance.id}" title="Refund remaining">${icon('arrowUp', 16)}</button>` : ''}
        ${advance.allowed_actions.includes('correct') ? correctButtonHtml('advance', advance) : ''}
        ${advance.allowed_actions.includes('void') ? `<button class="icon-btn danger" data-void-advance="${advance.id}" title="Void advance">${icon('trash', 16)}</button>` : ''}
      </div>
    </div>
  `).join('');

  const paymentRows = visa.payments.length
    ? visa.payments.map((payment) => `
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

  const billRows = visa.bills.length
    ? visa.bills.map((bill) => `
        <div class="payment-item">
          <div class="payment-icon">${icon('bill', 15)}</div>
          <div class="payment-main">
            <strong>${esc(bill.number)} · ${esc(bill.vendor_name)}</strong>
            <span>${esc(fmtDate(bill.bill_date))} · Total ${fmtMoney(bill.total_cents)} · ${statusBadge(bill.status_display || bill.status)}${bill.portal_name ? ` · ${esc(bill.portal_name)}` : ''}</span>
          </div>
          <div class="payment-amount">${fmtMoney(bill.balance_cents)} <small class="muted">due</small></div>
          <a class="icon-btn" href="#/bills/${bill.id}" title="Open bill">${icon('chevron', 16)}</a>
        </div>
      `).join('')
    : `<div class="muted" style="font-size:12.5px;padding:6px 0">${isDraft ? 'Supplier bills are created automatically when you submit this application.' : 'No supplier bills linked.'}</div>`;

  const cancellation = visa.cancellation;
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

  const refundsCard = refundsCardHtml(visa);

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
    : `<div class="muted" style="font-size:12.5px;padding:6px 0">${isDraft ? 'A customer invoice is created when you submit this application.' : 'No customer invoice linked.'}</div>`;

  const applicantDetails = [
    visa.nationality ? `Nationality: ${visa.nationality}` : '',
    visa.passport_number ? `Passport: ${visa.passport_number}` : '',
    visa.passport_expiry ? `Expires ${fmtDate(visa.passport_expiry)}` : '',
    visa.date_of_birth ? `DOB ${fmtDate(visa.date_of_birth)}` : '',
  ].filter(Boolean).join('\n');

  container.innerHTML = `
    ${summaryStripHtml([
      { label: 'Total', value: fmtMoney(visa.sale_total_cents) },
      { label: 'Paid', value: fmtMoney(visa.amount_paid_cents || 0) },
      { label: 'Balance', value: fmtMoney(visa.balance_cents || 0), tone: visa.balance_cents > 0 && visa.invoice ? 'due' : '' },
      { label: 'Gross profit', value: fmtMoney(visa.margin_cents), tone: visa.margin_cents >= 0 ? 'good' : 'bad' },
    ])}
    ${statusSteps(visa)}
    ${groupCard(visa)}

    ${visa.passport_warning ? `
      <div class="callout warning no-print" data-passport-warning>
        <div class="callout-icon">${icon('alert', 20)}</div>
        <div class="callout-text">
          <h3>Check the passport validity</h3>
          <p>${esc(visa.passport_warning)}</p>
        </div>
      </div>` : ''}
    ${internalNotesHtml(visa.notes)}
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
            <div class="doc-kind">Visa application</div>
            <div class="doc-number">${esc(visa.number)}</div>
            <div class="doc-status">${statusBadge(visa.status_display || visa.status)}</div>
            <dl class="doc-meta-grid">
              <dt>Application date</dt><dd>${esc(fmtDate(visa.application_date))}</dd>
              <dt>Travel date</dt><dd>${visa.travel_date ? esc(fmtDate(visa.travel_date)) : '—'}</dd>
              <dt>Visa type</dt><dd>${esc(visaTypeLabel(visa.visa_type))}</dd>
              <dt>Duration</dt><dd>${esc(duration || '—')}</dd>
              <dt>Embassy ref</dt><dd>${esc(visa.reference || '—')}</dd>
            </dl>
          </div>
        </div>

        <div class="doc-parties">
          <div>
            <div class="doc-label">Applicant / customer</div>
            <div class="doc-party-name">${esc(visa.applicant_name || visa.customer_name)}</div>
            <div class="doc-party-detail">${esc([visa.customer_address, visa.customer_email, visa.customer_phone].filter(Boolean).join('\n'))}</div>
            ${applicantDetails ? `<div class="doc-party-detail" style="margin-top:6px">${esc(applicantDetails)}</div>` : ''}
          </div>
          <div>
            <div class="doc-label">Destination</div>
            <div class="doc-terms">${esc(visa.destination_country || 'No destination recorded')}${visa.invoice_notes ? esc(`\n${visa.invoice_notes}`) : ''}</div>
          </div>
        </div>

        <div class="doc-items-wrap" tabindex="0" role="region" aria-label="Line items">
          <div class="doc-label" style="margin-bottom:8px">Sale items</div>
          <table class="doc-items"><caption class="sr-only">Visa sale items</caption>
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
          <table class="doc-items"><caption class="sr-only">Visa supplier costs</caption>
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
            <div class="totals-row"><span>Total sale</span><span>${fmtMoney(visa.sale_total_cents)}</span></div>
            ${result && result.sale_cents !== visa.sale_total_cents ? `<div class="totals-row" data-result-sale><span>Sale after refund to customer</span><span>${fmtMoney(result.sale_cents)}</span></div>` : ''}
            <div class="totals-row"><span>Total cost</span><span>${fmtMoney(visa.cost_total_cents)}</span></div>
            ${result && result.cost_cents !== visa.cost_total_cents ? `<div class="totals-row" data-result-cost><span>Cost after supplier refund</span><span>${fmtMoney(result.cost_cents)}</span></div>` : ''}
            <div class="totals-row total"><span>Gross profit</span><span class="${marginClass}">${fmtMoney(visa.margin_cents)}</span></div>
            <div class="totals-row"><span class="muted">Gross margin</span><span class="muted">${marginPercent.toFixed(1)}%</span></div>
            <div class="totals-row balance"><span>Customer balance</span><span>${fmtMoney(visa.balance_cents)}</span></div>
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
            ${!isCancelled && !isRejected ? `<button class="btn btn-primary btn-sm" data-action="record-advance">${icon('plus', 14)} Record</button>` : ''}
          </div>
        </div>
        <div class="card-body" ${visa.advances.length ? 'style="padding:4px 20px"' : ''}>
          ${visa.advances.length ? advanceRows : emptyState({
    iconName: 'wallet',
    title: 'No advances recorded',
  })}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Payments received</h2></div>
        </div>
        <div class="card-body" ${visa.payments.length ? 'style="padding:4px 20px"' : ''}>${paymentRows}</div>
      </div>
    </div>

    <div style="margin-top:16px">${depositCardHtml(visa)}</div>
    ${statusHistoryCard(visa.status_history)}
    ${attachmentSection({ entityType: 'visa', entityId: id, attachments })}
  `;

  bindAttachmentSection(container, { entityType: 'visa', entityId: id });
  bindCorrections(container, () => render(container, { params: [String(id)] }));
  bindDepositCard(container, visa, () => render(container, { params: [String(id)] }));

  function refresh() {
    return render(container, { params: [String(id)] });
  }

  function on(selector, handler) {
    document.querySelectorAll(selector).forEach((element) => element.addEventListener('click', handler));
  }

  on('[data-action="print"]', () => printPage());

  const editButton = document.querySelector('[data-action="edit"]');
  if (editButton) {
    editButton.addEventListener('click', () => openVisaModal({ visa, onSaved: () => refresh() }));
  }

  const submitGroupButton = document.querySelector('[data-action="submit-group"]');
  if (submitGroupButton) {
    submitGroupButton.addEventListener('click', async () => {
      const drafts = visa.group.applications.filter((row) => row.status === 'draft');
      const total = drafts.reduce((sum, row) => sum + row.sale_total_cents, 0);
      const confirmed = await confirmDialog({
        title: `Submit ${drafts.length} application${drafts.length === 1 ? '' : 's'} in ${visa.group.number}?`,
        message: `This creates and posts ${drafts.length} customer invoice${drafts.length === 1 ? '' : 's'} (${fmtMoney(total)} in total) and the supplier bills to your ledger.`,
        confirmLabel: 'Submit all & post',
        danger: false,
      });
      if (!confirmed) return;
      try {
        const result = await api.post(`/visas/groups/${visa.group.id}/submit`, { apply_advances: true });
        toast(`${result.submitted.length} application${result.submitted.length === 1 ? '' : 's'} submitted and posted`);
        (result.warnings || []).forEach((warning) => toast(warning, 'error'));
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  const submitButton = document.querySelector('[data-action="submit"]');
  if (submitButton) {
    submitButton.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: `Submit ${visa.number}?`,
        message: 'Check what will be posted to your ledger. Once submitted, the application can only be changed by rejecting or cancelling it.',
        preview: postingPreview(visa, await api.get('/portals').catch(() => null)),
        confirmLabel: 'Submit & post',
        danger: false,
      });
      if (!confirmed) return;
      try {
        const result = await api.post(`/visas/${id}/submit`, { apply_advances: true });
        toast(`${visa.number} submitted and posted`);
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

  const approveButton = document.querySelector('[data-action="approve"]');
  if (approveButton) {
    approveButton.addEventListener('click', async () => {
      try {
        await api.post(`/visas/${id}/approve`, {});
        toast(`${visa.number} marked as approved`);
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  const issueButton = document.querySelector('[data-action="issue"]');
  if (issueButton) {
    issueButton.addEventListener('click', async () => {
      try {
        await api.post(`/visas/${id}/issue`, {});
        toast(`${visa.number} marked as issued`);
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
        title: 'Delete this draft application?',
        message: `${visa.number} and its line items will be permanently deleted. Nothing has been posted to the ledger yet.`,
        confirmLabel: 'Delete application',
      });
      if (!confirmed) return;
      try {
        await api.del(`/visas/${id}`);
        toast('Draft visa application deleted');
        location.hash = '#/visas';
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  // Rejected by immigration: only the date and the reason. Refunds, if any,
  // are recorded from the Refunds card.
  on('[data-action="reject"]', () => {
    openModal({
      title: 'Reject visa application',
      submitLabel: 'Reject application',
      danger: true,
      body: `
        <div class="form-grid">
          <div class="field">
            <label for="reject-date">Rejection date</label>
            <input class="input" id="reject-date" name="rejection_date" type="date" value="${todayISO()}" required>
          </div>
          <div class="field full">
            <label for="reject-reason">Reason</label>
            <input class="input" id="reject-reason" name="reason" maxlength="500" placeholder="Rejected by immigration">
          </div>
        </div>
      `,
      async onSubmit(form) {
        const values = new FormData(form);
        await api.post(`/visas/${id}/reject`, { rejection_date: values.get('rejection_date'), reason: values.get('reason') });
        toast(`${visa.number} rejected`);
        refresh();
      },
    });
  });

  bindRefunds(container, visa, 'visa', refresh);
  on('[data-action="add-reminder"]', () => openReminderForm({
    link: { type: 'visa', id: visa.id, label: [visa.number, visa.applicant_name || visa.customer_name].filter(Boolean).join(' · ') },
  }));

  on('[data-action="edit-details"]', () => {
    openModal({
      title: `Edit details · ${visa.number}`,
      submitLabel: 'Save details',
      body: `
        <div class="form-grid">
          <div class="field"><label for="ed-travel">Travel date</label><input class="input" id="ed-travel" name="travel_date" type="date" value="${esc(visa.travel_date || '')}"></div>
          <div class="field"><label for="ed-reference">Application reference</label><input class="input" id="ed-reference" name="reference" maxlength="120" value="${esc(visa.reference || '')}"></div>
          <div class="field"><label for="ed-nationality">Nationality</label><input class="input" id="ed-nationality" name="nationality" maxlength="80" value="${esc(visa.nationality || '')}"></div>
          <div class="field"><label for="ed-passport">Passport number</label><input class="input" id="ed-passport" name="passport_number" maxlength="60" value="${esc(visa.passport_number || '')}"></div>
          <div class="field"><label for="ed-expiry">Passport expiry</label><input class="input" id="ed-expiry" name="passport_expiry" type="date" value="${esc(visa.passport_expiry || '')}"></div>
          <div class="field"><label for="ed-birth">Date of birth</label><input class="input" id="ed-birth" name="date_of_birth" type="date" value="${esc(visa.date_of_birth || '')}"></div>
          <div class="field full"><label for="ed-notes">Notes</label><textarea class="input" id="ed-notes" name="notes" rows="2" maxlength="2000">${esc(visa.notes || '')}</textarea></div>
        </div>`,
      async onSubmit(form) {
        const values = new FormData(form);
        await api.post(`/visas/${id}/details`, {
          travel_date: values.get('travel_date') || null,
          reference: values.get('reference'),
          nationality: values.get('nationality'),
          passport_number: values.get('passport_number'),
          passport_expiry: values.get('passport_expiry') || null,
          date_of_birth: values.get('date_of_birth') || null,
          notes: values.get('notes'),
        });
        toast('Details saved');
        refresh();
      },
    });
  });

  on('[data-action="correct-document"]', () => {
    openVisaModal({ visa, correct: true, onSaved: refresh });
  });

  on('[data-action="void-job"]', async () => {
    const result = await voidDialog({
      title: `Void ${visa.number}?`,
      message: 'For an application entered by mistake. Its invoice and the payments on it, refunds, supplier bills and supplier credits are all reversed. No cancellation note or charges are made.',
      confirmLabel: 'Void application',
    });
    if (!result.confirmed) return;
    try {
      await api.post(`/visas/${id}/void`, { remarks: result.remarks });
      toast(`${visa.number} voided`);
      refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  const cancelButton = document.querySelector('[data-action="cancel"]');
  if (cancelButton) {
    cancelButton.addEventListener('click', () => {
      openCancellationModal({
        job: visa,
        sourceType: 'visa',
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
      body: advanceModalBody(visa, 'visa'),
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
          customer_id: visa.customer_id,
          visa_id: visa.id,
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
      const openAdvances = visa.advances.filter((advance) => advance.remaining_cents > 0);
      openModal({
        title: 'Apply advance to invoice',
        body: applyModalBody(visa, openAdvances),
        submitLabel: 'Apply advance',
        async onSubmit(form) {
          const values = new FormData(form);
          const advanceId = Number(values.get('advance_id'));
          if (!advanceId) throw new Error('Choose an advance');
          await api.post(`/advances/${advanceId}/apply`, {
            invoice_id: visa.invoice.id,
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
      const advance = visa.advances.find((item) => item.id === Number(button.dataset.refundAdvance));
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
      const advance = visa.advances.find((item) => item.id === Number(button.dataset.voidAdvance));
      if (advance) voidAdvance(advance, refresh);
    });
  });

  return () => {};
}
