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
import { openVisaModal, visaDurationLabel, visaTypeLabel } from './visas.js';
import { openCancellationModal } from './cancellation-modal.js';
import { attachmentSection, bindAttachmentSection, loadAttachments } from '../attachments.js';

import { advanceModalBody, applyModalBody, depositAccounts, refundModalBody } from './job-modals.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusSteps(visa) {
  if (['rejected', 'cancelled'].includes(visa.status)) {
    const rejected = visa.status === 'rejected';
    return `
      <div class="visa-outcome ${rejected ? 'rejected' : 'cancelled'}">
        <div class="visa-outcome-icon">${icon(rejected ? 'alert' : 'x', 18)}</div>
        <div>
          <strong>${rejected ? 'Application rejected' : 'Application cancelled'}</strong>
          <p>${visa.cancellation
    ? `Cancellation ${escapeHtml(visa.cancellation.number)} was recorded. Receipts and supplier payments stay in the ledger, and any refund or supplier credit is tracked on the cancellation note.`
    : 'The customer invoice and supplier bills were reversed under the earlier cancellation logic.'}</p>
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
        <div class="card-title"><h2>Group ${esc(group.number)}</h2><p>${group.size} applications created together · each has its own invoice</p></div>
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
  const visa = await api.get(`/visas/${id}`);
  const attachments = await loadAttachments('visa', id);

  const isDraft = visa.status === 'draft';
  const isSubmitted = visa.status === 'submitted';
  const isApproved = visa.status === 'approved';
  const isIssued = visa.status === 'issued';
  const isRejected = visa.status === 'rejected';
  const isCancelled = visa.status === 'cancelled';
  const invoice = visa.invoice;

  const canApplyAdvance = Boolean(invoice && invoice.status === 'sent' && invoice.balance_cents > 0 && visa.advances.some((advance) => advance.remaining_cents > 0));

  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const marginClass = visa.margin_cents >= 0 ? 'margin-positive' : 'margin-negative';
  const marginPercent = visa.sale_total_cents ? (visa.margin_cents / visa.sale_total_cents) * 100 : 0;

  const actions = [];
  actions.push(`<a class="btn btn-ghost" href="#/visas"><span>All visas</span></a>`);
  actions.push(`<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>`);
  if (isDraft) {
    actions.push(`<button class="btn btn-secondary" data-action="edit">${icon('edit', 15)}<span>Edit</span></button>`);
    actions.push(`<button class="icon-btn danger" data-action="delete" title="Delete draft">${icon('trash', 17)}</button>`);
    actions.push(`<button class="btn btn-primary" data-action="submit">${icon('check', 15)}<span>Submit &amp; post</span></button>`);
  }
  if (isSubmitted) {
    actions.push(`<button class="btn btn-danger-ghost" data-action="reject"><span>Reject</span></button>`);
    actions.push(`<button class="btn btn-primary" data-action="approve">${icon('check', 15)}<span>Mark approved</span></button>`);
  }
  if (isApproved) {
    actions.push(`<button class="btn btn-danger-ghost" data-action="reject"><span>Reject</span></button>`);
    actions.push(`<button class="btn btn-primary" data-action="issue">${icon('check', 15)}<span>Mark issued</span></button>`);
  }
  if (!isCancelled && !isRejected) {
    actions.push(`<button class="btn btn-danger-ghost" data-action="cancel"><span>Cancel application</span></button>`);
  }

  const duration = visaDurationLabel(visa.duration_days);
  const subtitleParts = [
    visa.applicant_name || visa.customer_name,
    visa.destination_country || 'No destination',
    `${visaTypeLabel(visa.visa_type)} visa${duration ? ` · ${duration}` : ''}`,
  ];
  actions.push(`<a class="btn btn-ghost" href="#/audit-chain/visa/${id}">${icon('shield', 15)}<span>Audit chain</span></a>`);
  setHeader({
    title: visa.number,
    subtitle: subtitleParts.join(' · '),
    actions: actions.join(''),
  });

  const saleRows = visa.sale_items.map((item) => `
    <tr>
      <td>${esc(item.description)}</td>
      <td class="num">${fmtNumber(item.quantity)}</td>
      <td class="num">${fmtMoney(item.unit_price_cents)}</td>
      <td class="muted">${esc(item.account_code)} · ${esc(item.account_name)}</td>
      <td class="num amount">${fmtMoney(item.amount_cents)}</td>
    </tr>
  `).join('') || `<tr><td colspan="5" class="muted">No sale items</td></tr>`;

  const costRows = visa.cost_items.map((item) => `
    <tr>
      <td>${esc(item.description)}</td>
      <td class="num">${fmtNumber(item.quantity)}</td>
      <td class="num">${fmtMoney(item.unit_price_cents)}</td>
      <td class="muted">${esc(item.account_code)} · ${esc(item.account_name)}</td>
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
        ${advance.remaining_cents > 0 ? `<button class="icon-btn" data-refund-advance="${advance.id}" title="Refund remaining">${icon('arrowUp', 16)}</button>` : ''}
        ${!advance.voided ? `<button class="icon-btn danger" data-void-advance="${advance.id}" title="Void advance">${icon('trash', 16)}</button>` : ''}
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
      message: invoice && invoice.balance_cents > 0 ? 'Record a payment or apply an advance to reduce the balance.' : 'Payments will appear here once recorded.',
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
    : `<div class="muted" style="font-size:12.5px;padding:6px 0">${isDraft ? 'A customer invoice is created when you submit this application.' : 'No customer invoice linked.'}</div>`;

  const applicantDetails = [
    visa.nationality ? `Nationality: ${visa.nationality}` : '',
    visa.passport_number ? `Passport: ${visa.passport_number}` : '',
    visa.passport_expiry ? `Expires ${fmtDate(visa.passport_expiry)}` : '',
    visa.date_of_birth ? `DOB ${fmtDate(visa.date_of_birth)}` : '',
  ].filter(Boolean).join('\n');

  container.innerHTML = `
    ${statusSteps(visa)}
    ${groupCard(visa)}

    ${visa.passport_warning ? `
      <div class="callout no-print" data-passport-warning style="border-color:var(--amber-soft)">
        <div class="callout-icon" style="background:var(--amber-soft);color:var(--amber)">${icon('alert', 20)}</div>
        <div class="callout-text">
          <h3>Check the passport validity</h3>
          <p>${esc(visa.passport_warning)}</p>
        </div>
      </div>` : ''}
    ${visa.notes ? `
      <div class="callout internal-notes no-print" data-internal-notes>
        <div class="callout-text">
          <h3>Internal notes</h3>
          <p>${esc(visa.notes)}</p>
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
            <div class="doc-kind">Visa application</div>
            <div class="doc-number">${esc(visa.number)}</div>
            <div class="doc-status">${statusBadge(visa.status)}</div>
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

        <div class="doc-items-wrap">
          <div class="doc-label" style="margin-bottom:8px">Sale items</div>
          <table class="doc-items"><caption class="sr-only">Visa sale items</caption>
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
          <table class="doc-items"><caption class="sr-only">Visa supplier costs</caption>
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
            <div class="totals-row"><span>Total sale</span><span>${fmtMoney(visa.sale_total_cents)}</span></div>
            <div class="totals-row"><span>Total cost</span><span>${fmtMoney(visa.cost_total_cents)}</span></div>
            <div class="totals-row total"><span>Margin</span><span class="${marginClass}">${fmtMoney(visa.margin_cents)}</span></div>
            <div class="totals-row"><span class="muted">Profitability</span><span class="muted">${marginPercent.toFixed(1)}%</span></div>
            <div class="totals-row balance"><span>Customer balance</span><span>${fmtMoney(visa.balance_cents)}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="detail-grid no-print">
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Customer invoice</h2><p>${invoice ? fmtMoney(invoice.balance_cents) + ' outstanding' : 'Created on submission'}</p></div>
          ${invoice && invoice.status === 'sent' && invoice.balance_cents > 0 ? `<a class="card-link" href="#/invoices/${invoice.id}">Record payment ${icon('chevron', 12)}</a>` : ''}
        </div>
        <div class="card-body" style="padding:6px 20px">${invoiceCard}</div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Supplier bills</h2><p>${visa.bills.length} bill${visa.bills.length === 1 ? '' : 's'} · ${fmtMoney(visa.cost_total_cents)} cost</p></div>
        </div>
        <div class="card-body" style="padding:6px 20px">${billRows}</div>
      </div>

      ${cancellationCard}

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Customer advances</h2><p>${visa.advances.length ? `${visa.advances.length} advance${visa.advances.length === 1 ? '' : 's'}` : 'No advances recorded'}</p></div>
          <div style="display:flex;gap:6px">
            ${canApplyAdvance ? `<button class="btn btn-secondary btn-sm" data-action="apply-advance">${icon('check', 14)} Apply</button>` : ''}
            ${!isCancelled && !isRejected ? `<button class="btn btn-primary btn-sm" data-action="record-advance">${icon('plus', 14)} Record</button>` : ''}
          </div>
        </div>
        <div class="card-body" ${visa.advances.length ? 'style="padding:4px 20px"' : ''}>
          ${visa.advances.length ? advanceRows : emptyState({
    iconName: 'wallet',
    title: 'No advances recorded',
    message: 'Record a deposit if the customer pays before the application is invoiced.',
  })}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Payments received</h2><p>${invoice ? `${fmtMoney(invoice.amount_paid_cents)} received` : 'No invoice yet'}</p></div>
        </div>
        <div class="card-body" ${visa.payments.length ? 'style="padding:4px 20px"' : ''}>${paymentRows}</div>
      </div>
    </div>

    ${statusHistoryCard(visa.status_history)}
    ${attachmentSection({ entityType: 'visa', entityId: id, attachments })}
  `;

  bindAttachmentSection(container, { entityType: 'visa', entityId: id });

  function refresh() {
    return render(container, { params: [String(id)] });
  }

  function on(selector, handler) {
    document.querySelectorAll(selector).forEach((element) => element.addEventListener('click', handler));
  }

  on('[data-action="print"]', () => window.print());

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
        const result = await api.post(`/visas/groups/${visa.group.id}/submit`, {});
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
        message: `This creates and posts the customer invoice (${fmtMoney(visa.sale_total_cents)}) and ${fmtMoney(visa.cost_total_cents)} of supplier bills to your ledger.`,
        confirmLabel: 'Submit & post',
        danger: false,
      });
      if (!confirmed) return;
      try {
        const result = await api.post(`/visas/${id}/submit`, {});
        toast(`${visa.number} submitted and posted`);
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

  const rejectButton = document.querySelector('[data-action="reject"]');
  if (rejectButton) {
    rejectButton.addEventListener('click', () => {
      openCancellationModal({
        job: visa,
        sourceType: 'visa',
        action: 'reject',
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
      subtitle: `${visa.number} · ${visa.customer_name}`,
      body: advanceModalBody(visa, 'visa'),
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
        subtitle: `${visa.invoice.number} · ${fmtMoney(visa.invoice.balance_cents)} due`,
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
        subtitle: `${visa.customer_name} · ${fmtMoney(advance.remaining_cents)} available`,
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
      const advance = visa.advances.find((item) => item.id === Number(button.dataset.voidAdvance));
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
