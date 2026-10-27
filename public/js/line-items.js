import { centsToInput, currencySymbol, esc, fmtMoney, icon, optionsHtml, toCents } from './ui.js';

function accountOptions(accounts, selected) {
  return optionsHtml(accounts, {
    selected,
    placeholder: 'Choose account…',
    labelKey: (account) => `${account.code} · ${account.name}`,
  });
}

// Compact rows show what most invoices need (description and amount); quantity
// and account sit behind ⋯ with the same classes, so the editor works the same.
function compactLineRow(item, accounts) {
  return `
    <div class="line-row compact" data-line>
      <input class="input line-desc" placeholder="Service, fee or commission" value="${esc(item.description || '')}" autocomplete="off" aria-label="Description">
      <div class="money-input">
        <span>${esc(currencySymbol())}</span>
        <input class="input line-price" type="number" min="0" step="0.01" inputmode="decimal" value="${item.unit_price_cents ? esc(centsToInput(item.unit_price_cents)) : ''}" placeholder="0.00" aria-label="Amount">
      </div>
      <button type="button" class="icon-btn" data-line-more aria-expanded="false" title="Quantity and account" aria-label="Quantity and account">${icon('more', 16)}</button>
      <button type="button" class="icon-btn danger line-remove" title="Remove line" aria-label="Remove line">${icon('x', 16)}</button>
      <div class="line-details" hidden>
        <label>Qty
          <input class="input line-qty" type="number" min="0.01" step="any" value="${esc(item.quantity ?? 1)}">
        </label>
        <label>Account
          <select class="input line-account">${accountOptions(accounts, item.account_id || (accounts[0] && accounts[0].id))}</select>
        </label>
        <div class="line-details-total">Line total <span class="line-amount">${fmtMoney(0)}</span></div>
      </div>
    </div>
  `;
}

function lineRow(item, accounts, { compact = false } = {}) {
  if (compact) return compactLineRow(item, accounts);
  return `
    <div class="line-row" data-line>
      <input class="input line-desc" placeholder="Description of item or service" value="${esc(item.description || '')}" autocomplete="off">
      <input class="input line-qty" type="number" min="0.01" step="any" value="${esc(item.quantity ?? 1)}" aria-label="Quantity">
      <div class="money-input">
        <span>${esc(currencySymbol())}</span>
        <input class="input line-price" type="number" min="0" step="0.01" value="${esc(centsToInput(item.unit_price_cents || 0))}" aria-label="Unit price">
      </div>
      <select class="input line-account" aria-label="Account">${accountOptions(accounts, item.account_id || (accounts[0] && accounts[0].id))}</select>
      <div class="line-amount">${fmtMoney(0)}</div>
      <button type="button" class="icon-btn danger line-remove" title="Remove line">${icon('x', 16)}</button>
    </div>
  `;
}

export function lineItemsHtml(items, accounts, { compact = false } = {}) {
  const rows = items.length ? items : [{ quantity: 1, unit_price_cents: 0 }];
  if (compact) {
    return `
      <div class="line-items-wrap">
        <div class="line-items compact" data-line-items data-compact>
          <div class="line-head compact" aria-hidden="true"><div>Description</div><div>Amount</div><div></div><div></div></div>
          <div class="line-rows" data-line-rows>
            ${rows.map((item) => lineRow(item, accounts, { compact: true })).join('')}
          </div>
        </div>
        <div class="line-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-add-line>${icon('plus', 15)} Add line</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="line-items-wrap">
      <div class="line-items" data-line-items>
        <div class="line-head">
          <div>Description</div>
          <div>Qty</div>
          <div>Unit price</div>
          <div>Account</div>
          <div style="text-align:right">Amount</div>
          <div></div>
        </div>
        <div class="line-rows" data-line-rows>
          ${rows.map((item) => lineRow(item, accounts)).join('')}
        </div>
      </div>
      <div class="line-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-add-line>${icon('plus', 15)} Add line</button>
        <span class="line-total-live"></span>
      </div>
    </div>
  `;
}

export function mountLineItems(root, { accounts, onTotals = () => {} }) {
  const rowsContainer = root.querySelector('[data-line-rows]');
  const addButton = root.querySelector('[data-add-line]');
  const compact = Boolean(root.querySelector('[data-line-items][data-compact]'));
  if (!rowsContainer) return { getItems: () => [], recalc: () => {}, getTotals: () => ({}) };

  function rows() {
    return Array.from(rowsContainer.querySelectorAll('[data-line]'));
  }

  function updateRemoveButtons() {
    const all = rows();
    all.forEach((row) => {
      const button = row.querySelector('.line-remove');
      if (button) button.disabled = all.length <= 1;
      if (button) button.style.opacity = all.length <= 1 ? '0.35' : '';
    });
  }

  function rowAmount(row) {
    const quantity = Number.parseFloat(row.querySelector('.line-qty').value) || 0;
    const unit = toCents(row.querySelector('.line-price').value);
    return Math.round(quantity * unit);
  }

  function recalc() {
    let subtotal = 0;
    for (const row of rows()) {
      const amount = rowAmount(row);
      subtotal += amount;
      row.querySelector('.line-amount').textContent = fmtMoney(amount);
    }
    const live = root.querySelector('.line-total-live');
    if (live) live.textContent = rows().length ? `Subtotal ${fmtMoney(subtotal)}` : '';
    onTotals({ subtotal_cents: subtotal, total_cents: subtotal });
    updateRemoveButtons();
    return { subtotal_cents: subtotal, total_cents: subtotal };
  }

  function addRow() {
    const items = rowsContainer;
    const holder = document.createElement('div');
    // A new compact line keeps the account of the line above.
    const previousAccount = rows().at(-1)?.querySelector('.line-account')?.value;
    holder.innerHTML = lineRow({ quantity: 1, unit_price_cents: 0, account_id: compact ? Number(previousAccount) || null : null }, accounts, { compact });
    const row = holder.firstElementChild;
    items.appendChild(row);
    recalc();
    const input = row.querySelector('.line-desc');
    if (input) input.focus();
  }

  rowsContainer.addEventListener('input', (event) => {
    if (event.target.closest('[data-line]')) recalc();
  });
  rowsContainer.addEventListener('change', (event) => {
    if (event.target.closest('[data-line]')) recalc();
  });
  rowsContainer.addEventListener('click', (event) => {
    const more = event.target.closest('[data-line-more]');
    if (more) {
      const details = more.closest('[data-line]').querySelector('.line-details');
      details.hidden = !details.hidden;
      more.setAttribute('aria-expanded', String(!details.hidden));
      return;
    }
    const remove = event.target.closest('.line-remove');
    if (!remove || remove.disabled) return;
    const row = remove.closest('[data-line]');
    if (rows().length <= 1) return;
    row.remove();
    recalc();
  });
  if (addButton) addButton.addEventListener('click', addRow);

  recalc();

  return {
    getItems() {
      return rows().map((row) => ({
        description: row.querySelector('.line-desc').value.trim(),
        quantity: Number.parseFloat(row.querySelector('.line-qty').value) || 0,
        unit_price_cents: toCents(row.querySelector('.line-price').value),
        account_id: Number(row.querySelector('.line-account').value),
      }));
    },
    recalc,
    getTotals: recalc,
  };
}
