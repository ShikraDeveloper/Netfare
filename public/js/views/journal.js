import { api } from '../api.js';
import { store } from '../store.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
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
  openModal,
  optionsHtml,
  setHeader,
  sourceBadge,
  sourceLabel,
  statusBadge,
  todayISO,
  toast,
  toCents,
} from '../ui.js';

function entryRow(entry) {
  return `
    <tr class="clickable" data-id="${entry.id}" tabindex="0">
      <td class="nowrap">${esc(fmtDate(entry.entry_date))}</td>
      <td>
        <div class="cell-main">${esc(entry.memo || '(no memo)')}</div>
        <div class="cell-sub">Entry #${entry.id}${entry.reference ? ` · ${esc(entry.reference)}` : ''}</div>
      </td>
      <td>${sourceBadge(entry.source_type)}</td>
      <td class="num">${entry.line_count}</td>
      <td class="num">${fmtMoney(entry.total_cents)}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-view="${entry.id}" title="View entry">${icon('chevron', 16)}</button>
          ${entry.source_type === 'manual' ? `<button class="icon-btn danger" data-delete="${entry.id}" title="Delete manual entry">${icon('trash', 16)}</button>` : ''}
        </div>
      </td>
    </tr>
  `;
}

function journalLineRow(accounts, line = {}) {
  return `
    <div class="line-row j-row" data-j-line style="grid-template-columns:2.1fr 1.7fr 1fr 1fr 30px">
      <select class="input j-account" aria-label="Account">
        ${optionsHtml(accounts, {
    selected: line.account_id,
    placeholder: 'Choose account…',
    labelKey: (account) => `${account.code} · ${account.name}`,
  })}
      </select>
      <input class="input j-desc" placeholder="Description" value="${esc(line.description || '')}">
      <input class="input j-debit" type="number" min="0" step="0.01" placeholder="0.00" value="${line.debit_cents ? (line.debit_cents / 100).toFixed(2) : ''}" aria-label="Debit">
      <input class="input j-credit" type="number" min="0" step="0.01" placeholder="0.00" value="${line.credit_cents ? (line.credit_cents / 100).toFixed(2) : ''}" aria-label="Credit">
      <button type="button" class="icon-btn danger j-remove" title="Remove line">${icon('x', 16)}</button>
    </div>
  `;
}

function mountJournalLines(root, accounts) {
  const list = root.querySelector('[data-journal-lines]');
  const status = root.querySelector('#journal-status');
  const rows = () => Array.from(list.querySelectorAll('[data-j-line]'));

  function updateRemove() {
    rows().forEach((row) => {
      const button = row.querySelector('.j-remove');
      if (button) button.disabled = rows().length <= 2;
      if (button) button.style.opacity = rows().length <= 2 ? '0.35' : '';
    });
  }

  function recalc() {
    let debits = 0;
    let credits = 0;
    for (const row of rows()) {
      debits += toCents(row.querySelector('.j-debit').value);
      credits += toCents(row.querySelector('.j-credit').value);
    }
    if (!debits && !credits) {
      status.textContent = 'Enter debits and credits for at least two lines.';
      status.style.color = 'var(--muted-2)';
    } else if (debits === credits) {
      status.textContent = `Balanced · ${fmtMoney(debits)}`;
      status.style.color = 'var(--green)';
    } else {
      status.textContent = `Out of balance by ${fmtMoney(Math.abs(debits - credits))} · Dr ${fmtMoney(debits)} / Cr ${fmtMoney(credits)}`;
      status.style.color = 'var(--red)';
    }
    updateRemove();
  }

  list.addEventListener('input', (event) => {
    const row = event.target.closest('[data-j-line]');
    if (!row) return;
    if (event.target.classList.contains('j-debit') && event.target.value) {
      row.querySelector('.j-credit').value = '';
    }
    if (event.target.classList.contains('j-credit') && event.target.value) {
      row.querySelector('.j-debit').value = '';
    }
    recalc();
  });

  list.addEventListener('click', (event) => {
    const remove = event.target.closest('.j-remove');
    if (!remove || remove.disabled) return;
    if (rows().length <= 2) return;
    remove.closest('[data-j-line]').remove();
    recalc();
  });

  const addButton = root.querySelector('[data-add-j-line]');
  if (addButton) {
    addButton.addEventListener('click', () => {
      const holder = document.createElement('div');
      holder.innerHTML = journalLineRow(accounts);
      const row = holder.firstElementChild;
      list.appendChild(row);
      recalc();
      const select = row.querySelector('.j-account');
      if (select) select.focus();
    });
  }

  recalc();

  return {
    getLines() {
      return rows()
        .map((row) => ({
          account_id: Number(row.querySelector('.j-account').value),
          description: row.querySelector('.j-desc').value.trim(),
          debit_cents: toCents(row.querySelector('.j-debit').value),
          credit_cents: toCents(row.querySelector('.j-credit').value),
        }))
        .filter((line) => line.debit_cents || line.credit_cents || line.account_id);
    },
  };
}

