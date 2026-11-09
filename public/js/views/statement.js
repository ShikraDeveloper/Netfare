import { api } from '../api.js';
import { cashAccounts } from '../store.js';
import {
  bindDateRange,
  centsToInput,
  dateRangeHtml,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  openModal,
  printPage,
  setHeader,
  toast,
  toCents,
  todayISO,
} from '../ui.js';

const CUSTOMER_TITLES = {
  invoice: 'Invoice raised',
  payment: 'Payment received',
  credit: 'Credit applied',
  refund: 'Refund issued',
  cancellation: 'Booking or visa cancelled',
  cancellation_charge: 'Cancellation charges',
  cancellation_credit: 'Refund kept as credit',
};

const VENDOR_TITLES = {
  bill: 'Supplier bill',
  payment: 'Payment made',
  supplier_credit: 'Supplier credit',
  credit_refund: 'Refund received',
  refund: 'Supplier refund received',
};

const KIND_TONES = {
  invoice: 'blue',
  payment: 'green',
  credit: 'amber',
  refund: 'red',
  bill: 'blue',
  supplier_credit: 'amber',
  cancellation: 'red',
  cancellation_charge: 'blue',
  cancellation_credit: 'amber',
};

// Advances and visa security deposits run as their own balances: money we
// hold for the customer, separate from what they owe on invoices. Each shows
// as one line; its history opens on click.
function heldSectionHtml(held, { title, attr, note }) {
  if (!held || (!held.transactions.length && !held.opening_held_cents)) return '';
  return `
    <details class="statement-held${held.closing_held_cents ? '' : ' is-empty'}" ${attr}>
      <summary>
        <span class="statement-held-title">${esc(title)}</span>
        <strong>${fmtMoney(held.closing_held_cents)}</strong>
        <span class="statement-held-more no-print">History</span>
      </summary>
      <div class="table-wrap">
      <table class="data statement-table"><caption class="sr-only">${esc(title)}</caption>
        <thead><tr>
          <th scope="col">Date</th><th scope="col">Reference</th><th scope="col">Description</th>
          <th scope="col" class="num">Returned / used</th><th scope="col" class="num">Received</th><th scope="col" class="num">Held</th>
        </tr></thead>
        <tbody>
          ${held.opening_held_cents ? `<tr><td></td><td></td><td>Held at start</td><td></td><td></td><td class="num">${fmtMoney(held.opening_held_cents)}</td></tr>` : ''}
          ${held.transactions.map((row) => `
            <tr>
              <td class="nowrap">${esc(fmtDate(row.date))}</td>
              <td class="nowrap"><span class="statement-ref">${esc(row.reference)}</span></td>
              <td>${esc(row.description)}</td>
              <td class="num">${row.debit_cents ? fmtMoney(row.debit_cents) : '<span class="statement-zero">—</span>'}</td>
              <td class="num">${row.credit_cents ? fmtMoney(row.credit_cents) : '<span class="statement-zero">—</span>'}</td>
              <td class="num">${fmtMoney(row.balance_cents)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>
      <p class="muted">${esc(note)}</p>
    </details>`;
}

function transactionTitle(row, kind) {
  return (kind === 'customer' ? CUSTOMER_TITLES : VENDOR_TITLES)[row.kind] || row.description;
}

function transactionDetail(row, kind) {
  const parts = [];
  if (row.kind === 'invoice' || row.kind === 'bill') {
    if (row.related) parts.push(`Cancelled · ${row.related}`);
    else if (row.due_date) parts.push(`Due ${fmtDate(row.due_date)}`);
  } else if (row.kind === 'cancellation') {
    parts.push(`Invoice ${row.related} reversed`);
  } else if (row.kind === 'cancellation_credit') {
    parts.push(`From ${row.related}`);
  } else {
    if (row.method) parts.push(row.method);
    if (row.related) parts.push(`Against ${row.related}`);
  }
  return parts.join(' · ');
}

function itemLabel(item) {
  const quantity = Number(item.quantity) || 1;
  return quantity === 1 ? item.description : `${quantity} × ${item.description}`;
}

// One short line under the title: the first item, then due date or method.
function transactionSubHtml(row, kind) {
  const items = Array.isArray(row.items) ? row.items : [];
  const parts = [];
  if (items.length) {
    const more = items.length > 1 ? ` +${items.length - 1} more` : '';
    parts.push(`<span class="statement-item-line">${esc(itemLabel(items[0]))}</span>${more}`);
  }
  const detail = transactionDetail(row, kind);
  if (detail) parts.push(esc(detail).replace(/-/g, '&#8209;'));
  return parts.length ? `<div class="statement-row-sub">${parts.join(' · ')}</div>` : '';
}

// Everything else about the row (all items, visa, traveller) stays folded
// until the row's Details button or the Show details switch opens it.
function transactionExtraHtml(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  const itemList = items.length > 1
    ? `<ul class="statement-extra-items">${items.map((item) => `<li>${esc(itemLabel(item))}</li>`).join('')}</ul>`
    : '';
  const html = `${itemList}${visaDetailsHtml(row)}${beneficiaryDetailsHtml(row)}`;
  return html.trim() ? `<div class="statement-extra">${html}</div>` : '';
}

function titleCase(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

// An invoice the customer paid for another person (traveller, guest, family).
function beneficiaryDetailsHtml(row) {
  const person = row.beneficiary;
  if (!person || !person.name || row.visa) return '';
  const meta = [
    person.nationality,
    person.passport_masked ? `Passport ${person.passport_masked}` : '',
  ].filter(Boolean);
  return `
    <div class="statement-visa" data-statement-beneficiary>
      <div class="statement-visa-head">
        <span class="statement-visa-label">Service for</span>
        <span class="statement-visa-name">${esc(person.name)}</span>
      </div>
      ${meta.length ? `<div class="statement-visa-meta">${esc(meta.join(' · '))}</div>` : ''}
    </div>
  `;
}

function visaDetailsHtml(row) {
  const visa = row.visa;
  if (!visa || !visa.applicant_name) return '';
  const applicantMeta = [];
  if (visa.nationality) applicantMeta.push(visa.nationality);
  if (visa.passport_masked) applicantMeta.push(`Passport ${visa.passport_masked}`);
  if (visa.passport_expiry) applicantMeta.push(`Exp ${fmtDate(visa.passport_expiry)}`);
  const visaMeta = [];
  if (visa.number) visaMeta.push(visa.number);
  if (visa.visa_type) visaMeta.push(titleCase(visa.visa_type));
  if (visa.destination_country) visaMeta.push(visa.destination_country);
  if (Number(visa.duration_days) > 0) visaMeta.push(`${visa.duration_days} days`);
  if (visa.reference) visaMeta.push(`Ref ${visa.reference}`);
  const applicantType = Number(visa.applicant_is_customer) ? 'customer' : 'visitor';
  const applicantLabel = applicantType === 'customer' ? 'Customer' : 'Visitor';
  return `
    <div class="statement-visa">
      <div class="statement-visa-head">
        <span class="statement-visa-label">Visa applicant</span>
        <span class="statement-visa-name">${esc(visa.applicant_name)}</span>
        <span class="statement-visa-tag ${applicantType}">${applicantLabel}</span>
      </div>
      ${applicantMeta.length ? `<div class="statement-visa-meta">${esc(applicantMeta.join(' · ')).replace(/-/g, '&#8209;')}</div>` : ''}
      ${visaMeta.length ? `<div class="statement-visa-meta">${esc(visaMeta.join(' · ')).replace(/-/g, '&#8209;')}</div>` : ''}
    </div>
  `;
}

const DETAILS_KEY = 'ledgerly.statement.details';

function readShowDetails() {
  try { return localStorage.getItem(DETAILS_KEY) === '1'; } catch { return false; }
}

function presetRange(preset) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const today = todayISO();
  if (preset === 'month') return { from: `${year}-${month}-01`, to: today };
  if (preset === 'year') return { from: `${year}-01-01`, to: today };
  return { from: '', to: today };
}

function markActivePreset(container) {
  const from = container.querySelector('#date-from')?.value || '';
  const to = container.querySelector('#date-to')?.value || '';
  container.querySelectorAll('[data-statement-preset]').forEach((button) => {
    const range = presetRange(button.dataset.statementPreset);
    const active = range.from === from && range.to === to;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

export async function render(container, { params = [], query = new URLSearchParams(), kind = 'customer' } = {}) {
  const partyId = Number(params[0]);
  const base = kind === 'customer' ? '/customers' : '/vendors';
  const routeBase = kind === 'customer' ? 'customers' : 'vendors';
  const data = await api.get(`${base}/${partyId}/statement`, {
    from: query.get('from') || '',
    to: query.get('to') || '',
  });
  const partyLabel = kind === 'customer' ? 'Customer' : 'Supplier';
  // Statement of account columns follow the ledger: Debit / Credit / Balance.
  const balanceLabel = kind === 'customer' ? 'Balance due' : 'Balance payable';
  const closing = data.closing_balance_cents;
  const closingStatus = closing === 0
    ? { text: 'Settled', className: 'settled' }
    : closing > 0
      ? { text: kind === 'customer' ? 'Payment due' : 'Payable', className: 'due' }
      : { text: kind === 'customer' ? 'Credit balance' : 'Credit with supplier', className: 'credit' };
  // Money a supplier holds for us (open supplier credits), to take back.
  const held = kind === 'vendor' ? Number(data.unapplied_supplier_credits_cents || 0) : 0;
  const showDetails = readShowDetails();
  const hasExtras = data.transactions.some((row) => transactionExtraHtml(row));

  setHeader({
    title: `${data.party.name} statement`,
    actions: `
      <a class="btn btn-ghost" href="#/${routeBase}">${icon('chevron', 15)}<span>All ${routeBase}</span></a>
      ${held > 0 ? `<button class="btn btn-secondary" data-action="receive-refund">${icon('arrowUp', 15)}<span>Receive refund · ${fmtMoney(held)}</span></button>` : ''}
      <button class="btn btn-primary" data-action="print-statement">${icon('print', 15)}<span>Print</span></button>
    `,
  });

  container.innerHTML = `
    <div class="toolbar statement-toolbar no-print">
      ${dateRangeHtml({ from: data.from, to: data.to, label: 'Period', presets: false })}
      <div class="statement-presets" role="group" aria-label="Statement period presets">
        <button type="button" class="btn btn-ghost btn-sm" data-statement-preset="month" aria-pressed="false">This month</button>
        <button type="button" class="btn btn-ghost btn-sm" data-statement-preset="year" aria-pressed="false">This year</button>
        <button type="button" class="btn btn-ghost btn-sm" data-statement-preset="all" aria-pressed="false">All time</button>
      </div>
      ${hasExtras ? `<label class="statement-details-switch"><input type="checkbox" data-statement-details ${showDetails ? 'checked' : ''}> Show details</label>` : ''}
    </div>

    <div class="card statement-card${showDetails ? ' show-details' : ''}">
      <div class="statement-head">
        <div>
          <div class="statement-brand">${esc(data.company.company_name || 'My Company')}</div>
          ${data.company.company_address ? `<p class="statement-address">${esc(data.company.company_address)}</p>` : ''}
          ${data.company.company_phone || data.company.company_email ? `<p class="statement-contact">${esc([data.company.company_phone, data.company.company_email].filter(Boolean).join(' · '))}</p>` : ''}
        </div>
        <div class="statement-head-right">
          <div class="statement-doc-type">${kind === 'customer' ? 'Statement of account' : 'Supplier statement'}</div>
          <div class="statement-period">${esc(periodLabel(data.from, data.to))}</div>
          <div class="statement-generated">Generated ${esc(fmtDate(todayISO(), { long: true }))}</div>
        </div>
      </div>

      <div class="statement-parties">
        <div>
          <div class="statement-label">${partyLabel}</div>
          <strong>${esc(data.party.name)}</strong>
          ${data.party.address ? `<p class="statement-address">${esc(data.party.address)}</p>` : ''}
          ${data.party.email || data.party.phone ? `<p class="statement-contact">${esc([data.party.phone, data.party.email].filter(Boolean).join(' · '))}</p>` : ''}
        </div>
      </div>

      <div class="statement-summary" data-statement-summary>
        <div><span>Opening</span><strong>${fmtMoney(data.opening_balance_cents)}</strong></div>
        <div><span>Debit</span><strong>${fmtMoney(data.total_debit_cents)}</strong></div>
        <div><span>Credit</span><strong>${fmtMoney(data.total_credit_cents)}</strong></div>
        <div class="statement-summary-due">
          <span>${balanceLabel} · ${esc(fmtDate(data.to))}</span>
          <strong>${fmtMoney(closing)} <span class="statement-status ${closingStatus.className}">${closingStatus.text}</span></strong>
        </div>
      </div>
      ${data.unapplied_credits_cents > 0 ? `<p class="statement-note">Unapplied credits: ${fmtMoney(data.unapplied_credits_cents)}</p>` : ''}
      ${data.unapplied_supplier_credits_cents > 0 ? `<p class="statement-note">Credit with supplier: ${fmtMoney(data.unapplied_supplier_credits_cents)}</p>` : ''}

      <div class="table-wrap">
        <table class="data statement-table"><caption class="sr-only">Account statement</caption>
          <colgroup>
            <col style="width:12%">
            <col style="width:17%">
            <col>
            <col style="width:12%">
            <col style="width:12%">
            <col style="width:14%">
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Reference</th>
              <th scope="col">Description</th>
              <th scope="col" class="num">Debit</th>
              <th scope="col" class="num">Credit</th>
              <th scope="col" class="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr class="statement-opening">
              <td>${data.from ? esc(fmtDate(data.from)) : '—'}</td>
              <td></td>
              <td><strong>Opening balance</strong></td>
              <td class="num"></td>
              <td class="num"></td>
              <td class="num"><strong>${fmtMoney(data.opening_balance_cents)}</strong></td>
            </tr>
            ${data.transactions.length ? data.transactions.map((row, index) => {
              const extra = transactionExtraHtml(row);
              return `
                <tr>
                  <td class="nowrap">${esc(fmtDate(row.date))}</td>
                  <td class="nowrap"><span class="statement-ref">${esc(row.reference)}</span></td>
                  <td>
                    <div class="statement-desc">
                      <span class="statement-desc-dot ${KIND_TONES[row.kind] || 'slate'}" aria-hidden="true"></span>
                      <div class="statement-desc-content">
                        <div class="statement-desc-title">${esc(transactionTitle(row, kind))}</div>
                        ${transactionSubHtml(row, kind)}
                        ${extra ? `<button type="button" class="statement-row-toggle no-print" data-statement-row-toggle aria-expanded="false" aria-controls="statement-extra-${index}">Details</button>
                          <div id="statement-extra-${index}" class="statement-extra-wrap">${extra}</div>` : ''}
                      </div>
                    </div>
                  </td>
                  <td class="num">${row.debit_cents ? fmtMoney(row.debit_cents) : '<span class="statement-zero">—</span>'}</td>
                  <td class="num">${row.credit_cents ? fmtMoney(row.credit_cents) : '<span class="statement-zero">—</span>'}</td>
                  <td class="num">${fmtMoney(row.balance_cents)}</td>
                </tr>
              `;
            }).join('') : `
              <tr><td colspan="6" class="statement-empty">No transactions in this period.</td></tr>
            `}
            <tr class="statement-total">
              <td colspan="3"><strong>Closing balance</strong></td>
              <td class="num"><strong>${fmtMoney(data.total_debit_cents)}</strong></td>
              <td class="num"><strong>${fmtMoney(data.total_credit_cents)}</strong></td>
              <td class="num"><strong>${fmtMoney(data.closing_balance_cents)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      ${heldSectionHtml(data.advances, { title: 'Advances held for you', attr: 'data-statement-advances', note: 'Money received before an invoice. It is used for your next invoice or refunded, and is not part of the amount due above.' })}
      ${heldSectionHtml(data.deposits, { title: 'Security deposits held for you', attr: 'data-statement-deposits', note: 'Deposits are refundable and are not part of the amount due above.' })}

      <div class="statement-foot">
        <p>Please review this statement and contact us if anything looks incorrect.</p>
        <p>${esc([data.company.company_name, data.company.company_email, data.company.company_phone].filter(Boolean).join(' · '))}</p>
      </div>
    </div>
  `;

  bindDateRange(container, ({ from, to }) => {
    const next = new URLSearchParams();
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    const qs = next.toString();
    location.hash = `#/${routeBase}/${partyId}/statement${qs ? `?${qs}` : ''}`;
  });

  container.querySelectorAll('[data-statement-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const range = presetRange(button.dataset.statementPreset);
      const fromInput = container.querySelector('#date-from');
      const toInput = container.querySelector('#date-to');
      if (!fromInput || !toInput) return;
      fromInput.value = range.from;
      toInput.value = range.to;
      const apply = container.querySelector('[data-date-apply]');
      if (apply) apply.click();
    });
  });
  markActivePreset(container);

  const card = container.querySelector('.statement-card');
  container.querySelector('[data-statement-details]')?.addEventListener('change', (event) => {
    card.classList.toggle('show-details', event.target.checked);
    try { localStorage.setItem(DETAILS_KEY, event.target.checked ? '1' : '0'); } catch { /* not stored */ }
  });
  container.querySelectorAll('[data-statement-row-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.closest('tr').classList.toggle('open', open);
    });
  });

  const printButton = document.querySelector('[data-action="print-statement"]');
  if (printButton) printButton.addEventListener('click', printPage);

  document.querySelector('[data-action="receive-refund"]')?.addEventListener('click', () => {
    const accounts = cashAccounts().sort((a, b) => a.code.localeCompare(b.code));
    const bank = accounts.find((account) => account.code === '1010') || accounts[0];
    openModal({
      title: `Receive refund · ${data.party.name}`,
      submitLabel: 'Record refund',
      body: `
        <div class="form-grid">
          <div class="field">
            <label for="rr-amount">Amount · up to ${fmtMoney(held)}</label>
            <div class="money-input"><span>AED</span>
              <input class="input" id="rr-amount" name="amount" type="number" min="0.01" max="${centsToInput(held)}" step="0.01"
                value="${centsToInput(held)}" required inputmode="decimal" data-rr-amount>
            </div>
          </div>
          <div class="field">
            <label for="rr-date">Date</label>
            <input class="input" id="rr-date" name="date" type="date" value="${todayISO()}" required>
          </div>
          <div class="field">
            <label for="rr-account">Received into</label>
            <select class="input" id="rr-account" name="account_id" required>
              ${accounts.map((account) => `<option value="${account.id}" ${account.id === bank?.id ? 'selected' : ''}>${esc(account.code)} · ${esc(account.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="rr-charges">Bank charges</label>
            <div class="money-input"><span>AED</span>
              <input class="input" id="rr-charges" name="bank_charges" type="number" min="0" step="0.01" value="0.00" inputmode="decimal" data-rr-charges>
            </div>
          </div>
          <div class="field full muted" data-rr-net></div>
        </div>
      `,
      onMount(overlay) {
        const amount = overlay.querySelector('[data-rr-amount]');
        const charges = overlay.querySelector('[data-rr-charges]');
        const net = overlay.querySelector('[data-rr-net]');
        const sync = () => {
          const fee = toCents(charges.value || 0);
          net.textContent = fee > 0 ? `${fmtMoney(Math.max(0, toCents(amount.value || 0) - fee))} lands in the account` : '';
        };
        amount.addEventListener('input', sync);
        charges.addEventListener('input', sync);
      },
      async onSubmit(form) {
        const values = new FormData(form);
        const account = accounts.find((row) => row.id === Number(values.get('account_id')));
        await api.post(`/vendors/${partyId}/receive-refund`, {
          amount_cents: toCents(values.get('amount')),
          date: values.get('date'),
          account_id: Number(values.get('account_id')),
          method: /cash/i.test(account?.name || '') ? 'Cash' : 'Bank transfer',
          bank_charges_cents: toCents(values.get('bank_charges') || 0),
        });
        toast('Refund recorded');
        render(container, { params, query, kind });
      },
    });
  });
}

function periodLabel(from, to) {
  if (from && to) return `${fmtDate(from, { long: true })} – ${fmtDate(to, { long: true })}`;
  if (to) return `All transactions to ${fmtDate(to, { long: true })}`;
  return 'All transactions';
}
