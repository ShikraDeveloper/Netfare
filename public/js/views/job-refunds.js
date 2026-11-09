import { api } from '../api.js';
import { cashAccounts } from '../store.js';
import {
  centsToInput,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  openModal,
  toast,
  toCents,
  todayISO,
} from '../ui.js';

// The Refunds card on a booking or visa page: money back to the customer
// (a credit note on the invoice) and from the supplier (a credit on the bill,
// which stays with the supplier until it is received).

const BASE = { booking: 'bookings', visa: 'visas' };

// Where a supplier refund sits: off the bill, in the portal wallet, still
// with the supplier, or already received.
function supplierRefundWhere(row) {
  return [
    row.applied_cents > 0 ? `${fmtMoney(row.applied_cents)} off the bill` : '',
    row.portal_settled_cents > 0 ? `${fmtMoney(row.portal_settled_cents)} in the portal wallet` : '',
    row.held_cents > 0 ? `${fmtMoney(row.held_cents)} with the supplier` : '',
    row.refunded_cents > 0 ? `${fmtMoney(row.refunded_cents)} received` : '',
  ].filter(Boolean).join(' · ');
}

function refundState(job) {
  const canRefundCustomer = Boolean(job.invoice && job.invoice.status === 'sent');
  const bills = (job.bills || []).filter((bill) => bill.status === 'received');
  const customerRefunds = job.customer_refunds || [];
  const supplierRefunds = job.supplier_refunds || [];
  return { canRefundCustomer, bills, customerRefunds, supplierRefunds };
}

export function refundsCardHtml(job) {
  const { canRefundCustomer, bills, customerRefunds, supplierRefunds } = refundState(job);
  if (!canRefundCustomer && !bills.length && !customerRefunds.length && !supplierRefunds.length) return '';
  const items = [
    ...customerRefunds.map((row) => `
      <div class="payment-item">
        <div class="payment-icon">${icon('arrowUp', 15)}</div>
        <div class="payment-main">
          <strong>${esc(row.number)} · To the customer</strong>
          <span>${esc(fmtDate(row.date))}${row.remaining_cents > 0 ? ` · ${fmtMoney(row.remaining_cents)} held as credit` : ''}</span>
        </div>
        <div class="payment-amount">${fmtMoney(row.amount_cents)}</div>
        <a class="icon-btn" href="#/credits/${row.id}" title="Open credit note">${icon('chevron', 16)}</a>
      </div>`),
    ...supplierRefunds.map((row) => `
      <div class="payment-item">
        <div class="payment-icon">${icon('wallet', 15)}</div>
        <div class="payment-main">
          <strong>${esc(row.number)} · From ${esc(row.vendor_name || 'the supplier')}</strong>
          <span>${esc([fmtDate(row.date), supplierRefundWhere(row)].filter(Boolean).join(' · '))}</span>
        </div>
        <div class="payment-amount">${fmtMoney(row.amount_cents)}</div>
        <a class="icon-btn" href="#/supplier-credits/${row.id}" title="Open supplier credit">${icon('chevron', 16)}</a>
      </div>`),
  ];
  return `
    <div class="card" data-refunds-card>
      <div class="card-head">
        <div class="card-title"><h2>Refunds</h2></div>
        <div style="display:flex;gap:6px">
          ${bills.length ? `<button class="btn btn-secondary btn-sm" data-action="supplier-refund">${icon('wallet', 14)} Supplier refund</button>` : ''}
          ${canRefundCustomer ? `<button class="btn btn-secondary btn-sm" data-action="refund-customer">${icon('arrowUp', 14)} Refund customer</button>` : ''}
        </div>
      </div>
      <div class="card-body" ${items.length ? 'style="padding:4px 20px"' : ''}>
        ${items.length ? items.join('') : emptyState({ iconName: 'wallet', title: 'No refunds' })}
      </div>
    </div>`;
}

