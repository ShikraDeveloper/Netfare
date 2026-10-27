import { api } from '../api.js';
import {
  bindDateRange,
  dateRangeHtml,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  printPage,
  setHeader,
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
  supplier_credit: 'Supplier credit applied',
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

function transactionItemsHtml(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  if (!items.length) return '';
  const visible = items.slice(0, 3);
  const lines = visible.map((item) => {
    const quantity = Number(item.quantity) || 1;
    const label = quantity === 1 ? item.description : `${quantity} × ${item.description}`;
    return `<div class="statement-item-line">${esc(label)}</div>`;
  });
  const remaining = items.length - visible.length;
  if (remaining > 0) {
    lines.push(`<div class="statement-item-line statement-item-more">+${remaining} more item${remaining === 1 ? '' : 's'}</div>`);
  }
  return lines.join('');
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

function summaryCard(label, valueCents, meta, iconName, color) {
  return `
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">${esc(label)}</span>
        <span class="kpi-icon ${color}">${icon(iconName, 17)}</span>
      </div>
      <div class="kpi-value">${fmtMoney(valueCents)}</div>
      <div class="kpi-meta">${esc(meta)}</div>
    </div>
  `;
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
  const partyLabel = kind === 'customer' ? 'Customer' : 'Vendor';
  const balanceLabel = kind === 'customer' ? 'Amount due' : 'Balance payable';
  const debitLabel = kind === 'customer' ? 'Invoiced' : 'Paid';
  const creditLabel = kind === 'customer' ? 'Received' : 'Billed';
  const debitCount = data.transactions.filter((row) => row.debit_cents > 0).length;
  const creditCount = data.transactions.filter((row) => row.credit_cents > 0).length;
  const transactionCount = data.transactions.length;
  const transactionText = `${transactionCount} transaction${transactionCount === 1 ? '' : 's'}`;
  const closing = data.closing_balance_cents;
  const closingStatus = closing === 0
    ? { text: 'Settled', className: 'settled' }
    : closing > 0
      ? { text: kind === 'customer' ? 'Payment due' : 'Payable', className: 'due' }
      : { text: kind === 'customer' ? 'Credit balance' : 'Advance paid', className: 'credit' };
  const balanceColor = closing > 0 ? 'amber' : closing < 0 ? 'blue' : 'green';
  const openingMeta = data.from ? `At ${fmtDate(data.from)}` : 'Start of history';

  setHeader({
    title: `${data.party.name} statement`,
    subtitle: `${partyLabel} statement · ${periodLabel(data.from, data.to)}`,
    actions: `
      <a class="btn btn-ghost" href="#/${routeBase}">${icon('chevron', 15)}<span>All ${routeBase}</span></a>
      <button class="btn btn-primary" data-action="print-statement">${icon('print', 15)}<span>Print</span></button>
    `,
  });

  container.innerHTML = `
    <div class="kpi-grid no-print">
      ${summaryCard('Opening balance', data.opening_balance_cents, openingMeta, 'wallet', 'indigo')}
      ${summaryCard(debitLabel, data.total_debit_cents, `${debitCount} debit entr${debitCount === 1 ? 'y' : 'ies'} in period`, 'invoice', 'blue')}
      ${summaryCard(creditLabel, data.total_credit_cents, `${creditCount} credit entr${creditCount === 1 ? 'y' : 'ies'} in period`, 'check', 'green')}
      ${summaryCard(balanceLabel, closing, `${closingStatus.text} · ${transactionText}`, 'bill', balanceColor)}
    </div>

    <div class="toolbar statement-toolbar no-print">
      ${dateRangeHtml({ from: data.from, to: data.to, label: 'Period' })}
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
          ${data.party.address ? `<p class="statement-address">${esc(data.party.address)}</p>` : ''}
          ${data.party.email || data.party.phone ? `<p class="statement-contact">${esc([data.party.phone, data.party.email].filter(Boolean).join(' · '))}</p>` : ''}
        </div>
        <div class="statement-balance-box">
          <span>${balanceLabel}</span>
          <div class="statement-balance-value">
            <strong>${fmtMoney(closing)}</strong>
            <span class="statement-status ${closingStatus.className}">${closingStatus.text}</span>
          </div>
          <small>As of ${esc(fmtDate(data.to, { long: true }))}</small>
          ${data.unapplied_credits_cents > 0 ? `<small>Unapplied credits: ${fmtMoney(data.unapplied_credits_cents)}</small>` : ''}
          ${data.unapplied_supplier_credits_cents > 0 ? `<small>Open supplier credits: ${fmtMoney(data.unapplied_supplier_credits_cents)}</small>` : ''}
        </div>
      </div>

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
            ${data.transactions.length ? data.transactions.map((row) => {
              const detail = transactionDetail(row, kind);
              return `
                <tr>
                  <td class="nowrap">${esc(fmtDate(row.date))}</td>
                  <td class="nowrap"><span class="statement-ref">${esc(row.reference)}</span></td>
                  <td>
                    <div class="statement-desc">
                      <span class="statement-desc-dot ${KIND_TONES[row.kind] || 'slate'}" aria-hidden="true"></span>
                      <div class="statement-desc-content">
                        <div class="statement-desc-title">${esc(transactionTitle(row, kind))}</div>
                        ${transactionItemsHtml(row)}
                        ${detail ? `<div class="cell-sub">${esc(detail).replace(/-/g, '&#8209;')}</div>` : ''}
                        ${visaDetailsHtml(row)}
                        ${beneficiaryDetailsHtml(row)}
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

  const printButton = document.querySelector('[data-action="print-statement"]');
  if (printButton) printButton.addEventListener('click', printPage);
}

function periodLabel(from, to) {
  if (from && to) return `${fmtDate(from, { long: true })} – ${fmtDate(to, { long: true })}`;
  if (to) return `All transactions to ${fmtDate(to, { long: true })}`;
  return 'All transactions';
}
