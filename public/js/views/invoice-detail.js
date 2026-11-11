import { api } from '../api.js';
import { bindMethodAccount, MONEY_IN_METHODS, methodOptionsHtml } from '../payment-methods.js';
import { bankChargesFieldHtml, bindBankCharges, readBankCharges } from '../bank-charges.js';
import { cashAccounts, store } from '../store.js';
import {
  centsToInput,
  companyMark,
  confirmDialog,
  currencySymbol,
  esc,
  foldHtml,
  foldsHtml,
  fmtDate,
  fmtMoney,
  fmtNumber,
  icon,
  moreMenuHtml,
  openModal,
  optionsHtml,
  setHeader,
  statusBadge,
  toast,
  toCents,
  todayISO,
  voidDialog,
  pageRecord,
  printPage,
} from '../ui.js';
import { bindCorrections, correctButtonHtml } from '../corrections.js';
import { amountInWords } from '../amount-words.js';
import { invoiceMessage, mailtoUrl, whatsappNumber, whatsappUrl } from '../share-links.js';
import { openInvoiceModal } from './invoices.js';
import { openRefundModal } from './refund-modal.js';
import { visaDurationLabel, visaTypeLabel } from './visas.js';
import { attachmentFoldHtml, bindAttachmentSection, loadAttachments } from '../attachments.js';

const DOCUMENT_TITLES = {
  ticket: 'Ticket invoice',
  booking: 'Booking invoice',
  visa: 'Visa invoice',
  cancellation: 'Cancellation invoice',
  service: 'Invoice',
};

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
    <div class="doc-parties-right" data-beneficiary>
      <div class="doc-label">Service for</div>
      <div class="doc-party-name">${esc(name)}</div>
      ${details.length ? `<div class="doc-party-detail">${esc(details.join(' · '))}</div>` : ''}
    </div>
  `;
}

// The table: a ticket invoice lists each passenger with their ticket number
// (or the booking PNR when there is none) and never shows Qty or Unit price:
// a line with another quantity says "2 × 50.00" beside its name. Other
// invoices show Qty and Unit price only when some line's quantity is not 1.
function itemsTableHtml(invoice) {
  const items = invoice.items || [];
  if (invoice.document_kind === 'visa') return visaTableHtml(invoice, items);
  const passengers = ['ticket', 'booking'].includes(invoice.document_kind) && items.some((item) => item.passenger_name);
  const qty = !passengers && items.some((item) => Number(item.quantity) !== 1);
  const times = (item) => (Number(item.quantity) !== 1 ? ` · ${fmtNumber(item.quantity)} × ${fmtMoney(item.unit_price_cents)}` : '');
  const route = (item) => {
    const name = item.passenger_name;
    if (!name) return item.description;
    if (item.description === name) return '—';
    return item.description.endsWith(` – ${name}`) ? item.description.slice(0, -(name.length + 3)) : item.description;
  };
  const head = [
    ...(passengers ? ['<th scope="col">Passenger</th>', '<th scope="col">Route / service</th>', '<th scope="col">Ticket / PNR</th>'] : ['<th scope="col">Description</th>']),
    ...(qty ? ['<th scope="col" class="num">Qty</th>', '<th scope="col" class="num">Unit price</th>'] : []),
    '<th scope="col" class="num">Amount</th>',
  ].join('');
  const rows = items.map((item) => {
    const ref = item.ticket_no || (item.passenger_name ? invoice.booking_pnr || '' : '');
    return `<tr>
      ${passengers
    ? `<td class="doc-passenger">${item.passenger_name ? esc(item.passenger_name) : '<span class="muted">—</span>'}</td>
         <td class="muted">${esc(route(item) + times(item))}</td>
         <td class="doc-ref">${ref ? esc(ref) : '<span class="muted">—</span>'}</td>`
    : `<td>${esc(item.description)}</td>`}
      ${qty ? `<td class="num">${fmtNumber(item.quantity)}</td><td class="num">${fmtMoney(item.unit_price_cents)}</td>` : ''}
      <td class="num amount">${fmtMoney(item.amount_cents)}</td>
    </tr>`;
  }).join('');
  return `<table class="doc-items"><caption class="sr-only">Invoice line items</caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// A visa invoice: the applicant, passport and visa on the first line (the
