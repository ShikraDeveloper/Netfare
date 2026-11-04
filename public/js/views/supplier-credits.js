import { api } from '../api.js';
import { activeVendors, purchaseAccounts } from '../store.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import {
  bindDateRange,
  centsToInput,
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
  statusBadge,
  todayISO,
  toast,
  toCents,
} from '../ui.js';

function creditRow(credit) {
  return `
    <tr class="clickable" data-id="${credit.id}" tabindex="0">
      <td>
        <div class="cell-main">${esc(credit.number)}</div>
        <div class="cell-sub">${esc(fmtDate(credit.credit_date))}</div>
      </td>
      <td>${esc(credit.vendor_name)}</td>
      <td>
        <div class="cell-main">${credit.bill_number ? `<a href="#/bills/${credit.bill_id}" onclick="event.stopPropagation()">${esc(credit.bill_number)}</a>` : 'Standalone'}</div>
        <div class="cell-sub">${esc(credit.booking_number || credit.visa_number || credit.cancellation_number || '')}</div>
      </td>
      <td class="num">${fmtMoney(credit.amount_cents)}</td>
      <td class="num">${fmtMoney(credit.applied_cents)}</td>
      <td class="num">${fmtMoney(credit.refunded_cents)}</td>
      <td class="num ${credit.remaining_cents ? 'amount-due' : 'muted'}">${fmtMoney(credit.remaining_cents)}</td>
      <td>${statusBadge(credit.status_display)}</td>
    </tr>
  `;
}

export async function render(container, { query } = {}) {
  const [credits, vendors] = await Promise.all([
    api.get('/supplier-credits'),
    api.get('/vendors'),
  ]);
  setHeader({
    title: 'Supplier credits',
    actions: `<button class="btn btn-primary" data-action="new-credit">${icon('plus', 15)}<span>New supplier credit</span></button>`,
  });

  if (!credits.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
    iconName: 'bill',
    title: 'No supplier credits yet',
    action: '<button class="btn btn-primary" data-action="new-credit">New supplier credit</button>',
  })}
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="toolbar">
        <div class="search-box">
          ${icon('search', 17)}
          <input class="input" id="supplier-credit-search" type="search" placeholder="Search credits, suppliers or bills…" aria-label="Search supplier credits" autocomplete="off">
        </div>
        <select class="input" id="supplier-credit-status" aria-label="Filter supplier credits" style="max-width:170px">
          <option value="all">All credits</option>
          <option value="open">Open credits</option>
          <option value="issued">Issued</option>
          <option value="void">Void</option>
        </select>
        ${dateRangeHtml({ label: 'Credit date' })}
        <div class="spacer"></div>
        <span class="muted" id="supplier-credit-count" style="font-size:12px"></span>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table class="data"><caption class="sr-only">Supplier credit notes</caption>
            <thead>
              <tr>
                <th scope="col">Credit</th>
                <th scope="col">Supplier</th>
                <th scope="col">Source</th>
                <th scope="col" class="num">Amount</th>
                <th scope="col" class="num">Applied</th>
                <th scope="col" class="num">Refunded</th>
                <th scope="col" class="num">Remaining</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody id="supplier-credit-body"></tbody>
          </table>
        </div>
        <div id="supplier-credit-pagination"></div>
      </div>
    `;
  }

  const openCreditForm = (preset = {}) => openNewCredit({
    vendors,
    preset,
    onSaved: (credit) => { location.hash = `#/supplier-credits/${credit.id}`; },
  });
  document.querySelectorAll('[data-action="new-credit"]').forEach((button) => {
    button.addEventListener('click', () => openCreditForm());
  });
  // Opened from a booking or visa bill: start with that bill selected.
  if (query?.get('new')) {
    openCreditForm({ billId: Number(query.get('bill')) || null });
  }

  const body = container.querySelector('#supplier-credit-body');
  if (!body) return;

  const searchInput = container.querySelector('#supplier-credit-search');
  const statusSelect = container.querySelector('#supplier-credit-status');
  const countEl = container.querySelector('#supplier-credit-count');
  const paginationEl = container.querySelector('#supplier-credit-pagination');
  const dateRange = bindDateRange(container, () => applyFilters());
  let page = 1;
  let pageSize = DEFAULT_PAGE_SIZE;
  let filtered = [];

  function renderPage() {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const start = (page - 1) * pageSize;
    const rows = filtered.slice(start, start + pageSize);
    body.innerHTML = rows.length ? rows.map(creditRow).join('') : `<tr><td colspan="8">${emptyState({
      iconName: 'search',
      title: 'No matching supplier credits',
    })}</td></tr>`;
    if (countEl) countEl.textContent = `${filtered.length} credit${filtered.length === 1 ? '' : 's'}`;
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
    filtered = credits.filter((credit) => {
      if (!inDateRange(credit.credit_date, from, to)) return false;
      if (status === 'open' && !(credit.status === 'issued' && credit.remaining_cents > 0)) return false;
      if (!['all', 'open'].includes(status) && credit.status !== status) return false;
      if (!term) return true;
      return [credit.number, credit.vendor_name, credit.bill_number, credit.booking_number, credit.visa_number, credit.cancellation_number, credit.notes]
        .filter(Boolean).join(' ').toLowerCase().includes(term);
    });
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  applyFilters();

  body.addEventListener('click', (event) => {
    if (event.target.closest('a')) return;
    const row = event.target.closest('tr[data-id]');
    if (row) location.hash = `#/supplier-credits/${row.dataset.id}`;
  });
}

