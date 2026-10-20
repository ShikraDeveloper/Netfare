import { store } from '../../store.js';
import { esc, fmtDate, fmtMoney, icon } from '../../ui.js';
import { periodLabel, reportHeader, sectionHead, reportRow } from './common.js';

export function incomeStatement(data) {
  const company = store.settings?.company_name || 'My Company';
  const revenue = data.revenue.length
    ? data.revenue.map((row) => reportRow(row.name, row.code, row.amount_cents)).join('')
    : '<div class="report-row subtle"><div class="row-label">No revenue in this period</div><div class="amount">—</div></div>';
  const expenses = data.expenses.length
    ? data.expenses.map((row) => reportRow(row.name, row.code, row.amount_cents)).join('')
    : '<div class="report-row subtle"><div class="row-label">No expenses in this period</div><div class="amount">—</div></div>';

  return `
    <div class="report-card">
      ${reportHeader('Income Statement', periodLabel(data.from, data.to), company)}
      <div class="report-section">
        ${sectionHead('Revenue')}
        ${revenue}
        <div class="report-row total"><div class="row-label">Total revenue</div><div class="amount">${fmtMoney(data.revenue_total_cents)}</div></div>
      </div>
      <div class="report-section">
        ${sectionHead('Expenses')}
        ${expenses}
        <div class="report-row total"><div class="row-label">Total expenses</div><div class="amount">${fmtMoney(data.expenses_total_cents)}</div></div>
      </div>
      <div class="report-net ${data.net_income_cents < 0 ? 'negative' : ''}">
        <span>Net income</span>
        <span class="amount">${fmtMoney(data.net_income_cents)}</span>
      </div>
    </div>
  `;
}

export function balanceSheet(data) {
  const company = store.settings?.company_name || 'My Company';
  const rowsFor = (rows, emptyLabel) => (rows.length
    ? rows.map((row) => reportRow(row.name, row.code, row.amount_cents)).join('')
    : `<div class="report-row subtle"><div class="row-label">${emptyLabel}</div><div class="amount">—</div></div>`);

  return `
    <div class="report-card">
      ${reportHeader('Balance Sheet', `As of ${fmtDate(data.as_of, { long: true })}`, company)}
      <div class="report-section">
        ${sectionHead('Assets')}
        ${rowsFor(data.assets, 'No asset balances')}
        <div class="report-row total"><div class="row-label">Total assets</div><div class="amount">${fmtMoney(data.asset_total_cents)}</div></div>
      </div>
      <div class="report-section">
        ${sectionHead('Liabilities')}
        ${rowsFor(data.liabilities, 'No liabilities')}
        <div class="report-row total"><div class="row-label">Total liabilities</div><div class="amount">${fmtMoney(data.liability_total_cents)}</div></div>
      </div>
      <div class="report-section">
        ${sectionHead('Equity')}
        ${rowsFor(data.equity, 'No equity balances')}
        <div class="report-row total"><div class="row-label">Total equity</div><div class="amount">${fmtMoney(data.equity_total_cents)}</div></div>
      </div>
      <div class="report-net">
        <span>Total liabilities &amp; equity</span>
        <span class="amount">${fmtMoney(data.liabilities_and_equity_cents)}</span>
      </div>
      <div class="report-balance-note">
        ${data.balanced
    ? `${icon('check', 14)} Assets equal liabilities and equity.`
    : `${icon('alert', 14)} Out of balance by ${fmtMoney(Math.abs(data.difference_cents))}. Check your journal entries.`}
      </div>
    </div>
  `;
}

export function trialBalance(data) {
  const company = store.settings?.company_name || 'My Company';
  const rows = data.rows.filter((row) => row.debit_cents !== 0 || row.credit_cents !== 0);
  if (!rows.length) {
    return `
      <div class="report-card">
        ${reportHeader('Trial Balance', `As of ${fmtDate(data.as_of, { long: true })}`, company)}
        <div class="report-empty">No ledger activity yet. Post an invoice, bill or journal entry to see a trial balance.</div>
      </div>
    `;
  }

  return `
    <div class="report-card">
      ${reportHeader('Trial Balance', `As of ${fmtDate(data.as_of, { long: true })}`, company)}
      <div class="table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Account</th>
              <th class="num">Debit</th>
              <th class="num">Credit</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td class="muted">${esc(row.code)}</td>
                <td>${esc(row.name)}</td>
                <td class="num">${row.debit_cents ? fmtMoney(row.debit_cents) : ''}</td>
                <td class="num">${row.credit_cents ? fmtMoney(row.credit_cents) : ''}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2">Totals</td>
              <td class="num">${fmtMoney(data.totals.debit_cents)}</td>
              <td class="num">${fmtMoney(data.totals.credit_cents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="report-balance-note">
        ${data.balanced
    ? `${icon('check', 14)} Debits equal credits.`
    : `${icon('alert', 14)} Debits and credits do not match.`}
      </div>
    </div>
  `;
}

