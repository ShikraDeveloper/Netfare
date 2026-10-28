import { api } from '../api.js';
import { cashAccounts, store } from '../store.js';
import {
  centsToInput,
  confirmDialog,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  fmtNumber,
  icon,
  openModal,
  optionsHtml,
  setHeader,
  statusBadge,
  todayISO,
  toast,
  toCents,
  currencySymbol,
  voidDialog,
} from '../ui.js';
import { amountInWords } from '../amount-words.js';
import { invoiceMessage, mailtoUrl, whatsappNumber, whatsappUrl } from '../share-links.js';
import { openInvoiceModal } from './invoices.js';
import { openRefundModal } from './refund-modal.js';
import { visaDurationLabel, visaTypeLabel } from './visas.js';
import { attachmentSection, bindAttachmentSection, loadAttachments } from '../attachments.js';

const DOCUMENT_TITLES = {
  ticket: 'Ticket invoice',
  booking: 'Booking invoice',
  visa: 'Visa invoice',
  cancellation: 'Cancellation invoice',
  service: 'Invoice',
};

// The booking or visa the invoice was made from, shown in the header.
function sourceMetaHtml(invoice) {
  const kind = invoice.document_kind;
  if ((kind === 'ticket' || kind === 'booking') && invoice.booking_number) {
    return `<dt>Booking</dt><dd>${esc(invoice.booking_number)}</dd>`;
  }
  if (kind === 'visa' && invoice.visa_number) {
    return `<dt>Visa application</dt><dd>${esc(invoice.visa_number)}</dd>${invoice.visa_group_number ? `<dt>Group</dt><dd>${esc(invoice.visa_group_number)}</dd>` : ''}`;
  }
  return '';
}

// Ticket and booking invoices: route, PNR and travel dates.
function tripDetailsHtml(invoice) {
  if (!['ticket', 'booking'].includes(invoice.document_kind)) return '';
  const dates = invoice.booking_travel_date
    ? `${fmtDate(invoice.booking_travel_date)}${invoice.booking_return_date ? ` → ${fmtDate(invoice.booking_return_date)}` : ''}`
    : '';
  if (!invoice.booking_destination && !invoice.booking_pnr && !dates) return '';
  return `
    <div class="doc-visa-applicant doc-trip" data-trip-details>
      <div>
        <div class="doc-label">Trip details</div>
        <div class="doc-party-name">${esc(invoice.booking_destination || '—')}</div>
        ${invoice.booking_passenger_count ? `<div class="doc-party-detail">${invoice.booking_passenger_count} passenger${invoice.booking_passenger_count === 1 ? '' : 's'}</div>` : ''}
      </div>
      <dl class="doc-trip-grid">
        ${invoice.booking_pnr ? `<dt>PNR</dt><dd>${esc(invoice.booking_pnr)}</dd>` : ''}
        ${dates ? `<dt>Travel</dt><dd>${esc(dates)}</dd>` : ''}
      </dl>
    </div>
  `;
}

// Visa invoices always show who the visa is for; other documents linked to a
// visa (cancellation charges) only when the applicant is not the customer.
function visaApplicantHtml(invoice) {
  if (!invoice.visa_id) return '';
  if (invoice.document_kind !== 'visa' && Number(invoice.visa_applicant_is_customer) !== 0) return '';
  const name = String(invoice.visa_applicant_name || '').trim();
  if (!name) return '';

  const details = [
    invoice.visa_nationality ? `Nationality: ${invoice.visa_nationality}` : '',
    invoice.visa_passport_masked
      ? `Passport: ${invoice.visa_passport_masked}${invoice.visa_passport_expiry ? ` · expires ${fmtDate(invoice.visa_passport_expiry)}` : ''}`
      : '',
  ].filter(Boolean);

  const application = [
    invoice.visa_number,
    [
      invoice.visa_destination_country,
      `${visaTypeLabel(invoice.visa_type)} visa`,
      visaDurationLabel(invoice.visa_duration_days),
    ].filter(Boolean).join(' · '),
    invoice.visa_reference ? `Ref ${invoice.visa_reference}` : '',
  ].filter(Boolean).join(' · ');

  return `
    <div class="doc-visa-applicant" data-visa-details>
      <div>
        <div class="doc-label">${invoice.document_kind === 'visa' ? 'Visa details' : 'Visa applicant'}</div>
        <div class="doc-party-name">${esc(name)}</div>
        ${details.length ? `<div class="doc-party-detail">${esc(details.join('\n'))}</div>` : ''}
      </div>
      ${application ? `
        <div class="doc-visa-application">
          <div class="doc-label">Visa application</div>
          <div class="doc-party-detail">${esc(application)}</div>
          ${invoice.document_kind === 'visa' && Number(invoice.visa_applicant_is_customer) !== 0 ? '' : `<div class="doc-party-detail muted">Paid by ${esc(invoice.customer_name || '')}</div>`}
        </div>
      ` : ''}
    </div>
  `;
}

