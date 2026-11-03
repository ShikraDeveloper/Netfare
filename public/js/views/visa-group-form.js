import { api } from '../api.js';
import { nationalityList } from '../nationalities.js';
import { bindMethodAccount } from '../payment-methods.js';
import { depositAccounts } from './job-modals.js';
import { activeCustomers, activeVendors, portalForVendorId, purchaseAccounts, revenueAccounts, store } from '../store.js';
import {
  addDaysISO,
  centsToInput,
  currencySymbol,
  esc,
  fmtMoney,
  icon,
  openModal,
  optionsHtml,
  todayISO,
  toast,
  toCents,
} from '../ui.js';

// New visa form for one or more people. Shared details are entered once; each
// applicant row becomes its own application (invoice, status, cancellation),
// linked as a group when there is more than one.

function accountIdByCode(accounts, code) {
  return accounts.find((account) => account.code === code)?.id || accounts[0]?.id || '';
}

function vendorLabel(vendor) {
  const portal = portalForVendorId(vendor.id);
  if (!portal) return vendor.name;
  return `${vendor.name} — ${portal.settlement === 'prepaid' ? 'wallet' : 'credit'}`;
}

function applicantRowHtml(row = {}) {
  const sales = revenueAccounts();
  const costs = purchaseAccounts();
  return `
    <div class="va-row" data-va-row>
      <input class="input va-name" value="${esc(row.name || '')}" placeholder="Applicant name" aria-label="Applicant name" autocomplete="off">
      <input class="input va-passport" value="${esc(row.passport || '')}" placeholder="Passport no." aria-label="Passport number" autocomplete="off">
      <input class="input va-expiry" type="date" value="${esc(row.expiry || '')}" aria-label="Passport expiry" title="Passport expiry">
      <div class="money-input"><span>${esc(currencySymbol())}</span>
        <input class="input va-sale" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Sale price"
          value="${row.sale ? esc(centsToInput(row.sale)) : ''}" placeholder="0.00">
      </div>
      <div class="money-input"><span>${esc(currencySymbol())}</span>
        <input class="input va-cost" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Supplier cost"
          value="${row.cost ? esc(centsToInput(row.cost)) : ''}" placeholder="0.00">
      </div>
      <div class="money-input"><span>${esc(currencySymbol())}</span>
        <input class="input va-deposit" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Security deposit"
          value="${row.deposit ? esc(centsToInput(row.deposit)) : ''}" placeholder="0.00">
      </div>
      <select class="input va-vendor" aria-label="Supplier">
        ${optionsHtml(activeVendors(), { selected: row.vendorId || '', placeholder: 'Supplier…', labelKey: vendorLabel })}
      </select>
      <button type="button" class="icon-btn" data-va-more aria-expanded="false" title="More details for this applicant" aria-label="More details for this applicant">${icon('more', 16)}</button>
      <button type="button" class="icon-btn danger" data-va-remove title="Remove applicant" aria-label="Remove applicant">${icon('x', 16)}</button>
      <div class="va-details" hidden>
        <label>Nationality
          <input class="input va-nationality" value="${esc(row.nationality || '')}" autocomplete="off" placeholder="Optional" ${nationalityList()}>
        </label>
        <label>Date of birth
          <input class="input va-dob" type="date" value="${esc(row.dob || '')}">
        </label>
        <label>Sale account
          <select class="input va-sale-account">
            ${optionsHtml(sales, { selected: row.saleAccountId || accountIdByCode(sales, '4320'), placeholder: '', labelKey: (a) => `${a.code} · ${a.name}` })}
          </select>
        </label>
        <label>Cost account
          <select class="input va-cost-account">
            ${optionsHtml(costs, { selected: row.costAccountId || accountIdByCode(costs, '5120'), placeholder: '', labelKey: (a) => `${a.code} · ${a.name}` })}
          </select>
        </label>
      </div>
    </div>
  `;
}

