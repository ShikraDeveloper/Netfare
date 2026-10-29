import { cashAccounts, portalForVendorId } from '../store.js';
import {
  centsToInput,
  currencySymbol,
  esc,
  fmtMoney,
  optionsHtml,
  todayISO,
} from '../ui.js';

// What confirming a booking or submitting a visa will post: the customer
// invoice, one bill per supplier, and which bills a prepaid wallet pays.
export function postingPreview(job, portals = null) {
  const bySupplier = new Map();
  for (const item of job.cost_items || []) {
    const key = Number(item.vendor_id) || 0;
    const row = bySupplier.get(key) || { name: item.vendor_name || 'Supplier', cents: 0 };
    row.cents += Number(item.amount_cents) || 0;
    bySupplier.set(key, row);
  }
  const items = [{
    label: `Customer invoice — ${job.customer_name || 'customer'}`,
    note: 'Receivable in 1100 Trade Receivables; payment due by the job due date.',
    value: fmtMoney(job.sale_total_cents),
  }];
  for (const [vendorId, row] of bySupplier) {
    const portal = portals
      ? portals.find((row) => row.vendor_id === vendorId && row.is_active) || null
      : portalForVendorId(vendorId);
    let note = 'Supplier bill, payable in 2000 Trade Payables.';
    if (portal && portal.settlement === 'prepaid') {
      const wallet = Number(portal.balance_cents) || 0;
      note = wallet >= row.cents
        ? `Paid from the ${portal.name} wallet (balance ${fmtMoney(wallet)} → ${fmtMoney(wallet - row.cents)}).`
        : `${portal.name} wallet has ${fmtMoney(Math.max(0, wallet))}; ${fmtMoney(row.cents - Math.max(0, wallet))} stays payable.`;
    } else if (portal) {
      note = `Supplier bill on the ${portal.name} credit account.`;
    }
    items.push({ label: `Supplier bill — ${row.name}`, note, value: fmtMoney(row.cents) });
  }
  // Open advances on the job pay the new invoice straight away.
  let toApply = job.sale_total_cents || 0;
  for (const advance of (job.advances || []).filter((row) => !row.voided && row.remaining_cents > 0)) {
    if (toApply <= 0) break;
    const amount = Math.min(advance.remaining_cents, toApply);
    toApply -= amount;
    items.push({
      label: `Paid from advance ${advance.number}`,
      note: 'Applied to the invoice automatically (Dr 2400 · Cr 1100).',
      value: `−${fmtMoney(amount)}`,
    });
  }
  const margin = (job.sale_total_cents || 0) - (job.cost_total_cents || 0);
  return {
    heading: 'This will post',
    icon: 'check',
    items,
    total: { label: 'Gross profit', value: fmtMoney(margin) },
    note: bySupplier.size ? '' : 'No supplier cost is recorded, so no bill is created.',
  };
}

export function depositAccounts() {
  const accounts = cashAccounts().slice().sort((a, b) => a.code.localeCompare(b.code));
  const preferred = accounts.find((account) => account.code === '1010')
    || accounts.find((account) => account.is_cash)
    || accounts[0];
  return { accounts, preferred };
}

export function advanceModalBody(job, kind = 'booking') {
  const { accounts, preferred } = depositAccounts();
  return `
    <div class="form-grid">
      <div class="field">
        <label for="adv-amount">Advance amount</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="adv-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(job.balance_cents)}" required>
        </div>
        <div class="hint">${kind === 'visa' ? 'Application balance' : 'Booking balance'} ${fmtMoney(job.balance_cents)}</div>
      </div>
      <div class="field">
        <label for="adv-date">Date received</label>
        <input class="input" id="adv-date" name="advance_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label for="adv-method">Method</label>
        <select class="input" id="adv-method" name="method">
          <option>Bank transfer</option><option>Cheque</option><option>Cash</option><option>Credit card</option><option>Other</option>
        </select>
      </div>
      <div class="field">
        <label for="adv-ref">Reference</label>
        <input class="input" id="adv-ref" name="reference" placeholder="e.g. deposit slip no." autocomplete="off">
      </div>
      <div class="field full">
        <label for="adv-account">Deposit to</label>
        <select class="input" id="adv-account" name="deposit_account_id">
          ${optionsHtml(accounts, { selected: preferred?.id, placeholder: 'Choose account…', labelKey: (account) => `${account.code} · ${account.name}` })}
        </select>
      </div>
      <div class="field full">
        <div class="form-note">${kind === 'visa' ? 'Money received before the application is invoiced.' : 'Money received before the trip.'} It is held as a <strong>Contract Liabilities (Customer Advances)</strong> liability until you apply it to an invoice.</div>
      </div>
    </div>
  `;
}

export function applyModalBody(job, advances) {
  return `
    <div class="form-grid">
      <div class="field full">
        <label for="apply-advance">Advance to apply</label>
        <select class="input" id="apply-advance" name="advance_id">
          ${optionsHtml(advances, { placeholder: 'Choose an advance…', labelKey: (advance) => `${advance.number} · ${fmtMoney(advance.remaining_cents)} available` })}
        </select>
      </div>
      <div class="field">
        <label for="apply-date">Application date</label>
        <input class="input" id="apply-date" name="payment_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field">
        <label>Invoice</label>
        <input class="input" value="${esc(job.invoice.number)} · ${fmtMoney(job.invoice.balance_cents)} due" disabled>
      </div>
      <div class="field full">
        <div class="form-note">Applying the advance reduces the invoice balance and moves the amount from Contract Liabilities (Customer Advances) to Trade Receivables.</div>
      </div>
    </div>
  `;
}

export function refundModalBody(advance) {
  const { accounts, preferred } = depositAccounts();
  return `
    <div class="form-grid">
      <div class="field">
        <label for="ref-amount">Refund amount</label>
        <div class="money-input">
          <span>${esc(currencySymbol())}</span>
          <input class="input" id="ref-amount" name="amount" type="number" min="0.01" step="0.01" value="${centsToInput(advance.remaining_cents)}" required>
        </div>
        <div class="hint">${fmtMoney(advance.remaining_cents)} available on ${esc(advance.number)}</div>
      </div>
      <div class="field">
        <label for="ref-date">Refund date</label>
        <input class="input" id="ref-date" name="refund_date" type="date" value="${todayISO()}" required>
      </div>
      <div class="field full">
        <label for="ref-account">Refund from</label>
        <select class="input" id="ref-account" name="payment_account_id">
          ${optionsHtml(accounts, { selected: preferred?.id, placeholder: 'Choose account…', labelKey: (account) => `${account.code} · ${account.name}` })}
        </select>
      </div>
      <div class="field full">
        <div class="form-note">Refunding debits Contract Liabilities (Customer Advances) and credits your bank or cash account.</div>
      </div>
    </div>
  `;
}