// A direct invoice paid by the customer for another person. Visa invoices use
// the visa applicant section instead.
function beneficiaryHtml(invoice) {
  if (invoice.visa_id || Number(invoice.beneficiary_is_customer) !== 0) return '';
  const name = String(invoice.beneficiary_name || '').trim();
  if (!name) return '';
  const details = [
    invoice.beneficiary_nationality ? `Nationality: ${invoice.beneficiary_nationality}` : '',
    invoice.beneficiary_passport_masked ? `Passport: ${invoice.beneficiary_passport_masked}` : '',
  ].filter(Boolean);
  return `
    <div class="doc-visa-applicant" data-beneficiary>
      <div>
        <div class="doc-label">Service for</div>
        <div class="doc-party-name">${esc(name)}</div>
        ${details.length ? `<div class="doc-party-detail">${esc(details.join('\n'))}</div>` : ''}
      </div>
      <div>
        <div class="doc-label">Paid by</div>
        <div class="doc-party-detail">${esc(invoice.customer_name || '')}</div>
      </div>
    </div>
  `;
}

// Send the invoice from the user's own email or WhatsApp. Nothing is sent by
// Ledgerly itself; the PDF is attached by printing to PDF first.
function openShareModal(invoice, settings) {
  const title = DOCUMENT_TITLES[invoice.document_kind] || 'Invoice';
  const message = invoiceMessage(invoice, {
    company: settings.company_name || '',
    companyPhone: settings.company_phone || '',
    title,
    format: (cents) => fmtMoney(cents).replace(/\s/g, ' '),
    date: (iso) => fmtDate(iso, { long: true }),
  });
  const subject = `${title} ${invoice.number}${settings.company_name ? ` from ${settings.company_name}` : ''}`;
  const hasNumber = Boolean(whatsappNumber(invoice.customer_phone));
  openModal({
    title: `Share ${invoice.number}`,
    subtitle: 'Opens your own email or WhatsApp with this message. Attach the PDF yourself: Print → Save as PDF.',
    size: 'modal-md',
    hideFooter: true,
    body: `
      <div class="field">
        <label for="share-message">Message</label>
        <textarea class="input" id="share-message" rows="10">${esc(message)}</textarea>
      </div>
      <div class="share-actions">
        <a class="btn btn-secondary" data-share="email" target="_blank" rel="noopener">${icon('mail', 15)}<span>Email${invoice.customer_email ? ` ${esc(invoice.customer_email)}` : ''}</span></a>
        <a class="btn btn-secondary" data-share="whatsapp" target="_blank" rel="noopener">${icon('send', 15)}<span>WhatsApp${hasNumber ? ` ${esc(invoice.customer_phone)}` : ''}</span></a>
        <button type="button" class="btn btn-ghost" data-share="copy">Copy text</button>
      </div>
      ${!invoice.customer_email || !hasNumber ? `<div class="hint">${[
        invoice.customer_email ? '' : 'No email saved for this customer: your mail app will ask for the address.',
        hasNumber ? '' : 'No mobile number saved: WhatsApp will ask you to choose the chat.',
      ].filter(Boolean).join(' ')}</div>` : ''}
    `,
    onMount(overlay) {
      const text = overlay.querySelector('#share-message');
      const email = overlay.querySelector('[data-share="email"]');
      const whatsapp = overlay.querySelector('[data-share="whatsapp"]');
      const update = () => {
        email.href = mailtoUrl(invoice.customer_email, subject, text.value);
        whatsapp.href = whatsappUrl(invoice.customer_phone, text.value);
      };
      text.addEventListener('input', update);
      update();
      overlay.querySelector('[data-share="copy"]').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text.value);
          toast('Message copied');
        } catch {
          text.select();
          toast('Select the text and copy it with Ctrl/⌘ + C', 'error');
        }
      });
    },
  });
}

