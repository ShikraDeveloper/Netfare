import { api } from '../api.js';
import {
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  openModal,
  setHeader,
  toCents,
  toast,
  todayISO,
  voidDialog,
} from '../ui.js';

export async function render(container, { query = new URLSearchParams() } = {}) {
  const accounts = (await api.get('/accounts')).filter((account) => account.is_cash && account.is_active);
  const selected = query.get('account') || '';
  const rows = await api.get('/bank-reconciliations', selected ? { account_id: selected } : {});
  const totalBalance = accounts.reduce((sum, account) => sum + (account.balance_cents || 0), 0);
  const last = rows[0] || null;

  setHeader({
    title: 'Bank reconciliation',
    subtitle: `${accounts.length} cash/bank account${accounts.length === 1 ? '' : 's'} · ${fmtMoney(totalBalance)} book balance`,
    actions: accounts.length
      ? `<button class="btn btn-primary" data-action="new-reconciliation">${icon('plus', 15)}<span>Reconcile</span></button>`
      : '',
  });

  if (!accounts.length) {
    container.innerHTML = `<div class="card">${emptyState({
      iconName: 'cash',
      title: 'No bank or cash accounts',
      message: 'Add an active cash or bank account in the chart of accounts before reconciling.',
      action: '<a class="btn btn-primary" href="#/accounts?new=1">Add account</a>',
    })}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="recon-kpis">
      <div class="recon-kpi"><span>Book balance</span><strong>${fmtMoney(totalBalance)}</strong><small>Across all cash/bank accounts</small></div>
      <div class="recon-kpi"><span>Last reconciliation</span><strong>${last ? esc(fmtDate(last.statement_date)) : 'Never'}</strong><small>${last ? `${esc(last.account_name)} · ${esc(last.status)}` : 'Start with your latest bank statement'}</small></div>
      <div class="recon-kpi"><span>Open differences</span><strong>${rows.filter((row) => row.status === 'difference').length}</strong><small>Reconciliations that still need attention</small></div>
    </div>

    <div class="toolbar">
      <label class="field-inline">
        <span>Account</span>
        <select class="input" id="recon-account-filter" style="min-width:200px">
          <option value="">All cash/bank accounts</option>
          ${accounts.map((account) => `<option value="${account.id}" ${String(account.id) === String(selected) ? 'selected' : ''}>${esc(account.code)} ${esc(account.name)}</option>`).join('')}
        </select>
      </label>
      <div class="spacer"></div>
      <span class="muted" style="font-size:12px">${rows.length} reconciliation${rows.length === 1 ? '' : 's'}</span>
    </div>

    <div class="card">
      ${rows.length ? `
        <div class="table-wrap">
          <table class="data"><caption class="sr-only">Reconciliation history</caption>
            <thead><tr><th scope="col">Statement date</th><th scope="col">Account</th><th scope="col" class="num">Statement balance</th><th scope="col" class="num">Cleared balance</th><th scope="col" class="num">Difference</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
            <tbody>
              ${rows.map((row) => `
                <tr>
                  <td class="nowrap">${esc(fmtDate(row.statement_date))}</td>
                  <td><div class="cell-main">${esc(row.account_name)}</div><div class="cell-sub">${esc(row.account_code)}</div></td>
                  <td class="num">${fmtMoney(row.statement_balance_cents)}</td>
                  <td class="num">${fmtMoney(row.cleared_balance_cents)}</td>
                  <td class="num ${row.difference_cents ? 'amount-due' : 'muted'}">${row.difference_cents ? fmtMoney(row.difference_cents) : '—'}</td>
                  <td><span class="badge badge-${row.status === 'reconciled' ? 'paid' : 'partial'}">${row.status === 'reconciled' ? 'Reconciled' : 'Difference'}</span></td>
                  <td><button class="icon-btn danger" data-delete-recon="${row.id}" title="Reopen">${icon('trash', 15)}</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : emptyState({
        iconName: 'check',
        title: 'No reconciliations yet',
        message: 'Match your bank statement to the ledger. Select the transactions that cleared and compare the closing balance.',
        action: '<button class="btn btn-primary" data-action="new-reconciliation">Start reconciliation</button>',
      })}
    </div>
  `;

  const filter = container.querySelector('#recon-account-filter');
  filter.addEventListener('change', () => {
    const value = filter.value;
    location.hash = value ? `#/bank-reconciliation?account=${value}` : '#/bank-reconciliation';
  });

  document.querySelectorAll('[data-action="new-reconciliation"]').forEach((button) => {
    button.addEventListener('click', () => openReconcileModal({ accounts, onSaved: () => render(container, { query }) }));
  });

  const historyCard = container.querySelector('.card');
  if (historyCard) historyCard.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-recon]');
    if (!button) return;
    const row = rows.find((item) => item.id === Number(button.dataset.deleteRecon));
    const result = await voidDialog({
      title: 'Void this reconciliation?',
      message: `${row.account_name} · ${fmtDate(row.statement_date)} will be reopened and its transactions released for reconciliation again.`,
      warning: 'This cannot be undone. The reconciliation record is removed, but the action is written to the audit log.',
      confirmLabel: 'Void reconciliation',
    });
    if (!result.confirmed) return;
    try {
      await api.post(`/bank-reconciliations/${row.id}/void`, { remarks: result.remarks });
      toast('Reconciliation voided and reopened');
      await render(container, { query });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function openReconcileModal({ accounts, onSaved }) {
  let workspace = null;
  openModal({
    title: 'Reconcile bank account',
    subtitle: 'Compare the statement closing balance with cleared ledger transactions.',
    size: 'modal-xl',
    submitLabel: 'Save reconciliation',
    body: `
      <div class="form-grid">
        <div class="field">
          <label for="recon-account">Account</label>
          <select class="input" id="recon-account" name="account_id" required>
            ${accounts.map((account) => `<option value="${account.id}">${esc(account.code)} ${esc(account.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="recon-date">Statement date</label>
          <input class="input" id="recon-date" name="statement_date" type="date" value="${todayISO()}" required>
        </div>
        <div class="field">
          <label for="recon-balance">Statement closing balance</label>
          <input class="input" id="recon-balance" name="statement_balance" type="number" step="0.01" inputmode="decimal" placeholder="0.00" required>
        </div>
        <div class="field">
          <label>&nbsp;</label>
          <button type="button" class="btn btn-secondary" data-load-workspace>${icon('search', 15)}${icon('refresh', 15)}<span>Load transactions</span></button>
        </div>
        <div class="field full">
          <label for="recon-notes">Notes</label>
          <input class="input" id="recon-notes" name="notes" placeholder="Optional note (bank charges, timing, etc.)">
        </div>
      </div>
      <div id="recon-workspace" class="recon-workspace">
        <div class="recon-placeholder">Choose an account and statement date, then load transactions.</div>
      </div>
    `,
    onMount(overlay) {
      const loadButton = overlay.querySelector('[data-load-workspace]');
      const accountSelect = overlay.querySelector('#recon-account');
      const dateInput = overlay.querySelector('#recon-date');
      const balanceInput = overlay.querySelector('#recon-balance');
      const workspaceEl = overlay.querySelector('#recon-workspace');

      async function load() {
        loadButton.disabled = true;
        try {
          workspace = await api.get('/bank-reconciliations/workspace', {
            account_id: accountSelect.value,
            statement_date: dateInput.value,
          });
          workspaceEl.innerHTML = workspaceHtml(workspace);
          wireWorkspace(workspaceEl, workspace, balanceInput);
        } catch (error) {
          workspace = null;
          workspaceEl.innerHTML = `<div class="recon-placeholder error-text">${esc(error.message)}</div>`;
          toast(error.message, 'error');
        } finally {
          loadButton.disabled = false;
        }
      }

      const reset = () => {
        workspace = null;
        workspaceEl.innerHTML = '<div class="recon-placeholder">Choose an account and statement date, then load transactions.</div>';
      };
      loadButton.addEventListener('click', load);
      accountSelect.addEventListener('change', reset);
      dateInput.addEventListener('change', reset);
      balanceInput.addEventListener('input', () => {
        if (workspace) updateDifference(workspaceEl, workspace, balanceInput);
      });
      overlay._loadReconciliation = load;
    },
    async onSubmit(form) {
      if (!workspace) throw new Error('Load the transactions for this statement first');
      const values = new FormData(form);
      if (values.get('statement_balance') === '') throw new Error('Enter the statement closing balance');
      const statement = toCents(values.get('statement_balance'));
      const lineIds = [...form.querySelectorAll('[data-line-select]:checked')].map((input) => Number(input.value));
      const saved = await api.post('/bank-reconciliations', {
        account_id: values.get('account_id'),
        statement_date: values.get('statement_date'),
        statement_balance_cents: statement,
        line_ids: lineIds,
        notes: values.get('notes'),
      });
      toast(saved.difference_cents ? `Saved with a ${fmtMoney(saved.difference_cents)} difference` : 'Bank account reconciled', saved.difference_cents ? 'error' : 'success');
      onSaved(saved);
    },
  });
}

function workspaceHtml(workspace) {
  return `
    <div class="recon-modal-cards">
      <div><span>Previously cleared</span><strong>${fmtMoney(workspace.cleared_before_cents)}</strong></div>
      <div><span>Book balance</span><strong>${fmtMoney(workspace.ledger_balance_cents)}</strong></div>
      <div><span>Selected</span><strong data-selected-total>${fmtMoney(0)}</strong></div>
      <div><span>Difference</span><strong data-recon-difference>${fmtMoney(0)}</strong></div>
    </div>
    <div class="table-wrap recon-lines">
      <table class="data"><caption class="sr-only">Bank transactions for reconciliation</caption>
        <thead><tr><th scope="col"><input type="checkbox" data-select-all aria-label="Select all transactions"></th><th scope="col">Date</th><th scope="col">Description</th><th scope="col">Reference</th><th scope="col" class="num">Debit</th><th scope="col" class="num">Credit</th></tr></thead>
        <tbody>
          ${workspace.lines.length ? workspace.lines.map((line) => `
            <tr>
              <td><input type="checkbox" data-line-select value="${line.id}" data-amount="${line.amount_cents}" aria-label="Clear ${esc(line.description || line.memo || line.reference)}"></td>
              <td class="nowrap">${esc(fmtDate(line.entry_date))}</td>
              <td><div class="cell-main">${esc(line.memo || line.description || 'Journal entry')}</div><div class="cell-sub">${esc(line.source_type)}</div></td>
              <td class="nowrap">${esc(line.reference || '—')}</td>
              <td class="num">${line.debit_cents ? fmtMoney(line.debit_cents) : '—'}</td>
              <td class="num">${line.credit_cents ? fmtMoney(line.credit_cents) : '—'}</td>
            </tr>
          `).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">No uncleared transactions through this date.</td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="hint" style="margin:10px 0 0">Only transactions that appear on the bank statement should be ticked. Use a journal entry for bank charges or other missing items.</p>
  `;
}

function wireWorkspace(root, workspace, balanceInput) {
  const update = () => updateDifference(root, workspace, balanceInput);
  root.querySelectorAll('[data-line-select]').forEach((input) => input.addEventListener('change', update));
  const selectAll = root.querySelector('[data-select-all]');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      root.querySelectorAll('[data-line-select]').forEach((input) => { input.checked = selectAll.checked; });
      update();
    });
  }
  update();
}

function updateDifference(root, workspace, balanceInput) {
  const selected = [...root.querySelectorAll('[data-line-select]:checked')]
    .reduce((sum, input) => sum + Number(input.dataset.amount || 0), 0);
  const cleared = workspace.cleared_before_cents + selected;
  const statement = toCents(balanceInput.value);
  const difference = statement - cleared;
  root.querySelector('[data-selected-total]').textContent = fmtMoney(selected);
  const diffEl = root.querySelector('[data-recon-difference]');
  diffEl.textContent = fmtMoney(difference);
  diffEl.classList.toggle('amount-due', difference !== 0);
  diffEl.classList.toggle('amount-ok', difference === 0);
}
