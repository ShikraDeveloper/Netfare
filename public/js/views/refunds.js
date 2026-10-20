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

function typeBadge(type) {
  const label = type === 'customer' ? 'Customer' : 'Supplier';
  return `<span class="badge badge-${esc(type)}">${esc(label)}</span>`;
}

function refundRow(refund) {
  return `
    <tr class="clickable" data-id="${refund.id}">
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
        <div class="cell-main nowrap">${esc(refund.document_number || '—')}</div>
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
    title: 'Refunds',
    subtitle: `${paid.length} paid refund${paid.length === 1 ? '' : 's'} · ${fmtMoney(refundedTotal)} refunded`,
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
          message: 'Refund a customer payment from an invoice, or record money returned by a supplier from a bill. Each refund posts its own journal entry and leaves the original payment intact.',
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
        <input class="input" id="refund-search" type="search" placeholder="Search refunds…" autocomplete="off">
      </div>
      <select class="input" id="refund-type-filter" style="max-width:180px">
        <option value="all">All types</option>
        <option value="customer">Customer refunds</option>
        <option value="supplier">Supplier refunds</option>
      </select>
      <select class="input" id="refund-status-filter" style="max-width:160px">
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
        <table class="data">
          <thead>
            <tr>
              <th>Refund</th>
              <th>Party</th>
              <th>Source</th>
              <th class="num">Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="refund-body"></tbody>
        </table>
      </div>
    </div>
  `;

  const searchInput = container.querySelector('#refund-search');
  const typeSelect = container.querySelector('#refund-type-filter');
  const statusSelect = container.querySelector('#refund-status-filter');
  const body = container.querySelector('#refund-body');
  const countEl = container.querySelector('#refund-count');
  const dateRange = bindDateRange(container, () => applyFilters());

  function applyFilters() {
    const term = searchInput.value.trim().toLowerCase();
    const type = typeSelect.value;
    const status = statusSelect.value;
    const { from, to } = dateRange.values();
    const filtered = refunds.filter((refund) => {
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

    const filteredPaid = filtered.filter((refund) => refund.status === 'paid');
    const filteredTotal = filteredPaid.reduce((sum, refund) => sum + refund.amount_cents, 0);
    countEl.textContent = `${filtered.length} shown`;
    const subtitleEl = document.getElementById('page-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = `${filteredPaid.length} paid refund${filteredPaid.length === 1 ? '' : 's'} · ${fmtMoney(filteredTotal)} refunded`;
    }
    if (!filtered.length) {
      body.innerHTML = `<tr><td colspan="6">${emptyState({
        iconName: 'search',
        title: 'No matching refunds',
        message: 'Try a different search term, type, status or date range.',
      })}</td></tr>`;
      return;
    }
    body.innerHTML = filtered.map(refundRow).join('');
  }

  searchInput.addEventListener('input', applyFilters);
  typeSelect.addEventListener('change', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  body.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) location.hash = `#/refunds/${row.dataset.id}`;
  });

  bindNewRefund();
  applyFilters();
}