function invoiceVoidPreview(invoice) {
  const payments = invoice.payments.filter((payment) => payment.status === 'posted');
  const paymentTotal = payments.reduce((sum, payment) => sum + payment.amount_cents, 0);
  const refunded = payments.reduce((sum, payment) => sum + Number(payment.refunded_cents || 0), 0);
  const credits = invoice.credits || [];
  const creditTotal = credits.reduce((sum, credit) => sum + credit.amount_cents, 0);
  const items = [{
    label: `Invoice ${invoice.number}`,
    value: fmtMoney(invoice.total_cents),
    note: `${invoice.customer_name} · ${invoice.status_display || invoice.status}`,
  }];
  if (payments.length) {
    items.push({
      label: `${payments.length} linked payment${payments.length === 1 ? '' : 's'}`,
      value: fmtMoney(paymentTotal),
      note: refunded > 0
        ? `${fmtMoney(refunded)} already refunded; those refunds are reversed first`
        : 'Payment and deposit entries will be reversed',
    });
  }
  if (creditTotal > 0) {
    items.push({
      label: `${credits.length} credit application${credits.length === 1 ? '' : 's'}`,
      value: fmtMoney(creditTotal),
      note: 'Credits return to their credit notes',
    });
  }
  return {
    heading: 'Void preview',
    items,
    note: 'The original invoice, payments and credits stay in the ledger with matching reversing entries.',
  };
}

function paymentModalBody(invoice) {
  const accounts = cashAccounts().sort((a, b) => a.code.localeCompare(b.code));
  const preferred = accounts.find((account) => account.code === '1010')
    || accounts.find((account) => account.is_cash)
    || accounts[0];
  return `
    <div class="form-grid">
      <div class="field">
        <label for="payment-amount">Amount received</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="payment-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(invoice.balance_cents)}" required>
        </div>
        <div class="hint">Balance due ${fmtMoney(invoice.balance_cents)}</div>
      </div>
      <div class="field">
        <label for="payment-date">Payment date</label>
        <input class="input" id="payment-date" name="payment_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label for="payment-method">Method</label>
        <select class="input" id="payment-method" name="method">
          <option>Bank transfer</option>
          <option>Cash</option>
          <option>Credit card</option>
          <option>Cheque</option>
          <option>Other</option>
        </select>
      </div>
      <div class="field">
        <label for="payment-reference">Reference</label>
        <input class="input" id="payment-reference" name="reference" placeholder="e.g. wire reference" autocomplete="off">
      </div>
      <div class="field" data-cheque-field hidden>
        <label for="cheque-number">Cheque number</label>
        <input class="input" id="cheque-number" name="cheque_number" placeholder="e.g. 004512" autocomplete="off">
      </div>
      <div class="field" data-cheque-field hidden>
        <label for="cheque-date">Cheque date</label>
        <input class="input" id="cheque-date" name="cheque_date" type="date" value="${todayISO()}">
        <div class="hint">For tracking; the ledger posts on the payment date.</div>
      </div>
      <div class="field" data-cheque-field hidden>
        <label for="cheque-bank">Bank</label>
        <input class="input" id="cheque-bank" name="bank_name" placeholder="e.g. Emirates NBD" autocomplete="off">
      </div>
      <div class="field full">
        <label for="payment-account">Deposit to</label>
        <select class="input" id="payment-account" name="deposit_account_id">
          ${optionsHtml(accounts, { selected: preferred?.id, placeholder: 'Choose account…', labelKey: (account) => `${account.code} · ${account.name}` })}
        </select>
      </div>
      <div class="field full">
        <div class="form-note">Recording a payment debits your bank or cash account and credits Accounts Receivable. The invoice balance updates automatically.</div>
      </div>
    </div>
  `;
}