function accountOptions(emptyLabel) {
  const accounts = cashAccounts().sort((a, b) => a.code.localeCompare(b.code));
  return `<option value="">${esc(emptyLabel)}</option>${accounts.map((account) => `<option value="${account.id}">${esc(account.code)} · ${esc(account.name)}</option>`).join('')}`;
}

function openCustomerRefund(job, sourceType, onDone) {
  const { customerRefunds } = refundState(job);
  const refunded = customerRefunds.reduce((sum, row) => sum + row.amount_cents, 0);
  const limit = Math.max(0, job.invoice.total_cents - refunded);
  const owing = Number(job.invoice.balance_cents || 0);
  openModal({
    title: 'Refund customer',
    submitLabel: 'Record refund',
    body: `
      <div class="form-grid">
        <div class="field">
          <label for="rc-amount">Amount · up to ${fmtMoney(limit)}</label>
          <div class="money-input"><span>AED</span>
            <input class="input" id="rc-amount" name="amount" type="number" min="0.01" max="${centsToInput(limit)}" step="0.01" required inputmode="decimal" data-rc-amount>
          </div>
        </div>
        <div class="field">
          <label for="rc-date">Date</label>
          <input class="input" id="rc-date" name="date" type="date" value="${todayISO()}" required>
        </div>
        <div class="field full">
          <label for="rc-account">Paid from</label>
          <select class="input" id="rc-account" name="account_id">${accountOptions('Keep as customer credit')}</select>
        </div>
        <div class="field full muted" data-rc-split></div>
      </div>
    `,
    onMount(overlay) {
      const input = overlay.querySelector('[data-rc-amount]');
      const split = overlay.querySelector('[data-rc-split]');
      input.addEventListener('input', () => {
        const amount = Math.min(toCents(input.value || 0), limit);
        const lowers = Math.min(amount, owing);
        split.textContent = amount
          ? [lowers ? `Lowers what they owe by ${fmtMoney(lowers)}` : '', amount > lowers ? `${fmtMoney(amount - lowers)} goes back to them` : ''].filter(Boolean).join(' · ')
          : '';
      });
    },
    async onSubmit(form) {
      const values = new FormData(form);
      await api.post(`/${BASE[sourceType]}/${job.id}/refund-customer`, {
        amount_cents: toCents(values.get('amount')),
        date: values.get('date'),
        account_id: values.get('account_id') ? Number(values.get('account_id')) : null,
      });
      toast('Refund recorded');
      onDone();
    },
  });
}

function openSupplierRefund(job, sourceType, onDone) {
  const { bills } = refundState(job);
  openModal({
    title: 'Supplier refund',
    submitLabel: 'Record refund',
    body: `
      <div class="form-grid">
        <div class="field full">
          <label for="sr-bill">Bill</label>
          <select class="input" id="sr-bill" name="bill_id" required>
            ${bills.map((bill) => `<option value="${bill.id}">${esc(bill.number)} · ${esc(bill.vendor_name || '')} · up to ${fmtMoney(bill.supplier_credit_available_cents)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="sr-amount">Amount</label>
          <div class="money-input"><span>AED</span>
            <input class="input" id="sr-amount" name="amount" type="number" min="0.01" step="0.01" required inputmode="decimal">
          </div>
        </div>
        <div class="field">
          <label for="sr-date">Date</label>
          <input class="input" id="sr-date" name="date" type="date" value="${todayISO()}" required>
        </div>
      </div>
    `,
    async onSubmit(form) {
      const values = new FormData(form);
      await api.post(`/${BASE[sourceType]}/${job.id}/supplier-refund`, {
        bill_id: Number(values.get('bill_id')),
        amount_cents: toCents(values.get('amount')),
        date: values.get('date'),
      });
      toast('Supplier refund recorded · it stays with the supplier until you receive it');
      onDone();
    },
  });
}

export function bindRefunds(container, job, sourceType, onDone) {
  container.querySelector('[data-action="refund-customer"]')?.addEventListener('click', () => openCustomerRefund(job, sourceType, onDone));
  container.querySelector('[data-action="supplier-refund"]')?.addEventListener('click', () => openSupplierRefund(job, sourceType, onDone));
}