function openNewEntryModal(onSaved) {
  const accounts = store.accounts.filter((account) => account.is_active);
  if (accounts.length < 2) {
    toast('Add at least two active accounts before making a journal entry.', 'error');
    return;
  }

  openModal({
    title: 'New journal entry',
    subtitle: 'Post a balanced entry directly to your general ledger.',
    size: 'modal-xl',
    body: `
      <div class="form-grid">
        <div class="field">
          <label for="entry-date">Date</label>
          <input class="input" id="entry-date" name="entry_date" type="date" value="${todayISO()}" required>
        </div>
        <div class="field">
          <label for="entry-reference">Reference</label>
          <input class="input" id="entry-reference" name="reference" placeholder="Optional reference" autocomplete="off">
        </div>
        <div class="field full">
          <label for="entry-memo">Memo</label>
          <input class="input" id="entry-memo" name="memo" placeholder="What is this entry for?" required>
        </div>
        <div class="field full" style="margin-top:2px">
          <label>Lines</label>
          <div class="line-items-wrap">
            <div class="line-items" style="min-width:700px">
              <div class="line-head" style="grid-template-columns:2.1fr 1.7fr 1fr 1fr 30px">
                <div>Account</div>
                <div>Description</div>
                <div style="text-align:right">Debit</div>
                <div style="text-align:right">Credit</div>
                <div></div>
              </div>
              <div data-journal-lines>
                ${journalLineRow(accounts)}
                ${journalLineRow(accounts)}
              </div>
            </div>
            <div class="line-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-add-j-line>${icon('plus', 15)} Add line</button>
              <span id="journal-status" class="line-total-live" style="margin-left:auto"></span>
            </div>
          </div>
        </div>
      </div>
    `,
    submitLabel: 'Post entry',
    onMount(overlay) {
      overlay.querySelector('form').journalEditor = mountJournalLines(overlay, accounts);
    },
    async onSubmit(form) {
      const values = new FormData(form);
      const editor = form.journalEditor;
      const lines = editor ? editor.getLines() : [];
      const debits = lines.reduce((sum, line) => sum + line.debit_cents, 0);
      const credits = lines.reduce((sum, line) => sum + line.credit_cents, 0);
      if (lines.length < 2) throw new Error('A journal entry needs at least two lines');
      if (debits !== credits) throw new Error('Debits and credits must match before posting');
      if (debits === 0) throw new Error('Entry total must be greater than zero');
      if (lines.some((line) => !line.account_id)) throw new Error('Every line needs an account');
      await api.post('/journal-entries', {
        entry_date: values.get('entry_date'),
        memo: values.get('memo'),
        reference: values.get('reference'),
        lines,
      });
      toast('Journal entry posted');
      onSaved();
    },
  });
}

