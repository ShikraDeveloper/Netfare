import { store } from '../../store.js';
import { emptyState, esc, fmtDate } from '../../ui.js';
import { periodLabel, reportHeader } from './common.js';

// Daily Sales Report laid out like a travel counter's DSR: a ticket sales
// list and a visa sales list with how each sale was settled in its own
// column (Cash, Card, Bank, Credit) and totals, then money received for
// older invoices, and the closing boxes: payments, cash in hand, sales by
// how they were paid, the bank account, and suppliers and portal wallets
// with a balance. Cost and gross profit show only with "Show profit".

const PROFIT_KEY = 'ledgerly.dsr.showProfit';

export function profitShown() {
  try { return localStorage.getItem(PROFIT_KEY) === '1'; } catch { return false; }
}

export function rememberProfit(shown) {
  try { localStorage.setItem(PROFIT_KEY, shown ? '1' : '0'); } catch { /* per-viewer convenience only */ }
}

const amountFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (cents) => esc(amountFormat.format((Number(cents) || 0) / 100));
// A money cell: empty when nothing, as on the counter's sheet.
const cell = (cents) => (cents ? money(cents) : '');
const sumOf = (rows, pick) => rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
// "INV-2026-0022" → "INV-0022": the year is on the report already.
const short = (number) => String(number || '').replace(/-\d{4}-/, '-');
const firstName = (name) => String(name || '').split(' ')[0];

