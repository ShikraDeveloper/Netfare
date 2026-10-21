import { api } from '../api.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import {
  bindDateRange,
  dateRangeHtml,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  inDateRange,
  setHeader,
} from '../ui.js';

function cancellationRow(cancellation) {
  return `
    <tr class="clickable" data-id="${cancellation.id}" tabindex="0">
      <td>
        <div class="cell-main">${esc(cancellation.number)}</div>
        <div class="cell-sub">${esc(fmtDate(cancellation.cancellation_date))}</div>
      </td>
      <td>
        <div class="cell-main">${esc(cancellation.customer_name)}</div>
        <div class="cell-sub">${esc(cancellation.source_type === 'booking' ? 'Booking' : 'Visa')} ${esc(cancellation.source_number || '')}</div>
      </td>
      <td>${esc(cancellation.reason || '—')}</td>
      <td class="num">${fmtMoney(cancellation.customer_charges_cents)}</td>
      <td class="num">${fmtMoney(cancellation.received_cents)}</td>
      <td class="num">${fmtMoney(cancellation.supplier_credit_total_cents)}</td>
      <td class="num ${cancellation.refund_remaining_cents ? 'amount-due' : 'muted'}">${fmtMoney(cancellation.refund_remaining_cents)}</td>
      <td class="chev">${icon('chevron', 16)}</td>
    </tr>
  `;
}

export async function render(container) {
  const cancellations = await api.get('/cancellations');
  const refundRemaining = cancellations.reduce((sum, cancellation) => sum + cancellation.refund_remaining_cents, 0);
  const supplierCredits = cancellations.reduce((sum, cancellation) => sum + cancellation.supplier_credit_total_cents, 0);

  setHeader({
    title: 'Cancellations',
    subtitle: `${cancellations.length} cancellation${cancellations.length === 1 ? '' : 's'} · ${fmtMoney(refundRemaining)} refundable · ${fmtMoney(supplierCredits)} supplier credit`,
  });

  if (!cancellations.length) {
    container.innerHTML = `<div class="card">${emptyState({
      iconName: 'x',
      title: 'No cancellations yet',
      message: 'Cancel a booking or visa application to record cancellation charges, refunds and supplier credits without deleting receipts or supplier payments.',
    })}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="cancellation-search" type="search" placeholder="Search cancellations…" aria-label="Search cancellations" autocomplete="off">
      </div>
      <select class="input" id="cancellation-source" aria-label="Filter cancellations by source" style="max-width:170px">
        <option value="all">All sources</option>
        <option value="booking">Bookings</option>
        <option value="visa">Visa applications</option>
      </select>
      ${dateRangeHtml({ label: 'Cancellation date' })}
      <div class="spacer"></div>
      <span class="muted" id="cancellation-count" style="font-size:12px"></span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data"><caption class="sr-only">Cancellations</caption>
          <thead>
            <tr>
              <th scope="col">Cancellation</th>
              <th scope="col">Customer</th>
              <th scope="col">Reason</th>
              <th scope="col" class="num">Charges</th>
              <th scope="col" class="num">Held</th>
              <th scope="col" class="num">Supplier credit</th>
              <th scope="col" class="num">Refund left</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="cancellation-body"></tbody>
        </table>
      </div>
      <div id="cancellation-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#cancellation-search');
  const sourceSelect = container.querySelector('#cancellation-source');
  const body = container.querySelector('#cancellation-body');
  const countEl = container.querySelector('#cancellation-count');
  const paginationEl = container.querySelector('#cancellation-pagination');
  const dateRange = bindDateRange(container, () => applyFilters());
  let page = 1;
  let pageSize = DEFAULT_PAGE_SIZE;
  let filtered = [];

  function renderPage() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    body.innerHTML = rows.length ? rows.map(cancellationRow).join('') : `<tr><td colspan="8">${emptyState({
      iconName: 'search',
      title: 'No matching cancellations',
      message: 'Try another search, source or date range.',
    })}</td></tr>`;
    if (countEl) countEl.textContent = `${filtered.length} cancellation${filtered.length === 1 ? '' : 's'}`;
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
    const source = sourceSelect.value;
    const { from, to } = dateRange.values();
    filtered = cancellations.filter((cancellation) => {
      if (!inDateRange(cancellation.cancellation_date, from, to)) return false;
      if (source !== 'all' && cancellation.source_type !== source) return false;
      if (!term) return true;
      return [cancellation.number, cancellation.customer_name, cancellation.source_number, cancellation.reason, cancellation.notes]
        .filter(Boolean).join(' ').toLowerCase().includes(term);
    });
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  sourceSelect.addEventListener('change', applyFilters);
  applyFilters();

  body.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) location.hash = `#/cancellations/${row.dataset.id}`;
  });
}
