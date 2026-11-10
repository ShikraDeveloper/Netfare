import { api } from '../api.js';
import { bankChargesFieldHtml, bindBankCharges, readBankCharges } from '../bank-charges.js';
import { cashAccounts, store } from '../store.js';
import {
  centsToInput,
  companyMark,
  confirmDialog,
  currencySymbol,
  esc,
  fmtDate,
  fmtMoney,
  fmtNumber,
  foldHtml,
  foldsHtml,
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
  pageRecord
} from '../ui.js';
import { bindCorrections, correctButtonHtml } from '../corrections.js';
import { openBillModal } from './bills.js';
import { openRefundModal } from './refund-modal.js';
import { attachmentFoldHtml, bindAttachmentSection, loadAttachments } from '../attachments.js';

function billVoidPreview(bill) {
  const payments = bill.payments.filter((payment) => payment.status === 'posted');
  const paymentTotal = payments.reduce((sum, payment) => sum + payment.amount_cents, 0);
  const refunded = payments.reduce((sum, payment) => sum + Number(payment.refunded_cents || 0), 0);
  const applications = bill.credit_applications || [];
  const applicationTotal = applications.reduce((sum, application) => sum + application.amount_cents, 0);
  const items = [{
    label: `Bill ${bill.number}`,
    value: fmtMoney(bill.total_cents),
    note: `${bill.vendor_name} · ${bill.status_display || bill.status}`,
  }];
  if (payments.length) {
    items.push({
      label: `${payments.length} linked payment${payments.length === 1 ? '' : 's'}`,
      value: fmtMoney(paymentTotal),
      note: refunded > 0
        ? `${fmtMoney(refunded)} already refunded; those refunds are reversed first`
        : 'Payment and supplier entries will be reversed',
    });
  }
  if (applicationTotal > 0) {
    items.push({
      label: `${applications.length} supplier credit application${applications.length === 1 ? '' : 's'}`,
      value: fmtMoney(applicationTotal),
      note: 'Supplier credits return to their credit notes',
    });
  }
  return {
    heading: 'Void preview',
    items,
    note: 'The original bill, payments and supplier credits stay in the ledger with matching reversing entries.',
  };
}