function timeOf(createdAt) {
  if (!createdAt) return '';
  const date = new Date(`${String(createdAt).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const whenCell = (date, createdAt) => `<td class="dsr-when">${esc(fmtDate(date, { short: true }))}<div class="dsr-sub">${esc(timeOf(createdAt))}</div></td>`;

// How each sale was settled, one column each; Adv. (advance or credit note
// used) only when a sale in the list used one.
const MODE_LABELS = { cash: 'Cash', card: 'Card', bank: 'Bank', other: 'Adv.', credit: 'Credit' };
const usesOther = (rows) => rows.some((row) => row.split?.other);
const payKeys = (other) => (other ? ['cash', 'card', 'bank', 'other', 'credit'] : ['cash', 'card', 'bank', 'credit']);
const payHeads = (other) => payKeys(other).map((key) => `<th scope="col" class="num dsr-mode">${MODE_LABELS[key]}</th>`).join('');
const payCells = (split, other) => payKeys(other).map((key) => `<td class="num${key === 'credit' && split.credit ? ' dsr-due' : ''}">${cell(split[key])}</td>`).join('');
const payTotals = (rows, other) => payKeys(other).map((key) => `<td class="num">${money(sumOf(rows, (row) => row.split[key]))}</td>`).join('');
const PROFIT_HEADS = '<th scope="col" class="num dsr-profit">Cost</th><th scope="col" class="num dsr-profit">Profit</th>';
const profitCells = (row) => `<td class="num dsr-profit">${cell(row.cost_cents)}</td><td class="num dsr-profit ${row.margin_cents >= 0 ? 'margin-positive' : 'margin-negative'}">${money(row.margin_cents)}</td>`;
const profitTotals = (rows) => `<td class="num dsr-profit">${money(sumOf(rows, (r) => r.cost_cents))}</td><td class="num dsr-profit">${money(sumOf(rows, (r) => r.margin_cents))}</td>`;

function cancelledNote(row) {
  if (!row.cancelled_by) return '';
  return `<div class="dsr-sub dsr-cancelled">Cancelled · <a href="#/cancellations/${row.cancelled_by.id}">${esc(short(row.cancelled_by.number))}</a></div>`;
}

const emptyRow = (colspan, text) => `<tr><td colspan="${colspan}" class="dsr-empty">${esc(text)}</td></tr>`;
const title = (text) => `<h3 class="dsr-title">${esc(text)}</h3>`;

function ticketList(rows) {
  const other = usesOther(rows);
  const body = rows.length ? rows.map((row) => {
    const tickets = row.passengers.map((p) => p.ticket_no).filter(Boolean);
    const names = row.passengers.length ? row.passengers.map((p) => esc(p.name)).join('<br>') : esc(row.particulars || '—');
    return `
      <tr>
        ${whenCell(row.date, row.created_at)}
        <td><a href="#/invoices/${row.id}">${esc(short(row.number))}</a>
          <div class="dsr-sub">${esc([row.pnr, ...tickets].filter(Boolean).join(' · ') || short(row.reference))}</div>${cancelledNote(row)}</td>
        <td>${names}${row.customer_name && !row.passengers.some((p) => p.name === row.customer_name) ? `<div class="dsr-sub">${esc(row.customer_name)}</div>` : ''}${row.remarks ? `<div class="dsr-sub">${esc(row.remarks)}</div>` : ''}</td>
        <td class="num">${cell(row.fare_cents)}</td>
        <td class="num">${cell(row.fee_cents)}</td>
        <td class="num">${money(row.total_cents)}</td>
        ${profitCells(row)}
        ${payCells(row.split, other)}
        <td class="dsr-staff">${esc(firstName(row.staff))}</td>
      </tr>`;
  }).join('') : emptyRow(14, 'No ticket sales in this period');
  return `
    ${title('Ticket Sales List')}
    <table class="dsr-table" data-dsr-table="tickets"><caption class="sr-only">Ticket sales</caption>
      <thead><tr>
        <th scope="col">Date</th><th scope="col">Invoice · Ticket/PNR</th><th scope="col">Pax name</th>
        <th scope="col" class="num">Fare</th><th scope="col" class="num">S.Fee</th><th scope="col" class="num">Total</th>${PROFIT_HEADS}${payHeads(other)}<th scope="col">Staff</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="3">Total${rows.length ? ` · ${plural(rows.length, 'ticket sale')}` : ''}</td>
        <td class="num">${money(sumOf(rows, (r) => r.fare_cents))}</td>
        <td class="num">${money(sumOf(rows, (r) => r.fee_cents))}</td>
        <td class="num">${money(sumOf(rows, (r) => r.total_cents))}</td>
        ${profitTotals(rows)}${payTotals(rows, other)}<td></td>
      </tr></tfoot>
    </table>`;
}

function visaList(rows) {
  const other = usesOther(rows);
  const body = rows.length ? rows.map((row) => `
      <tr>
        ${whenCell(row.date, row.created_at)}
        <td><a href="#/invoices/${row.id}">${esc(short(row.number))}</a><div class="dsr-sub"><a href="#/visas/${row.reference_id}">${esc(short(row.reference))}</a></div>${cancelledNote(row)}</td>
        <td>${esc(row.applicant_name || '—')}${row.customer_name && row.customer_name !== row.applicant_name ? `<div class="dsr-sub">${esc(row.customer_name)}</div>` : ''}${row.remarks ? `<div class="dsr-sub">${esc(row.remarks)}</div>` : ''}</td>
        <td class="num">${row.deposit_cents ? money(row.deposit_cents) : '—'}</td>
        <td class="num">${money(row.total_cents)}</td>
        ${profitCells(row)}
        ${payCells(row.split, other)}
        <td class="dsr-staff">${esc(firstName(row.staff))}</td>
      </tr>`).join('') : emptyRow(13, 'No visa sales in this period');
  return `
    ${title('Visa Sales List')}
    <table class="dsr-table" data-dsr-table="visas"><caption class="sr-only">Visa sales</caption>
      <thead><tr>
        <th scope="col">Date</th><th scope="col">Invoice · Visa</th><th scope="col">Applicant · paid by</th>
        <th scope="col" class="num">Sec.Dep</th><th scope="col" class="num">Total</th>${PROFIT_HEADS}${payHeads(other)}<th scope="col">Staff</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="3">Total${rows.length ? ` · ${plural(rows.length, 'visa')}` : ''}</td>
        <td class="num">${money(sumOf(rows, (r) => r.deposit_cents))}</td>
        <td class="num">${money(sumOf(rows, (r) => r.total_cents))}</td>
        ${profitTotals(rows)}${payTotals(rows, other)}<td></td>
      </tr></tfoot>
    </table>`;
}

// Other services (only when there were some).
function serviceList(rows) {
  if (!rows.length) return '';
  const other = usesOther(rows);
  return `
    ${title('Service Sales List')}
    <table class="dsr-table" data-dsr-table="services"><caption class="sr-only">Service sales</caption>
      <thead><tr>
        <th scope="col">Date</th><th scope="col">Invoice</th><th scope="col">Customer · service</th>
        <th scope="col" class="num">Total</th>${payHeads(other)}<th scope="col">Staff</th>
      </tr></thead>
      <tbody>${rows.map((row) => `
        <tr>
          ${whenCell(row.date, row.created_at)}
          <td><a href="#/invoices/${row.id}">${esc(short(row.number))}</a></td>
          <td>${esc(row.customer_name)}<div class="dsr-sub">${esc(row.description || '')}</div></td>
          <td class="num">${money(row.total_cents)}</td>
          ${payCells(row.split, other)}
          <td class="dsr-staff">${esc(firstName(row.staff))}</td>
        </tr>`).join('')}</tbody>
      <tfoot><tr>
        <td colspan="3">Total · ${plural(rows.length, 'sale')}</td>
        <td class="num">${money(sumOf(rows, (r) => r.total_cents))}</td>
        ${payTotals(rows, other)}<td></td>
      </tr></tfoot>
    </table>`;
}

// Cancellations, refunds paid and visa deposits kept (only when there were some).
function cancellationList(cancellations, refunds, kept) {
  if (!cancellations.length && !refunds.length && !kept.length) return '';
  return `
    ${title('Cancellations & Refunds')}
    ${cancellations.length ? `
    <table class="dsr-table" data-dsr-table="cancellations"><caption class="sr-only">Cancellations</caption>
      <thead><tr>
        <th scope="col">Date</th><th scope="col">Cancellation</th><th scope="col">Customer</th>
        <th scope="col" class="num">Sale reversed</th><th scope="col" class="num">Charges kept</th>
        <th scope="col" class="num">Supplier credit</th><th scope="col" class="num">Net sale</th><th scope="col" class="num dsr-profit">Profit</th>
      </tr></thead>
      <tbody>${cancellations.map((row) => `
        <tr class="dsr-cancellation-row">
          <td class="dsr-when">${esc(fmtDate(row.issue_date, { short: true }))}</td>
          <td><a href="${row.href || `#/cancellations/${row.cancellation_id}`}">${esc(short(row.number))}</a><div class="dsr-sub">${esc(short(row.reference || ''))}</div></td>
          <td>${esc(row.customer_name)}</td>
          <td class="num">${row.reversed_sale_cents ? money(-row.reversed_sale_cents) : '—'}</td>
          <td class="num">${row.charges_cents ? money(row.charges_cents) : '—'}</td>
          <td class="num">${row.supplier_credits_cents ? money(row.supplier_credits_cents) : '—'}</td>
          <td class="num">${money(row.sale_cents)}</td>
          <td class="num dsr-profit">${money(row.margin_cents)}</td>
        </tr>`).join('')}</tbody>
      <tfoot><tr>
        <td colspan="3">Total · ${cancellations.length}</td>
        <td class="num">${money(-sumOf(cancellations, (r) => r.reversed_sale_cents))}</td>
        <td class="num">${money(sumOf(cancellations, (r) => r.charges_cents))}</td>
        <td class="num">${money(sumOf(cancellations, (r) => r.supplier_credits_cents))}</td>
        <td class="num">${money(sumOf(cancellations, (r) => r.sale_cents))}</td>
        <td class="num dsr-profit">${money(sumOf(cancellations, (r) => r.margin_cents))}</td>
      </tr></tfoot>
    </table>` : ''}
    ${refunds.length ? `
    <table class="dsr-table" data-dsr-table="refunds"><caption class="dsr-caption">Refunds paid to customers</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Refund</th><th scope="col">Customer</th><th scope="col">Against</th><th scope="col">Method</th><th scope="col" class="num">Amount</th></tr></thead>
      <tbody>${refunds.map((row) => `
        <tr><td class="dsr-when">${esc(fmtDate(row.date, { short: true }))}</td><td>${esc(short(row.number))}</td><td>${esc(row.customer_name)}</td>
          <td>${esc(row.against || '—')}</td><td>${esc(row.method || '')}</td><td class="num">${money(row.amount_cents)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="5">Total refunds</td><td class="num">${money(sumOf(refunds, (r) => r.amount_cents))}</td></tr></tfoot>
    </table>` : ''}
    ${kept.length ? `
    <table class="dsr-table" data-dsr-table="deposit-kept"><caption class="dsr-caption">Visa deposits forfeited or deducted</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Deposit</th><th scope="col">Customer</th><th scope="col">Reason</th><th scope="col">Kept by</th><th scope="col" class="num">Amount</th></tr></thead>
      <tbody>${kept.map((row) => `
        <tr><td class="dsr-when">${esc(fmtDate(row.date, { short: true }))}</td><td>${esc(row.number)}<div class="dsr-sub">${esc(short(row.visa_number))}</div></td>
          <td>${esc(row.customer_name)}</td><td>${esc(row.notes || '—')}</td><td>${row.kept_by === 'agency' ? 'Us (income)' : 'Supplier'}</td><td class="num">${money(row.amount_cents)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="5">Total</td><td class="num">${money(sumOf(kept, (r) => r.amount_cents))}</td></tr></tfoot>
    </table>` : ''}`;
}

function collectionList(rows) {
  const modes = rows.some((row) => row.mode === 'other') ? ['cash', 'card', 'bank', 'other'] : ['cash', 'card', 'bank'];
  const byMode = (mode) => sumOf(rows.filter((r) => r.mode === mode), (r) => r.amount_cents);
  const body = rows.length ? rows.map((row) => `
      <tr>
        <td class="dsr-when">${esc(fmtDate(row.date, { short: true }))}</td>
        <td>${row.kind === 'payment' ? `<a href="#/receipts/${row.id}">${esc(short(row.number))}</a>` : esc(short(row.number))}</td>
        <td>${esc(row.customer_name)} · ${esc(row.invoice_number ? `${short(row.invoice_number)} (${fmtDate(row.invoice_date, { short: true })})` : row.against)}</td>
        ${modes.map((mode) => `<td class="num">${cell(row.mode === mode ? row.amount_cents : 0)}</td>`).join('')}
      </tr>`).join('') : emptyRow(3 + modes.length, 'Nothing received for older invoices in this period');
  return `
    ${title('Received for older invoices')}
    <table class="dsr-table" data-dsr-table="collections"><caption class="sr-only">Money received for older invoices and advances</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Receipt</th><th scope="col">Customer · for invoice</th>${modes.map((mode) => `<th scope="col" class="num dsr-mode">${MODE_LABELS[mode]}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="3">Total</td>${modes.map((mode) => `<td class="num">${money(byMode(mode))}</td>`).join('')}</tr></tfoot>
    </table>`;
}

const boxRow = (label, cents, className = '') => `<div class="dsr-box-row ${className}"><span>${esc(label)}</span><span class="num">${money(cents)}</span></div>`;
const box = (heading, rows, attr = '') => `<div class="dsr-box" ${attr}><div class="dsr-box-head">${esc(heading)}</div>${rows}</div>`;

// The closing boxes: what was paid out, the cash the counter should hold,
// sales by how they were paid, the bank, and suppliers and wallets.
function closingBoxes(data) {
  const s = data.sections;
  const { settlement, collected, position } = s.summary;
  const out = s.cash_out.map((row) => ({ label: row.label, cents: row.cash_out_cents + row.bank_out_cents })).filter((row) => row.cents);
  // Refunds paid are already in here (as "Customer refunds" etc.), so no line of their own.
  const paidOut = sumOf(out, (row) => row.cents);
  const cash = position.cash;
  const bank = position.bank;
  const cashOf = (rows) => sumOf(rows, (r) => r.split.cash);
  // Deposit cash sits in the visa rows' Cash column but is not a sale.
  const depositCash = sumOf(s.visas, (r) => r.deposit_cash_cents);
  // Whatever the shown lines miss, so the box always adds up to cash in hand.
  const otherIn = cash ? cash.in_cents - cashOf(s.tickets) - cashOf(s.visas) - cashOf(s.services) - (collected.cash || 0) : 0;
  const parties = s.parties || [];
  // Sales by how they were settled, plus what no column holds, add up to the
  // lists' totals; cancellations (net of charges kept) after.
  const sales = [...s.tickets, ...s.visas, ...s.services];
  const listed = sumOf(sales, (r) => r.total_cents);
  const deposits = sumOf(s.visas, (r) => r.deposit_cents);
  const fromDeposit = sumOf(sales, (r) => r.from_deposit_cents);
  const unpaidCancelled = sumOf(sales, (r) => r.unpaid_cancelled_cents);
  const cancelled = s.summary.sales.cancellations_cents || 0;
  const modes = [['cash', 'Cash'], ['card', 'Card & payment link'], ['bank', 'Bank'], ['other', 'Advance or credit note used'], ['credit', 'Credit (unpaid)']];
  return `
    <div class="dsr-boxes">
      <div class="dsr-col">
      ${box('Payments', `
        ${out.map((row) => boxRow(row.label, -row.cents, 'neg')).join('')}
        ${boxRow('Total', -paidOut, `dsr-box-total ${paidOut ? 'neg' : ''}`)}`, 'data-dsr-payments')}
      ${box('By how it was paid · sales', `
        ${modes.filter(([key]) => key !== 'other' || settlement.other).map(([key, label]) => boxRow(label, settlement[key])).join('')}
        ${deposits ? boxRow('Security deposits (not sales)', -deposits, 'neg') : ''}
        ${fromDeposit ? boxRow('Paid from a security deposit', fromDeposit) : ''}
        ${unpaidCancelled ? boxRow('Cancelled before payment', unpaidCancelled) : ''}
        ${boxRow('Total sales', listed, 'dsr-box-total')}
        ${cancelled ? `${boxRow('Cancellations', cancelled, 'neg')}${boxRow('Net sales', listed + cancelled, 'dsr-box-total')}` : ''}`, 'data-dsr-modes')}
      ${box(`Suppliers and portal wallets · ${fmtDate(data.to, { short: true })}`, parties.length
    ? `${parties.map((party) => `<div class="dsr-box-row"><span>${esc(party.name)} <span class="dsr-sub">${esc(party.kind)}</span></span><span class="num ${party.balance_cents < 0 ? 'pos' : ''}">${money(party.balance_cents)}</span></div>`).join('')}
       ${boxRow(parties.some((party) => party.balance_cents < 0) ? 'Net' : 'We owe in all', sumOf(parties, (party) => party.balance_cents), 'dsr-box-total')}`
    : '<div class="dsr-box-row"><span class="dsr-sub">Every supplier and wallet is at 0.00</span></div>', 'data-dsr-parties')}
      </div>
      <div class="dsr-col">
      ${cash ? box('Summary · cash in hand', `
        ${boxRow('Opening cash', cash.opening_cents)}
        ${boxRow('Ticket sales (cash)', cashOf(s.tickets))}
        ${boxRow('Visa sales (cash)', cashOf(s.visas) - depositCash)}
        ${depositCash ? boxRow('Security deposits (cash)', depositCash) : ''}
        ${s.services.length ? boxRow('Service sales (cash)', cashOf(s.services)) : ''}
        ${boxRow('Received for older invoices (cash)', collected.cash || 0)}
        ${otherIn > 0 ? boxRow('Other cash in', otherIn) : ''}
        ${otherIn < 0 ? boxRow('Paid in cash, kept outside the cash account', otherIn, 'neg') : ''}
        ${boxRow('Refunds and payments (cash)', -cash.out_cents, cash.out_cents ? 'neg' : '')}
        ${boxRow('Cash in hand', cash.closing_cents, 'dsr-box-total pos')}`, 'data-dsr-cash') : ''}
      ${bank ? box(bank.label, `
        ${boxRow('Opening', bank.opening_cents)}
        ${boxRow('In', bank.in_cents)}
        ${boxRow('Out', -bank.out_cents, bank.out_cents ? 'neg' : '')}
        ${boxRow('Closing', bank.closing_cents, 'dsr-box-total')}`, 'data-dsr-bank') : ''}
      ${(data.staff_totals || []).length > 1 ? box('By staff', `
        ${data.staff_totals.map((row) => boxRow(`${row.staff} · ${plural(row.sales, 'sale')}`, row.sale_cents, row.staff === data.staff ? 'dsr-box-total' : '')).join('')}`, 'data-dsr-staff-totals') : ''}
      </div>
    </div>`;
}

// Narrows the sales and cancellations to one staff member.
function staffPicker(data) {
  const names = (data.staff_totals || []).map((row) => row.staff);
  if (names.length < 2 && !data.staff) return '';
  return `
    <label class="dsr-staff-pick no-print">
      <span>Staff</span>
      <select class="input" data-dsr-staff>
        <option value="">All staff</option>
        ${names.map((name) => `<option value="${esc(name)}" ${name === data.staff ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>
    </label>`;
}

export function dailySales(data) {
  const company = store.settings?.company_name || 'My Company';
  const s = data.sections;
  const hasAnything = s && (s.tickets.length || s.visas.length || s.services.length || s.cancellations.length
    || s.refunds.length || s.collections.length || s.cash_out.length || (s.deposit_kept || []).length);
  if (!hasAnything) {
    return `
      <div class="report-card">
        ${reportHeader('Daily Sales Report', periodLabel(data.from, data.to), company)}
        ${emptyState({ iconName: 'invoice', title: 'No sales in this period' })}
      </div>`;
  }
  const printed = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `
    <div class="report-card dsr-report ${profitShown() ? 'show-profit' : ''}" data-dsr>
      <div class="dsr-head">
        <div><h2 class="dsr-name">Daily Sales Report</h2><div class="dsr-sub">${esc(company)} · ${esc(periodLabel(data.from, data.to))}${data.staff ? ` · ${esc(data.staff)} only` : ''} · AED</div></div>
        <div class="dsr-printed">Printed ${esc(printed)}${store.user?.full_name ? `<br>by ${esc(store.user.full_name)}` : ''}</div>
      </div>
      <div class="dsr-controls no-print">
        ${staffPicker(data)}
        <label class="checkbox-row"><input type="checkbox" data-dsr-profit ${profitShown() ? 'checked' : ''}> <span>Show profit</span></label>
      </div>
      ${ticketList(s.tickets)}
      ${visaList(s.visas)}
      ${serviceList(s.services)}
      ${cancellationList(s.cancellations, s.refunds, s.deposit_kept || [])}
      ${collectionList(s.collections)}
      ${closingBoxes(data)}
    </div>`;
}
