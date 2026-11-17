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
  entryTimeHtml,
} from '../ui.js';

const CUSTOMER_TITLES = {
  invoice: 'Invoice raised',
  payment: 'Payment received',
  receipt: 'Payment received',
  credit_note: 'Credit note',
  refund: 'Refund issued',
  cancellation: 'Booking or visa cancelled',
  cancellation_charge: 'Cancellation charges',
};

const VENDOR_TITLES = {
  bill: 'Supplier bill',
  payment: 'Payment made',
  supplier_credit: 'Supplier credit',
  credit_refund: 'Refund received',
  refund: 'Supplier refund received',
  deposit: 'Deposit sent',
  deposit_return: 'Deposit returned',
};

const KIND_TONES = {
  invoice: 'blue',
  payment: 'green',
  receipt: 'green',
  deposit: 'green',
  credit_note: 'amber',
  deposit_return: 'red',
  refund: 'red',
  bill: 'blue',
  supplier_credit: 'amber',
  cancellation: 'red',
  cancellation_charge: 'blue',
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
              <td class="nowrap">${esc(fmtDate(row.date))}${entryTimeHtml(row.date, row.created_at)}</td>
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
    else if (row.paid_from_deposit?.length) parts.push('Paid from deposit');
    else if (row.due_date && kind === 'vendor') parts.push(`Due ${fmtDate(row.due_date)}`);
  } else if (row.kind === 'cancellation') {
    parts.push(`Invoice ${row.related} reversed`);
  } else if (row.kind === 'receipt') {
    parts.push(row.method, `${row.allocations.length} invoice${row.allocations.length === 1 ? '' : 's'}`);
  } else if (row.kind === 'credit_note') {
    if (row.status === 'opening') parts.push('Opening balance');
  } else if (row.kind === 'deposit' || row.kind === 'deposit_return') {
    parts.push(row.method, row.related);
  } else {
    if (row.method) parts.push(row.method);
    if (row.related) parts.push(`Against ${row.related}`);
  }
  return parts.join(' · ');
}

// What the line is for, as on a travel agency's statement: the booking
// (route, PNR, travel dates, passengers and tickets) or the visa (applicant,
// type, passport), and on a supplier statement the customer it was for.
// The customer statement has the passport masked; the supplier's has it in full.
function jobLine(row, kind) {
  const nb = (text) => esc(text).replace(/-/g, '&#8209;');
  const booking = row.booking;
  if (booking) {
    const passengers = booking.passengers || [];
    const shown = passengers.slice(0, 3).map((p) => `${p.name}${p.ticket ? ` · Ticket ${p.ticket}` : ''}`);
    if (passengers.length > 3) shown.push(`+${passengers.length - 3} more`);
    const details = [
      booking.travel_date ? `Travel ${fmtDate(booking.travel_date)}${booking.return_date ? ` – ${fmtDate(booking.return_date)}` : ''}` : '',
      ...shown,
      kind === 'vendor' && row.customer_name ? `for ${row.customer_name}` : '',
    ];
    return { title: [booking.number, booking.destination, booking.pnr ? `PNR ${booking.pnr}` : ''].filter(Boolean).join(' · '), details: details.filter(Boolean).map(nb) };
  }
  const visa = row.visa;
  if (visa && visa.applicant_name) {
    const details = [
      visa.visa_type ? `${titleCase(visa.visa_type)} visa` : '',
      visa.destination_country,
      Number(visa.duration_days) > 0 ? `${visa.duration_days} days` : '',
      visa.nationality,
      kind === 'vendor' ? (visa.passport ? `Passport ${visa.passport}` : '') : (visa.passport_masked ? `Passport ${visa.passport_masked}` : ''),
      kind === 'vendor' && row.customer_name ? `for ${row.customer_name}` : '',
    ];
    return { title: `${visa.number} · ${visa.applicant_name}`, details: details.filter(Boolean).map(nb) };
  }
  if (row.kind === 'bill' && row.first_item) {
    return { title: `${row.first_item}${row.item_count > 1 ? ` +${row.item_count - 1} more` : ''}`, details: [] };
  }
  return null;
}

