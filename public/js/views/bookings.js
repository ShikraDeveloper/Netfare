import { api } from '../api.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import {
  activeCustomers,
  activePortals,
  activeVendors,
  purchaseAccounts,
  portalForVendorId,
  revenueAccounts,
  store,
} from '../store.js';
import { mountPassengerEditor, passengerSectionHtml, rowsFromItems } from './booking-passengers.js';
import {
  addDaysISO,
  avatar,
  bindDateRange,
  centsToInput,
  currencySymbol,
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
  paymentBadge,
  statusBadge,
  todayISO,
  toast,
  toCents,
} from '../ui.js';

const STATUS_OPTIONS = ['draft', 'confirmed', 'travelled', 'cancelled'];

function bookingRow(booking) {
  const marginClass = booking.margin_cents >= 0 ? 'margin-positive' : 'margin-negative';
  return `
    <tr class="clickable" data-id="${booking.id}">
      <td>
        <div class="cell-main">${esc(booking.number)}</div>
        <div class="cell-sub">${esc(fmtDate(booking.booking_date))}${booking.pnr ? ` · ${esc(booking.pnr)}` : ''}</div>
      </td>
      <td>
        <div class="party-cell">
          ${avatar(booking.customer_name, 32)}
          <div class="party-info">
            <div class="cell-main">${esc(booking.customer_name)}</div>
            <div class="cell-sub">${esc(booking.destination || '—')}</div>
            ${booking.passenger_names ? `<div class="cell-sub">${esc(booking.passenger_names)}</div>` : ''}
          </div>
        </div>
      </td>
      <td class="nowrap">${booking.travel_date ? esc(fmtDate(booking.travel_date)) : '—'}</td>
      <td>${statusBadge(booking.status)}</td>
      <td data-payment-status>${paymentBadge(booking)}</td>
      <td class="num">${fmtMoney(booking.sale_total_cents)}</td>
      <td class="num">${fmtMoney(booking.cost_total_cents)}</td>
      <td class="num ${marginClass}">${fmtMoney(booking.margin_cents)}</td>
      <td class="right muted">${icon('chevron', 16)}</td>
    </tr>
  `;
}

export function saleRow(item = {}, defaults = {}) {
  return `
    <div class="bk-row" data-bk-line data-type="sale">
      <input class="input bk-desc" placeholder="What the customer is buying" value="${esc(item.description || '')}" autocomplete="off">
      <input class="input bk-qty" type="number" min="0.01" step="any" value="${esc(item.quantity ?? 1)}" aria-label="Quantity">
      <div class="money-input">
        <span>${esc(currencySymbol())}</span>
        <input class="input bk-price" type="number" min="0" step="0.01" value="${esc(centsToInput(item.unit_price_cents || 0))}" aria-label="Unit price">
      </div>
      <select class="input bk-account" aria-label="Revenue account">
        ${optionsHtml(revenueAccounts(), { selected: item.account_id ?? defaults.saleAccountId, placeholder: 'Revenue account…', labelKey: (a) => `${a.code} · ${a.name}` })}
      </select>
      <div class="bk-amount">${fmtMoney(0)}</div>
      <button type="button" class="icon-btn danger" data-remove title="Remove line">${icon('x', 16)}</button>
    </div>
  `;
}

function vendorLabel(vendor) {
  const portal = portalForVendorId(vendor.id);
  if (!portal) return vendor.name;
  return `${vendor.name} — ${portal.settlement === 'prepaid' ? 'wallet' : 'credit'}`;
}

export function costRow(item = {}, defaults = {}) {
  return `
    <div class="bk-row" data-bk-line data-type="cost">
      <input class="input bk-desc" placeholder="Supplier cost description" value="${esc(item.description || '')}" autocomplete="off">
      <input class="input bk-qty" type="number" min="0.01" step="any" value="${esc(item.quantity ?? 1)}" aria-label="Quantity">
      <div class="money-input">
        <span>${esc(currencySymbol())}</span>
        <input class="input bk-price" type="number" min="0" step="0.01" value="${esc(centsToInput(item.unit_price_cents || 0))}" aria-label="Unit cost">
      </div>
      <select class="input bk-account" aria-label="Cost account">
        ${optionsHtml(purchaseAccounts(), { selected: item.account_id ?? defaults.costAccountId, placeholder: 'Cost account…', labelKey: (a) => `${a.code} · ${a.name}` })}
      </select>
      <select class="input bk-vendor" aria-label="Supplier">
        ${optionsHtml(activeVendors(), { selected: item.vendor_id, placeholder: 'Supplier…', labelKey: vendorLabel })}
      </select>
      <input class="input bk-ref" placeholder="Supplier ref" value="${esc(item.supplier_ref || '')}" autocomplete="off">
      <div class="bk-amount">${fmtMoney(0)}</div>
      <button type="button" class="icon-btn danger" data-remove title="Remove line">${icon('x', 16)}</button>
    </div>
  `;
}

