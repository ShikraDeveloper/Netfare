import { api } from '../api.js';
import { bindListToggles, listRowsHtml, listToggleHtml, particulars } from '../statement-lines.js';
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
              <td class="nowrap">${esc(fmtDate(row.date, { short: true }))}</td>
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
    </div>

    <div class="card statement-card">
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
            <col style="width:9%">
            <col style="width:15%">
            <col>
            <col style="width:14%">
            <col style="width:14%">
            <col style="width:15%">
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Reference</th>
              <th scope="col">Particulars</th>
              <th scope="col" class="num">Debit</th>
              <th scope="col" class="num">Credit</th>
              <th scope="col" class="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr class="statement-opening">
              <td class="nowrap">${data.from ? esc(fmtDate(data.from, { short: true })) : '—'}</td>
              <td></td>
              <td><strong>Opening balance</strong></td>
              <td class="num"></td>
              <td class="num"></td>
              <td class="num"><strong>${fmtMoney(data.opening_balance_cents)}</strong></td>
            </tr>
            ${data.transactions.length ? data.transactions.map((row, index) => {
              const lines = particulars(row, kind);
              const { top, sub } = lines;
              const topText = top.filter(Boolean).join(' · ');
              const subText = sub.filter(Boolean).join(' · ');
              return `
                <tr class="statement-row">
                  <td class="nowrap">${esc(fmtDate(row.date, { short: true }))}</td>
                  <td class="nowrap"><span class="statement-ref">${esc(row.reference)}</span></td>
                  <td class="statement-line-cell" title="${esc([topText, subText].filter(Boolean).join(' · '))}">
                    <div class="statement-line">${esc(topText)}${listToggleHtml(lines, index)}</div>
                    ${subText ? `<div class="statement-line-sub">${esc(subText)}</div>` : ''}
                  </td>
                  <td class="num">${row.debit_cents ? fmtMoney(row.debit_cents) : ''}</td>
                  <td class="num">${row.credit_cents ? fmtMoney(row.credit_cents) : ''}</td>
                  <td class="num">${fmtMoney(row.balance_cents)}</td>
                </tr>
                ${listRowsHtml(lines, index)}
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

  bindListToggles(container);

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