function paymentModalBody(bill) {
  const accounts = cashAccounts().sort((a, b) => a.code.localeCompare(b.code));
  const preferred = accounts.find((account) => account.code === '1010')
    || accounts.find((account) => account.is_cash)
    || accounts[0];
  return `
    <div class="form-grid">
      <div class="field">
        <label for="payment-amount">Amount paid</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="payment-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(bill.balance_cents)}" required>
        </div>
      </div>
      <div class="field">
        <label for="payment-date">Payment date</label>
        <input class="input" id="payment-date" name="payment_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label for="payment-method">Method</label>
        <select class="input" id="payment-method" name="method">
          ${['Bank transfer', 'Cheque', 'Cash', 'Credit card', 'Other'].map((method) => `<option ${method === (bill.default_payment_method || 'Bank transfer') ? 'selected' : ''}>${method}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="payment-reference">Reference</label>
        <input class="input" id="payment-reference" name="reference" placeholder="e.g. transfer reference" autocomplete="off">
      </div>
      ${bankChargesFieldHtml('paid')}
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
        <label for="payment-account">Pay from</label>
        <select class="input" id="payment-account" name="payment_account_id">
          ${optionsHtml(accounts, { selected: preferred?.id, placeholder: 'Choose account…', labelKey: (account) => `${account.code} · ${account.name}` })}
        </select>
      </div>
    </div>
  `;
}

export async function render(container, { params } = {}) {
  const id = Number(params?.[0]);
  const bill = await api.get(`/bills/${id}`);
  const attachments = await loadAttachments('bill', id);
  let journal = null;
  if (bill.journal_entry_id) {
    try {
      journal = await api.get(`/journal-entries/${bill.journal_entry_id}`);
    } catch { /* ignore */ }
  }

  const settings = store.settings || {};
  const company = settings.company_name || 'My Company';
  const isDraft = bill.status === 'draft';
  const canRecordPayment = bill.status === 'received' && bill.balance_cents > 0;
  // Booking and visa bills are part of the job: adjust them with a supplier
  // credit or by cancelling the job, never by voiding the bill directly.
  const isJobBill = Boolean(bill.booking_id || bill.visa_id);
  const canVoid = bill.status === 'received' && !isJobBill;
  const canCreditJobBill = bill.status === 'received' && isJobBill;

  // One main action; everything else is in the More menu.
  const actions = [];
  const menu = [];
  if (bill.booking_id) {
    menu.push(`<a class="btn btn-ghost" href="#/bookings/${bill.booking_id}">${icon('plane', 15)}<span>Booking</span></a>`);
  }
  if (bill.visa_id) {
    menu.push(`<a class="btn btn-ghost" href="#/visas/${bill.visa_id}">${icon('visa', 15)}<span>Visa</span></a>`);
  }
  menu.push(`<button class="btn btn-ghost" data-action="print">${icon('print', 15)}<span>Print</span></button>`);
  if (isDraft) {
    actions.push(`<button class="btn btn-secondary" data-action="edit">${icon('edit', 15)}<span>Edit</span></button>`);
    menu.push(`<button class="btn btn-danger-ghost" data-action="delete">${icon('trash', 15)}<span>Delete draft</span></button>`);
    actions.push(`<button class="btn btn-primary" data-action="finalize">${icon('check', 15)}<span>Receive &amp; post</span></button>`);
  } else if (canRecordPayment) {
    actions.push(`<button class="btn btn-primary" data-action="payment">${icon('plus', 15)}<span>Record payment</span></button>`);
  }
  // Booking and visa bills are adjusted with a supplier credit or by cancelling the job.
  if (canCreditJobBill) {
    menu.push(`<a class="btn btn-ghost" href="#/supplier-credits?new=1&bill=${bill.id}" data-action="supplier-credit">${icon('invoice', 15)}<span>Supplier credit</span></a>`);
  }
  menu.push(`<a class="btn btn-ghost" href="#/audit-chain/bill/${id}">${icon('shield', 15)}<span>Audit chain</span></a>`);
  menu.push(`<a class="btn btn-ghost" href="#/bills"><span>All bills</span></a>`);
  if (canVoid && !bill.is_opening) {
    menu.push(`<button class="btn btn-ghost" data-action="correct-document">${icon('edit', 15)}<span>Correct</span></button>`);
  }
  if (canVoid) {
    menu.push(`<button class="btn btn-danger-ghost" data-action="void"><span>Void</span></button>`);
  }
  pageRecord(bill);
  setHeader({
    title: bill.number,
    badge: statusBadge(bill.status_display),
    actions: actions.join('') + moreMenuHtml(menu),
  });

  const paymentRows = bill.payments.length
    ? bill.payments.map((payment) => {
      const refunded = Number(payment.refunded_cents || 0);
      const refundable = Number(payment.refundable_cents || 0);
      return `
        <div class="payment-item">
          <div class="payment-icon">${icon('cash', 15)}</div>
          <div class="payment-main">
            <strong>${esc(payment.method || 'Payment')}</strong>
            <span>${esc(fmtDate(payment.payment_date))} · ${esc(payment.number)}${payment.reference ? ` · ${esc(payment.reference)}` : ''}${payment.status === 'void' ? ` · ${statusBadge('void')}` : ''}</span>
            ${payment.cheque_number ? `<span class="cell-sub">Cheque ${esc(payment.cheque_number)}${payment.bank_name ? ` · ${esc(payment.bank_name)}` : ''}${payment.cheque_date ? ` · ${esc(fmtDate(payment.cheque_date))}` : ''}</span>` : ''}
            ${payment.bank_charges_cents ? `<span class="cell-sub">Plus bank charges ${fmtMoney(payment.bank_charges_cents)} · 6700 Bank Charges</span>` : ''}
            ${payment.portal_id ? `<span class="cell-sub">Paid from ${esc(payment.portal_name || 'supplier wallet')}</span>` : ''}
            ${refunded > 0 ? `<span class="cell-sub">${fmtMoney(refunded)} refunded · ${fmtMoney(refundable)} refundable</span>` : ''}
          </div>
          <div class="payment-amount">
            <div>${fmtMoney(payment.amount_cents)}</div>
            ${refunded > 0 ? `<div class="cell-sub">net ${fmtMoney(payment.amount_cents - refunded)}</div>` : ''}
          </div>
          ${refundable > 0 && bill.status === 'received' ? `<button class="icon-btn" data-refund-payment="${payment.id}" title="Record supplier refund">${icon('arrowUp', 16)}</button>` : ''}
          ${refunded > 0 || bill.status !== 'received' || payment.portal_id || payment.status === 'void' ? '' : correctButtonHtml('bill_payment', payment)}
          ${refunded > 0 || bill.status !== 'received' ? '' : `<button class="icon-btn danger" data-delete-payment="${payment.id}" title="Void payment">${icon('trash', 16)}</button>`}
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
      ? 'This draft has not been posted to the ledger yet. Receive it to create the journal entry.'
      : 'No journal entry is linked to this bill.'}</div>`;

  container.innerHTML = `
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
            <div class="doc-kind">Bill</div>
            <div class="doc-number">${esc(bill.number)}</div>
            <div class="doc-status">${statusBadge(bill.status_display)}</div>
            <dl class="doc-meta-grid">
              <dt>Bill date</dt><dd>${esc(fmtDate(bill.bill_date))}</dd>
              <dt>Due date</dt><dd>${esc(fmtDate(bill.due_date))}</dd>
              <dt>Amount due</dt><dd>${fmtMoney(bill.balance_cents)}</dd>
              ${bill.portal_name ? `<dt>Paid from</dt><dd><a href="#/portals/${bill.portal_id}">${esc(bill.portal_name)}</a></dd>` : ''}
            </dl>
          </div>
        </div>

        <div class="doc-parties">
          <div>
            <div class="doc-label">Supplier</div>
            <div class="doc-party-name">${esc(bill.vendor_name)}</div>
            <div class="doc-party-detail">${esc([bill.vendor_number ? `Supplier no. ${bill.vendor_number}` : '', bill.vendor_address, bill.vendor_email, bill.vendor_phone].filter(Boolean).join('\n'))}</div>
          </div>
          <div>
            <div class="doc-label">Notes</div>
            <div class="doc-terms">${esc(bill.notes || `Payment due by ${fmtDate(bill.due_date, { long: true })}.`)}</div>
          </div>
        </div>

        <div class="doc-items-wrap" tabindex="0" role="region" aria-label="Line items">
          <table class="doc-items"><caption class="sr-only">Bill line items</caption>
            <thead>
              <tr>
                <th scope="col" style="width:46%">Description</th>
                <th scope="col" class="num">Qty</th>
                <th scope="col" class="num">Unit cost</th>
                <th scope="col" class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${bill.items.map((item) => `
                <tr>
                  <td>${esc(item.description)}<div class="cell-sub">${esc(item.account_name)}</div></td>
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
            ${bill.notes ? `<strong>Notes</strong>${esc(bill.notes)}` : ''}
          </div>
          <div class="doc-totals">
            <div class="totals-row"><span>Subtotal</span><span>${fmtMoney(bill.subtotal_cents)}</span></div>
            <div class="totals-row total"><span>Total</span><span>${fmtMoney(bill.total_cents)}</span></div>
            ${bill.amount_paid_cents > 0 ? `<div class="totals-row"><span>Paid</span><span>−${fmtMoney(bill.amount_paid_cents)}</span></div>` : ''}
            ${bill.credit_applied_cents > 0 ? `<div class="totals-row"><span>Supplier credits applied</span><span>−${fmtMoney(bill.credit_applied_cents)}</span></div>` : ''}
            <div class="totals-row balance"><span>Balance due</span><span>${fmtMoney(bill.balance_cents)}</span></div>
          </div>
        </div>
      </div>
    </div>

    ${foldsHtml([
    foldHtml({ key: 'payments', title: 'Payments', count: bill.payments.length, body: paymentRows }),
    foldHtml({
      key: 'ledger',
      title: 'Ledger entry',
      actions: journal ? `<a class="card-link" href="#/journal?focus=${journal.id}">Open ${icon('chevron', 12)}</a>` : '',
      body: journalHtml,
    }),
    bill.supplier_credits.length && foldHtml({
      key: 'supplier-credits',
      title: 'Supplier credits',
      count: bill.supplier_credits.length,
      actions: `<a class="card-link" href="#/supplier-credits">All supplier credits ${icon('chevron', 12)}</a>`,
      body: `<div class="table-wrap">
          <table class="data"><caption class="sr-only">Supplier credits linked to this bill</caption>
            <thead><tr><th scope="col">Credit</th><th scope="col">Date</th><th scope="col" class="num">Amount</th><th scope="col" class="num">Remaining</th><th scope="col">Status</th></tr></thead>
            <tbody>
              ${bill.supplier_credits.map((credit) => `
                <tr class="clickable" data-credit-id="${credit.id}">
                  <td><a href="#/supplier-credits/${credit.id}">${esc(credit.number)}</a></td>
                  <td>${esc(fmtDate(credit.credit_date))}</td>
                  <td class="num">${fmtMoney(credit.amount_cents)}</td>
                  <td class="num">${fmtMoney(credit.remaining_cents)}</td>
                  <td>${statusBadge(credit.remaining_cents > 0 ? 'open' : 'used')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>`,
    }),
    attachmentFoldHtml({ entityType: 'bill', entityId: id, attachments }),
  ])}
  `;

  bindAttachmentSection(container, { entityType: 'bill', entityId: id });
  bindCorrections(container, () => render(container, { params: [String(id)] }));
  // Admin only: correct the posted bill; the page then shows the new one.
  document.querySelector('[data-action="correct-document"]')?.addEventListener('click', () => {
    openBillModal({ bill, correct: true, onSaved: (saved) => { location.hash = `#/bills/${saved.id}`; } });
  });

  function refresh() {
    return render(container, { params: [String(id)] });
  }

  document.querySelectorAll('[data-action="print"]').forEach((button) => {
    button.addEventListener('click', () => window.print());
  });

  const editButton = document.querySelector('[data-action="edit"]');
  if (editButton) {
    editButton.addEventListener('click', () => {
      openBillModal({ bill, onSaved: () => refresh() });
    });
  }

  const finalizeButton = document.querySelector('[data-action="finalize"]');
  if (finalizeButton) {
    finalizeButton.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: 'Receive and post this bill?',
        message: 'This will lock the bill and post the expense and a payable to your ledger.',
        confirmLabel: 'Receive & post',
        danger: false,
      });
      if (!confirmed) return;
      try {
        await api.post(`/bills/${id}/finalize`, {});
        toast(`${bill.number} posted to the ledger`);
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
        message: `Draft ${bill.number} will be permanently deleted. Delete is only for drafts: nothing has been posted to the ledger yet.`,
        confirmLabel: 'Delete draft',
      });
      if (!confirmed) return;
      try {
        await api.del(`/bills/${id}`);
        toast('Draft bill deleted');
        location.hash = '#/bills';
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  const voidButton = document.querySelector('[data-action="void"]');
  if (voidButton) {
    voidButton.addEventListener('click', async () => {
      const result = await voidDialog({
        title: `Void ${bill.number}?`,
        message: 'A reversing journal entry will be posted to cancel this bill. Any linked payments, refunds and supplier credit applications will also be reversed.',
        warning: 'This cannot be undone. The bill and every linked reversal are kept permanently in the audit trail.',
        preview: billVoidPreview(bill),
        confirmLabel: 'Void bill',
      });
      if (!result.confirmed) return;
      try {
        await api.post(`/bills/${id}/void`, { remarks: result.remarks });
        toast(`${bill.number} voided with a reversing entry`);
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  document.querySelectorAll('[data-action="payment"]').forEach((button) => {
    button.addEventListener('click', () => {
      openModal({
        title: 'Record bill payment',
        body: paymentModalBody(bill),
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
          bindBankCharges(overlay, method);
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
          await api.post(`/bills/${id}/payments`, {
            amount_cents: amount,
            payment_date: values.get('payment_date'),
            method,
            reference: values.get('reference'),
            cheque_number: chequeNumber,
            cheque_date: values.get('cheque_date'),
            bank_name: values.get('bank_name'),
            payment_account_id: Number(values.get('payment_account_id')),
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
      const payment = bill.payments.find((candidate) => candidate.id === Number(button.dataset.refundPayment));
      if (!payment) return;
      openRefundModal({
        type: 'supplier',
        source: {
          bill_payment_id: payment.id,
          document_id: bill.id,
          document_number: bill.number,
          payment_number: payment.number,
          payment_date: payment.payment_date,
          party_name: bill.vendor_name,
          amount_cents: payment.amount_cents,
          refunded_cents: payment.refunded_cents || 0,
          refundable_cents: payment.refundable_cents,
          account_id: payment.payment_account_id,
          method: payment.method,
        },
        onSaved: () => refresh(),
      });
    });
  });

  document.querySelectorAll('[data-delete-payment]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const payment = bill.payments.find((candidate) => candidate.id === Number(button.dataset.deletePayment));
      const result = await voidDialog({
        title: 'Void this payment?',
        message: 'The payment will be voided and a reversing journal entry will be posted. The payment record and its audit trail are kept, and the bill balance will reopen.',
        warning: 'Any supplier refund linked to this payment must be reversed first. This cannot be undone.',
        preview: payment ? {
          heading: 'Void preview',
          items: [
            {
              label: `Payment ${payment.number}`,
              value: fmtMoney(payment.amount_cents),
              note: `${fmtDate(payment.payment_date)} · ${payment.method || 'Payment'}`,
            },
            {
              label: `Bill ${bill.number}`,
              value: fmtMoney(bill.balance_cents + payment.amount_cents),
              note: 'Balance reopens after the reversal',
            },
          ],
          note: payment.portal_id ? 'This payment was settled from a supplier wallet; the wallet balance will be restored.' : '',
        } : null,
        confirmLabel: 'Void payment',
      });
      if (!result.confirmed) return;
      try {
        await api.del(`/bills/payments/${button.dataset.deletePayment}`, { remarks: result.remarks });
        toast('Payment voided');
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  return () => {};
}
