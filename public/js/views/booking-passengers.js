import { activeVendors, portalForVendorId, purchaseAccounts, revenueAccounts } from '../store.js';
import { centsToInput, currencySymbol, esc, fmtMoney, icon, optionsHtml, toCents } from '../ui.js';

// One row per passenger: what the customer pays, what the supplier charges and
// who the supplier is. Rows that are not a passenger (hotel, service fee,
// insurance) use a description instead. Each row becomes a sale line and,
// when it has a cost, a matching cost line that shares its line_group.

const DEFAULT_ACCOUNTS = {
  passenger: { sale: '4000', cost: '5000' },
  item: { sale: '4100', cost: '5100' },
};

function accountIdByCode(accounts, code) {
  return accounts.find((account) => account.code === code)?.id || accounts[0]?.id || '';
}

function vendorLabel(vendor) {
  const portal = portalForVendorId(vendor.id);
  if (!portal) return vendor.name;
  return `${vendor.name} — ${portal.settlement === 'prepaid' ? 'wallet' : 'credit'}`;
}

// Rebuild rows from saved booking items. Lines saved before passenger rows
// existed have no line_group; each becomes its own row.
export function rowsFromItems(saleItems = [], costItems = []) {
  const rows = [];
  const groups = new Map();
  const place = (item, side) => {
    const key = item.line_group ? Number(item.line_group) : null;
    let row = key != null ? groups.get(key) : null;
    if (!row) {
      row = {
        kind: item.passenger_name ? 'passenger' : 'item',
        label: item.passenger_name || item.description || '',
        sale: null,
        cost: null,
      };
      rows.push(row);
      if (key != null) groups.set(key, row);
    }
    row[side] = item;
  };
  saleItems.forEach((item) => place(item, 'sale'));
  costItems.forEach((item) => {
    // Older lines: pair a cost with the sale line of the same description.
    if (!item.line_group) {
      const match = rows.find((row) => row.sale && !row.cost && !row.sale.line_group
        && row.sale.description === item.description);
      if (match) {
        match.cost = item;
        return;
      }
    }
    place(item, 'cost');
  });
  return rows;
}

function rowHtml(row = {}, { supplierId = '' } = {}) {
  const kind = row.kind === 'item' ? 'item' : 'passenger';
  const defaults = DEFAULT_ACCOUNTS[kind];
  const sales = revenueAccounts();
  const costs = purchaseAccounts();
  const quantity = row.sale?.quantity ?? row.cost?.quantity ?? 1;
  const isPassenger = kind === 'passenger';
  return `
    <div class="px-row" data-px-row data-kind="${kind}">
      <input class="input px-label" value="${esc(row.label || '')}" autocomplete="off"
        placeholder="${isPassenger ? 'Passenger name' : 'Hotel, service fee, insurance…'}"
        aria-label="${isPassenger ? 'Passenger name' : 'Item description'}">
      <div class="money-input"><span>${esc(currencySymbol())}</span>
        <input class="input px-sale" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Sale price"
          value="${row.sale ? esc(centsToInput(row.sale.unit_price_cents)) : ''}" placeholder="0.00">
      </div>
      <div class="money-input"><span>${esc(currencySymbol())}</span>
        <input class="input px-cost" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Supplier cost"
          value="${row.cost ? esc(centsToInput(row.cost.unit_price_cents)) : ''}" placeholder="0.00">
      </div>
      <select class="input px-vendor" aria-label="Supplier">
        ${optionsHtml(activeVendors(), { selected: row.cost?.vendor_id ?? supplierId, placeholder: 'Supplier…', labelKey: vendorLabel })}
      </select>
      <button type="button" class="icon-btn" data-px-more aria-expanded="false" title="More details for this row" aria-label="More details for this row">${icon('more', 16)}</button>
      <button type="button" class="icon-btn danger" data-px-remove title="Remove row" aria-label="Remove row">${icon('x', 16)}</button>
      <div class="px-details" hidden>
        <label>Qty
          <input class="input px-qty" type="number" min="0.01" step="any" value="${esc(quantity)}">
        </label>
        <label>Sale account
          <select class="input px-sale-account">
            ${optionsHtml(sales, { selected: row.sale?.account_id ?? accountIdByCode(sales, defaults.sale), placeholder: '', labelKey: (a) => `${a.code} · ${a.name}` })}
          </select>
        </label>
        <label>Cost account
          <select class="input px-cost-account">
            ${optionsHtml(costs, { selected: row.cost?.account_id ?? accountIdByCode(costs, defaults.cost), placeholder: '', labelKey: (a) => `${a.code} · ${a.name}` })}
          </select>
        </label>
        <label>${isPassenger ? 'Ticket no. / PNR' : 'Supplier ref'}
          <input class="input px-ref" value="${esc(row.cost?.supplier_ref || '')}" autocomplete="off" placeholder="${isPassenger ? 'Empty: the booking PNR' : 'Optional'}">
        </label>
      </div>
    </div>
  `;
}

