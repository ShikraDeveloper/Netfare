import { store } from '../../store.js';
import { emptyState, esc, fmtMoney, icon, statusBadge } from '../../ui.js';
import { reportHeader } from './common.js';

export function portalWallets(data) {
  const company = store.settings?.company_name || 'My Company';
  if (!data.rows.length) {
    return `
      <div class="report-card">
        ${reportHeader('Portal Wallets', 'Live balances', company)}
        ${emptyState({
    iconName: 'wallet',
    title: 'No portals yet',
    message: 'Add the airline, IATA, consolidator, GDS or visa-agent portals you use to track top-ups and balances.',
  })}
      </div>
    `;
  }

  return `
    <div class="report-card">
      ${reportHeader('Portal Wallets', 'Live balances', company)}
      <div class="table-wrap">
        <table class="report-table"><caption class="sr-only">Portal wallet balances</caption>
          <thead>
            <tr>
              <th scope="col">Portal</th>
              <th scope="col">Supplier</th>
              <th scope="col">Terms</th>
              <th scope="col" class="num">Topped up</th>
              <th scope="col" class="num">Used</th>
              <th scope="col" class="num">Withdrawn</th>
              <th scope="col" class="num">Balance</th>
              <th scope="col" class="num">Payable</th>
            </tr>
          </thead>
          <tbody>
            ${data.rows.map((row) => `
              <tr>
                <td><a href="#/portals/${row.id}">${esc(row.name)}</a></td>
                <td class="muted">${esc(row.vendor_name || '—')}</td>
                <td>${statusBadge(row.settlement)}</td>
                <td class="num">${fmtMoney(row.topup_total_cents)}</td>
                <td class="num">${fmtMoney(row.consumed_total_cents)}</td>
                <td class="num">${fmtMoney(row.refunded_total_cents)}</td>
                <td class="num" style="font-weight:650">${fmtMoney(row.balance_cents)}</td>
                <td class="num">${fmtMoney(row.outstanding_ap_cents)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3">Totals</td>
              <td class="num">${fmtMoney(data.totals.topup_total_cents)}</td>
              <td class="num">${fmtMoney(data.totals.consumed_total_cents)}</td>
              <td class="num">${fmtMoney(data.totals.refunded_total_cents)}</td>
              <td class="num">${fmtMoney(data.totals.balance_cents)}</td>
              <td class="num">${fmtMoney(data.totals.outstanding_ap_cents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="report-balance-note">
        ${icon('wallet', 14)} Wallet balances sit in <strong>1400 Supplier Advances</strong> until a booking uses them.
      </div>
    </div>
  `;
}

async function fetchReport(key, filters) {
  if (key === 'income-statement') {
    return api.get('/reports/income-statement', { from: filters.from, to: filters.to });
  }
  if (key === 'booking-margin') {
    return api.get('/reports/bookings', { from: filters.from, to: filters.to });
  }
  if (key === 'visa-margin') {
    return api.get('/reports/visas', { from: filters.from, to: filters.to });
  }
  if (key === 'daily-sales') {
    return api.get('/reports/daily-sales', { from: filters.from, to: filters.to });
  }
  if (key === 'portal-wallets') return api.get('/reports/portals');
  if (key === 'balance-sheet') return api.get('/reports/balance-sheet', { as_of: filters.asOf });
  if (key === 'trial-balance') return api.get('/reports/trial-balance', { as_of: filters.asOf });
  if (key === 'ar-aging') return api.get('/reports/ar-aging', { as_of: filters.asOf });
  return api.get('/reports/ap-aging', { as_of: filters.asOf });
}

