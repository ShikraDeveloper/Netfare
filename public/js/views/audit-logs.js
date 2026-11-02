import { api } from '../api.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import {
  bindDateRange,
  dateRangeHtml,
  emptyState,
  esc,
  fmtMoney,
  icon,
  inDateRange,
  setHeader,
} from '../ui.js';

const ENTITY_LABELS = {
  invoice: 'Invoice',
  payment: 'Invoice payment',
  bill: 'Bill',
  bill_payment: 'Bill payment',
  credit_note: 'Credit note',
  credit_application: 'Credit application',
  supplier_credit: 'Supplier credit',
  supplier_credit_application: 'Supplier credit application',
  refund: 'Refund',
  cash_deposit: 'Cash deposit',
  customer_advance: 'Customer advance',
  journal_entry: 'Journal entry',
  portal_topup: 'Portal top-up',
  portal_refund: 'Portal withdrawal',
  portal_credit: 'Portal credit',
  cheque: 'Cheque',
  bank_reconciliation: 'Bank reconciliation',
  opening_balance: 'Opening balance',
  cancellation: 'Cancellation',
  booking: 'Booking',
  visa: 'Visa application',
  visa_deposit: 'Visa security deposit',
  user: 'User login',
};

const ACTION_LABELS = {
  void: 'Void',
  cancel: 'Cancellation',
  delete: 'Delete',
  create: 'Created',
  forfeit: 'Forfeit',
  enable: 'Enabled',
  disable: 'Disabled',
  password_reset: 'Password reset',
};

function entityLabel(value) {
  return ENTITY_LABELS[value] || value || '—';
}

function actionBadge(action) {
  const key = String(action || '').toLowerCase();
  const label = ACTION_LABELS[key] || key || '—';
  if (key === 'void') return `<span class="badge badge-rejected">${esc(label)}</span>`;
  return `<span class="badge badge-draft">${esc(label)}</span>`;
}

function fmtDateTime(value) {
  if (!value) return '—';
  const parsed = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return esc(value);
  return parsed.toLocaleString('en-AE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function auditRow(row) {
  let metadata = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }
  return `
    <tr>
      <td class="nowrap">
        <div class="cell-main">${fmtDateTime(row.created_at)}</div>
        <div class="cell-sub">#${row.id}${row.user_name ? ` · ${esc(row.user_name)}` : ''}</div>
      </td>
      <td>
        <div class="cell-main">${esc(entityLabel(row.entity_type))}</div>
        <div class="cell-sub">${esc(row.entity_number || (row.entity_id ? `#${row.entity_id}` : '—'))}</div>
      </td>
      <td>${actionBadge(row.action)}</td>
      <td>
        <div class="cell-main">${esc(row.remarks || 'No remarks')}</div>
        ${metadata.void_entry_id ? `<div class="cell-sub">Reversal entry #${esc(metadata.void_entry_id)}</div>` : ''}
      </td>
      <td class="num">${row.amount_cents == null ? '—' : fmtMoney(row.amount_cents)}</td>
    </tr>
  `;
}

export async function render(container) {
  const response = await api.get('/audit-logs', { limit: 2000 });
  const entries = response.rows || [];

  setHeader({
    title: 'Audit log',
    subtitle: `${response.total ?? entries.length} recorded action${(response.total ?? entries.length) === 1 ? '' : 's'} · Void, cancel and delete history`,
  });

  if (!entries.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
    iconName: 'file',
    title: 'No audit entries yet',
    message: 'Voiding or cancelling a document records what happened, when it happened and the mandatory remarks here.',
  })}
      </div>
    `;
    return;
  }

  const entityTypes = [...new Set(entries.map((row) => row.entity_type))].sort();
  const actions = [...new Set(entries.map((row) => row.action))].sort();

  container.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="audit-search" type="search" placeholder="Search documents or remarks…" aria-label="Search audit log" autocomplete="off">
      </div>
      <select class="input" id="audit-action" aria-label="Filter audit log by action" style="max-width:170px">
        <option value="all">All actions</option>
        ${actions.map((action) => `<option value="${esc(action)}">${esc(ACTION_LABELS[action] || action)}</option>`).join('')}
      </select>
      <select class="input" id="audit-entity" aria-label="Filter audit log by document type" style="max-width:210px">
        <option value="all">All document types</option>
        ${entityTypes.map((type) => `<option value="${esc(type)}">${esc(entityLabel(type))}</option>`).join('')}
      </select>
      ${dateRangeHtml({ label: 'Logged' })}
      <div class="spacer"></div>
      <span class="muted" id="audit-count" style="font-size:12px"></span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Audit log</caption>
          <thead>
            <tr>
              <th scope="col">Logged</th>
              <th scope="col">Document</th>
              <th scope="col">Action</th>
              <th scope="col">Remarks</th>
              <th scope="col" class="num">Amount</th>
            </tr>
          </thead>
          <tbody id="audit-body"></tbody>
        </table>
      </div>
      <div id="audit-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#audit-search');
  const actionSelect = container.querySelector('#audit-action');
  const entitySelect = container.querySelector('#audit-entity');
  const body = container.querySelector('#audit-body');
  const countEl = container.querySelector('#audit-count');
  const paginationEl = container.querySelector('#audit-pagination');
  const dateRange = bindDateRange(container, () => applyFilters());
  let page = 1;
  let pageSize = DEFAULT_PAGE_SIZE;
  let filtered = [];

  function renderPage() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    body.innerHTML = rows.length
      ? rows.map(auditRow).join('')
      : `<tr><td colspan="5">${emptyState({
        iconName: 'search',
        title: 'No matching audit entries',
        message: 'Try a different search term, action, document type or date range.',
      })}</td></tr>`;
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
    const action = actionSelect.value;
    const entity = entitySelect.value;
    const { from, to } = dateRange.values();
    filtered = entries.filter((row) => {
      const loggedDate = String(row.created_at || '').slice(0, 10);
      if (!inDateRange(loggedDate, from, to)) return false;
      if (action !== 'all' && row.action !== action) return false;
      if (entity !== 'all' && row.entity_type !== entity) return false;
      if (!term) return true;
      return [
        row.entity_type,
        entityLabel(row.entity_type),
        row.entity_number,
        row.action,
        ACTION_LABELS[row.action],
        row.remarks,
        row.user_name,
      ].some((value) => String(value || '').toLowerCase().includes(term));
    });
    countEl.textContent = `${filtered.length} matching`;
    const subtitleEl = document.getElementById('page-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = `${filtered.length} audited action${filtered.length === 1 ? '' : 's'} · All voids, cancellations and deletes`;
    }
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  actionSelect.addEventListener('change', applyFilters);
  entitySelect.addEventListener('change', applyFilters);
  applyFilters();
}
