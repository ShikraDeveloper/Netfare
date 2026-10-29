import { api } from '../api.js';
import { activeVendors } from '../store.js';
import {
  centsToInput,
  currencySymbol,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  openModal,
  optionsHtml,
  todayISO,
  toast,
  toCents,
  voidDialog,
} from '../ui.js';
import { depositAccounts } from './job-modals.js';

// Visa security deposits on the visa page: what was received, what the
// supplier holds, what was refunded, used or forfeited, and what is still held.

const STATUS_TEXT = {
  held: 'Held',
  with_supplier: 'With supplier',
  settled: 'Settled',
  forfeited: 'Forfeited',
  void: 'Void',
};

const METHODS = ['Cash', 'Bank transfer', 'Cheque', 'Credit card', 'Other'];

function methodSelect(id, selected = 'Cash') {
  return `<select class="input" id="${id}" name="method">${METHODS.map((m) => `<option ${m === selected ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
}

function accountSelect(id, preferCash = true) {
  const { accounts, preferred } = depositAccounts();
  const chosen = preferCash ? (accounts.find((a) => a.code === '1000') || preferred) : preferred;
  return `<select class="input" id="${id}" name="account_id">${optionsHtml(accounts, { selected: chosen?.id, placeholder: 'Choose account…', labelKey: (a) => `${a.code} · ${a.name}` })}</select>`;
}

function amountField(id, label, cents, hint = '') {
  return `
    <div class="field">
      <label for="${id}">${esc(label)}</label>
      <div class="money-input"><span>${esc(currencySymbol())}</span>
        <input class="input" id="${id}" name="amount" type="number" min="0.01" step="0.01" value="${cents ? centsToInput(cents) : ''}" required>
      </div>
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    </div>`;
}

function dateField(id, label) {
  return `<div class="field"><label for="${id}">${esc(label)}</label><input class="input" id="${id}" name="event_date" type="date" value="${todayISO()}" required></div>`;
}

function eventLine(event) {
  const detail = [
    event.vendor_name,
    event.method,
    event.account_name,
    event.invoice_number ? `Invoice ${event.invoice_number}` : '',
    event.refund_number,
    event.deduction_cents ? `${fmtMoney(event.deduction_cents)} deducted` : '',
    event.event_type === 'forfeit' ? (event.forfeit_to === 'supplier' ? 'kept by supplier' : 'kept by us') : '',
    event.notes,
  ].filter(Boolean).join(' · ');
  return `
    <div class="deposit-event ${event.voided_at ? 'is-void' : ''}">
      <span class="deposit-event-date">${esc(fmtDate(event.event_date))}</span>
      <span class="deposit-event-label">${esc(event.label)}${event.voided_at ? ' · void' : ''}<small>${esc(detail)}</small></span>
      <span class="deposit-event-amount">${fmtMoney(event.amount_cents)}</span>
    </div>`;
}

function depositHtml(deposit) {
  const open = !deposit.voided_at;
  const buttons = open ? [
    deposit.in_hand_cents > 0 ? `<button class="btn btn-secondary btn-sm" data-deposit-action="to-supplier" data-id="${deposit.id}">Pay to supplier</button>` : '',
    deposit.with_supplier_cents > 0 ? `<button class="btn btn-secondary btn-sm" data-deposit-action="supplier-return" data-id="${deposit.id}">Supplier returned</button>` : '',
    deposit.in_hand_cents > 0 ? `<button class="btn btn-primary btn-sm" data-deposit-action="refund" data-id="${deposit.id}">Refund</button>` : '',
    deposit.in_hand_cents > 0 ? `<button class="btn btn-secondary btn-sm" data-deposit-action="apply" data-id="${deposit.id}">Use for invoice</button>` : '',
    deposit.held_cents > 0 ? `<button class="btn btn-danger-ghost btn-sm" data-deposit-action="forfeit" data-id="${deposit.id}">Forfeit</button>` : '',
    `<button class="icon-btn danger" data-deposit-action="void-last" data-id="${deposit.id}" title="Void the latest step" aria-label="Void the latest step on ${esc(deposit.number)}">${icon('trash', 15)}</button>`,
  ].join('') : '';
  return `
    <div class="deposit-item" data-deposit="${deposit.id}">
      <div class="deposit-head">
        <div><strong>${esc(deposit.number)}</strong> <span class="badge badge-deposit-${esc(deposit.status)}">${esc(STATUS_TEXT[deposit.status] || deposit.status)}</span>
          <div class="cell-sub">Received ${esc(fmtDate(deposit.deposit_date))}</div></div>
        <div class="deposit-held"><span>Still held</span><strong>${fmtMoney(deposit.held_cents)}</strong></div>
      </div>
      <dl class="deposit-figures">
        <div><dt>Received</dt><dd>${fmtMoney(deposit.collected_cents)}</dd></div>
        <div><dt>With supplier</dt><dd>${fmtMoney(deposit.with_supplier_cents)}</dd></div>
        <div><dt>Refunded</dt><dd>${fmtMoney(deposit.refunded_cents)}</dd></div>
        <div><dt>Used for invoices</dt><dd>${fmtMoney(deposit.applied_cents)}</dd></div>
        <div><dt>Forfeited / deducted</dt><dd>${fmtMoney(deposit.forfeited_cents)}</dd></div>
      </dl>
      <div class="deposit-events">${deposit.events.map(eventLine).join('')}</div>
      ${buttons ? `<div class="deposit-actions no-print">${buttons}</div>` : ''}
    </div>`;
}

export function depositCardHtml(visa) {
  const deposits = visa.deposits || [];
  const canCollect = !['cancelled', 'rejected'].includes(visa.status);
  const held = deposits.reduce((sum, deposit) => sum + (deposit.voided_at ? 0 : deposit.held_cents), 0);
  return `
    <div class="card no-print" data-visa-deposits>
      <div class="card-head">
        <div class="card-title"><h2>Security deposit</h2><p>${deposits.length ? `${fmtMoney(held)} still held · not a sale` : 'No deposit taken'}</p></div>
        ${canCollect ? `<button class="btn btn-primary btn-sm" data-deposit-action="collect">${icon('plus', 14)} Take deposit</button>` : ''}
      </div>
      <div class="card-body" ${deposits.length ? 'style="padding:6px 20px"' : ''}>
        ${deposits.length ? deposits.map(depositHtml).join('') : '<p class="muted" style="margin:0">A refundable deposit is held in 2600 until it is refunded, used for an invoice or forfeited.</p>'}
      </div>
    </div>`;
}

function run(promise, message, refresh) {
  return promise.then(() => { toast(message); refresh(); });
}

export function bindDepositCard(container, visa, refresh) {
  const byId = new Map((visa.deposits || []).map((deposit) => [String(deposit.id), deposit]));
  container.querySelectorAll('[data-deposit-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.depositAction;
      const deposit = byId.get(button.dataset.id);
      if (action === 'collect') {
        openModal({
          title: 'Take a security deposit',
          subtitle: `${visa.number}${visa.applicant_name ? ` · ${visa.applicant_name}` : ''}`,
          body: `<div class="form-grid">
            ${amountField('dep-amount', 'Deposit amount', 0)}
            <div class="field"><label for="dep-date">Date received</label><input class="input" id="dep-date" type="date" value="${todayISO()}" required></div>
            <div class="field"><label for="dep-method">Method</label>${methodSelect('dep-method')}</div>
            <div class="field"><label for="dep-account">Received into</label>${accountSelect('dep-account')}</div>
            <div class="field full"><label for="dep-ref">Reference</label><input class="input" id="dep-ref" autocomplete="off" placeholder="Optional"></div>
            <div class="field full"><div class="form-note">Not a sale: held in <strong>2600 Refundable Security Deposits Held</strong>.</div></div>
          </div>`,
          submitLabel: 'Record deposit',
          onSubmit: (form) => run(api.post('/visa-deposits', {
            visa_id: visa.id,
            amount_cents: toCents(form.querySelector('#dep-amount').value),
            deposit_date: form.querySelector('#dep-date').value,
            method: form.querySelector('#dep-method').value,
            account_id: Number(form.querySelector('#dep-account').value),
            reference: form.querySelector('#dep-ref').value,
          }), 'Deposit recorded', refresh),
        });
        return;
      }
      if (action === 'to-supplier') {
        openModal({
          title: `Pay ${deposit.number} to the supplier`,
          body: `<div class="form-grid">
            ${amountField('dep-amount', 'Amount', deposit.in_hand_cents, `In hand ${fmtMoney(deposit.in_hand_cents)}`)}
            ${dateField('dep-date', 'Date paid')}
            <div class="field full"><label for="dep-vendor">Supplier</label><select class="input" id="dep-vendor" required>${optionsHtml(activeVendors(), { placeholder: 'Choose supplier…' })}</select></div>
            <div class="field"><label for="dep-method">Method</label>${methodSelect('dep-method', 'Bank transfer')}</div>
            <div class="field"><label for="dep-account">Paid from</label>${accountSelect('dep-account', false)}</div>
            <div class="field full"><div class="form-note">Moves the money to <strong>1460 Refundable Deposits Paid</strong>. The customer is still owed the full deposit.</div></div>
          </div>`,
          submitLabel: 'Record payment',
          onSubmit: (form) => run(api.post(`/visa-deposits/${deposit.id}/to-supplier`, {
            amount_cents: toCents(form.querySelector('#dep-amount').value),
            event_date: form.querySelector('#dep-date').value,
            vendor_id: Number(form.querySelector('#dep-vendor').value),
            method: form.querySelector('#dep-method').value,
            account_id: Number(form.querySelector('#dep-account').value),
          }), 'Deposit paid to supplier', refresh),
        });
        return;
      }
      if (action === 'supplier-return') {
        openModal({
          title: `Supplier returned ${deposit.number}`,
          body: `<div class="form-grid">
            ${amountField('dep-amount', 'Amount settled by the supplier', deposit.with_supplier_cents, `Supplier holds ${fmtMoney(deposit.with_supplier_cents)}`)}
            <div class="field"><label for="dep-deduction">Deducted by the supplier</label>
              <div class="money-input"><span>${esc(currencySymbol())}</span><input class="input" id="dep-deduction" type="number" min="0" step="0.01" value="0"></div>
              <div class="hint">Fines or charges taken out; the customer bears them.</div></div>
            ${dateField('dep-date', 'Date returned')}
            <div class="field"><label for="dep-account">Received into</label>${accountSelect('dep-account', false)}</div>
            <div class="field full"><label for="dep-notes">Reason for any deduction</label><input class="input" id="dep-notes" autocomplete="off" placeholder="e.g. overstay fine 2 days"></div>
          </div>`,
          submitLabel: 'Record return',
          onSubmit: (form) => run(api.post(`/visa-deposits/${deposit.id}/supplier-return`, {
            amount_cents: toCents(form.querySelector('#dep-amount').value),
            deduction_cents: toCents(form.querySelector('#dep-deduction').value),
            event_date: form.querySelector('#dep-date').value,
            account_id: Number(form.querySelector('#dep-account').value),
            notes: form.querySelector('#dep-notes').value,
          }), 'Supplier return recorded', refresh),
        });
        return;
      }
      if (action === 'refund') {
        openModal({
          title: `Refund ${deposit.number}`,
          body: `<div class="form-grid">
            ${amountField('dep-amount', 'Refund amount', deposit.in_hand_cents, `Can be refunded now ${fmtMoney(deposit.in_hand_cents)}`)}
            ${dateField('dep-date', 'Refund date')}
            <div class="field"><label for="dep-method">Method</label>${methodSelect('dep-method')}</div>
            <div class="field"><label for="dep-account">Paid from</label>${accountSelect('dep-account')}</div>
          </div>`,
          submitLabel: 'Refund deposit',
          onSubmit: (form) => run(api.post(`/visa-deposits/${deposit.id}/refund`, {
            amount_cents: toCents(form.querySelector('#dep-amount').value),
            event_date: form.querySelector('#dep-date').value,
            method: form.querySelector('#dep-method').value,
            account_id: Number(form.querySelector('#dep-account').value),
          }), 'Deposit refunded', refresh),
        });
        return;
      }
      if (action === 'apply') {
        const invoices = (await api.get('/invoices', { status: 'outstanding' }))
          .filter((invoice) => invoice.customer_id === visa.customer_id && invoice.balance_cents > 0);
        if (!invoices.length) {
          toast('This customer has no unpaid invoice to use the deposit for.', 'error');
          return;
        }
        openModal({
          title: `Use ${deposit.number} for an invoice`,
          body: `<div class="form-grid">
            <div class="field full"><label for="dep-invoice">Invoice</label><select class="input" id="dep-invoice">${invoices.map((invoice) => `<option value="${invoice.id}" data-balance="${invoice.balance_cents}">${esc(invoice.number)} · ${esc(fmtMoney(invoice.balance_cents))} due</option>`).join('')}</select></div>
            ${amountField('dep-amount', 'Amount', Math.min(deposit.in_hand_cents, invoices[0].balance_cents), `Available ${fmtMoney(deposit.in_hand_cents)}`)}
            ${dateField('dep-date', 'Date')}
          </div>`,
          submitLabel: 'Use deposit',
          onMount(overlay) {
            overlay.querySelector('#dep-invoice').addEventListener('change', (event) => {
              const balance = Number(event.target.selectedOptions[0].dataset.balance);
              overlay.querySelector('#dep-amount').value = centsToInput(Math.min(balance, deposit.in_hand_cents));
            });
          },
          onSubmit: (form) => run(api.post(`/visa-deposits/${deposit.id}/apply`, {
            invoice_id: Number(form.querySelector('#dep-invoice').value),
            amount_cents: toCents(form.querySelector('#dep-amount').value),
            event_date: form.querySelector('#dep-date').value,
          }), 'Deposit used for the invoice', refresh),
        });
        return;
      }
      if (action === 'forfeit') {
        openModal({
          title: `Forfeit ${deposit.number}`,
          body: `<div class="form-grid">
            <div class="field full"><label for="dep-to">Who keeps it</label>
              <select class="input" id="dep-to">
                ${deposit.in_hand_cents > 0 ? `<option value="agency">We keep it (income 4340) · up to ${esc(fmtMoney(deposit.in_hand_cents))}</option>` : ''}
                ${deposit.with_supplier_cents > 0 ? `<option value="supplier">The supplier kept it · up to ${esc(fmtMoney(deposit.with_supplier_cents))}</option>` : ''}
              </select></div>
            ${amountField('dep-amount', 'Amount', deposit.in_hand_cents > 0 ? deposit.in_hand_cents : deposit.with_supplier_cents)}
            ${dateField('dep-date', 'Forfeit date')}
            <div class="field full"><label for="dep-notes">Reason</label><input class="input" id="dep-notes" required autocomplete="off" placeholder="e.g. visitor absconded, overstay"></div>
          </div>`,
          submitLabel: 'Forfeit',
          danger: true,
          onMount(overlay) {
            overlay.querySelector('#dep-to').addEventListener('change', (event) => {
              overlay.querySelector('#dep-amount').value = centsToInput(event.target.value === 'supplier' ? deposit.with_supplier_cents : deposit.in_hand_cents);
            });
          },
          onSubmit: (form) => run(api.post(`/visa-deposits/${deposit.id}/forfeit`, {
            forfeit_to: form.querySelector('#dep-to').value,
            amount_cents: toCents(form.querySelector('#dep-amount').value),
            event_date: form.querySelector('#dep-date').value,
            notes: form.querySelector('#dep-notes').value,
          }), 'Deposit forfeited', refresh),
        });
        return;
      }
      if (action === 'void-last') {
        const last = deposit.events.filter((event) => !event.voided_at).at(-1);
        const result = await voidDialog({
          title: `Void "${last?.label}" on ${deposit.number}?`,
          message: last?.event_type === 'collect'
            ? 'This is the first step, so the whole deposit becomes void and its ledger entry is reversed.'
            : 'The latest step is reversed in the ledger. Earlier steps stay as they are.',
          confirmLabel: 'Void step',
        });
        if (!result.confirmed) return;
        try {
          await run(api.post(`/visa-deposits/${deposit.id}/void-last`, { remarks: result.remarks }), 'Step voided', refresh);
        } catch (error) {
          toast(error.message, 'error');
        }
      }
    });
  });
}