export function passengerSectionHtml(rows = []) {
  const list = rows.length ? rows : [{ kind: 'passenger' }];
  return `
    <div class="field full">
      <div class="bk-section-title">
        <label>Passengers</label>
        <div class="px-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-px-add="passenger">${icon('plus', 14)} Add passenger</button>
          <button type="button" class="btn btn-ghost btn-sm" data-px-add="item">${icon('plus', 14)} Add other item</button>
        </div>
      </div>
      <div class="bk-wrap">
        <div class="px-head" aria-hidden="true">
          <div>Passenger / item</div><div>Sale price</div><div>Cost</div><div>Supplier</div><div></div><div></div>
        </div>
        <div data-px-rows>${list.map((row) => rowHtml(row)).join('')}</div>
      </div>
    </div>
  `;
}

export function mountPassengerEditor(overlay) {
  const wrap = overlay.querySelector('[data-px-rows]');
  const rows = () => Array.from(wrap.querySelectorAll('[data-px-row]'));

  function recalc() {
    let sale = 0;
    let cost = 0;
    for (const row of rows()) {
      const qty = Number.parseFloat(row.querySelector('.px-qty').value) || 0;
      sale += Math.round(qty * toCents(row.querySelector('.px-sale').value));
      cost += Math.round(qty * toCents(row.querySelector('.px-cost').value));
    }
    const margin = sale - cost;
    const marginEl = overlay.querySelector('#bk-margin');
    marginEl.textContent = fmtMoney(margin);
    marginEl.className = margin >= 0 ? 'margin-positive' : 'margin-negative';
    overlay.querySelector('#bk-sale').textContent = fmtMoney(sale);
    overlay.querySelector('#bk-cost').textContent = fmtMoney(cost);
    overlay.querySelector('#bk-margin-percent').textContent = sale ? `${((margin / sale) * 100).toFixed(1)}% gross margin` : '—';
  }

  function updateRemoveButtons() {
    const all = rows();
    all.forEach((row) => {
      const button = row.querySelector('[data-px-remove]');
      button.disabled = all.length <= 1;
      button.style.opacity = all.length <= 1 ? '0.35' : '';
    });
  }

  function add(kind) {
    // The supplier of the last passenger usually applies to the next one.
    const previous = rows().reverse().find((row) => row.dataset.kind === kind && row.querySelector('.px-vendor').value);
    const holder = document.createElement('div');
    holder.innerHTML = rowHtml({ kind }, { supplierId: previous ? Number(previous.querySelector('.px-vendor').value) : '' });
    const row = holder.firstElementChild;
    wrap.appendChild(row);
    row.querySelector('.px-label').focus();
    updateRemoveButtons();
    recalc();
  }

  overlay.querySelectorAll('[data-px-add]').forEach((button) => {
    button.addEventListener('click', () => add(button.dataset.pxAdd));
  });
  wrap.addEventListener('input', recalc);
  wrap.addEventListener('change', recalc);
  wrap.addEventListener('click', (event) => {
    const more = event.target.closest('[data-px-more]');
    if (more) {
      const details = more.closest('[data-px-row]').querySelector('.px-details');
      details.hidden = !details.hidden;
      more.setAttribute('aria-expanded', String(!details.hidden));
      return;
    }
    const remove = event.target.closest('[data-px-remove]');
    if (remove && !remove.disabled && rows().length > 1) {
      remove.closest('[data-px-row]').remove();
      updateRemoveButtons();
      recalc();
    }
  });

  // Rows become sale and cost lines that share a line_group.
  function getItems() {
    const sale = [];
    const cost = [];
    const problems = [];
    rows().forEach((row, index) => {
      const label = row.querySelector('.px-label').value.trim();
      const saleCents = toCents(row.querySelector('.px-sale').value);
      const costCents = toCents(row.querySelector('.px-cost').value);
      if (!label && !saleCents && !costCents) return;
      const isPassenger = row.dataset.kind === 'passenger';
      const name = `Row ${index + 1}`;
      if (!label) problems.push(`${name}: enter the ${isPassenger ? 'passenger name' : 'item description'}`);
      if (!saleCents && !costCents) problems.push(`${name}: enter a sale price or a cost`);
      const vendorId = Number(row.querySelector('.px-vendor').value);
      if (costCents && !vendorId) problems.push(`${name}: choose the supplier for the cost`);
      const common = {
        description: label,
        passenger_name: isPassenger ? label : '',
        line_group: index + 1,
        quantity: Number.parseFloat(row.querySelector('.px-qty').value) || 1,
      };
      if (saleCents) {
        sale.push({ ...common, unit_price_cents: saleCents, account_id: Number(row.querySelector('.px-sale-account').value) });
      }
      if (costCents) {
        cost.push({
          ...common,
          unit_price_cents: costCents,
          account_id: Number(row.querySelector('.px-cost-account').value),
          vendor_id: vendorId,
          supplier_ref: row.querySelector('.px-ref').value.trim(),
        });
      }
    });
    return { sale, cost, problems };
  }

  updateRemoveButtons();
  recalc();
  return { getItems, recalc };
}
