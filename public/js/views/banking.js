import { api } from '../api.js';
import {
  bindDateRange,
  confirmDialog,
  dateRangeHtml,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  inDateRange,
  setHeader,
  statusBadge,
  toast,
} from '../ui.js';
import { openCashDepositModal } from './cash-deposit.js';

function rowHtml(deposit) {
  return `
    <tr data-id="${deposit.id}">
      <td>
        <div class="cell-main nowrap">${esc(fmtDate(deposit.deposit_date))}</div>
        <div class="cell-sub">${esc(deposit.number)}</div>
      </td>
      <td>
        <div class="cell-main">${esc(deposit.from_name)}</div>
        <div class="cell-sub">${esc(deposit.from_code)}</div>
      </td>
      <td>
        <div class="cell-main">${esc(deposit.to_name)}</div>
        <div class="cell-sub">${esc(deposit.to_code)}</div>
      </td>
      <td class="num">${fmtMoney(deposit.amount_cents)}</td>
      <td>${esc(deposit.reference || '—')}</td>
      <td>${statusBadge(deposit.status)}</td>
      <td>
        ${deposit.journal_entry_id ? `<a href="#/journal?focus=${deposit.journal_entry_id}">${icon('journal', 14)} Journal</a>` : '—'}
      </td>
      <td>
        <div class="row-actions">
          ${deposit.status === 'posted' ? `<button class="icon-btn danger" data-void="${deposit.id}" title="Void deposit">${icon('x', 15)}</button>` : ''}
        </div>
      </td>
    </tr>
  `;
}

function kpi(label, value, meta, iconName, color) {
  return `
    <div class="kpi">
      <div class="kpi-top"><span class="kpi-label">${esc(label)}</span><span class="kpi-icon ${color}">${icon(iconName, 16)}</span></div>
      <div class="kpi-value">${esc(value)}</div>
      <div class="kpi-meta">${esc(meta)}</div>
    </div>
  `;
}