export function mountBookingLines(overlay, defaults = {}) {
  const saleWrap = overlay.querySelector('[data-bk-lines="sale"]');
  const costWrap = overlay.querySelector('[data-bk-lines="cost"]');

  function rows() {
    return Array.from(overlay.querySelectorAll('[data-bk-line]'));
  }

  function recalc() {
    let sale = 0;
    let cost = 0;
    for (const row of rows()) {
      const qty = Number.parseFloat(row.querySelector('.bk-qty').value) || 0;
      const price = toCents(row.querySelector('.bk-price').value);
      const amount = Math.round(qty * price);
      row.querySelector('.bk-amount').textContent = fmtMoney(amount);
      if (row.dataset.type === 'sale') sale += amount;
      else cost += amount;
    }
    const margin = sale - cost;
    const marginEl = overlay.querySelector('#bk-margin');
    marginEl.textContent = fmtMoney(margin);
    marginEl.className = margin >= 0 ? 'margin-positive' : 'margin-negative';
    overlay.querySelector('#bk-sale').textContent = fmtMoney(sale);
    overlay.querySelector('#bk-cost').textContent = fmtMoney(cost);
    overlay.querySelector('#bk-margin-percent').textContent = sale ? `${((margin / sale) * 100).toFixed(1)}% gross margin` : '—';
    return { sale, cost, margin };
  }

  function add(type, item = {}) {
    const holder = document.createElement('div');
    holder.innerHTML = type === 'sale' ? saleRow(item, defaults) : costRow(item, defaults);
    const row = holder.firstElementChild;
    (type === 'sale' ? saleWrap : costWrap).appendChild(row);
    recalc();
    updateRemoveButtons();
  }

  function updateRemoveButtons() {
    for (const type of ['sale', 'cost']) {
      const typed = rows().filter((row) => row.dataset.type === type);
      typed.forEach((row) => {
        const button = row.querySelector('[data-remove]');
        if (button) button.disabled = typed.length <= 1;
        if (button) button.style.opacity = typed.length <= 1 ? '0.35' : '';
      });
    }
  }

  overlay.addEventListener('input', recalc);
  overlay.addEventListener('change', recalc);
  overlay.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]');
    if (!remove || remove.disabled) return;
    const row = remove.closest('[data-bk-line]');
    const typed = rows().filter((item) => item.dataset.type === row.dataset.type);
    if (typed.length <= 1) return;
    row.remove();
    recalc();
    updateRemoveButtons();
  });

  overlay.querySelector('[data-add-sale]').addEventListener('click', () => add('sale'));
  overlay.querySelector('[data-add-cost]').addEventListener('click', () => add('cost'));

  function getItems() {
    const sale = [];
    const cost = [];
    for (const row of rows()) {
      const item = {
        description: row.querySelector('.bk-desc').value.trim(),
        quantity: Number.parseFloat(row.querySelector('.bk-qty').value) || 0,
        unit_price_cents: toCents(row.querySelector('.bk-price').value),
        account_id: Number(row.querySelector('.bk-account').value),
      };
      if (row.dataset.type === 'sale') {
        sale.push(item);
      } else {
        item.vendor_id = Number(row.querySelector('.bk-vendor').value);
        item.supplier_ref = row.querySelector('.bk-ref').value.trim();
        cost.push(item);
      }
    }
    return { sale, cost };
  }

  recalc();
  updateRemoveButtons();
  return { getItems, recalc, updateRemoveButtons };
}