export async function render(container, { params } = {}) {
  const id = Number(params?.[0]);
  const invoice = await api.get(`/invoices/${id}`);
  const attachments = await loadAttachments('invoice', id);
  let journal = null;
  if (invoice.journal_entry_id) {
    try {
      journal = await api.get(`/journal-entries/${invoice.journal_entry_id}`);
    } catch { /* entry may have been archived */ }
  }

  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const isDraft = invoice.status === 'draft';
  const isVoid = invoice.status === 'void';
  const canRecordPayment = invoice.status === 'sent' && invoice.balance_cents > 0;
  // Booking, visa and cancellation invoices are reversed through their own
  // workflow so receipts, charges and supplier bills stay consistent.
  const isCancellationInvoice = Boolean(invoice.cancellation_id);
  const jobType = isCancellationInvoice ? null : invoice.booking_id ? 'booking' : invoice.visa_id ? 'visa' : null;
  const canVoid = invoice.status === 'sent' && !jobType && !isCancellationInvoice;

  const actions = [];
  actions.push(`<a class="btn btn-ghost" href="#/invoices"><span>All invoices</span></a>`);
  if (invoice.booking_id) {
    actions.push(`<a class="btn btn-secondary" href="#/bookings/${invoice.booking_id}">${icon('plane', 15)}<span>Booking</span></a>`);
  }
  if (invoice.visa_id) {
    actions.push(`<a class="btn btn-secondary" href="#/visas/${invoice.visa_id}">${icon('visa', 15)}<span>Visa</span></a>`);
  }
  if (isCancellationInvoice) {
    actions.push(`<a class="btn btn-secondary" href="#/cancellations/${invoice.cancellation_id}">${icon('x', 15)}<span>Cancellation note</span></a>`);
  }
  if (invoice.source_cancellation_id) {
    actions.push(`<a class="btn btn-secondary" href="#/cancellations/${invoice.source_cancellation_id}">${icon('x', 15)}<span>Cancellation ${esc(invoice.source_cancellation_number || '')}</span></a>`);
  }
  if (invoice.status === 'sent' && invoice.balance_cents > 0) {
    actions.push(`<a class="btn btn-ghost" href="#/credits?new=1&customer=${invoice.customer_id}">${icon('invoice', 15)}<span>Credit note</span></a>`);
  }
  actions.push(`<button class="btn btn-secondary" data-action="print">${icon('print', 15)}<span>Print</span></button>`);
  if (!isDraft && !isVoid) {
    actions.push(`<button class="btn btn-secondary" data-action="share">${icon('send', 15)}<span>Share</span></button>`);
  }
  if (isDraft) {
    actions.push(`<button class="btn btn-secondary" data-action="edit">${icon('edit', 15)}<span>Edit</span></button>`);
    actions.push(`<button class="icon-btn danger" data-action="delete" title="Delete draft">${icon('trash', 17)}</button>`);
    actions.push(`<button class="btn btn-primary" data-action="finalize">${icon('check', 15)}<span>Send &amp; post</span></button>`);
  } else if (canRecordPayment) {
    actions.push(`<button class="btn btn-primary" data-action="payment">${icon('plus', 15)}<span>Record payment</span></button>`);
  }
  if (canVoid) {
    actions.push(`<button class="btn btn-danger-ghost" data-action="void"><span>Void</span></button>`);
  }
  if (invoice.status === 'sent' && jobType) {
    actions.push(`<a class="btn btn-danger-ghost" href="#/${jobType === 'booking' ? 'bookings' : 'visas'}/${jobType === 'booking' ? invoice.booking_id : invoice.visa_id}" data-action="cancel-job" title="This invoice belongs to a ${jobType === 'booking' ? 'booking' : 'visa application'}. Cancel the job to reverse it.">${icon('x', 15)}<span>Cancel ${jobType === 'booking' ? 'booking' : 'visa'}</span></a>`);
  }

  actions.push(`<a class="btn btn-ghost" href="#/audit-chain/invoice/${id}">${icon('shield', 15)}<span>Audit chain</span></a>`);
  setHeader({
    title: invoice.number,
    subtitle: `${invoice.customer_name} · Issued ${fmtDate(invoice.issue_date)}`,
    actions: actions.join(''),
  });

  const paymentRows = invoice.payments.length
    ? invoice.payments.map((payment) => {
      const refunded = Number(payment.refunded_cents || 0);
      const refundable = Number(payment.refundable_cents || 0);
      return `
        <div class="payment-item">
          <div class="payment-icon">${icon('cash', 15)}</div>
          <div class="payment-main">
            <strong>${esc(payment.method || 'Payment')}</strong>
            <span>${esc(fmtDate(payment.payment_date))} · ${esc(payment.number)}${payment.reference ? ` · ${esc(payment.reference)}` : ''}${payment.status === 'void' ? ` · ${statusBadge('void')}` : ''}</span>
            ${payment.cheque_number ? `<span class="cell-sub">Cheque ${esc(payment.cheque_number)}${payment.bank_name ? ` · ${esc(payment.bank_name)}` : ''}${payment.cheque_date ? ` · ${esc(fmtDate(payment.cheque_date))}` : ''}</span>` : ''}
            ${payment.advance_id ? '<span class="cell-sub">Applied from customer advance</span>' : ''}
            ${payment.deposit_id ? `<span class="cell-sub">Paid from visa deposit ${esc(payment.reference || '')} · undo it on the visa's deposit card</span>` : ''}
            ${refunded > 0 ? `<span class="cell-sub">${fmtMoney(refunded)} refunded · ${fmtMoney(refundable)} refundable</span>` : ''}
          </div>
          <div class="payment-amount">
            <div>${fmtMoney(payment.amount_cents)}</div>
            ${refunded > 0 ? `<div class="cell-sub">net ${fmtMoney(payment.amount_cents - refunded)}</div>` : ''}
          </div>
          <a class="icon-btn" href="#/receipts/${payment.id}" data-receipt-link title="Print receipt ${esc(payment.number)}" aria-label="Print receipt ${esc(payment.number)}">${icon('print', 16)}</a>
          ${refundable > 0 && invoice.status === 'sent' ? `<button class="icon-btn" data-refund-payment="${payment.id}" title="Refund payment">${icon('arrowUp', 16)}</button>` : ''}
          ${refunded > 0 || invoice.status !== 'sent' || payment.deposit_id ? '' : `<button class="icon-btn danger" data-delete-payment="${payment.id}" title="Void payment">${icon('trash', 16)}</button>`}
        </div>
      `;
    }).join('')
    : emptyState({
      iconName: 'cash',
      title: 'No payments recorded',
      message: canRecordPayment ? 'Record a payment to reduce the balance due.' : 'Payments will appear here once recorded.',
    });

  const journalHtml = journal
    ? `
      <div class="entry-lines">
        <div class="entry-line" style="color:var(--muted-2);font-size:10px;text-transform:uppercase;letter-spacing:.05em">
          <div>Account</div><div class="dr">Debit</div><div class="cr">Credit</div>
        </div>
        ${journal.lines.map((line) => `
          <div class="entry-line">
            <div class="acct">${esc(line.account_name)}<small>${esc(line.account_code)}</small></div>
            <div class="dr">${line.debit_cents ? fmtMoney(line.debit_cents) : ''}</div>
            <div class="cr">${line.credit_cents ? fmtMoney(line.credit_cents) : ''}</div>
          </div>
        `).join('')}
        <div class="entry-total">
          <span>Total</span>
          <span>${fmtMoney(journal.total_cents)}</span>
          <span>${fmtMoney(journal.total_cents)}</span>
        </div>
      </div>
    `
    : `<div class="muted" style="font-size:12.5px;line-height:1.6">${isDraft
      ? 'This draft has not been posted to the ledger yet. Send it to create the journal entry.'
      : 'No journal entry is linked to this document.'}</div>`;

  // Booking and visa invoices store their trip or visa details as terms; the
  // trip and visa boxes now show them, so the terms column shows the due date.
  const hasJobDetails = ['ticket', 'booking', 'visa'].includes(invoice.document_kind);

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
            <div class="doc-kind" data-document-kind="${esc(invoice.document_kind || 'service')}">${esc(DOCUMENT_TITLES[invoice.document_kind] || 'Invoice')}</div>
            <div class="doc-number">${esc(invoice.number)}</div>
            <div class="doc-status">${statusBadge(invoice.status_display)}</div>
            <dl class="doc-meta-grid">
              <dt>Issue date</dt><dd>${esc(fmtDate(invoice.issue_date))}</dd>
              <dt>Due date</dt><dd>${esc(fmtDate(invoice.due_date))}</dd>
              ${sourceMetaHtml(invoice)}
              <dt>Amount due</dt><dd>${fmtMoney(invoice.balance_cents)}</dd>
            </dl>
          </div>
        </div>

        <div class="doc-parties">
          <div>
            <div class="doc-label">Bill to</div>
            <div class="doc-party-name">${esc(invoice.customer_name)}</div>
            <div class="doc-party-detail">${esc([invoice.customer_address, invoice.customer_email, invoice.customer_phone].filter(Boolean).join('\n'))}</div>
          </div>
          <div>
            <div class="doc-label">Payment terms</div>
            <div class="doc-terms">${esc((hasJobDetails ? '' : invoice.terms) || `Payment due by ${fmtDate(invoice.due_date, { long: true })}.`)}</div>
          </div>
        </div>

        ${tripDetailsHtml(invoice)}
        ${visaApplicantHtml(invoice)}
        ${beneficiaryHtml(invoice)}

        <div class="doc-items-wrap">
          <table class="doc-items"><caption class="sr-only">Invoice line items</caption>
            <thead>
              <tr>
                <th scope="col" style="width:46%">Description</th>
                <th scope="col" class="num">Qty</th>
                <th scope="col" class="num">Unit price</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${invoice.items.map((item) => `
                <tr>
                  <td>${esc(item.description)}${item.ticket_no ? `<div class="doc-item-sub">Ticket ${esc(item.ticket_no)}</div>` : ''}</td>
                  <td class="num">${fmtNumber(item.quantity)}</td>
                  <td class="num">${fmtMoney(item.unit_price_cents)}</td>
                  <td class="num amount">${fmtMoney(item.amount_cents)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="doc-total-area">
          <div class="doc-notes">
            ${invoice.notes ? `<strong>Notes</strong>${esc(invoice.notes)}` : ''}
          </div>
          <div class="doc-totals">
            <div class="totals-row"><span>Subtotal</span><span>${fmtMoney(invoice.subtotal_cents)}</span></div>
            <div class="totals-row total"><span>Total</span><span>${fmtMoney(invoice.total_cents)}</span></div>
            ${invoice.amount_paid_cents > 0 ? `<div class="totals-row"><span>Paid</span><span>−${fmtMoney(invoice.amount_paid_cents)}</span></div>` : ''}
            ${invoice.credit_applied_cents > 0 ? `<div class="totals-row"><span>Credits applied</span><span>−${fmtMoney(invoice.credit_applied_cents)}</span></div>` : ''}
            <div class="totals-row balance"><span>Balance due</span><span>${fmtMoney(invoice.balance_cents)}</span></div>
          </div>
        </div>
        <div class="doc-amount-words" data-amount-words><span class="doc-label">Amount in words</span>${esc(amountInWords(invoice.total_cents))}</div>
      </div>
    </div>

    <div class="detail-grid no-print">
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Payments</h2><p>${invoice.amount_paid_cents > 0 ? `${fmtMoney(invoice.amount_paid_cents)} received` : 'Nothing received yet'}</p></div>
          ${canRecordPayment ? `<button class="btn btn-secondary btn-sm" data-action="payment">${icon('plus', 14)} Record</button>` : ''}
        </div>
        <div class="card-body" ${invoice.payments.length ? 'style="padding:4px 20px"' : ''}>
          ${paymentRows}
          ${invoice.credits?.length ? `
            <div class="credit-application-list">
              <div class="credit-application-title">Credits applied</div>
              ${invoice.credits.map((credit) => `
                <div class="credit-application-row">
                  <div><a href="#/credits/${credit.credit_note_id}"><strong>${esc(credit.credit_number)}</strong></a><span class="cell-sub">${esc(fmtDate(credit.applied_date))}${credit.credit_status === 'void' ? ' · void' : ''}</span></div>
                  <strong>−${fmtMoney(credit.amount_cents)}</strong>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title"><h2>Ledger entry</h2><p>${journal ? `Posted ${esc(fmtDate(journal.entry_date))}` : 'Not posted'}</p></div>
          ${journal ? `<a class="card-link" href="#/journal?focus=${journal.id}">Open ${icon('chevron', 12)}</a>` : ''}
        </div>
        <div class="card-body">${journalHtml}</div>
      </div>
    </div>

    ${attachmentSection({ entityType: 'invoice', entityId: id, attachments })}
  `;

  bindAttachmentSection(container, { entityType: 'invoice', entityId: id });

  function refresh() {
    return render(container, { params: [String(id)] });
  }

  document.querySelectorAll('[data-action="print"]').forEach((button) => {
    button.addEventListener('click', () => window.print());
  });

  document.querySelector('[data-action="share"]')?.addEventListener('click', () => openShareModal(invoice, settings));

  const editButton = document.querySelector('[data-action="edit"]');
  if (editButton) {
    editButton.addEventListener('click', () => {
      openInvoiceModal({
        invoice,
        onSaved: () => refresh(),
      });
    });
  }

  const finalizeButton = document.querySelector('[data-action="finalize"]');
  if (finalizeButton) {
    finalizeButton.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: 'Send and post this invoice?',
        message: 'This will lock the invoice and post a receivable and revenue to your ledger.',
        confirmLabel: 'Send & post',
        danger: false,
      });
      if (!confirmed) return;
      try {
        await api.post(`/invoices/${id}/finalize`, {});
        toast(`${invoice.number} posted to the ledger`);
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
        title: 'Delete this draft?',
        message: `Draft ${invoice.number} will be permanently deleted. Nothing has been posted to the ledger yet.`,
        confirmLabel: 'Delete draft',
      });
      if (!confirmed) return;
      try {
        await api.del(`/invoices/${id}`);
        toast('Draft invoice deleted');
        location.hash = '#/invoices';
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  const voidButton = document.querySelector('[data-action="void"]');
  if (voidButton) {
    voidButton.addEventListener('click', async () => {
      const result = await voidDialog({
        title: `Void ${invoice.number}?`,
        message: 'A reversing journal entry will be posted to cancel this invoice. Any linked payments, refunds and credit applications will also be reversed.',
        warning: 'This cannot be undone. The invoice and every linked reversal are kept permanently in the audit trail.',
        preview: invoiceVoidPreview(invoice),
        confirmLabel: 'Void invoice',
      });
      if (!result.confirmed) return;
      try {
        await api.post(`/invoices/${id}/void`, { remarks: result.remarks });
        toast(`${invoice.number} voided with a reversing entry`);
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  document.querySelectorAll('[data-action="payment"]').forEach((button) => {
    button.addEventListener('click', () => {
      openModal({
        title: 'Record payment',
        subtitle: `${invoice.number} · ${invoice.customer_name}`,
        body: paymentModalBody(invoice),
        submitLabel: 'Record payment',
        onMount(overlay) {
          const method = overlay.querySelector('#payment-method');
          const account = overlay.querySelector('#payment-account');
          const chequeFields = overlay.querySelectorAll('[data-cheque-field]');
          const chequeDate = overlay.querySelector('#cheque-date');
          const paymentDate = overlay.querySelector('#payment-date');
          if (!method || !account) return;
          const syncCheque = () => {
            const isCheque = ['Cheque', 'Check'].includes(method.value);
            chequeFields.forEach((field) => { field.hidden = !isCheque; });
            if (isCheque && chequeDate && !chequeDate.value) {
              chequeDate.value = paymentDate?.value || todayISO();
            }
          };
          method.addEventListener('change', () => {
            const code = method.value === 'Cash' ? '1000' : '1010';
            const target = cashAccounts().find((candidate) => candidate.code === code);
            if (target) account.value = String(target.id);
            syncCheque();
          });
          syncCheque();
        },
        async onSubmit(form) {
          const values = new FormData(form);
          const amount = toCents(values.get('amount'));
          if (amount <= 0) throw new Error('Enter a payment amount');
          const method = values.get('method');
          const chequeNumber = values.get('cheque_number');
          if (['Cheque', 'Check'].includes(method) && !String(chequeNumber || '').trim()) {
            throw new Error('Enter the cheque number');
          }
          await api.post(`/invoices/${id}/payments`, {
            amount_cents: amount,
            payment_date: values.get('payment_date'),
            method,
            reference: values.get('reference'),
            cheque_number: chequeNumber,
            cheque_date: values.get('cheque_date'),
            bank_name: values.get('bank_name'),
            deposit_account_id: Number(values.get('deposit_account_id')),
          });
          toast(`Payment of ${fmtMoney(amount)} recorded`);
          refresh();
        },
      });
    });
  });

  document.querySelectorAll('[data-refund-payment]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const payment = invoice.payments.find((candidate) => candidate.id === Number(button.dataset.refundPayment));
      if (!payment) return;
      openRefundModal({
        type: 'customer',
        source: {
          payment_id: payment.id,
          document_id: invoice.id,
          document_number: invoice.number,
          payment_number: payment.number,
          payment_date: payment.payment_date,
          party_name: invoice.customer_name,
          amount_cents: payment.amount_cents,
          refunded_cents: payment.refunded_cents || 0,
          refundable_cents: payment.refundable_cents,
          account_id: payment.deposit_account_id,
          method: payment.method,
        },
        onSaved: () => refresh(),
      });
    });
  });

  document.querySelectorAll('[data-delete-payment]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const payment = invoice.payments.find((candidate) => candidate.id === Number(button.dataset.deletePayment));
      const result = await voidDialog({
        title: 'Void this payment?',
        message: 'The payment will be voided and a reversing journal entry will be posted. The payment record and its audit trail are kept, and the invoice balance will reopen.',
        warning: 'Any refund linked to this payment must also be reversed. This cannot be undone.',
        preview: payment ? {
          heading: 'Void preview',
          items: [
            {
              label: `Payment ${payment.number}`,
              value: fmtMoney(payment.amount_cents),
              note: `${fmtDate(payment.payment_date)} · ${payment.method || 'Payment'}`,
            },
            {
              label: `Invoice ${invoice.number}`,
              value: fmtMoney(invoice.balance_cents + payment.amount_cents),
              note: 'Balance reopens after the reversal',
            },
          ],
          note: payment.advance_id ? 'The linked customer advance application will also be reversed.' : '',
        } : null,
        confirmLabel: 'Void payment',
      });
      if (!result.confirmed) return;
      try {
        await api.del(`/invoices/payments/${button.dataset.deletePayment}`, { remarks: result.remarks });
        toast('Payment voided');
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  return () => {};
}
