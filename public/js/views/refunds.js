import { api } from '../api.js';
import {
  avatar,
  bindDateRange,
  dateRangeHtml,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  inDateRange,
  setHeader,
  statusBadge,
} from '../ui.js';
import { openRefundModal } from './refund-modal.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';

function typeBadge(type) {
  const label = type === 'customer' ? 'Customer' : 'Supplier';
  return `<span class="badge badge-${esc(type)}">${esc(label)}</span>`;
}

const REFUND_SOURCE_LABELS = {
  invoice: 'Invoice payment',
  bill: 'Bill payment',
  cancellation: 'Cancellation',
  advance: 'Customer advance',
  credit: 'Customer credit',
  supplier_credit: 'Supplier credit',
};

function sourceBadge(refund) {
  const type = refund.source_type || 'invoice';
  const label = REFUND_SOURCE_LABELS[type] || 'Payment';
  return `<span class="source source-${esc(type)}">${esc(label)}</span>`;
}

function sourceHref(refund) {
  if (!refund.document_id) return null;
  switch (refund.source_type) {
    case 'cancellation':
      return `#/cancellations/${refund.document_id}`;
    case 'supplier_credit':
      return `#/supplier-credits/${refund.document_id}`;
    case 'credit':
      return `#/credits/${refund.document_id}`;
    case 'invoice':
      return `#/invoices/${refund.document_id}`;
    case 'bill':
      return `#/bills/${refund.document_id}`;
    default:
      return null;
  }
}

function refundRow(refund) {
  const href = sourceHref(refund);
  const documentNumber = refund.document_number
    ? (href
      ? `<a href="${href}" data-source-link>${esc(refund.document_number)}</a>`
      : esc(refund.document_number))
    : '—';
  return `
    <tr class="clickable" data-id="${refund.id}" tabindex="0">
      <td>
        <div class="cell-main nowrap">${esc(refund.number)}</div>
        <div class="cell-sub">${esc(fmtDate(refund.refund_date))}</div>
        <div style="margin-top:4px">${typeBadge(refund.refund_type)}</div>
      </td>
      <td>
        <div class="party-cell">
          ${avatar(refund.party_name, 32)}
          <div class="party-info">
            <div class="cell-main">${esc(refund.party_name)}</div>
            <div class="cell-sub">${esc(refund.party_email || '')}</div>
          </div>
        </div>
      </td>
      <td>
        <div style="margin-bottom:4px">${sourceBadge(refund)}</div>
        <div class="cell-main nowrap">${documentNumber}</div>
        <div class="cell-sub nowrap">${esc(refund.payment_number || '')}</div>
      </td>
      <td class="num">
        <div>${fmtMoney(refund.amount_cents)}</div>
        <div class="cell-sub">${esc(refund.account_name || '—')} · ${esc(refund.method || '')}</div>
      </td>
      <td>${statusBadge(refund.status)}</td>
      <td class="chev">${icon('chevron', 16)}</td>
    </tr>
  `;
}

export async function render(container) {
  const refunds = await api.get('/refunds');
  const paid = refunds.filter((refund) => refund.status === 'paid');
  const refundedTotal = paid.reduce((sum, refund) => sum + refund.amount_cents, 0);

  setHeader({
    title: 'Customer & supplier refunds',
    actions: `<button class="btn btn-primary" data-action="new-refund">${icon('plus', 16)}<span>New refund</span></button>`,
  });

  function bindNewRefund() {
    document.querySelectorAll('[data-action="new-refund"]').forEach((button) => {
      button.addEventListener('click', () => {
        openRefundModal({
          allowTypeChange: true,
          onSaved: (refund) => { location.hash = `#/refunds/${refund.id}`; },
        });
      });
    });
  }

  if (!refunds.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
          iconName: 'arrowUp',
          title: 'No refunds yet',
          action: '<button class="btn btn-primary" data-action="new-refund">Record your first refund</button>',
        })}
      </div>
    `;
    bindNewRefund();
    return;
  }

  container.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="refund-search" type="search" placeholder="Search refunds…" aria-label="Search refunds" autocomplete="off">
      </div>
      <select class="input" id="refund-type-filter" aria-label="Filter refunds by type" style="max-width:180px">
        <option value="all">All types</option>
        <option value="customer">Customer refunds</option>
        <option value="supplier">Supplier refunds</option>
      </select>
      <select class="input" id="refund-status-filter" aria-label="Filter refunds by status" style="max-width:160px">
        <option value="all">All statuses</option>
        <option value="paid">Paid</option>
        <option value="void">Void</option>
      </select>
      ${dateRangeHtml({ label: 'Refund date' })}
      <div class="spacer"></div>
      <span class="muted" id="refund-count" style="font-size:12px"></span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Refunds</caption>
          <thead>
            <tr>
              <th scope="col">Refund</th>
              <th scope="col">Party</th>
              <th scope="col">Source</th>
              <th scope="col" class="num">Amount</th>
              <th scope="col">Status</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="refund-body"></tbody>
        </table>
      </div>
      <div id="refund-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#refund-search');
  const typeSelect = container.querySelector('#refund-type-filter');
  const statusSelect = container.querySelector('#refund-status-filter');
  const body = container.querySelector('#refund-body');
  const countEl = container.querySelector('#refund-count');
  const paginationEl = container.querySelector('#refund-pagination');
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
        iconName: 'search',
        title: 'No matching refunds',
      })}</td></tr>`;
    } else {
      body.innerHTML = rows.map(refundRow).join('');
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
    const type = typeSelect.value;
    const status = statusSelect.value;
    const { from, to } = dateRange.values();
    filtered = refunds.filter((refund) => {
      if (!inDateRange(refund.refund_date, from, to)) return false;
      if (type !== 'all' && refund.refund_type !== type) return false;
      if (status !== 'all' && refund.status !== status) return false;
      if (!term) return true;
      return [
        refund.number,
        refund.party_name,
        refund.party_email,
        refund.document_number,
        refund.payment_number,
        refund.reference,
        refund.notes,
      ].some((value) => String(value || '').toLowerCase().includes(term));
    });

    countEl.textContent = `${filtered.length} matching`;
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  typeSelect.addEventListener('change', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  body.addEventListener('click', (event) => {
    if (event.target.closest('[data-source-link]')) return;
    const row = event.target.closest('tr[data-id]');
    if (row) location.hash = `#/refunds/${row.dataset.id}`;
  });
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.matches('tr[data-id]')) return;
    location.hash = `#/refunds/${event.target.dataset.id}`;
  });

  bindNewRefund();
  applyFilters();
}
