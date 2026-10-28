import { store } from '../../store.js';
import { emptyState, esc, fmtDate, fmtMoney } from '../../ui.js';
import { reportHeader } from './common.js';

// Deposit register: every visa security deposit and what is still held.

const STATUS_TEXT = { held: 'Held', with_supplier: 'With supplier', settled: 'Settled', forfeited: 'Forfeited' };
const FLAG_TEXT = { refund_due: 'Refund due · visa cancelled or rejected', old: 'Held over 90 days' };

export function visaDeposits(data) {
  const company = store.settings?.company_name || 'My Company';
  const title = data.status === 'all' ? 'All visa deposits' : 'Deposits still held';
  if (!data.rows.length) {
    return `
      <div class="report-card">
        ${reportHeader('Visa Security Deposits', `${title} · as of ${fmtDate(data.as_of, { long: true })}`, company)}
        ${emptyState({ iconName: 'visa', title: 'No deposits to show', message: 'Take a security deposit on a visa application to see it here.' })}
      </div>`;
  }
  const t = data.totals;
  return `
    <div class="report-card" data-deposit-register>
      ${reportHeader('Visa Security Deposits', `${title} · as of ${fmtDate(data.as_of, { long: true })}`, company)}
      <div class="account-summary">
        <div class="summary-tile"><span>Still held (2600)</span><strong>${fmtMoney(t.held_cents)}</strong></div>
        <div class="summary-tile"><span>With suppliers (1460)</span><strong>${fmtMoney(t.with_supplier_cents)}</strong></div>
        <div class="summary-tile"><span>In hand</span><strong>${fmtMoney(t.in_hand_cents)}</strong></div>
        <div class="summary-tile"><span>Refund due</span><strong>${t.refund_due_count}</strong><small class="sub">visa cancelled or rejected</small></div>
      </div>
      <div class="table-wrap">
        <table class="report-table"><caption class="sr-only">Visa security deposits</caption>
          <thead><tr>
            <th scope="col">Deposit</th><th scope="col">Customer / applicant</th><th scope="col">Visa</th>
            <th scope="col" class="num">Received</th><th scope="col" class="num">Refunded / used</th><th scope="col" class="num">Forfeited</th>
            <th scope="col" class="num">With supplier</th><th scope="col" class="num">Still held</th><th scope="col">Status</th>
          </tr></thead>
          <tbody>${data.rows.map((row) => `
            <tr${row.flag ? ` class="deposit-flag-${esc(row.flag)}"` : ''}>
              <td class="nowrap">${esc(row.number)}<div class="cell-sub">${esc(fmtDate(row.deposit_date))} · ${row.age_days} days</div></td>
              <td>${esc(row.customer_name)}${row.applicant_name && row.applicant_name !== row.customer_name ? `<div class="cell-sub">${esc(row.applicant_name)}</div>` : ''}</td>
              <td class="nowrap"><a href="#/visas/${row.visa_id}">${esc(row.visa_number)}</a><div class="cell-sub">${esc([row.destination_country, row.visa_status].filter(Boolean).join(' · '))}</div></td>
              <td class="num">${fmtMoney(row.collected_cents)}</td>
              <td class="num">${fmtMoney(row.refunded_cents + row.applied_cents)}</td>
              <td class="num">${fmtMoney(row.forfeited_cents)}</td>
              <td class="num">${fmtMoney(row.with_supplier_cents)}</td>
              <td class="num"><strong>${fmtMoney(row.held_cents)}</strong></td>
              <td>${esc(STATUS_TEXT[row.status] || row.status)}${row.flag ? `<div class="cell-sub deposit-flag">${esc(FLAG_TEXT[row.flag])}</div>` : ''}</td>
            </tr>`).join('')}</tbody>
          <tfoot><tr>
            <td colspan="3">Total · ${data.rows.length} deposit${data.rows.length === 1 ? '' : 's'}</td>
            <td class="num">${fmtMoney(t.collected_cents)}</td>
            <td class="num">${fmtMoney(t.refunded_cents)}</td>
            <td class="num">${fmtMoney(t.forfeited_cents)}</td>
            <td class="num">${fmtMoney(t.with_supplier_cents)}</td>
            <td class="num">${fmtMoney(t.held_cents)}</td>
            <td></td>
          </tr></tfoot>
        </table>
      </div>
    </div>`;
}