// A bill's reference at the supplier: the one typed on the bill, else the
// booking's ticket numbers.
function supplierRef(row) {
  if (row.kind !== 'bill') return '';
  if (row.supplier_ref) return row.supplier_ref;
  return (row.booking?.passengers || []).map((p) => p.ticket).filter(Boolean).join(', ');
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
  // What one receipt paid, and the wallet payments behind a bill.
  const paid = (row.allocations || []).map((share) => `<li>${esc(share.invoice)} · ${fmtMoney(share.amount_cents)} <span class="statement-ref">${esc(share.payment)}</span></li>`)
    .concat((row.paid_from_deposit || []).map((share) => `<li>Paid from deposit ${esc(fmtDate(share.date))} · ${fmtMoney(share.amount_cents)} <span class="statement-ref">${esc(share.payment)}</span></li>`));
  const paidList = paid.length ? `<ul class="statement-extra-items">${paid.join('')}</ul>` : '';
  const html = `${paidList}${itemList}${beneficiaryDetailsHtml(row)}`;
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

// How late the open invoices or bills are, as on a standard statement of account.
function ageingHtml(ageing) {
  if (!ageing) return '';
  const cells = [['Current', ageing.current], ['1–30 days', ageing.days_30], ['31–60', ageing.days_60], ['61–90', ageing.days_90], ['Over 90', ageing.over_90]];
  if (ageing.other_cents) cells.push(['Credits and other', ageing.other_cents]);
  return `<div class="statement-ageing" data-statement-ageing>${cells.map(([label, cents]) => `
    <div${label === 'Over 90' && cents ? ' class="is-late"' : ''}><span>${label}</span><strong>${fmtMoney(cents)}</strong></div>`).join('')}</div>`;
}

// Where to pay, from Settings, as invoices print it.
function bankHtml(company, closing) {
  if (!company.bank_iban || closing <= 0) return '';
  return `<div class="statement-bank" data-statement-bank>
    <div><span>Pay by bank</span>${esc([company.bank_name, company.bank_account_name].filter(Boolean).join(' · '))}<br>IBAN ${esc(company.bank_iban)}</div>
    <div class="statement-bank-due"><span>Balance due</span><strong>${fmtMoney(closing)}</strong></div>
  </div>`;
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
          ${data.party.number ? `<p class="statement-contact">${partyLabel} no. ${esc(data.party.number)}</p>` : ''}
          ${data.party.trn ? `<p class="statement-contact">TRN ${esc(data.party.trn)}</p>` : ''}
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
      ${data.deposit_held_cents ? `<p class="statement-note">Held in your deposit with the supplier: ${fmtMoney(data.deposit_held_cents)}</p>` : ''}
      ${data.unapplied_supplier_credits_cents > 0 ? `<p class="statement-note">Credit with supplier: ${fmtMoney(data.unapplied_supplier_credits_cents)}</p>` : ''}

      <div class="table-wrap">
        <table class="data statement-table"><caption class="sr-only">Account statement</caption>
          <colgroup>
            <col style="width:11%">
            <col style="width:15%">
            <col>
            <col style="width:${kind === 'vendor' ? 13 : 9}%">
            <col style="width:11%">
            <col style="width:11%">
            <col style="width:12%">
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Reference</th>
              <th scope="col">Particulars</th>
              <th scope="col">${kind === 'vendor' ? 'Supplier ref' : 'Due'}</th>
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
              <td></td>
              <td class="num"></td>
              <td class="num"></td>
              <td class="num"><strong>${fmtMoney(data.opening_balance_cents)}</strong></td>
            </tr>
            ${data.transactions.length ? data.transactions.map((row, index) => {
              const extra = transactionExtraHtml(row);
              const job = jobLine(row, kind);
              const detail = transactionDetail(row, kind);
              const sub = job
                ? `<div class="statement-row-sub">${[...job.details, kind === 'vendor' && detail ? esc(detail) : ''].filter(Boolean).join(' · ')}</div>`
                : transactionSubHtml(row, kind);
              const side = kind === 'vendor' ? esc(supplierRef(row) || '') : (row.kind === 'invoice' && row.due_date ? esc(fmtDate(row.due_date)) : '');
              return `
                <tr>
                  <td class="nowrap">${esc(fmtDate(row.date))}${entryTimeHtml(row.date, row.created_at)}</td>
                  <td class="nowrap"><span class="statement-ref">${esc(row.reference)}</span></td>
                  <td>
                    <div class="statement-desc">
                      <span class="statement-desc-dot ${KIND_TONES[row.kind] || 'slate'}" aria-hidden="true"></span>
                      <div class="statement-desc-content">
                        <div class="statement-desc-title">${esc(job ? job.title : transactionTitle(row, kind))}</div>
                        ${sub}
                        ${extra ? `<button type="button" class="statement-row-toggle no-print" data-statement-row-toggle aria-expanded="false" aria-controls="statement-extra-${index}">Details</button>
                          <div id="statement-extra-${index}" class="statement-extra-wrap">${extra}</div>` : ''}
                      </div>
                    </div>
                  </td>
                  <td class="statement-side">${side}</td>
                  <td class="num">${row.debit_cents ? fmtMoney(row.debit_cents) : '<span class="statement-zero">—</span>'}</td>
                  <td class="num">${row.credit_cents ? fmtMoney(row.credit_cents) : '<span class="statement-zero">—</span>'}</td>
                  <td class="num">${fmtMoney(row.balance_cents)}</td>
                </tr>
              `;
            }).join('') : `
              <tr><td colspan="7" class="statement-empty">No transactions in this period.</td></tr>
            `}
            <tr class="statement-total">
              <td colspan="4"><strong>Closing balance</strong></td>
              <td class="num"><strong>${fmtMoney(data.total_debit_cents)}</strong></td>
              <td class="num"><strong>${fmtMoney(data.total_credit_cents)}</strong></td>
              <td class="num"><strong>${fmtMoney(data.closing_balance_cents)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      ${ageingHtml(data.ageing)}
      ${kind === 'customer' ? bankHtml(data.company, closing) : ''}
      ${heldSectionHtml(data.advances, { title: 'Advances held for you', attr: 'data-statement-advances', note: 'Money received before an invoice. It is used for your next invoice or refunded, and is not part of the amount due above.' })}
      ${heldSectionHtml(data.deposits, { title: 'Security deposits held for you', attr: 'data-statement-deposits', note: 'Deposits are refundable and are not part of the amount due above.' })}

      <div class="statement-foot">
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
