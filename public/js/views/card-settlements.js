import { bindCorrections, correctButtonHtml } from '../corrections.js';
import { api } from '../api.js';
import { cashAccounts } from '../store.js';
import {
  currencySymbol,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  optionsHtml,
  setHeader,
  statusBadge,
  summaryStripHtml,
  todayISO,
  toast,
  toCents,
  voidDialog,
} from '../ui.js';

// Card and payment link money waiting in 1030 until the gateway pays the
// batch into the bank. Tick the items in the batch, enter what arrived, and
// the difference is the fee.

function itemRow(item) {
  return `
    <tr>
      <td><input type="checkbox" data-settle-item value="${item.id}" data-amount="${item.amount_cents}" aria-label="Include ${esc(item.payment_number || item.reference || item.memo)}"></td>
      <td class="nowrap">${esc(fmtDate(item.entry_date))}</td>
      <td><div class="cell-main">${esc(item.customer_name || item.memo || '')}</div>
        <div class="cell-sub">${esc([item.payment_method, item.payment_number || item.reference].filter(Boolean).join(' · '))}</div></td>
      <td class="num">${fmtMoney(item.amount_cents)}</td>
    </tr>`;
}

function settlementRow(row) {
  return `
    <tr>
      <td class="nowrap">${esc(fmtDate(row.settlement_date))}<div class="cell-sub">${esc(row.number)}</div></td>
      <td>${esc(row.bank_name)}<div class="cell-sub">${row.item_count} item${row.item_count === 1 ? '' : 's'}${row.reference ? ` · ${esc(row.reference)}` : ''}</div></td>
      <td class="num">${fmtMoney(row.gross_cents)}</td>
      <td class="num">${row.fee_cents ? `${fmtMoney(row.fee_cents)}<div class="cell-sub">${((row.fee_cents / row.gross_cents) * 100).toFixed(2)}%</div>` : '—'}</td>
      <td class="num">${fmtMoney(row.net_cents)}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${row.status === 'posted' ? correctButtonHtml('card_settlement', row) : ''}${row.status === 'posted' ? `<button class="icon-btn danger" data-void-settlement="${row.id}" title="Void settlement" aria-label="Void ${esc(row.number)}">${icon('x', 15)}</button>` : ''}</td>
    </tr>`;
}

export async function render(container) {
  const data = await api.get('/card-settlements');
  const banks = cashAccounts().filter((account) => !['1000', '1020', '1030'].includes(account.code)).sort((a, b) => a.code.localeCompare(b.code));
  const refresh = () => render(container);

  setHeader({
    title: 'Card settlements',
  });

  container.innerHTML = `
    ${summaryStripHtml([
      { label: 'Waiting for the gateway', value: fmtMoney(data.in_transit_cents) },
      { label: 'Open items', value: String(data.items.length) },
      { label: 'Selected', html: `<span data-settle-selected>${esc(fmtMoney(0))}</span>` },
      { label: 'Fee (selected − received)', html: `<span data-settle-fee>${esc(fmtMoney(0))}</span>` },
    ])}
    <div class="card">
      <div class="card-head"><div class="card-title"><h2>Waiting to settle</h2></div></div>
      ${data.items.length ? `
        <div class="table-wrap"><table class="data" data-settle-items><caption class="sr-only">Card and payment link items waiting to settle</caption>
          <thead><tr><th scope="col"><input type="checkbox" data-settle-all aria-label="Select all items"></th><th scope="col">Date</th><th scope="col">Customer</th><th scope="col" class="num">Amount</th></tr></thead>
          <tbody>${data.items.map(itemRow).join('')}</tbody>
        </table></div>
        <form class="settle-form" data-settle-form>
          <div class="field"><label for="settle-net">Received in the bank</label>
            <div class="money-input"><span>${esc(currencySymbol())}</span><input class="input" id="settle-net" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00" required></div></div>
          <div class="field"><label for="settle-date">Date on bank statement</label><input class="input" id="settle-date" type="date" value="${todayISO()}" required></div>
          <div class="field"><label for="settle-bank">Bank account</label><select class="input" id="settle-bank">${optionsHtml(banks, { selected: banks.find((a) => a.code === '1010')?.id, labelKey: (a) => `${a.code} · ${a.name}` })}</select></div>
          <div class="field"><label for="settle-ref">Payout reference <span class="muted">(optional)</span></label><input class="input" id="settle-ref" autocomplete="off"></div>
          <button type="submit" class="btn btn-primary">Record settlement</button>
        </form>`
        : emptyState({ iconName: 'check', title: 'Nothing waiting' })}
    </div>
    ${data.settlements.length ? `<div class="card" style="margin-top:16px">
      <div class="card-head"><div class="card-title"><h2>Settlements</h2></div></div>
      <div class="table-wrap"><table class="data" data-settlements><caption class="sr-only">Card settlements</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Bank</th><th scope="col" class="num">Items</th><th scope="col" class="num">Fee</th><th scope="col" class="num">Received</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${data.settlements.map(settlementRow).join('')}</tbody></table></div>
    </div>` : ''}
  `;

  const form = container.querySelector('[data-settle-form]');
  const selectedOut = container.querySelector('[data-settle-selected]');
  const feeOut = container.querySelector('[data-settle-fee]');
  const boxes = () => [...container.querySelectorAll('[data-settle-item]')];
  const selectedTotal = () => boxes().filter((box) => box.checked).reduce((sum, box) => sum + Number(box.dataset.amount), 0);
  const update = () => {
    const selected = selectedTotal();
    const net = form ? toCents(form.querySelector('#settle-net').value || 0) : 0;
    selectedOut.textContent = fmtMoney(selected);
    feeOut.textContent = net ? fmtMoney(selected - net) : fmtMoney(0);
  };
  boxes().forEach((box) => box.addEventListener('change', update));
  container.querySelector('[data-settle-all]')?.addEventListener('change', (event) => {
    boxes().forEach((box) => { box.checked = event.target.checked; });
    update();
  });
  form?.querySelector('#settle-net').addEventListener('input', update);
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const lineIds = boxes().filter((box) => box.checked).map((box) => Number(box.value));
    if (!lineIds.length) { toast('Tick the items in this payout', 'error'); return; }
    try {
      const saved = await api.post('/card-settlements', {
        line_ids: lineIds,
        net_cents: toCents(form.querySelector('#settle-net').value),
        settlement_date: form.querySelector('#settle-date').value,
        bank_account_id: Number(form.querySelector('#settle-bank').value),
        reference: form.querySelector('#settle-ref').value,
      });
      toast(`Settlement ${saved.number} recorded${saved.fee_cents ? ` · fee ${fmtMoney(saved.fee_cents)}` : ''}`);
      refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  bindCorrections(container, refresh);
  container.querySelectorAll('[data-void-settlement]').forEach((button) => button.addEventListener('click', async () => {
    const row = data.settlements.find((item) => item.id === Number(button.dataset.voidSettlement));
    const result = await voidDialog({
      title: `Void ${row.number}?`,
      message: `The payout entry is reversed and its ${row.item_count} item${row.item_count === 1 ? '' : 's'} go back to waiting.`,
      confirmLabel: 'Void settlement',
    });
    if (!result.confirmed) return;
    try {
      await api.post(`/card-settlements/${row.id}/void`, { remarks: result.remarks });
      toast(`${row.number} voided`);
      refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
}