// visa itself); the lines after it are services for the same application.
function visaTableHtml(invoice, items) {
  const times = (item) => (Number(item.quantity) !== 1 ? ` · ${fmtNumber(item.quantity)} × ${fmtMoney(item.unit_price_cents)}` : '');
  const dash = '<span class="muted">—</span>';
  const rows = items.map((item, index) => {
    const first = index === 0;
    const passport = invoice.visa_passport_masked
      ? `<span class="doc-ref">${esc(invoice.visa_passport_masked)}</span>${invoice.visa_passport_expiry ? `<div class="doc-item-sub">exp. ${esc(fmtDate(invoice.visa_passport_expiry))}</div>` : ''}`
      : dash;
    return `<tr>
      <td class="doc-passenger">${first && invoice.visa_applicant_name ? `${esc(invoice.visa_applicant_name)}${invoice.visa_nationality ? `<div class="doc-item-sub">${esc(invoice.visa_nationality)}</div>` : ''}` : dash}</td>
      <td>${first ? passport : dash}</td>
      <td>${first && invoice.visa_destination_country && !item.description.toLowerCase().includes(invoice.visa_destination_country.toLowerCase()) ? `${esc(invoice.visa_destination_country)} · ` : ''}${esc(item.description + times(item))}${first && invoice.visa_duration_days && !/\bdays?\b/i.test(item.description) ? ` · ${esc(visaDurationLabel(invoice.visa_duration_days))}` : ''}</td>
      <td class="num amount">${fmtMoney(item.amount_cents)}</td>
    </tr>`;
  }).join('');
  return `<table class="doc-items"><caption class="sr-only">Invoice line items</caption><thead><tr>
    <th scope="col">Passenger</th><th scope="col">Passport no.</th><th scope="col">Visa type</th><th scope="col" class="num">Amount</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

// The refundable security deposit: its own card, never part of the total.
function depositCardHtml(invoice) {
  const deposit = invoice.visa_deposit;
  if (!deposit) return '';
  const returned = deposit.returned.reduce((sum, row) => sum + row.amount_cents, 0);
  const settled = deposit.held_cents <= 0;
  const status = settled ? (returned ? 'Returned' : 'Settled') : 'Held';
  const second = deposit.returned.length
    ? deposit.returned.map((row) => `<strong>Returned</strong> ${esc(fmtDate(row.date))}${row.method ? ` · ${esc(row.method)}` : ''} · ${fmtMoney(row.amount_cents)}`).join('<br>')
    : '<span class="muted">Returned when the visitor leaves on time, less any fines</span>';
  return `
    <div class="doc-deposit ${settled ? 'is-settled' : ''}" data-visa-deposit>
      <div class="doc-deposit-head">
        <div><strong>Refundable security deposit</strong> <span class="doc-deposit-status">${status}</span>
          <div class="doc-item-sub">${esc(deposit.number)} · not part of this invoice</div></div>
        <div class="doc-deposit-amount">${fmtMoney(deposit.amount_cents)}</div>
      </div>
      <div class="doc-deposit-line">
        <span class="doc-deposit-dot"></span><span><strong>Received</strong> ${esc(fmtDate(deposit.received_date))}${deposit.received_method ? ` · ${esc(deposit.received_method)}` : ''}</span>
        <span class="doc-deposit-track"></span>
        <span class="doc-deposit-dot is-end"></span><span>${second}</span>
      </div>
      ${deposit.applied_cents ? `<div class="doc-item-sub">Used for an invoice: ${fmtMoney(deposit.applied_cents)}</div>` : ''}
      ${deposit.kept_cents ? `<div class="doc-item-sub">Kept for fines or charges: ${fmtMoney(deposit.kept_cents)}</div>` : ''}
    </div>`;
}

// Right of Bill to: the trip of a ticket invoice, or a service invoice's own terms.
function partiesRightHtml(invoice, hasJobDetails) {
  if (['ticket', 'booking'].includes(invoice.document_kind)) {
    const dates = invoice.booking_travel_date
      ? `${fmtDate(invoice.booking_travel_date)}${invoice.booking_return_date ? ` – ${fmtDate(invoice.booking_return_date)}` : ''}`
      : '';
    const people = invoice.booking_passenger_count ? `${invoice.booking_passenger_count} passenger${invoice.booking_passenger_count === 1 ? '' : 's'}` : '';
    return `<div class="doc-parties-right" data-trip-details>
      <div class="doc-label">Trip</div>
      <div class="doc-party-name">${esc(invoice.booking_destination || invoice.booking_number || '—')}</div>
      <div class="doc-party-detail">${esc([dates, people].filter(Boolean).join(' · '))}${invoice.booking_number ? `\nBooking ${esc(invoice.booking_number)}` : ''}</div>
    </div>`;
  }
  if (invoice.document_kind === 'visa') {
    return `<div class="doc-parties-right" data-visa-details>
      <div class="doc-label">Application</div>
      <div class="doc-party-name">${esc(invoice.visa_number || '—')}</div>
      <div class="doc-party-detail">${esc([invoice.visa_reference ? `Ref ${invoice.visa_reference}` : '', invoice.visa_group_number ? `Group ${invoice.visa_group_number}` : ''].filter(Boolean).join('\n'))}</div>
    </div>`;
  }
  const beneficiary = beneficiaryHtml(invoice);
  if (beneficiary) return beneficiary;
  if (!hasJobDetails && invoice.terms) {
    return `<div class="doc-parties-right"><div class="doc-label">Payment terms</div><div class="doc-terms">${esc(invoice.terms)}</div></div>`;
  }
  return '<div></div>';
}

// What was paid, one line each: date and method, the receipt number small.
function paidLinesHtml(invoice) {
  const payments = (invoice.payments || []).filter((payment) => payment.status !== 'void');
  const credits = invoice.credits || [];
  const refunded = payments.reduce((sum, payment) => sum + (payment.refunded_cents || 0), 0);
  if (!payments.length && !credits.length) return '';
  const short = (date) => fmtDate(date).replace(/,? \d{4}$/, '');
  const line = (label, sub, cents) => `<div class="doc-paid-line"><span>${esc(label)}<small>${esc(sub)}</small></span><span>−${fmtMoney(cents)}</span></div>`;
  return `<div class="doc-paid" data-paid-lines>
    <div class="doc-label">Paid</div>
    ${payments.map((payment) => line(`${short(payment.payment_date)} · ${payment.method || 'Payment'}`, [payment.number, payment.reference].filter(Boolean).join(' · '), payment.amount_cents)).join('')}
    ${credits.map((credit) => line(`${short(credit.applied_date)} · Credit note`, credit.credit_number, credit.amount_cents)).join('')}
    ${refunded ? `<div class="doc-paid-line"><span>Refunded</span><span>+${fmtMoney(refunded)}</span></div>` : ''}
  </div>`;
}

// How to pay, while something is still due.
function howToPayHtml(invoice, settings) {
  if (invoice.status !== 'sent' || invoice.balance_cents <= 0) return '';
  const bank = settings.bank_iban
    ? `<div>Pay by bank: ${esc([settings.bank_name, settings.bank_account_name].filter(Boolean).join(' · '))}</div><div class="nowrap">IBAN ${esc(settings.bank_iban)}</div>`
    : '';
  if (!bank && !invoice.payment_link) return '';
  return `<div class="doc-howto" data-pay-online>
    ${bank}
    ${invoice.payment_link ? `<div>Pay online: <a href="${esc(invoice.payment_link)}" target="_blank" rel="noopener noreferrer">${esc(invoice.payment_link)}</a></div>` : ''}
  </div>`;
}

function termsHtml(invoice, settings) {
  const own = ['ticket', 'booking'].includes(invoice.document_kind) ? settings.invoice_terms_ticket
    : invoice.document_kind === 'visa' ? settings.invoice_terms_visa : '';
  const terms = String(own || settings.invoice_terms || '').trim();
  return terms ? `<div class="doc-terms-foot">${esc(terms)}</div>` : '';
}

// Send the invoice from the user's own email or WhatsApp. Nothing is sent by
// Netfare itself; the PDF is attached by printing to PDF first.
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
  // The desktop app makes the PDF and sends it with the message.
  const docs = window.netfareDocs;
  openModal({
    title: `Share ${invoice.number}`,
    size: 'modal-md',
    hideFooter: true,
    body: `
      <div class="field">
        <label for="share-message">Message</label>
        <textarea class="input" id="share-message" rows="10">${esc(message)}</textarea>
      </div>
      ${docs ? `<div class="share-pdf" data-share-pdf>${icon('file', 16)}<span>${esc(invoice.number)}.pdf</span><span class="muted">goes with WhatsApp and Email</span></div>` : ''}
      <div class="share-actions">
        <a class="btn btn-secondary" data-share="email" target="_blank" rel="noopener">${icon('mail', 15)}<span>Email${invoice.customer_email ? ` ${esc(invoice.customer_email)}` : ''}</span></a>
        <a class="btn btn-secondary" data-share="whatsapp" target="_blank" rel="noopener">${icon('send', 15)}<span>WhatsApp${hasNumber ? ` ${esc(invoice.customer_phone)}` : ''}</span></a>
        <button type="button" class="btn btn-ghost" data-share="copy">Copy text</button>
        <button type="button" class="btn btn-ghost" data-share="pdf">${icon('print', 15)}<span>${docs ? 'Save PDF' : 'PDF'}</span></button>
      </div>
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
      // The page must be the invoice alone when the PDF is made, so the
      // window closes first.
      const closeThen = (work) => {
        overlay.querySelector('[data-close]').click();
        setTimeout(work, 300);
      };
      if (docs) {
        for (const link of [whatsapp, email]) {
          link.addEventListener('click', (event) => {
            event.preventDefault();
            const url = link.href;
            closeThen(async () => {
              try {
                const result = await docs.share(document.title, text.value, url);
                if (result?.shared === 'file') toast(`${result.file} is in Downloads: drag it into the chat or email`);
                if (result?.error) throw new Error(result.error);
              } catch (error) {
                toast(error.message || 'The PDF could not be made', 'error');
              }
            });
          });
        }
      }
      overlay.querySelector('[data-share="pdf"]').addEventListener('click', () => closeThen(async () => {
        if (!docs) return window.print();
        try {
          const result = await docs.save(document.title);
          if (result?.saved) toast(`${result.saved} saved`);
        } catch (error) {
          toast(error.message || 'The PDF could not be saved', 'error');
        }
      }));
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
      </div>
      <div class="field">
        <label for="payment-date">Payment date</label>
        <input class="input" id="payment-date" name="payment_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label for="payment-method">Method</label>
        <select class="input" id="payment-method" name="method">${methodOptionsHtml(MONEY_IN_METHODS)}</select>
      </div>
      <div class="field">
        <label for="payment-reference">Reference</label>
        <input class="input" id="payment-reference" name="reference" placeholder="e.g. wire reference" autocomplete="off">
      </div>
      ${bankChargesFieldHtml('received')}
      <div class="field" data-cheque-field hidden>
        <label for="cheque-number">Cheque number</label>
        <input class="input" id="cheque-number" name="cheque_number" placeholder="e.g. 004512" autocomplete="off">
      </div>
      <div class="field" data-cheque-field hidden>
        <label for="cheque-date">Cheque date</label>
        <input class="input" id="cheque-date" name="cheque_date" type="date" value="${todayISO()}">
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

  // One main action; everything else is in the More menu.
  const actions = [];
  const menu = [];
  if (!isDraft && !isVoid) {
    menu.push(`<button class="btn btn-ghost" data-action="share">${icon('send', 15)}<span>Share</span></button>`);
  }
  if (invoice.booking_id) {
    menu.push(`<a class="btn btn-ghost" href="#/bookings/${invoice.booking_id}">${icon('plane', 15)}<span>Booking</span></a>`);
  }
  if (invoice.visa_id) {
    menu.push(`<a class="btn btn-ghost" href="#/visas/${invoice.visa_id}">${icon('visa', 15)}<span>Visa</span></a>`);
  }
  if (isCancellationInvoice) {
    menu.push(`<a class="btn btn-secondary" href="#/cancellations/${invoice.cancellation_id}">${icon('x', 15)}<span>Cancellation note</span></a>`);
  }
  if (invoice.source_cancellation_id) {
    menu.push(`<a class="btn btn-secondary" href="#/cancellations/${invoice.source_cancellation_id}">${icon('x', 15)}<span>Cancellation ${esc(invoice.source_cancellation_number || '')}</span></a>`);
  }
  if (invoice.status === 'sent' && invoice.balance_cents > 0) {
    menu.push(`<a class="btn btn-ghost" href="#/credits?new=1&customer=${invoice.customer_id}">${icon('invoice', 15)}<span>Credit note</span></a>`);
  }
  menu.push(`<button class="btn btn-ghost" data-action="print">${icon('print', 15)}<span>Print</span></button>`);
  if (isDraft) {
    actions.push(`<button class="btn btn-secondary" data-action="edit">${icon('edit', 15)}<span>Edit</span></button>`);
    menu.push(`<button class="btn btn-danger-ghost" data-action="delete">${icon('trash', 15)}<span>Delete draft</span></button>`);
    actions.push(`<button class="btn btn-primary" data-action="finalize">${icon('check', 15)}<span>Send &amp; post</span></button>`);
  } else if (canRecordPayment) {
    actions.push(`<button class="btn btn-primary" data-action="payment">${icon('plus', 15)}<span>Record payment</span></button>`);
  }
  if (!isVoid) {
    menu.push(`<button class="btn btn-ghost" data-action="payment-link">${icon('send', 15)}<span>${invoice.payment_link ? 'Change payment link' : 'Add payment link'}</span></button>`);
  }
  menu.push(`<a class="btn btn-ghost" href="#/audit-chain/invoice/${id}">${icon('shield', 15)}<span>Audit chain</span></a>`);
  menu.push(`<a class="btn btn-ghost" href="#/invoices"><span>All invoices</span></a>`);
  if (canVoid && !invoice.is_opening) {
    menu.push(`<button class="btn btn-ghost" data-action="correct-document">${icon('edit', 15)}<span>Correct</span></button>`);
  }
  if (canVoid) {
    menu.push(`<button class="btn btn-danger-ghost" data-action="void"><span>Void</span></button>`);
  }
  if (invoice.status === 'sent' && jobType) {
    menu.push(`<a class="btn btn-danger-ghost" href="#/${jobType === 'booking' ? 'bookings' : 'visas'}/${jobType === 'booking' ? invoice.booking_id : invoice.visa_id}" data-action="cancel-job" title="This invoice belongs to a ${jobType === 'booking' ? 'booking' : 'visa application'}. Cancel the job to reverse it.">${icon('x', 15)}<span>Cancel ${jobType === 'booking' ? 'booking' : 'visa'}</span></a>`);
  }

  pageRecord(invoice, { print: true });
  setHeader({
    title: invoice.number,
    badge: statusBadge(invoice.status_display),
    actions: actions.join('') + moreMenuHtml(menu),
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
            ${payment.bank_charges_cents ? `<span class="cell-sub">Bank kept ${fmtMoney(payment.bank_charges_cents)} · 6700 Bank Charges</span>` : ''}
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
          ${refunded > 0 || invoice.status !== 'sent' || payment.deposit_id || payment.advance_id || payment.status === 'void' ? '' : correctButtonHtml('payment', payment)}
          ${refunded > 0 || invoice.status !== 'sent' || payment.deposit_id ? '' : `<button class="icon-btn danger" data-delete-payment="${payment.id}" title="Void payment">${icon('trash', 16)}</button>`}
        </div>
      `;
    }).join('')
    : '<p class="muted fold-empty">No payments yet</p>';

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
      <div class="doc doc-invoice">
        <div class="doc-head">
          <div class="doc-brand">
            ${companyMark(company)}
            <div>
              <div class="doc-company-name">${esc(company)}</div>
              <div class="doc-company-detail">${esc([settings.company_address, [settings.company_email, settings.company_phone].filter(Boolean).join(' · ')].filter(Boolean).join('\n'))}</div>
            </div>
          </div>
          <div class="doc-meta">
            <div class="doc-kind" data-document-kind="${esc(invoice.document_kind || 'service')}">${esc(DOCUMENT_TITLES[invoice.document_kind] || 'Invoice')}</div>
            <div class="doc-number">${esc(invoice.number)} ${statusBadge(invoice.status_display)}</div>
            <dl class="doc-dates"><dt>Issued</dt><dd>${esc(fmtDate(invoice.issue_date))}</dd><dt>Due</dt><dd>${esc(fmtDate(invoice.due_date))}</dd></dl>
          </div>
        </div>

        <div class="doc-parties">
          <div>
            <div class="doc-label">Bill to</div>
            <div class="doc-party-name">${esc(invoice.customer_name)}</div>
            <div class="doc-party-detail">${esc([[invoice.customer_number, invoice.customer_address].filter(Boolean).join(' · '), [invoice.customer_email, invoice.customer_phone].filter(Boolean).join(' · '), invoice.customer_trn ? `TRN ${invoice.customer_trn}` : ''].filter(Boolean).join('\n'))}</div>
          </div>
          ${partiesRightHtml(invoice, hasJobDetails)}
        </div>

        ${invoice.document_kind === 'visa' ? '' : visaApplicantHtml(invoice)}

        <div class="doc-items-wrap" tabindex="0" role="region" aria-label="Line items">
          ${itemsTableHtml(invoice)}
        </div>

        <div class="doc-total-area">
          <div class="doc-notes">
            <div class="doc-amount-words" data-amount-words>${esc(amountInWords(invoice.total_cents))}</div>
            ${invoice.notes ? `<div class="doc-note"><strong>Notes</strong>${esc(invoice.notes)}</div>` : ''}
          </div>
          <div class="doc-totals">
            ${invoice.subtotal_cents !== invoice.total_cents ? `<div class="totals-row"><span>Subtotal</span><span>${fmtMoney(invoice.subtotal_cents)}</span></div>` : ''}
            <div class="totals-row total"><span>Total</span><span>${fmtMoney(invoice.total_cents)}</span></div>
            ${paidLinesHtml(invoice)}
            <div class="totals-row balance"><span>Balance due</span><span>${fmtMoney(invoice.balance_cents)}</span></div>
          </div>
        </div>

        ${depositCardHtml(invoice)}
        <div class="doc-foot-grid">
          ${howToPayHtml(invoice, settings)}
          ${termsHtml(invoice, settings)}
        </div>
      </div>
    </div>

    ${foldsHtml([
    foldHtml({
    key: 'payments',
    title: 'Payments',
    count: invoice.payments.length + (invoice.credits?.length || 0),
    body: `${paymentRows}${invoice.credits?.length ? `
            <div class="credit-application-list">
              <div class="credit-application-title">Credits applied</div>
              ${invoice.credits.map((credit) => `
                <div class="credit-application-row">
                  <div><a href="#/credits/${credit.credit_note_id}"><strong>${esc(credit.credit_number)}</strong></a><span class="cell-sub">${esc(fmtDate(credit.applied_date))}${credit.credit_status === 'void' ? ' · void' : ''}</span></div>
                  <strong>−${fmtMoney(credit.amount_cents)}</strong>
                </div>
              `).join('')}
            </div>` : ''}`,
  }),
    foldHtml({
    key: 'ledger',
    title: 'Ledger entry',
    actions: journal ? `<a class="card-link" href="#/journal?focus=${journal.id}">Open ${icon('chevron', 12)}</a>` : '',
    body: journalHtml,
  }),
    attachmentFoldHtml({ entityType: 'invoice', entityId: id, attachments }),
  ])}
  `;

  bindAttachmentSection(container, { entityType: 'invoice', entityId: id });
  bindCorrections(container, () => render(container, { params: [String(id)] }));
  // Admin only: correct the posted invoice; the page then shows the new one.
  document.querySelector('[data-action="correct-document"]')?.addEventListener('click', () => {
    openInvoiceModal({ invoice, correct: true, onSaved: (saved) => { location.hash = `#/invoices/${saved.id}`; } });
  });

  function refresh() {
    return render(container, { params: [String(id)] });
  }

  document.querySelectorAll('[data-action="print"]').forEach((button) => {
    button.addEventListener('click', () => printPage());
  });

  document.querySelector('[data-action="share"]')?.addEventListener('click', () => openShareModal(invoice, settings));
  document.querySelector('[data-action="payment-link"]')?.addEventListener('click', () => {
    openModal({
      // Printed on the invoice and added to the share message; empty removes it.
      title: 'Payment link',
      body: `<div class="form-grid">
        <div class="field full"><label for="pay-link">Link for ${esc(fmtMoney(invoice.balance_cents))}</label>
          <input class="input" id="pay-link" type="url" value="${esc(invoice.payment_link || '')}" placeholder="https://…" autocomplete="off"></div>
      </div>`,
      submitLabel: 'Save link',
      async onSubmit(form) {
        await api.put(`/invoices/${id}/payment-link`, { payment_link: form.querySelector('#pay-link').value.trim() });
        toast('Payment link saved');
        refresh();
      },
    });
  });

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
        message: `Draft ${invoice.number} will be permanently deleted. Delete is only for drafts: nothing has been posted to the ledger yet.`,
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
          bindMethodAccount(method, account, cashAccounts());
          method.addEventListener('change', syncCheque);
          syncCheque();
          bindBankCharges(overlay, method, account);
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
            bank_charges_cents: readBankCharges(form),
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
