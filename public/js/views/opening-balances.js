import { api } from '../api.js';
import {
  centsToInput,
  esc,
  fmtMoney,
  icon,
  setHeader,
  toCents,
  toast,
  todayISO,
  voidDialog,
} from '../ui.js';

const TYPE_LABELS = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
};

function accountRows(accounts) {
  const groups = ['asset', 'liability', 'equity'];
  return groups.map((type) => {
    const rows = accounts.filter((account) => account.type === type);
    if (!rows.length) return '';
    return `
      <tr class="group-row"><td colspan="4">${esc(TYPE_LABELS[type])}</td></tr>
      ${rows.map((account) => `
        <tr>
          <td>
            <div class="cell-main">${esc(account.name)}</div>
            <div class="cell-sub">${esc(account.code)}${account.subtype ? ` · ${esc(account.subtype.replaceAll('_', ' '))}` : ''}</div>
          </td>
          <td class="num">
            <input class="input balance-input" type="number" min="0" step="0.01" inputmode="decimal"
              data-account-id="${account.id}" data-side="debit"
              value="${account.debit_cents ? centsToInput(account.debit_cents) : ''}"
              placeholder="0.00" aria-label="${esc(account.name)} opening debit">
          </td>
          <td class="num">
            <input class="input balance-input" type="number" min="0" step="0.01" inputmode="decimal"
              data-account-id="${account.id}" data-side="credit"
              value="${account.credit_cents ? centsToInput(account.credit_cents) : ''}"
              placeholder="0.00" aria-label="${esc(account.name)} opening credit">
          </td>
          <td class="num muted">${esc(account.normal_balance)}</td>
        </tr>
      `).join('')}
    `;
  }).join('');
}

export async function render(container) {
  const data = await api.get('/opening-balances');
  const openingDate = data.entry_date || todayISO();

  setHeader({
    title: 'Opening balances',
    subtitle: data.entry_id
      ? `Saved on ${esc(data.entry_date)} · journal entry #${data.entry_id}`
      : 'Enter the balances you want to carry into Ledgerly',
    actions: `
      ${data.entry_id ? `<button class="btn btn-ghost" data-action="clear-opening">${icon('trash', 15)}<span>Clear</span></button>` : ''}
      <button class="btn btn-primary" data-action="save-opening">${icon('check', 15)}<span>Save opening balances</span></button>
    `,
  });

  container.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="card-title"><h2>Starting position</h2><p>One balanced journal entry dated before your first live transaction.</p></div>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <div class="field">
            <label for="opening-date">Opening date</label>
            <input class="input" id="opening-date" type="date" value="${esc(openingDate)}" required>
            <div class="hint">Use the day before you started using Ledgerly for live transactions.</div>
          </div>
          <div class="field">
            <label>Balancing account</label>
            <div class="readonly-box">
              <strong>${esc(data.equity_account?.code || '3900')} ${esc(data.equity_account?.name || 'Opening Balance Equity')}</strong>
              <span>The difference between debits and credits posts here automatically.</span>
            </div>
          </div>
        </div>
        <div class="callout" style="margin-top:18px">
          ${icon('check', 18)}
          <div class="callout-text"><h3>One clean opening entry</h3><p>Enter account debits and credits only. Later business postings continue automatically.</p></div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div class="card-title"><h2>Balance sheet accounts</h2><p>Enter each account once as either a debit or a credit.</p></div>
      </div>
      <div class="table-wrap">
        <table class="data opening-table"><caption class="sr-only">Opening balances</caption>
          <thead>
            <tr><th scope="col">Account</th><th scope="col" class="num">Debit</th><th scope="col" class="num">Credit</th><th scope="col" class="num">Normal</th></tr>
          </thead>
          <tbody>${accountRows(data.accounts)}</tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-body opening-summary" id="opening-summary">
        ${summaryHtml(data.total_debit_cents, data.total_credit_cents, data.equity_account)}
      </div>
    </div>
  `;

  const summary = container.querySelector('#opening-summary');
  const inputs = [...container.querySelectorAll('[data-account-id]')];
  const dateInput = container.querySelector('#opening-date');

  function recalc() {
    const totals = new Map();
    for (const input of inputs) {
      const id = Number(input.dataset.accountId);
      const current = totals.get(id) || { debit: 0, credit: 0 };
      current[input.dataset.side] = Math.max(0, toCents(input.value));
      totals.set(id, current);
    }
    const debit = [...totals.values()].reduce((sum, row) => sum + row.debit, 0);
    const credit = [...totals.values()].reduce((sum, row) => sum + row.credit, 0);
    summary.innerHTML = summaryHtml(debit, credit, data.equity_account);
  }

  inputs.forEach((input) => input.addEventListener('input', recalc));

  document.querySelector('[data-action="save-opening"]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const balances = [];
    const grouped = new Map();
    for (const input of inputs) {
      const id = Number(input.dataset.accountId);
      const row = grouped.get(id) || { account_id: id, debit_cents: 0, credit_cents: 0 };
      row[input.dataset.side === 'debit' ? 'debit_cents' : 'credit_cents'] = Math.max(0, toCents(input.value));
      grouped.set(id, row);
    }
    for (const row of grouped.values()) {
      if (row.debit_cents || row.credit_cents) balances.push(row);
    }
    if (!dateInput.value) {
      toast('Choose an opening date', 'error');
      return;
    }
    button.disabled = true;
    try {
      const saved = await api.post('/opening-balances', { entry_date: dateInput.value, balances });
      toast(balances.length ? 'Opening balances saved' : 'Opening balances cleared');
      await render(container);
      return saved;
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  const clearButton = document.querySelector('[data-action="clear-opening"]');
  if (clearButton) {
    clearButton.addEventListener('click', async () => {
      const result = await voidDialog({
        title: 'Void opening balances?',
        message: 'A reversing entry will be posted for the opening-balance journal entry. Live transactions are not affected.',
        warning: 'This cannot be undone. The original entry and reversal stay in the audit trail.',
        confirmLabel: 'Void balances',
      });
      if (!result.confirmed) return;
      try {
        await api.post('/opening-balances/void', { remarks: result.remarks });
        toast('Opening balances voided with a reversing entry');
        await render(container);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }
}

function summaryHtml(debit, credit, equityAccount) {
  const difference = debit - credit;
  const equityDebit = difference < 0 ? Math.abs(difference) : 0;
  const equityCredit = difference > 0 ? difference : 0;
  return `
    <div class="opening-summary-grid">
      <div><span class="muted">Total debits</span><strong>${fmtMoney(debit)}</strong></div>
      <div><span class="muted">Total credits</span><strong>${fmtMoney(credit)}</strong></div>
      <div><span class="muted">${esc(equityAccount?.name || 'Opening Balance Equity')}</span><strong>${difference === 0 ? fmtMoney(0) : `${equityDebit ? 'Dr' : 'Cr'} ${fmtMoney(equityDebit || equityCredit)}`}</strong></div>
    </div>
    <p class="hint" style="margin:0">${difference === 0 ? 'Debits and credits balance.' : `The ${fmtMoney(Math.abs(difference))} difference will post to ${esc(equityAccount?.code || '3900')} automatically.`}</p>
  `;
}