export function openBookingModal({ booking = null, onSaved = () => {} } = {}) {
  const isEdit = Boolean(booking);
  const customers = activeCustomers();
  if (!customers.length) {
    toast('Add a customer before creating a booking.', 'error');
    location.hash = '#/customers?new=1';
    return;
  }

  const issueDate = booking?.booking_date || todayISO();
  // New bookings default to the company payment terms, like invoices.
  const dueDate = booking?.due_date || addDaysISO(issueDate, Number(store.settings?.payment_terms_days ?? 0));
  const travelDate = booking?.travel_date || '';
  const returnDate = booking?.return_date || '';
  const rows = rowsFromItems(booking?.sale_items || [], booking?.cost_items || []);
  const hasMoreDetails = Boolean(booking?.notes || booking?.invoice_notes);

  const body = `
    <div class="form-grid">
      <div class="field full">
        <label for="bk-customer">Customer</label>
        <select class="input" id="bk-customer" name="customer_id" required>
          ${optionsHtml(customers, { selected: booking?.customer_id, placeholder: 'Choose a customer…' })}
        </select>
      </div>
      <div class="field full">
        <label for="bk-destination">Destination / description</label>
        <input class="input" id="bk-destination" name="destination" value="${esc(booking?.destination || '')}"
          placeholder="e.g. Dubai–London return · Emirates" maxlength="200">
      </div>
      <div class="field">
        <label for="bk-pnr">PNR</label>
        <input class="input" id="bk-pnr" name="pnr" value="${esc(booking?.pnr || '')}" placeholder="Optional" maxlength="60">
      </div>
      <div class="field">
        <label for="bk-date">Booking date</label>
        <input class="input" id="bk-date" name="booking_date" type="date" value="${esc(issueDate)}" required>
      </div>
      <div class="field">
        <label for="bk-travel">Travel date</label>
        <input class="input" id="bk-travel" name="travel_date" type="date" value="${esc(travelDate)}">
      </div>
      <div class="field">
        <label for="bk-return">Return date</label>
        <input class="input" id="bk-return" name="return_date" type="date" value="${esc(returnDate)}">
      </div>

      ${passengerSectionHtml(rows)}

      <div class="field full">
        <div class="totals-panel">
          <div class="totals-row"><span>Total sale</span><span id="bk-sale">${fmtMoney(0)}</span></div>
          <div class="totals-row"><span>Total cost</span><span id="bk-cost">${fmtMoney(0)}</span></div>
          <div class="totals-row total"><span>Gross profit</span><span class="margin-positive" id="bk-margin">${fmtMoney(0)}</span></div>
          <div class="totals-row"><span class="muted">Gross margin</span><span class="muted" id="bk-margin-percent">—</span></div>
        </div>
      </div>

      <details class="field full more-details" ${hasMoreDetails ? 'open' : ''}>
        <summary>More details</summary>
        <div class="form-grid">
          <div class="field">
            <label for="bk-due">Payment due</label>
            <input class="input" id="bk-due" name="due_date" type="date" value="${esc(dueDate)}" required>
          </div>
          <div class="field full">
            <label for="bk-notes">Internal notes</label>
            <textarea class="input" id="bk-notes" name="notes" rows="2" placeholder="Only staff see this. Never printed for the customer.">${esc(booking?.notes || '')}</textarea>
          </div>
          <div class="field full">
            <label for="bk-invoice-notes">Note on invoice</label>
            <textarea class="input" id="bk-invoice-notes" name="invoice_notes" rows="2" placeholder="Optional. Printed on the customer invoice and booking confirmation.">${esc(booking?.invoice_notes || '')}</textarea>
          </div>
        </div>
      </details>
    </div>
  `;

  const modal = openModal({
    title: isEdit ? `Edit ${booking.number}` : 'New booking',
    size: 'modal-xl',
    body,
    submitLabel: isEdit ? 'Save booking' : 'Create booking',
    async onSubmit(form) {
      const editor = modal?.overlay?._bookingEditor;
      const values = new FormData(form);
      const { sale, cost, problems } = editor ? editor.getItems() : { sale: [], cost: [], problems: [] };
      if (problems.length) throw new Error(problems[0]);
      if (!sale.length) throw new Error('Add at least one passenger or item with a sale price');
      const payload = {
        customer_id: Number(values.get('customer_id')),
        booking_date: values.get('booking_date'),
        due_date: values.get('due_date'),
        travel_date: values.get('travel_date') || null,
        return_date: values.get('return_date') || null,
        destination: values.get('destination'),
        pnr: values.get('pnr'),
        notes: values.get('notes'),
        invoice_notes: values.get('invoice_notes'),
        sale_items: sale,
        cost_items: cost,
      };
      const saved = isEdit
        ? await api.put(`/bookings/${booking.id}`, payload)
        : await api.post('/bookings', payload);
      toast(isEdit ? 'Booking updated' : `Booking ${saved.number} created`);
      onSaved(saved);
    },
    onMount(overlay) {
      overlay._bookingEditor = mountPassengerEditor(overlay);
    },
  });

  return modal;
}