export function openVisaGroupModal({ visaTypes = {}, onSaved = () => {} } = {}) {
  const customers = activeCustomers();
  if (!customers.length) {
    toast('Add a customer before creating a visa application.', 'error');
    location.hash = '#/customers?new=1';
    return null;
  }
  const applicationDate = todayISO();
  const dueDate = addDaysISO(applicationDate, Number(store.settings?.payment_terms_days ?? 0));

  const body = `
    <div class="form-grid">
      <div class="field full">
        <label for="vg-customer">Customer</label>
        <select class="input" id="vg-customer" name="customer_id" required>
          ${optionsHtml(customers, { placeholder: 'Choose a customer…' })}
        </select>
      </div>
      <div class="field">
        <label for="vg-type">Visa type</label>
        <select class="input" id="vg-type" name="visa_type">
          ${optionsHtml(Object.entries(visaTypes).map(([value, label]) => ({ value, label })), { selected: 'tourist', valueKey: 'value', labelKey: 'label', placeholder: '' })}
        </select>
      </div>
      <div class="field">
        <label for="vg-country">Destination country</label>
        <input class="input" id="vg-country" name="destination_country" placeholder="e.g. Saudi Arabia" maxlength="120">
      </div>
      <div class="field">
        <label for="vg-date">Application date</label>
        <input class="input" id="vg-date" name="application_date" type="date" value="${esc(applicationDate)}" required>
      </div>
      <div class="field">
        <label for="vg-travel">Travel date</label>
        <input class="input" id="vg-travel" name="travel_date" type="date">
      </div>

      <div class="field full">
        <div class="bk-section-title">
          <label>Applicants</label>
          <button type="button" class="btn btn-ghost btn-sm" data-va-add>${icon('plus', 14)} Add applicant</button>
        </div>
        <div class="bk-wrap">
          <div class="va-head" aria-hidden="true">
            <div>Applicant</div><div>Passport no.</div><div>Expiry</div><div>Sale</div><div>Cost</div><div>Sec. deposit</div><div>Supplier</div><div></div><div></div>
          </div>
          <div data-va-rows>${applicantRowHtml()}</div>
        </div>
        <div class="hint">Each applicant becomes a separate application with its own invoice, so one person can be rejected or cancelled without affecting the others. Use <strong>⋯</strong> for nationality, date of birth or accounts.</div>
      </div>

      <div class="field full va-deposit-received" data-deposit-received hidden>
        <div class="form-grid">
          <div class="field">
            <label for="vg-deposit-method">Deposit received by</label>
            <select class="input" id="vg-deposit-method">
              <option>Cash</option><option>Bank transfer</option><option>Cheque</option><option>Credit card</option><option>Payment link</option><option>Other</option>
            </select>
          </div>
          <div class="field">
            <label for="vg-deposit-account">Deposit received into</label>
            <select class="input" id="vg-deposit-account">
              ${optionsHtml(depositAccounts().accounts, { selected: (depositAccounts().accounts.find((a) => a.code === '1000') || depositAccounts().preferred)?.id, placeholder: '', labelKey: (account) => `${account.code} · ${account.name}` })}
            </select>
          </div>
          <div class="field full"><div class="form-note">Security deposits are not a sale. They are held in <strong>2600 Refundable Security Deposits Held</strong> until refunded, used for an invoice or forfeited.</div></div>
        </div>
      </div>

      <div class="field full">
        <div class="totals-panel">
          <div class="totals-row"><span>Total sale</span><span id="vg-sale">${fmtMoney(0)}</span></div>
          <div class="totals-row"><span>Total cost</span><span id="vg-cost">${fmtMoney(0)}</span></div>
          <div class="totals-row total"><span>Gross profit</span><span class="margin-positive" id="vg-margin">${fmtMoney(0)}</span></div>
          <div class="totals-row"><span class="muted">Security deposits (not a sale)</span><span class="muted" id="vg-deposits">${fmtMoney(0)}</span></div>
        </div>
      </div>

      <details class="field full more-details">
        <summary>More details</summary>
        <div class="form-grid">
          <div class="field">
            <label for="vg-due">Payment due</label>
            <input class="input" id="vg-due" name="due_date" type="date" value="${esc(dueDate)}" required>
          </div>
          <div class="field">
            <label for="vg-duration">Duration (days)</label>
            <input class="input" id="vg-duration" name="duration_days" type="number" min="1" max="3650" step="1" placeholder="e.g. 30">
          </div>
          <div class="field">
            <label for="vg-reference">Application / embassy ref</label>
            <input class="input" id="vg-reference" name="reference" placeholder="Optional" autocomplete="off">
          </div>
          <div class="field full">
            <label for="vg-notes">Internal notes</label>
            <textarea class="input" id="vg-notes" name="notes" rows="2" placeholder="Documents checklist, embassy appointment… Only staff see this; never printed."></textarea>
          </div>
          <div class="field full">
            <label for="vg-invoice-notes">Note on invoice</label>
            <textarea class="input" id="vg-invoice-notes" name="invoice_notes" rows="2" placeholder="Optional. Printed on each customer invoice and application summary."></textarea>
          </div>
        </div>
      </details>
    </div>
  `;

  let overlayRef = null;
  const rows = () => Array.from(overlayRef.querySelectorAll('[data-va-row]'));

  function recalc() {
    let sale = 0;
    let cost = 0;
    let deposits = 0;
    for (const row of rows()) {
      sale += toCents(row.querySelector('.va-sale').value);
      cost += toCents(row.querySelector('.va-cost').value);
      deposits += toCents(row.querySelector('.va-deposit').value);
    }
    overlayRef.querySelector('#vg-deposits').textContent = fmtMoney(deposits);
    overlayRef.querySelector('[data-deposit-received]').hidden = deposits <= 0;
    const margin = sale - cost;
    const marginEl = overlayRef.querySelector('#vg-margin');
    marginEl.textContent = fmtMoney(margin);
    marginEl.className = margin >= 0 ? 'margin-positive' : 'margin-negative';
    overlayRef.querySelector('#vg-sale').textContent = fmtMoney(sale);
    overlayRef.querySelector('#vg-cost').textContent = fmtMoney(cost);
  }

  function updateRemoveButtons() {
    const all = rows();
    all.forEach((row) => {
      const button = row.querySelector('[data-va-remove]');
      button.disabled = all.length <= 1;
      button.style.opacity = all.length <= 1 ? '0.35' : '';
    });
  }

  const modal = openModal({
    title: 'New visa application',
    subtitle: 'Add one or more applicants. Submitting creates each customer invoice and supplier bill automatically.',
    size: 'modal-xl',
    body,
    submitLabel: 'Create application',
    onMount(overlay) {
      bindMethodAccount(overlay.querySelector('#vg-deposit-method'), overlay.querySelector('#vg-deposit-account'), depositAccounts().accounts);
      overlayRef = overlay;
      const customerSelect = overlay.querySelector('#vg-customer');
      const wrap = overlay.querySelector('[data-va-rows]');
      let firstNameAuto = true;

      // The first applicant is usually the customer; fill the name until edited.
      customerSelect.addEventListener('change', () => {
        const first = rows()[0]?.querySelector('.va-name');
        if (first && firstNameAuto && customerSelect.selectedIndex > 0) {
          first.value = customerSelect.selectedOptions[0].textContent.trim();
        }
      });
      wrap.addEventListener('input', (event) => {
        if (event.target.classList.contains('va-name') && event.target === rows()[0]?.querySelector('.va-name')) firstNameAuto = false;
        recalc();
      });
      wrap.addEventListener('change', recalc);
      wrap.addEventListener('click', (event) => {
        const more = event.target.closest('[data-va-more]');
        if (more) {
          const details = more.closest('[data-va-row]').querySelector('.va-details');
          details.hidden = !details.hidden;
          more.setAttribute('aria-expanded', String(!details.hidden));
          return;
        }
        const remove = event.target.closest('[data-va-remove]');
        if (remove && !remove.disabled && rows().length > 1) {
          remove.closest('[data-va-row]').remove();
          updateRemoveButtons();
          recalc();
        }
      });
      // A new applicant usually costs the same and uses the same supplier.
      overlay.querySelector('[data-va-add]').addEventListener('click', () => {
        const previous = rows().at(-1);
        const holder = document.createElement('div');
        holder.innerHTML = applicantRowHtml({
          sale: toCents(previous?.querySelector('.va-sale').value),
          cost: toCents(previous?.querySelector('.va-cost').value),
          deposit: toCents(previous?.querySelector('.va-deposit').value),
          vendorId: Number(previous?.querySelector('.va-vendor').value) || '',
          saleAccountId: Number(previous?.querySelector('.va-sale-account').value) || '',
          costAccountId: Number(previous?.querySelector('.va-cost-account').value) || '',
        });
        const row = holder.firstElementChild;
        wrap.appendChild(row);
        row.querySelector('.va-name').focus();
        updateRemoveButtons();
        recalc();
      });
      updateRemoveButtons();
      recalc();
    },
    async onSubmit(form) {
      const values = new FormData(form);
      const customerId = Number(values.get('customer_id'));
      const customerName = form.querySelector('#vg-customer').selectedOptions[0]?.textContent.trim() || '';
      const visaType = values.get('visa_type');
      const country = String(values.get('destination_country') || '').trim();
      const description = `${visaTypes[visaType] || 'Visa'} visa${country ? ` · ${country}` : ''}`;
      const applicants = [];
      rows().forEach((row, index) => {
        const name = row.querySelector('.va-name').value.trim();
        const sale = toCents(row.querySelector('.va-sale').value);
        const cost = toCents(row.querySelector('.va-cost').value);
        const vendorId = Number(row.querySelector('.va-vendor').value);
        if (!name && !sale && !cost) return;
        const label = `Applicant ${index + 1}`;
        if (!name) throw new Error(`${label}: enter the applicant name`);
        if (!sale) throw new Error(`${label}: enter the sale price`);
        if (cost && !vendorId) throw new Error(`${label}: choose the supplier for the cost`);
        applicants.push({
          applicant_is_customer: name === customerName,
          applicant_name: name,
          deposit_cents: toCents(row.querySelector('.va-deposit').value),
          passport_number: row.querySelector('.va-passport').value.trim(),
          passport_expiry: row.querySelector('.va-expiry').value || null,
          nationality: row.querySelector('.va-nationality').value.trim(),
          date_of_birth: row.querySelector('.va-dob').value || null,
          sale_items: [{ description, quantity: 1, unit_price_cents: sale, account_id: Number(row.querySelector('.va-sale-account').value) }],
          cost_items: cost ? [{
            description,
            quantity: 1,
            unit_price_cents: cost,
            account_id: Number(row.querySelector('.va-cost-account').value),
            vendor_id: vendorId,
          }] : [],
        });
      });
      if (!applicants.length) throw new Error('Add at least one applicant');
      const result = await api.post('/visas/groups', {
        customer_id: customerId,
        visa_type: visaType,
        destination_country: country,
        application_date: values.get('application_date'),
        travel_date: values.get('travel_date') || null,
        due_date: values.get('due_date'),
        duration_days: values.get('duration_days') || null,
        reference: values.get('reference'),
        notes: values.get('notes'),
        invoice_notes: values.get('invoice_notes'),
        applicants,
        deposit: {
          method: form.querySelector('#vg-deposit-method').value,
          account_id: Number(form.querySelector('#vg-deposit-account').value) || null,
        },
      });
      const first = result.applications[0];
      toast(result.group
        ? `${result.applications.length} applications created · group ${result.group.number}`
        : `Visa application ${first.number} created`);
      result.applications.filter((visa) => visa.passport_warning)
        .forEach((visa) => toast(`${visa.applicant_name}: ${visa.passport_warning}`, 'error'));
      onSaved(first, result);
    },
  });
  return modal;
}
