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
} from '../ui.js';

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

  setHeader({
    title: `${data.party.name} statement`,
    subtitle: `${partyLabel} statement · ${periodLabel(data.from, data.to)}`,
    actions: `
      <a class="btn btn-ghost" href="#/${routeBase}">${icon('chevron', 15)}<span>All ${routeBase}</span></a>
      <button class="btn btn-primary" data-action="print-statement">${icon('print', 15)}<span>Print</span></button>
    `,
  });

  container.innerHTML = `
    <div class="toolbar statement-toolbar no-print">
      ${dateRangeHtml({ from: data.from, to: data.to, label: 'Period' })}
      <div class="spacer"></div>
      <span class="muted" style="font-size:12px">${data.transactions.length} transaction${data.transactions.length === 1 ? '' : 's'} in this period</span>
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
          <div class="statement-generated">Generated ${esc(fmtDate(new Date().toISOString().slice(0, 10), { long: true }))}</div>
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
          <strong>${fmtMoney(data.closing_balance_cents)}</strong>
          <small>As of ${esc(fmtDate(data.to, { long: true }))}</small>
          ${data.unapplied_credits_cents > 0 ? `<small>Unapplied credits: ${fmtMoney(data.unapplied_credits_cents)}</small>` : ''}
        </div>
      </div>

      <div class="table-wrap">
        <table class="data statement-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Reference</th>
              <th>Description</th>
              <th class="num">Debit</th>
              <th class="num">Credit</th>
              <th class="num">Balance</th>
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
            ${data.transactions.length ? data.transactions.map((row) => `
              <tr>
                <td class="nowrap">${esc(fmtDate(row.date))}</td>
                <td class="nowrap"><span class="statement-ref">${esc(row.reference)}</span></td>
                <td>${esc(row.description)}${row.method ? `<div class="cell-sub">${esc(row.method)}</div>` : ''}</td>
                <td class="num">${row.debit_cents ? fmtMoney(row.debit_cents) : '—'}</td>
                <td class="num">${row.credit_cents ? fmtMoney(row.credit_cents) : '—'}</td>
                <td class="num">${fmtMoney(row.balance_cents)}</td>
              </tr>
            `).join('') : `
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
        <p>${esc(data.company.company_name || '')}${data.company.company_email ? ` · ${esc(data.company.company_email)}` : ''}</p>
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

  const printButton = document.querySelector('[data-action="print-statement"]');
  if (printButton) printButton.addEventListener('click', printPage);
}

function periodLabel(from, to) {
  if (from && to) return `${fmtDate(from, { long: true })} – ${fmtDate(to, { long: true })}`;
  if (to) return `All transactions to ${fmtDate(to, { long: true })}`;
  return 'All transactions';
}