async function openNewCredit({ vendors, onSaved, preset = {} }) {
  const [bills, bookings, visas] = await Promise.all([
    api.get('/bills'),
    api.get('/bookings'),
    api.get('/visas'),
  ]);
  const active = activeVendors();
  if (!active.length) {
    toast('Add an active supplier before recording a supplier credit.', 'error');
    return;
  }
  const costAccounts = purchaseAccounts();
  if (!costAccounts.length) {
    toast('Add an expense account before recording a supplier credit.', 'error');
    return;
  }
  const receivedBills = bills.filter((bill) => bill.status === 'received');

  openModal({
    title: 'New supplier credit',
    size: 'modal-lg',
    submitLabel: 'Record supplier credit',
    body: `
      <div class="form-grid">
        <div class="field">
          <label for="sc-vendor">Supplier</label>
          <select class="input" id="sc-vendor" name="vendor_id" required>
            ${optionsHtml(active, { placeholder: 'Choose supplier…' })}
          </select>
        </div>
        <div class="field">
          <label for="sc-date">Credit date</label>
          <input class="input" id="sc-date" name="credit_date" type="date" value="${todayISO()}" required>
        </div>
        <div class="field full">
          <label for="sc-bill">Bill</label>
          <select class="input" id="sc-bill" name="bill_id">
            <option value="">No bill</option>
          </select>
        </div>
        <div class="field full" data-bill-fields hidden>
          <label for="sc-bill-amount">Credit amount</label>
          <div class="money-input"><span>AED</span>
            <input class="input" id="sc-bill-amount" name="bill_amount" type="number" min="0.01" step="0.01" value="" inputmode="decimal">
          </div>
          <div class="hint" data-bill-available></div>
        </div>
        <div data-manual-fields class="field full">
          <div class="form-grid">
            <div class="field full">
              <label for="sc-line-description">Credit line description</label>
              <input class="input" id="sc-line-description" name="line_description" maxlength="300" value="Supplier credit">
            </div>
            <div class="field">
              <label for="sc-line-account">Cost account</label>
              <select class="input" id="sc-line-account" name="line_account_id">
                ${optionsHtml(costAccounts, { placeholder: 'Choose cost account…', labelKey: (account) => `${account.code} · ${account.name}` })}
              </select>
            </div>
            <div class="field">
              <label for="sc-line-amount">Credit amount</label>
              <div class="money-input"><span>AED</span>
                <input class="input" id="sc-line-amount" name="line_amount" type="number" min="0.01" step="0.01" value="" inputmode="decimal">
              </div>
            </div>
          </div>
        </div>
        <div class="field">
          <label for="sc-booking">Booking</label>
          <select class="input" id="sc-booking" name="booking_id">
            ${optionsHtml(bookings, { placeholder: 'No booking', labelKey: (booking) => `${booking.number} · ${booking.customer_name}` })}
          </select>
        </div>
        <div class="field">
          <label for="sc-visa">Visa</label>
          <select class="input" id="sc-visa" name="visa_id">
            ${optionsHtml(visas, { placeholder: 'No visa application', labelKey: (visa) => `${visa.number} · ${visa.applicant_name || visa.customer_name}` })}
          </select>
        </div>
        <div class="field full">
          <label for="sc-notes">Notes</label>
          <textarea class="input" id="sc-notes" name="notes" rows="2" maxlength="2000" placeholder="Reason, supplier reference or credit memo number"></textarea>
        </div>
      </div>
    `,
    onMount(overlay) {
      const vendorSelect = overlay.querySelector('#sc-vendor');
      const billSelect = overlay.querySelector('#sc-bill');
      const billFields = overlay.querySelector('[data-bill-fields]');
      const billAmount = overlay.querySelector('#sc-bill-amount');
      const billAvailable = overlay.querySelector('[data-bill-available]');
      const manualFields = overlay.querySelector('[data-manual-fields]');
      const lineAmount = overlay.querySelector('#sc-line-amount');
      let selectedBill = null;

      function billsForVendor() {
        const vendorId = Number(vendorSelect.value);
        return receivedBills.filter((bill) => bill.vendor_id === vendorId);
      }

      function renderBills() {
        const options = billsForVendor();
        billSelect.innerHTML = `<option value="">No bill — standalone supplier credit</option>${options.map((bill) => `
          <option value="${bill.id}">${esc(bill.number)} · ${fmtMoney(bill.total_cents)} total · ${fmtMoney(bill.balance_cents)} due</option>
        `).join('')}`;
        syncMode();
      }

      async function syncMode() {
        selectedBill = null;
        const billId = Number(billSelect.value);
        if (!billId) {
          billFields.hidden = true;
          manualFields.hidden = false;
          billAmount.required = false;
          lineAmount.required = true;
          return;
        }
        billFields.hidden = false;
        manualFields.hidden = true;
        billAmount.required = true;
        lineAmount.required = false;
        try {
          const detail = await api.get(`/bills/${billId}`);
          const used = (detail.supplier_credits || []).reduce((sum, credit) => sum + credit.amount_cents, 0);
          const available = Math.max(0, detail.total_cents - used);
          selectedBill = { ...detail, available };
          billAmount.max = centsToInput(available);
          billAmount.value = centsToInput(available);
          billAvailable.textContent = `${fmtMoney(available)} available to credit on ${detail.number}`;
          if (vendorSelect.value !== String(detail.vendor_id)) vendorSelect.value = String(detail.vendor_id);
        } catch (error) {
          toast(error.message, 'error');
        }
      }

      vendorSelect.addEventListener('change', renderBills);
      billSelect.addEventListener('change', syncMode);
      renderBills();

      const presetBill = preset.billId ? receivedBills.find((bill) => bill.id === preset.billId) : null;
      if (presetBill) {
        vendorSelect.value = String(presetBill.vendor_id);
        renderBills();
        billSelect.value = String(presetBill.id);
        if (presetBill.booking_id) overlay.querySelector('#sc-booking').value = String(presetBill.booking_id);
        if (presetBill.visa_id) overlay.querySelector('#sc-visa').value = String(presetBill.visa_id);
        syncMode();
      }
    },
    async onSubmit(form) {
      const values = new FormData(form);
      const vendorId = Number(values.get('vendor_id'));
      if (!vendorId) throw new Error('Choose a supplier');
      const billId = Number(values.get('bill_id'));
      const payload = {
        vendor_id: vendorId,
        credit_date: values.get('credit_date'),
        notes: values.get('notes'),
        booking_id: values.get('booking_id') ? Number(values.get('booking_id')) : null,
        visa_id: values.get('visa_id') ? Number(values.get('visa_id')) : null,
      };
      if (billId) {
        payload.bill_id = billId;
        payload.amount_cents = toCents(values.get('bill_amount'));
        if (payload.amount_cents <= 0) throw new Error('Enter a credit amount');
      } else {
        const accountId = Number(values.get('line_account_id'));
        if (!accountId) throw new Error('Choose a cost account');
        const amount = toCents(values.get('line_amount'));
        if (amount <= 0) throw new Error('Enter a credit amount');
        payload.items = [{
          description: values.get('line_description'),
          account_id: accountId,
          amount_cents: amount,
        }];
      }
      const credit = await api.post('/supplier-credits', payload);
      toast(`Supplier credit ${credit.number} recorded · ${fmtMoney(credit.remaining_cents)} open`);
      if (onSaved) onSaved(credit);
    },
  });
}
