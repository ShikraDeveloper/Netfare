import { store } from './store.js';
import { centsToInput, currencySymbol, esc, fmtDate, fmtMoney, toCents, todayISO } from './ui.js';

// "Opening balance" on the new customer, supplier and portal forms, for the
// admin only. The server turns it into an opening invoice, bill, credit or
// portal balance (services/party-opening.js): "owes us" becomes an opening
// invoice, credit or portal balance, "we owe" an opening bill or customer
// credit, and the other side goes to 3900 Opening Balance Equity, never to
// sales or purchases.

const CHOICES = {
  customer: [
    ['they_owe', 'Customer owes us'],
    ['we_owe', 'We owe the customer'],
  ],
  vendor: [
    ['we_owe', 'We owe the supplier'],
    ['they_owe', 'Supplier owes us'],
  ],
  portal: [
    ['they_owe', 'Balance held on the portal'],
    ['we_owe', 'We owe the supplier'],
  ],
};

export function canEnterOpening() {
  return Boolean(store.user?.is_admin);
}

// `status` (from GET /…/:id/opening) is given when editing an existing record.
export function openingFieldsHtml(kind, status = null, name = '') {
  if (!canEnterOpening()) return '';
  const choices = CHOICES[kind];
  const current = status?.opening;
  const label = current ? choices.find(([value]) => value === current.direction)?.[1] : '';
  const title = current
    ? `Opening balance: ${fmtMoney(current.amount_cents)} · ${esc(label)} · ${esc(fmtDate(current.as_of))} · ${esc(current.number)}${current.used_cents ? ` · ${fmtMoney(current.used_cents)} paid or used` : ''}`
    : 'Opening balance';
  if (status?.locked) {
    return `
    <div class="field full opening-fields">
      <label>${title}</label>
      <div class="callout" role="note" style="margin-top:8px">🔒 <strong>Locked.</strong> The books are closed through ${esc(fmtDate(status.closed_through))}. To change this opening balance, move the closing date in Settings first.</div>
    </div>`;
  }
  const checked = (value, index) => (current ? current.direction === value : index === 0);
  return `
    <details class="field full opening-fields" ${current ? 'open' : ''}>
      <summary>${title}</summary>
      <div class="form-grid" style="margin-top:10px">
        <div class="field full">
          <div class="radio-row" role="radiogroup" aria-label="Who owes the opening balance">
            ${choices.map(([value, label], index) => `
              <label class="radio-option">
                <input type="radio" name="opening_direction" value="${value}" ${checked(value, index) ? 'checked' : ''}>
                <span><strong>${esc(label)}</strong></span>
              </label>`).join('')}
          </div>
        </div>
        <div class="field">
          <label for="opening-amount">Amount</label>
          <div class="money-input">
            <span>${esc(currencySymbol())}</span>
            <input class="input" id="opening-amount" name="opening_amount" type="number" min="0" step="0.01" placeholder="0.00" inputmode="decimal" value="${current ? centsToInput(current.amount_cents) : ''}">
          </div>
        </div>
        <div class="field">
          <label for="opening-date">As of</label>
          <input class="input" id="opening-date" name="opening_as_of" type="date" value="${esc(current?.as_of || todayISO())}">
        </div>
        ${current ? `
        <div class="field full">
          <div class="callout warning" role="note">⚠️ Changing this changes ${esc(name)}'s starting balance from ${esc(fmtDate(current.as_of))}. Their statement, aging and reports from that date will change. ${esc(current.number)} is reversed on its own date and kept in history. Leave the amount empty to remove it. It locks once the books are closed through its date.</div>
        </div>
        <div class="field full">
          <label for="opening-reason">Why (needed to change it)</label>
          <input class="input" id="opening-reason" name="opening_reason" maxlength="500" placeholder="Opening amount entered wrong">
        </div>` : ''}
      </div>
    </details>`;
}

// True when the edit form asks for a different opening balance than `status` has.
export function openingChanged(form, status) {
  const wanted = readOpening(form);
  const current = status?.opening;
  if (!current) return Boolean(wanted);
  if (!wanted) return true;
  return wanted.direction !== current.direction || wanted.amount_cents !== current.amount_cents || wanted.as_of !== current.as_of;
}

// null when no amount was entered.
export function readOpening(form) {
  const amount = form.querySelector('#opening-amount')?.value;
  if (!amount || toCents(amount) <= 0) return null;
  return {
    direction: form.querySelector('input[name="opening_direction"]:checked')?.value,
    amount_cents: toCents(amount),
    as_of: form.querySelector('#opening-date')?.value,
  };
}