export async function render(container, { query } = {}) {
  const data = await api.get('/cash/deposits');
  const deposits = data.deposits;
  const balances = data.balances;
  const summary = data.summary;
  const bankCount = balances.bank_accounts.length;
  const last = summary.last_deposit;

  setHeader({
    title: 'Banking',
    subtitle: `Cash in hand ${fmtMoney(balances.cash_balance_cents)} · Bank ${fmtMoney(balances.bank_balance_cents)}`,
    actions: `<button class="btn btn-primary" data-action="new-deposit">${icon('plus', 16)}<span>New cash deposit</span></button>`,
  });

  const bindNew = () => {
    document.querySelectorAll('[data-action="new-deposit"]').forEach((button) => {
      button.addEventListener('click', () => openCashDepositModal({ onSaved: () => render(container) }));
    });
  };

  if (!deposits.length) {
    container.innerHTML = `
      <div class="kpi-grid">
        ${kpi('Cash in hand', fmtMoney(balances.cash_balance_cents), balances.cash_accounts[0]?.name || '1000 · Cash', 'cash', 'amber')}
        ${kpi('Bank balance', fmtMoney(balances.bank_balance_cents), `${bankCount} bank account${bankCount === 1 ? '' : 's'}`, 'wallet', 'indigo')}
        ${kpi('Deposits this month', fmtMoney(summary.month_total_cents), `${summary.month_count} deposit${summary.month_count === 1 ? '' : 's'}`, 'arrowUp', 'green')}
        ${kpi('Last deposit', last ? fmtMoney(last.amount_cents) : '—', last ? fmtDate(last.deposit_date) : 'No deposits yet', 'clock', 'blue')}
      </div>
      <div class="card">
        ${emptyState({
          iconName: 'cash',
          title: 'No cash deposits yet',
          message: 'At the end of the day, deposit cash sales from Cash in hand into your bank account. This moves money between accounts and does not change profit.',
          action: '<button class="btn btn-primary" data-action="new-deposit">Deposit cash to bank</button>',
        })}
      </div>
    `;
    bindNew();
    maybeOpenNew(query);
    return;
  }

  container.innerHTML = `
    <div class="kpi-grid">
      ${kpi('Cash in hand', fmtMoney(balances.cash_balance_cents), balances.cash_accounts[0]?.name || '1000 · Cash', 'cash', 'amber')}
      ${kpi('Bank balance', fmtMoney(balances.bank_balance_cents), `${bankCount} bank account${bankCount === 1 ? '' : 's'}`, 'wallet', 'indigo')}
      ${kpi('Deposits this month', fmtMoney(summary.month_total_cents), `${summary.month_count} deposit${summary.month_count === 1 ? '' : 's'}`, 'arrowUp', 'green')}
      ${kpi('Last deposit', last ? fmtMoney(last.amount_cents) : '—', last ? fmtDate(last.deposit_date) : 'No deposits yet', 'clock', 'blue')}
    </div>

    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="deposit-search" type="search" placeholder="Search deposit number, reference or notes…" autocomplete="off">
      </div>
      <select class="input" id="deposit-status" style="max-width:150px">
        <option value="all">All statuses</option>
        <option value="posted">Posted</option>
        <option value="void">Void</option>
      </select>
      ${dateRangeHtml({ label: 'Deposit date' })}
      <div class="spacer"></div>
      <span class="muted" id="deposit-count" style="font-size:12px"></span>
    </div>

    <div class="stmt-hint no-print">Cash deposits move money from <strong>1000 Cash</strong> to a bank account: Dr Bank / Cr Cash. Cash in hand goes down and bank goes up; profit does not change.</div>

    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Deposit</th>
              <th>From</th>
              <th>To</th>
              <th class="num">Amount</th>
              <th>Reference</th>
              <th>Status</th>
              <th>Journal</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="deposit-body"></tbody>
        </table>
      </div>
    </div>
  `;

  const searchInput = container.querySelector('#deposit-search');
  const statusSelect = container.querySelector('#deposit-status');
  const body = container.querySelector('#deposit-body');
  const countEl = container.querySelector('#deposit-count');
  const dateRange = bindDateRange(container, () => applyFilters());

  function applyFilters() {
    const term = searchInput.value.trim().toLowerCase();
    const status = statusSelect.value;
    const { from, to } = dateRange.values();
    const filtered = deposits.filter((deposit) => {
      if (status !== 'all' && deposit.status !== status) return false;
      if (!inDateRange(deposit.deposit_date, from, to)) return false;
      if (!term) return true;
      return [deposit.number, deposit.reference, deposit.notes, deposit.from_name, deposit.to_name]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    countEl.textContent = `${filtered.length} shown`;
    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="8">${emptyState({
        iconName: 'search',
        title: 'No matching deposits',
        message: 'Try a different search, status or date range.',
      })}</td></tr>`;
      return;
    }
    body.innerHTML = filtered.map(rowHtml).join('');
  }

  searchInput.addEventListener('input', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  bindNew();

  body.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-void]');
    if (!button) return;
    const deposit = deposits.find((row) => row.id === Number(button.dataset.void));
    if (!deposit) return;
    const confirmed = await confirmDialog({
      title: `Void ${deposit.number}?`,
      message: `A reversing entry will move ${fmtMoney(deposit.amount_cents)} back from ${deposit.to_name} to ${deposit.from_name}. The deposit stays in history as void.`,
      confirmLabel: 'Void deposit',
    });
    if (!confirmed) return;
    try {
      await api.post(`/cash/deposits/${deposit.id}/void`, {});
      toast(`${deposit.number} voided with a reversing entry`);
      await render(container);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  applyFilters();
  maybeOpenNew(query);
}

function maybeOpenNew(query) {
  if (query && query.get('new')) {
    history.replaceState(null, '', '#/banking');
    setTimeout(() => {
      document.querySelector('[data-action="new-deposit"]')?.click();
    }, 40);
  }
}