export async function render(container, { query } = {}) {
  const bookings = await api.get('/bookings');
  const saleTotal = bookings.filter((b) => b.status !== 'cancelled').reduce((sum, b) => sum + b.sale_total_cents, 0);

  setHeader({
    title: 'Bookings',
    actions: `<button class="btn btn-primary" data-action="new-booking">${icon('plus', 16)}<span>New booking</span></button>`,
  });

  if (!bookings.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
    iconName: 'invoice',
    title: 'No bookings yet',
    action: '<button class="btn btn-primary" data-action="new-booking">Create your first booking</button>',
  })}
      </div>
    `;
    document.querySelectorAll('[data-action="new-booking"]').forEach((button) => {
      button.addEventListener('click', () => openBookingModal({ onSaved: (booking) => { location.hash = `#/bookings/${booking.id}`; } }));
    });
    maybeOpenNew(query, true);
    return;
  }

  container.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="booking-search" type="search" placeholder="Search bookings, customers, PNR…" aria-label="Search bookings, customers or PNR" autocomplete="off">
      </div>
      <select class="input" id="booking-status" aria-label="Filter bookings by status" style="max-width:170px">
        <option value="all">All statuses</option>
        <option value="draft">Draft</option>
        <option value="confirmed">Confirmed</option>
        <option value="travelled">Travelled</option>
        <option value="cancelled">Cancelled</option>
      </select>
      ${dateRangeHtml({ label: 'Booking date' })}
      <div class="spacer"></div>
      <span class="muted" id="booking-count" style="font-size:12px"></span>
      <span class="muted" id="booking-sales" style="font-size:12px">Sales ${fmtMoney(saleTotal)}</span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data cards-sm"><caption class="sr-only">Bookings</caption>
          <thead>
            <tr>
              <th scope="col">Booking</th>
              <th scope="col">Customer</th>
              <th scope="col">Travel</th>
              <th scope="col">Status</th>
              <th scope="col">Payment</th>
              <th scope="col" class="num">Sale</th>
              <th scope="col" class="num">Cost</th>
              <th scope="col" class="num">Gross profit</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="booking-body"></tbody>
        </table>
      </div>
      <div id="booking-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#booking-search');
  const statusSelect = container.querySelector('#booking-status');
  const body = container.querySelector('#booking-body');
  const countEl = container.querySelector('#booking-count');
  const salesEl = container.querySelector('#booking-sales');
  const paginationEl = container.querySelector('#booking-pagination');
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
      body.innerHTML = `<tr><td colspan="9">${emptyState({
    iconName: 'search',
    title: 'No matching bookings',
  })}</td></tr>`;
    } else {
      body.innerHTML = rows.map(bookingRow).join('');
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
    const status = statusSelect.value;
    const { from, to } = dateRange.values();
    filtered = bookings.filter((booking) => {
      if (!inDateRange(booking.booking_date, from, to)) return false;
      if (status !== 'all' && booking.status !== status) return false;
      if (!term) return true;
      return [booking.number, booking.customer_name, booking.destination, booking.pnr, booking.status, booking.passenger_names]
        .some((value) => String(value || '').toLowerCase().includes(term));
    });
    const filteredSales = filtered
      .filter((booking) => booking.status !== 'cancelled')
      .reduce((sum, booking) => sum + booking.sale_total_cents, 0);
    const confirmed = filtered.filter((booking) => booking.status === 'confirmed').length;
    countEl.textContent = `${filtered.length} shown`;
    if (salesEl) salesEl.textContent = `Sales ${fmtMoney(filteredSales)}`;
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  body.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) location.hash = `#/bookings/${row.dataset.id}`;
  });

  document.querySelectorAll('[data-action="new-booking"]').forEach((button) => {
    button.addEventListener('click', () => openBookingModal({ onSaved: (booking) => { location.hash = `#/bookings/${booking.id}`; } }));
  });

  applyFilters();
  maybeOpenNew(query, false);
}

function maybeOpenNew(query, alreadyBound) {
  if (query && query.get('new')) {
    history.replaceState(null, '', '#/bookings');
    if (alreadyBound) {
      setTimeout(() => {
        document.querySelector('[data-action="new-booking"]').click();
      }, 40);
    } else {
      openBookingModal({ onSaved: (booking) => { location.hash = `#/bookings/${booking.id}`; } });
    }
  }
}