async function openEntryDetail(id) {
  const entry = await api.get(`/journal-entries/${id}`);
  openModal({
    title: entry.memo || `Journal entry #${entry.id}`,
    subtitle: `${fmtDate(entry.entry_date)} · ${sourceLabel(entry.source_type)}${entry.reference ? ` · ${entry.reference}` : ''}`,
    size: 'modal-lg',
    hideFooter: true,
    footer: `<div class="modal-foot"><button type="button" class="btn btn-secondary" data-close>Close</button></div>`,
    body: `
      <div class="table-wrap">
        <table class="report-table"><caption class="sr-only">Journal entry lines</caption>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Description</th>
              <th scope="col" class="num">Debit</th>
              <th scope="col" class="num">Credit</th>
            </tr>
          </thead>
          <tbody>
            ${entry.lines.map((line) => `
              <tr>
                <td><span class="code">${esc(line.account_code)}</span>${esc(line.account_name)}</td>
                <td class="muted">${esc(line.description || '—')}</td>
                <td class="num">${line.debit_cents ? fmtMoney(line.debit_cents) : ''}</td>
                <td class="num">${line.credit_cents ? fmtMoney(line.credit_cents) : ''}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2">Total</td>
              <td class="num">${fmtMoney(entry.total_cents)}</td>
              <td class="num">${fmtMoney(entry.total_cents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;align-items:center">
        ${sourceBadge(entry.source_type)}
        <span class="muted" style="font-size:12px">Posted ${esc(fmtDate(entry.entry_date))}</span>
      </div>
    `,
  });
}

export async function render(container, { query } = {}) {
  const entries = await api.get('/journal-entries');
  setHeader({
    title: 'General journal',
    subtitle: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · Every document posts here`,
    actions: `<button class="btn btn-primary" data-action="new-entry">${icon('plus', 16)}<span>New journal entry</span></button>`,
  });

  container.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="journal-search" type="search" placeholder="Search memo or reference…" autocomplete="off">
      </div>
      ${dateRangeHtml({ label: 'Entry date' })}
      <div class="spacer"></div>
      <span class="muted" id="journal-count" style="font-size:12px"></span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Journal entries</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Memo</th>
              <th scope="col">Source</th>
              <th scope="col" class="num">Lines</th>
              <th scope="col" class="num">Amount</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="journal-body"></tbody>
        </table>
      </div>
      <div id="journal-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#journal-search');
  const body = container.querySelector('#journal-body');
  const countEl = container.querySelector('#journal-count');
  const paginationEl = container.querySelector('#journal-pagination');
  const dateRange = bindDateRange(container, () => applyFilters());
  let page = 1;
  let pageSize = DEFAULT_PAGE_SIZE;
  let filtered = [];

  function renderPage() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6">${emptyState({
        iconName: 'journal',
        title: entries.length ? 'No matching entries' : 'No journal entries yet',
        message: entries.length ? 'Try a different search term or date range.' : 'Invoices, bills, payments and manual adjustments all appear here.',
      })}</td></tr>`;
    } else {
      body.innerHTML = rows.map(entryRow).join('');
    }
    paginationEl.innerHTML = paginationHtml({ total: filtered.length, page, pageSize });
    bindPagination(paginationEl.querySelector('[data-pagination]'), ({ page: nextPage, pageSize: nextSize }) => {
      page = nextPage;
      pageSize = nextSize;
      renderPage();
    });
  }

  function applyFilters() {
    page = 1;
    const term = searchInput.value.trim().toLowerCase();
    const { from, to } = dateRange.values();
    filtered = entries.filter((entry) => {
      if (!inDateRange(entry.entry_date, from, to)) return false;
      if (!term) return true;
      return [entry.memo, entry.reference, entry.source_type, entry.entry_date]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    countEl.textContent = `${filtered.length} matching`;
    const subtitleEl = document.getElementById('page-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = `${filtered.length} entr${filtered.length === 1 ? 'y' : 'ies'} · Every document posts here`;
    }
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);

  function refresh() {
    return render(container, { query: new URLSearchParams() });
  }

  document.querySelectorAll('[data-action="new-entry"]').forEach((button) => {
    button.addEventListener('click', () => openNewEntryModal(refresh));
  });

  document.querySelectorAll('[data-action="new-entry-empty"]').forEach((button) => {
    button.addEventListener('click', () => openNewEntryModal(refresh));
  });

  body.addEventListener('click', async (event) => {
    const deleteButton = event.target.closest('[data-delete]');
    if (deleteButton) {
      event.stopPropagation();
      const entry = entries.find((item) => item.id === Number(deleteButton.dataset.delete));
      const confirmed = await confirmDialog({
        title: 'Delete this journal entry?',
        message: `Entry #${entry.id} (“${entry.memo}”) will be permanently deleted. Document-linked entries cannot be deleted here.`,
        confirmLabel: 'Delete entry',
      });
      if (!confirmed) return;
      try {
        await api.del(`/journal-entries/${entry.id}`);
        toast('Journal entry deleted');
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) {
      try {
        await openEntryDetail(Number(viewButton.dataset.view));
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const row = event.target.closest('tr[data-id]');
    if (row) {
      try {
        await openEntryDetail(Number(row.dataset.id));
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  });
  body.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || !event.target.matches('tr[data-id]')) return;
    try {
      await openEntryDetail(Number(event.target.dataset.id));
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  applyFilters();

  if (query.get('new')) {
    history.replaceState(null, '', '#/journal');
    setTimeout(() => openNewEntryModal(refresh), 40);
  }

  const focus = query.get('focus');
  if (focus) {
    history.replaceState(null, '', '#/journal');
    setTimeout(() => {
      openEntryDetail(Number(focus)).catch((error) => toast(error.message, 'error'));
    }, 60);
  }

  return () => {};
}
