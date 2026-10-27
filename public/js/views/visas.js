import { api } from '../api.js';
import { DEFAULT_PAGE_SIZE, bindPagination, paginationHtml } from '../pagination.js';
import { activeCustomers, store } from '../store.js';
import {
  addDaysISO,
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
import { costRow, mountBookingLines, saleRow } from './bookings.js';
import { openVisaGroupModal } from './visa-group-form.js';

export const VISA_TYPE_LABELS = {
  tourist: 'Tourist',
  visit: 'Visit / family',
  business: 'Business',
  transit: 'Transit',
  student: 'Student',
  work: 'Work',
  other: 'Other',
};

export function visaTypeLabel(type) {
  return VISA_TYPE_LABELS[type] || 'Other';
}

export function visaDurationLabel(days) {
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${value} day${value === 1 ? '' : 's'}`;
}

const STATUS_OPTIONS = ['draft', 'submitted', 'approved', 'issued', 'rejected', 'cancelled'];

function accountIdByCode(code) {
  return store.accounts.find((account) => account.code === code)?.id;
}

function defaultAccounts() {
  const saleAccountId = accountIdByCode('4320')
    || store.accounts.find((account) => account.type === 'revenue' && account.is_active)?.id;
  const costAccountId = accountIdByCode('5120')
    || store.accounts.find((account) => account.type === 'expense' && account.is_active)?.id;
  return { saleAccountId, costAccountId };
}

function visaRow(visa) {
  const marginClass = visa.margin_cents >= 0 ? 'margin-positive' : 'margin-negative';
  const destination = [
    visa.destination_country,
    visaTypeLabel(visa.visa_type),
    visaDurationLabel(visa.duration_days),
  ].filter(Boolean).join(' · ');
  return `
    <tr class="clickable" data-id="${visa.id}">
      <td>
        <div class="cell-main">${esc(visa.number)}</div>
        <div class="cell-sub">${esc(fmtDate(visa.application_date))}${visa.reference ? ` · ${esc(visa.reference)}` : ''}</div>
        ${visa.group_number ? `<div class="cell-sub"><span class="group-chip" title="Created together with ${visa.group_size - 1} other application${visa.group_size === 2 ? '' : 's'}">${esc(visa.group_number)} · ${visa.group_size}</span></div>` : ''}
      </td>
      <td>
        <div class="party-cell">
          <div class="visa-avatar">${icon('visa', 17)}</div>
          <div class="party-info">
            <div class="cell-main">${esc(visa.applicant_name || visa.customer_name)}</div>
            <div class="cell-sub">${esc(destination || 'No destination')}</div>
            ${visa.nationality || visa.passport_number ? `<div class="cell-sub">${esc([visa.nationality, visa.passport_number].filter(Boolean).join(' · '))}</div>` : ''}
          </div>
        </div>
      </td>
      <td class="nowrap">${visa.travel_date ? esc(fmtDate(visa.travel_date)) : '—'}</td>
      <td>${statusBadge(visa.status)}</td>
      <td data-payment-status>${paymentBadge(visa)}</td>
      <td class="num">${fmtMoney(visa.sale_total_cents)}</td>
      <td class="num">${fmtMoney(visa.cost_total_cents)}</td>
      <td class="num ${marginClass}">${fmtMoney(visa.margin_cents)}</td>
      <td class="right muted">${icon('chevron', 16)}</td>
    </tr>
  `;
}

export function openVisaModal({ visa = null, onSaved = () => {} } = {}) {
  // New applications use the applicants-list form (one or more people).
  if (!visa) return openVisaGroupModal({ visaTypes: VISA_TYPE_LABELS, onSaved });
  const isEdit = Boolean(visa);
  const customers = activeCustomers();
  if (!customers.length) {
    toast('Add a customer before creating a visa application.', 'error');
    location.hash = '#/customers?new=1';
    return;
  }

  const applicationDate = visa?.application_date || todayISO();
  // New applications default to the company payment terms, like invoices.
  const dueDate = visa?.due_date || addDaysISO(applicationDate, Number(store.settings?.payment_terms_days ?? 0));
  const saleItems = visa?.sale_items?.length ? visa.sale_items : [{}];
  const costItems = visa?.cost_items?.length ? visa.cost_items : [{}];
  const defaults = defaultAccounts();
  const applicantIsOther = visa ? Number(visa.applicant_is_customer) === 0 : false;

  const body = `
    <div class="form-grid">
      <div class="field full">
        <label for="visa-customer">Customer</label>
        <select class="input" id="visa-customer" name="customer_id" required>
          ${optionsHtml(customers, { selected: visa?.customer_id, placeholder: 'Choose a customer…' })}
        </select>
      </div>
      <div class="field full">
        <label class="checkbox-row" for="visa-applicant-other">
          <input type="checkbox" id="visa-applicant-other" ${applicantIsOther ? 'checked' : ''}>
          <span>
            <strong>This visa is for someone else</strong><br>
            Turn this on to enter a visitor's name and passport details. Leave it off when the customer is travelling.
          </span>
        </label>
      </div>
      <div class="field">
        <label for="visa-applicant">Applicant name</label>
        <input class="input" id="visa-applicant" name="applicant_name" value="${esc(visa?.applicant_name || '')}"
          placeholder="${applicantIsOther ? 'Enter the visitor’s full name' : 'Select a customer to fill this'}"
          ${applicantIsOther ? 'required' : 'readonly'} autocomplete="off">
        <div class="hint" id="visa-applicant-hint">${applicantIsOther ? 'Enter the visitor’s full name and passport details below.' : 'Uses the selected customer’s name. Add the passport details below if needed.'}</div>
      </div>
      <div class="field">
        <label for="visa-passport">Passport number</label>
        <input class="input" id="visa-passport" name="passport_number" value="${esc(visa?.passport_number || '')}" autocomplete="off">
      </div>
      <div class="field">
        <label for="visa-passport-expiry">Passport expiry</label>
        <input class="input" id="visa-passport-expiry" name="passport_expiry" type="date" value="${esc(visa?.passport_expiry || '')}">
      </div>
      <div class="field">
        <label for="visa-type">Visa type</label>
        <select class="input" id="visa-type" name="visa_type">
          ${optionsHtml(Object.entries(VISA_TYPE_LABELS).map(([value, label]) => ({ value, label })), { selected: visa?.visa_type || 'tourist', valueKey: 'value', labelKey: 'label', placeholder: '' })}
        </select>
      </div>
      <div class="field">
        <label for="visa-country">Destination country</label>
        <input class="input" id="visa-country" name="destination_country" value="${esc(visa?.destination_country || '')}" placeholder="e.g. Saudi Arabia">
      </div>
      <div class="field">
        <label for="visa-date">Application date</label>
        <input class="input" id="visa-date" name="application_date" type="date" value="${esc(applicationDate)}" required>
      </div>
      <div class="field">
        <label for="visa-travel">Travel date</label>
        <input class="input" id="visa-travel" name="travel_date" type="date" value="${esc(visa?.travel_date || '')}">
      </div>

      <div class="field full">
        <div class="bk-section-title">
          <label>Sale items — what the customer pays</label>
          <button type="button" class="btn btn-ghost btn-sm" data-add-sale>${icon('plus', 14)} Add sale</button>
        </div>
        <div class="bk-wrap">
          <div class="bk-head" data-type="sale">
            <div>Description</div><div>Qty</div><div>Unit price</div><div>Revenue account</div><div style="text-align:right">Amount</div><div></div>
          </div>
          <div data-bk-lines="sale">
            ${saleItems.map((item) => saleRow(item, defaults)).join('')}
          </div>
        </div>
      </div>

      <div class="field full">
        <div class="bk-section-title">
          <label>Cost items — embassy, typing centre &amp; supplier fees</label>
          <button type="button" class="btn btn-ghost btn-sm" data-add-cost>${icon('plus', 14)} Add cost</button>
        </div>
        <div class="hint" style="margin:-4px 0 8px">Costs are billed to the supplier when you submit the application. Prepaid portals settle automatically; credit accounts stay payable.</div>
        <div class="bk-wrap">
          <div class="bk-head" data-type="cost">
            <div>Description</div><div>Qty</div><div>Unit cost</div><div>Cost account</div><div>Supplier</div><div>Supplier ref</div><div style="text-align:right">Amount</div><div></div>
          </div>
          <div data-bk-lines="cost">
            ${costItems.map((item) => costRow(item, defaults)).join('')}
          </div>
        </div>
      </div>

      <div class="field full">
        <div class="totals-panel">
          <div class="totals-row"><span>Total sale</span><span id="bk-sale">${fmtMoney(0)}</span></div>
          <div class="totals-row"><span>Total cost</span><span id="bk-cost">${fmtMoney(0)}</span></div>
          <div class="totals-row total"><span>Margin</span><span class="margin-positive" id="bk-margin">${fmtMoney(0)}</span></div>
          <div class="totals-row"><span class="muted">Profitability</span><span class="muted" id="bk-margin-percent">—</span></div>
        </div>
      </div>
      <details class="field full more-details"${visa?.notes || visa?.invoice_notes ? ' open' : ''}>
        <summary>More details</summary>
        <div class="form-grid">
          <div class="field">
            <label for="visa-due">Payment due</label>
            <input class="input" id="visa-due" name="due_date" type="date" value="${esc(dueDate)}" required>
          </div>
          <div class="field">
            <label for="visa-duration">Duration (days)</label>
            <input class="input" id="visa-duration" name="duration_days" type="number" min="1" max="3650" step="1" value="${esc(visa?.duration_days || '')}" placeholder="e.g. 30">
            <div class="hint">Leave blank if the stay length is not fixed.</div>
          </div>
          <div class="field">
            <label for="visa-reference">Application / embassy ref</label>
            <input class="input" id="visa-reference" name="reference" value="${esc(visa?.reference || '')}" placeholder="Optional" autocomplete="off">
          </div>
          <div class="field">
            <label for="visa-nationality">Nationality</label>
            <input class="input" id="visa-nationality" name="nationality" value="${esc(visa?.nationality || '')}" placeholder="e.g. Indian" autocomplete="off">
          </div>
          <div class="field">
            <label for="visa-dob">Date of birth</label>
            <input class="input" id="visa-dob" name="date_of_birth" type="date" value="${esc(visa?.date_of_birth || '')}">
          </div>
          <div class="field full">
            <label for="visa-notes">Internal notes</label>
            <textarea class="input" id="visa-notes" name="notes" rows="2" placeholder="Documents checklist, embassy appointment… Only staff see this; never printed.">${esc(visa?.notes || '')}</textarea>
          </div>
          <div class="field full">
            <label for="visa-invoice-notes">Note on invoice</label>
            <textarea class="input" id="visa-invoice-notes" name="invoice_notes" rows="2" placeholder="Optional. Printed on the customer invoice and application summary.">${esc(visa?.invoice_notes || '')}</textarea>
          </div>
        </div>
      </details>
    </div>
  `;

  const modal = openModal({
    title: isEdit ? `Edit ${visa.number}` : 'New visa application',
    subtitle: isEdit
      ? 'Draft applications can be edited until they are submitted.'
      : 'Submitting creates the customer invoice and supplier bills automatically.',
    size: 'modal-xl',
    body,
    submitLabel: isEdit ? 'Save application' : 'Create application',
    async onSubmit(form) {
      const editor = modal?.overlay?._visaEditor;
      const values = new FormData(form);
      const items = editor ? editor.getItems() : { sale: [], cost: [] };
      const sale = items.sale.filter((item) => item.description || item.unit_price_cents);
      const cost = items.cost.filter((item) => item.description || item.unit_price_cents);
      if (!sale.length) throw new Error('Add at least one sale item');
      if (sale.some((item) => !item.description || !item.account_id)) throw new Error('Every sale line needs a description and revenue account');
      if (cost.some((item) => !item.description || !item.account_id || !item.vendor_id)) throw new Error('Every cost line needs a description, cost account and supplier');
      const applicantOther = Boolean(form.querySelector('#visa-applicant-other')?.checked);
      if (applicantOther && !String(values.get('applicant_name') || '').trim()) {
        throw new Error('Enter the visitor name');
      }
      const payload = {
        customer_id: Number(values.get('customer_id')),
        application_date: values.get('application_date'),
        due_date: values.get('due_date'),
        travel_date: values.get('travel_date') || null,
        destination_country: values.get('destination_country'),
        visa_type: values.get('visa_type'),
        duration_days: values.get('duration_days') || null,
        applicant_is_customer: !applicantOther,
        applicant_name: values.get('applicant_name'),
        nationality: values.get('nationality'),
        passport_number: values.get('passport_number'),
        passport_expiry: values.get('passport_expiry') || null,
        date_of_birth: values.get('date_of_birth') || null,
        reference: values.get('reference'),
        notes: values.get('notes'),
        invoice_notes: values.get('invoice_notes'),
        sale_items: sale,
        cost_items: cost,
      };
      const saved = isEdit
        ? await api.put(`/visas/${visa.id}`, payload)
        : await api.post('/visas', payload);
      toast(isEdit ? 'Visa application updated' : `Visa application ${saved.number} created`);
      if (saved.passport_warning) toast(saved.passport_warning, 'error');
      onSaved(saved);
    },
    onMount(overlay) {
      overlay._visaEditor = mountBookingLines(overlay, defaults);
      const customerSelect = overlay.querySelector('#visa-customer');
      const applicant = overlay.querySelector('#visa-applicant');
      const otherToggle = overlay.querySelector('#visa-applicant-other');
      const applicantHint = overlay.querySelector('#visa-applicant-hint');

      function customerName() {
        if (!customerSelect || customerSelect.selectedIndex <= 0) return '';
        return customerSelect.selectedOptions[0]?.textContent.trim() || '';
      }

      function syncApplicantMode() {
        if (!applicant) return;
        const isOther = Boolean(otherToggle?.checked);
        applicant.readOnly = !isOther;
        applicant.required = isOther;
        applicant.placeholder = isOther ? 'Enter the visitor’s full name' : 'Select a customer to fill this';
        if (applicantHint) {
          applicantHint.textContent = isOther
            ? 'Enter the visitor’s full name and passport details below.'
            : 'Uses the selected customer’s name. Add the passport details below if needed.';
        }
        if (!isOther) {
          const name = customerName();
          if (name) applicant.value = name;
        }
      }

      customerSelect?.addEventListener('change', () => {
        if (!otherToggle?.checked) syncApplicantMode();
      });

      otherToggle?.addEventListener('change', () => {
        if (otherToggle.checked) {
          const current = applicant?.value.trim() || '';
          if (!current || current === customerName()) {
            if (applicant) applicant.value = '';
          }
        }
        syncApplicantMode();
        if (otherToggle.checked) applicant?.focus();
      });

      syncApplicantMode();
    },
  });

  return modal;
}

export async function render(container, { query } = {}) {
  const visas = await api.get('/visas');
  const activeCount = visas.filter((visa) => ['submitted', 'approved'].includes(visa.status)).length;
  const issuedCount = visas.filter((visa) => visa.status === 'issued').length;
  const saleTotal = visas.filter((visa) => !['cancelled', 'rejected'].includes(visa.status))
    .reduce((sum, visa) => sum + visa.sale_total_cents, 0);
  const marginTotal = visas.filter((visa) => !['cancelled', 'rejected'].includes(visa.status))
    .reduce((sum, visa) => sum + visa.margin_cents, 0);

  setHeader({
    title: 'Visas',
    subtitle: `${visas.length} application${visas.length === 1 ? '' : 's'} · ${activeCount} in progress · ${issuedCount} issued · ${fmtMoney(marginTotal)} margin`,
    actions: `<button class="btn btn-primary" data-action="new-visa">${icon('plus', 16)}<span>New visa</span></button>`,
  });

  const newHandler = () => openVisaModal({ onSaved: (visa) => { location.hash = `#/visas/${visa.id}`; } });

  if (!visas.length) {
    container.innerHTML = `
      <div class="card">
        ${emptyState({
    iconName: 'visa',
    title: 'No visa applications yet',
    message: 'Track tourist, visit and business visas with applicant details, embassy costs and margin. Submitting posts the invoice and supplier bills.',
    action: '<button class="btn btn-primary" data-action="new-visa">Create your first visa application</button>',
  })}
      </div>
    `;
    document.querySelectorAll('[data-action="new-visa"]').forEach((button) => button.addEventListener('click', newHandler));
    maybeOpenNew(query, true, newHandler);
    return;
  }

  container.innerHTML = `
    <div class="toolbar">
      <div class="search-box">
        ${icon('search', 17)}
        <input class="input" id="visa-search" type="search" placeholder="Search visas, applicants, passports…" aria-label="Search visas, applicants or passports" autocomplete="off">
      </div>
      <select class="input" id="visa-status" aria-label="Filter visas by status" style="max-width:170px">
        <option value="all">All statuses</option>
        ${STATUS_OPTIONS.map((status) => `<option value="${status}">${status.charAt(0).toUpperCase()}${status.slice(1)}</option>`).join('')}
      </select>
      ${dateRangeHtml({ label: 'Application date' })}
      <div class="spacer"></div>
      <span class="muted" id="visa-count" style="font-size:12px"></span>
      <span class="muted" id="visa-sales" style="font-size:12px">Sales ${fmtMoney(saleTotal)}</span>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data visa-table"><caption class="sr-only">Visa applications</caption>
          <thead>
            <tr>
              <th scope="col">Application</th>
              <th scope="col">Applicant</th>
              <th scope="col">Travel</th>
              <th scope="col">Status</th>
              <th scope="col">Payment</th>
              <th scope="col" class="num">Sale</th>
              <th scope="col" class="num">Cost</th>
              <th scope="col" class="num">Margin</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody id="visa-body"></tbody>
        </table>
      </div>
      <div id="visa-pagination"></div>
    </div>
  `;

  const searchInput = container.querySelector('#visa-search');
  const statusSelect = container.querySelector('#visa-status');
  const body = container.querySelector('#visa-body');
  const countEl = container.querySelector('#visa-count');
  const salesEl = container.querySelector('#visa-sales');
  const paginationEl = container.querySelector('#visa-pagination');
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
    title: 'No matching visa applications',
    message: 'Try a different search term, status or date range.',
  })}</td></tr>`;
    } else {
      body.innerHTML = rows.map(visaRow).join('');
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
    filtered = visas.filter((visa) => {
      if (!inDateRange(visa.application_date, from, to)) return false;
      if (status !== 'all' && visa.status !== status) return false;
      if (!term) return true;
      return [
        visa.number,
        visa.customer_name,
        visa.applicant_name,
        visa.destination_country,
        visa.visa_type,
        visa.duration_days,
        visa.passport_number,
        visa.nationality,
        visa.reference,
        visa.group_number,
        visa.status,
      ].some((value) => String(value || '').toLowerCase().includes(term));
    });
    const filteredSales = filtered
      .filter((visa) => !['cancelled', 'rejected'].includes(visa.status))
      .reduce((sum, visa) => sum + visa.sale_total_cents, 0);
    const filteredMargin = filtered
      .filter((visa) => !['cancelled', 'rejected'].includes(visa.status))
      .reduce((sum, visa) => sum + visa.margin_cents, 0);
    const active = filtered.filter((visa) => ['submitted', 'approved'].includes(visa.status)).length;
    const issued = filtered.filter((visa) => visa.status === 'issued').length;
    countEl.textContent = `${filtered.length} shown`;
    if (salesEl) salesEl.textContent = `Sales ${fmtMoney(filteredSales)}`;
    const subtitleEl = document.getElementById('page-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent = `${filtered.length} application${filtered.length === 1 ? '' : 's'} · ${active} in progress · ${issued} issued · ${fmtMoney(filteredMargin)} margin`;
    }
    renderPage();
  }

  searchInput.addEventListener('input', applyFilters);
  statusSelect.addEventListener('change', applyFilters);
  body.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) location.hash = `#/visas/${row.dataset.id}`;
  });

  document.querySelectorAll('[data-action="new-visa"]').forEach((button) => button.addEventListener('click', newHandler));

  applyFilters();
  maybeOpenNew(query, false, newHandler);
}

function maybeOpenNew(query, alreadyBound, handler) {
  if (!query || !query.get('new')) return;
  history.replaceState(null, '', '#/visas');
  if (alreadyBound) {
    setTimeout(() => {
      document.querySelector('[data-action="new-visa"]').click();
    }, 40);
  } else {
    handler();
  }
}
