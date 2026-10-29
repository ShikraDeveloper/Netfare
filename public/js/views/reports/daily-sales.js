import { store } from '../../store.js';
import { emptyState, esc, fmtDate, fmtMoney, icon } from '../../ui.js';
import { periodLabel, reportHeader } from './common.js';

// Daily Sales Report laid out like a travel counter's report: A header,
// B ticket and booking sales, C visa sales, D service income, E cancellations
// and refunds, F money collected for older invoices, G money paid out and
// H the summary. Cost and margin show only with "Show profit".

const PROFIT_KEY = 'ledgerly.dsr.showProfit';

export function profitShown() {
  try { return localStorage.getItem(PROFIT_KEY) === '1'; } catch { return false; }
}

export function rememberProfit(shown) {
  try { localStorage.setItem(PROFIT_KEY, shown ? '1' : '0'); } catch { /* per-viewer convenience only */ }
}

const amountFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Dense tables print plain amounts; the header says they are in AED.
function amt(cents, { blank = true } = {}) {
  if (!cents && blank) return '<span class="dsr-zero">—</span>';
  return esc(amountFormat.format((Number(cents) || 0) / 100));
}

function timeOf(createdAt) {
  if (!createdAt) return '';
  const date = new Date(`${String(createdAt).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dateLine(date, createdAt) {
  return `<div class="cell-sub dsr-when">${esc(fmtDate(date))}${createdAt ? ` · ${esc(timeOf(createdAt))}` : ''}</div>`;
}

const SPLIT_KEYS = ['cash', 'card', 'bank', 'other', 'credit'];
const SPLIT_HEADS = '<th scope="col" class="num">Cash</th><th scope="col" class="num">Card</th><th scope="col" class="num">Bank</th><th scope="col" class="num">Other</th><th scope="col" class="num">Credit</th>';
const PROFIT_HEADS = '<th scope="col" class="num dsr-profit">Cost</th><th scope="col" class="num dsr-profit">Gross profit</th>';

function splitCells(split) {
  return SPLIT_KEYS.map((key) => `<td class="num">${amt(split[key])}</td>`).join('');
}

function profitCells(row) {
  return `<td class="num dsr-profit">${amt(row.cost_cents)}</td>
    <td class="num dsr-profit ${row.margin_cents >= 0 ? 'margin-positive' : 'margin-negative'}">${amt(row.margin_cents, { blank: false })}</td>`;
}

function sumOf(rows, pick) {
  return rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
}

function splitTotals(rows) {
  return SPLIT_KEYS.map((key) => `<td class="num">${amt(sumOf(rows, (row) => row.split[key]), { blank: false })}</td>`).join('');
}

function cancelledNote(row) {
  if (!row.cancelled_by) return '';
  return `<div class="cell-sub"><span class="badge badge-cancelled">Cancelled</span> ${esc(fmtDate(row.cancelled_by.date))} · <a href="#/cancellations/${row.cancelled_by.id}">${esc(row.cancelled_by.number)}</a></div>`;
}

function section(letter, title, table, { id } = {}) {
  return `
    <section class="dsr-section" ${id ? `data-dsr-section="${id}"` : ''}>
      <h3 class="dsr-section-title"><span class="dsr-letter">${letter}</span>${esc(title)}</h3>
      <div class="table-wrap">${table}</div>
    </section>
  `;
}

function emptyRow(colspan, text) {
  return `<tr><td colspan="${colspan}" class="dsr-empty">${esc(text)}</td></tr>`;
}

function ticketTable(rows) {
  const body = rows.length ? rows.map((row) => {
    const people = row.passengers.length
      ? row.passengers.map((p) => `<div>${esc(p.name)}${p.ticket_no ? ` <span class="cell-sub">· ${esc(p.ticket_no)}</span>` : ''}</div>`).join('')
      : `<div>${esc(row.particulars || '—')}</div>`;
    return `
      <tr>
        <td class="dsr-doc"><a href="#/invoices/${row.id}">${esc(row.number)}</a>${dateLine(row.date, row.created_at)}
          <div class="cell-sub"><a href="#/bookings/${row.reference_id}">${esc(row.reference || '')}</a></div>${cancelledNote(row)}</td>
        <td><div class="cell-main">${esc(row.customer_name)}</div><div class="dsr-people">${people}</div>${row.remarks ? `<div class="cell-sub">${esc(row.remarks)}</div>` : ''}</td>
        <td><span class="dsr-pnr">${esc(row.pnr || '—')}</span><div class="cell-sub">${esc(row.route)}</div></td>
        <td class="num">${amt(row.fare_cents)}</td>
        <td class="num">${amt(row.fee_cents)}</td>
        <td class="num"><strong>${amt(row.total_cents, { blank: false })}</strong></td>
        ${splitCells(row.split)}
        ${profitCells(row)}
      </tr>`;
  }).join('') : emptyRow(13, 'No ticket or booking sales in this period.');
  return `
    <table class="report-table dsr-table" data-dsr-table="tickets"><caption class="sr-only">Ticket and booking sales</caption>
      <thead><tr>
        <th scope="col">Invoice / booking</th><th scope="col">Customer · passengers · ticket no.</th>
        <th scope="col">PNR / route</th><th scope="col" class="num">Fare</th><th scope="col" class="num">Fee</th>
        <th scope="col" class="num">Total</th>${SPLIT_HEADS}${PROFIT_HEADS}
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="3">Total · ${rows.length} sale${rows.length === 1 ? '' : 's'}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.fare_cents), { blank: false })}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.fee_cents), { blank: false })}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.total_cents), { blank: false })}</td>
        ${splitTotals(rows)}
        <td class="num dsr-profit">${amt(sumOf(rows, (r) => r.cost_cents), { blank: false })}</td>
        <td class="num dsr-profit">${amt(sumOf(rows, (r) => r.margin_cents), { blank: false })}</td>
      </tr></tfoot>
    </table>`;
}

function visaTable(rows) {
  const typeLabel = (type) => (type ? `${type.charAt(0).toUpperCase()}${type.slice(1)}` : '');
  const body = rows.length ? rows.map((row) => `
      <tr>
        <td class="dsr-doc"><a href="#/invoices/${row.id}">${esc(row.number)}</a>${dateLine(row.date, row.created_at)}
          <div class="cell-sub"><a href="#/visas/${row.reference_id}">${esc(row.reference || '')}</a></div>${cancelledNote(row)}</td>
        <td><div class="cell-main">${esc(row.applicant_name)}</div>${row.applicant_name !== row.customer_name ? `<div class="cell-sub">Paid by ${esc(row.customer_name)}</div>` : ''}${row.remarks ? `<div class="cell-sub">${esc(row.remarks)}</div>` : ''}</td>
        <td>${esc([row.country, typeLabel(row.visa_type)].filter(Boolean).join(' · ') || '—')}</td>
        <td class="num">${amt(row.fare_cents)}</td>
        <td class="num">${amt(row.fee_cents)}</td>
        <td class="num"><strong>${amt(row.total_cents, { blank: false })}</strong></td>
        <td class="num" title="${esc((row.deposit_numbers || []).join(', '))}">${amt(row.deposit_cents)}</td>
        ${splitCells(row.split)}
        ${profitCells(row)}
      </tr>`).join('') : emptyRow(14, 'No visa sales in this period.');
  return `
    <table class="report-table dsr-table" data-dsr-table="visas"><caption class="sr-only">Visa sales</caption>
      <thead><tr>
        <th scope="col">Invoice / visa</th><th scope="col">Applicant</th>
        <th scope="col">Country / type</th><th scope="col" class="num">Visa fee</th><th scope="col" class="num">Fee</th>
        <th scope="col" class="num">Total</th><th scope="col" class="num">Sec. deposit</th>${SPLIT_HEADS}${PROFIT_HEADS}
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="3">Total · ${rows.length} application${rows.length === 1 ? '' : 's'}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.fare_cents), { blank: false })}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.fee_cents), { blank: false })}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.total_cents), { blank: false })}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.deposit_cents), { blank: false })}</td>
        ${splitTotals(rows)}
        <td class="num dsr-profit">${amt(sumOf(rows, (r) => r.cost_cents), { blank: false })}</td>
        <td class="num dsr-profit">${amt(sumOf(rows, (r) => r.margin_cents), { blank: false })}</td>
      </tr></tfoot>
    </table>`;
}

function serviceTable(rows) {
  const body = rows.length ? rows.map((row) => `
      <tr>
        <td class="dsr-doc"><a href="#/invoices/${row.id}">${esc(row.number)}</a>${dateLine(row.date, row.created_at)}</td>
        <td><div class="cell-main">${esc(row.customer_name)}</div>${row.remarks ? `<div class="cell-sub">${esc(row.remarks)}</div>` : ''}</td>
        <td>${esc(row.description || '—')}</td>
        <td class="num"><strong>${amt(row.total_cents, { blank: false })}</strong></td>
        ${splitCells(row.split)}
      </tr>`).join('') : emptyRow(9, 'No service income in this period.');
  return `
    <table class="report-table dsr-table" data-dsr-table="services"><caption class="sr-only">Service income</caption>
      <thead><tr>
        <th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Description</th>
        <th scope="col" class="num">Total</th>${SPLIT_HEADS}
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="3">Total · ${rows.length} invoice${rows.length === 1 ? '' : 's'}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.total_cents), { blank: false })}</td>
        ${splitTotals(rows)}
      </tr></tfoot>
    </table>`;
}

function depositKeptTable(rows) {
  if (!rows.length) return '';
  return `
    <table class="report-table dsr-table dsr-subtable" data-dsr-table="deposit-kept"><caption class="dsr-caption">Visa deposits forfeited or deducted</caption>
      <thead><tr>
        <th scope="col">Date</th><th scope="col">Deposit</th><th scope="col">Customer</th><th scope="col">Reason</th>
        <th scope="col">Kept by</th><th scope="col" class="num">Amount</th>
      </tr></thead>
      <tbody>${rows.map((row) => `
        <tr>
          <td class="nowrap">${esc(fmtDate(row.date))}</td>
          <td class="nowrap">${esc(row.number)}<div class="cell-sub">${esc(row.visa_number)}</div></td>
          <td>${esc(row.customer_name)}</td>
          <td>${esc(row.notes || '—')}</td>
          <td>${row.kept_by === 'agency' ? 'Us (income)' : 'Supplier'}</td>
          <td class="num"><strong>${amt(row.amount_cents, { blank: false })}</strong></td>
        </tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="5">Total</td><td class="num">${amt(sumOf(rows, (r) => r.amount_cents), { blank: false })}</td></tr></tfoot>
    </table>`;
}

function cancellationTables(cancellations, refunds) {
  const cancelBody = cancellations.length ? cancellations.map((row) => `
      <tr class="dsr-cancellation-row">
        <td class="nowrap">${esc(fmtDate(row.issue_date))}</td>
        <td class="nowrap"><a href="#/cancellations/${row.cancellation_id}">${esc(row.number)}</a>
          <div class="cell-sub"><a href="#/${row.kind === 'booking' ? 'bookings' : 'visas'}/${row.reference_id}">${esc(row.reference || '')}</a>${row.charges_invoice_number ? ` · <a href="#/invoices/${row.charges_invoice_id}">${esc(row.charges_invoice_number)}</a>` : ''}</div></td>
        <td>${esc(row.customer_name)}</td>
        <td class="num">${amt(-row.reversed_sale_cents)}</td>
        <td class="num">${amt(row.charges_cents)}</td>
        <td class="num">${amt(row.supplier_credits_cents)}</td>
        <td class="num"><strong>${amt(row.sale_cents, { blank: false })}</strong></td>
        <td class="num dsr-profit ${row.margin_cents >= 0 ? 'margin-positive' : 'margin-negative'}">${amt(row.margin_cents, { blank: false })}</td>
      </tr>`).join('') : emptyRow(8, 'No cancellations in this period.');
  const refundBody = refunds.length ? refunds.map((row) => `
      <tr>
        <td class="nowrap">${esc(fmtDate(row.date))}</td>
        <td class="nowrap">${esc(row.number)}</td>
        <td>${esc(row.customer_name)}</td>
        <td>${esc(row.against || '—')}</td>
        <td>${esc(row.method || '')}</td>
        <td class="num"><strong>${amt(row.amount_cents, { blank: false })}</strong></td>
      </tr>`).join('') : emptyRow(6, 'No refunds paid in this period.');
  return `
    <table class="report-table dsr-table" data-dsr-table="cancellations"><caption class="sr-only">Cancellations</caption>
      <thead><tr>
        <th scope="col">Date</th><th scope="col">Cancellation</th><th scope="col">Customer</th>
        <th scope="col" class="num">Sale reversed</th><th scope="col" class="num">Charges kept</th>
        <th scope="col" class="num">Supplier credit</th><th scope="col" class="num">Net sale</th><th scope="col" class="num dsr-profit">Gross profit</th>
      </tr></thead>
      <tbody>${cancelBody}</tbody>
      <tfoot><tr>
        <td colspan="3">Total · ${cancellations.length} cancellation${cancellations.length === 1 ? '' : 's'}</td>
        <td class="num">${amt(-sumOf(cancellations, (r) => r.reversed_sale_cents), { blank: false })}</td>
        <td class="num">${amt(sumOf(cancellations, (r) => r.charges_cents), { blank: false })}</td>
        <td class="num">${amt(sumOf(cancellations, (r) => r.supplier_credits_cents), { blank: false })}</td>
        <td class="num">${amt(sumOf(cancellations, (r) => r.sale_cents), { blank: false })}</td>
        <td class="num dsr-profit">${amt(sumOf(cancellations, (r) => r.margin_cents), { blank: false })}</td>
      </tr></tfoot>
    </table>
    <table class="report-table dsr-table dsr-subtable" data-dsr-table="refunds"><caption class="dsr-caption">Refunds paid to customers</caption>
      <thead><tr>
        <th scope="col">Date</th><th scope="col">Refund</th><th scope="col">Customer</th><th scope="col">Against</th>
        <th scope="col">Method</th><th scope="col" class="num">Amount</th>
      </tr></thead>
      <tbody>${refundBody}</tbody>
      <tfoot><tr><td colspan="5">Total refunds</td><td class="num">${amt(sumOf(refunds, (r) => r.amount_cents), { blank: false })}</td></tr></tfoot>
    </table>`;
}

function collectionsTable(rows) {
  const modes = ['cash', 'card', 'bank', 'other'];
  const body = rows.length ? rows.map((row) => `
      <tr>
        <td class="nowrap">${esc(fmtDate(row.date))}</td>
        <td class="nowrap">${row.kind === 'payment' ? `<a href="#/receipts/${row.id}">${esc(row.number)}</a>` : esc(row.number)}</td>
        <td>${esc(row.customer_name)}</td>
        <td>${esc(row.against)}</td>
        ${modes.map((mode) => `<td class="num">${amt(row.mode === mode ? row.amount_cents : 0)}</td>`).join('')}
      </tr>`).join('') : emptyRow(8, 'No other money received in this period.');
  return `
    <table class="report-table dsr-table" data-dsr-table="collections"><caption class="sr-only">Money collected for older invoices and advances</caption>
      <thead><tr>
        <th scope="col">Date</th><th scope="col">Receipt</th><th scope="col">Customer</th><th scope="col">Against</th>
        <th scope="col" class="num">Cash</th><th scope="col" class="num">Card</th><th scope="col" class="num">Bank</th><th scope="col" class="num">Other</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="4">Total</td>
        ${modes.map((mode) => `<td class="num">${amt(sumOf(rows.filter((r) => r.mode === mode), (r) => r.amount_cents), { blank: false })}</td>`).join('')}
      </tr></tfoot>
    </table>`;
}

function cashOutTable(rows, position) {
  const body = rows.length ? rows.map((row) => `
      <tr>
        <td>${esc(row.label)}</td>
        <td class="num">${amt(row.cash_out_cents)}</td>
        <td class="num">${amt(row.bank_out_cents)}</td>
      </tr>`).join('') : emptyRow(3, 'Nothing paid out in this period.');
  return `
    <table class="report-table dsr-table dsr-narrow" data-dsr-table="cash-out"><caption class="sr-only">Money paid out</caption>
      <thead><tr><th scope="col">Paid for</th><th scope="col" class="num">${esc(position.cash?.label || 'Cash')}</th><th scope="col" class="num">${esc(position.bank?.label || 'Bank')}</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td>Total paid out</td>
        <td class="num">${amt(sumOf(rows, (r) => r.cash_out_cents), { blank: false })}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.bank_out_cents), { blank: false })}</td></tr></tfoot>
    </table>`;
}

function summaryHtml(data) {
  const { summary } = data.sections;
  const { sales, settlement, collected, position } = summary;
  const row = (label, cents, className = '') => `<div class="dsr-sum-row ${className}"><span>${esc(label)}</span><span>${amt(cents, { blank: false })}</span></div>`;
  const mode = (key) => settlement[key] + (collected[key] || 0);
  const totalIn = mode('cash') + mode('card') + mode('bank');
  const box = (key) => {
    const p = position[key];
    if (!p) return '';
    return `
      <div class="dsr-sum-box">
        <h4>${esc(p.label)}</h4>
        ${row('Opening', p.opening_cents)}
        ${row('Money in', p.in_cents)}
        ${row('Money out', -p.out_cents)}
        ${row('Closing', p.closing_cents, 'total')}
      </div>`;
  };
  return `
    <div class="dsr-summary" data-dsr-summary>
      <div class="dsr-sum-box">
        <h4>Sales</h4>
        ${row('Tickets & bookings', sales.tickets_cents)}
        ${row('Visas', sales.visas_cents)}
        ${row('Service income', sales.services_cents)}
        ${row('Cancellations (net)', sales.cancellations_cents)}
        ${row('Total sales', sales.total_cents, 'total')}
        <div class="dsr-profit">
          ${row('Cost', data.totals.cost_cents)}
          ${row(`Gross profit · ${data.totals.margin_percent.toFixed(1)}% gross margin`, data.totals.margin_cents, 'total')}
        </div>
      </div>
      <div class="dsr-sum-box">
        <h4>Collected by mode</h4>
        ${row('Cash', mode('cash'))}
        ${row('Card', mode('card'))}
        ${row('Bank / cheque', mode('bank'))}
        ${row('Total received', totalIn, 'total')}
        ${row('Advance / credit note used', mode('other'))}
        ${row('On credit (unpaid)', settlement.credit)}
        ${row('Refunds paid', -summary.refunds_cents)}
      </div>
      ${summary.deposits ? `
      <div class="dsr-sum-box" data-dsr-deposits>
        <h4>Visa security deposits</h4>
        ${row('Received', summary.deposits.received_cents)}
        ${row('Refunded', -summary.deposits.refunded_cents)}
        ${row('Forfeited / deducted', -summary.deposits.kept_cents)}
        ${row('Still held (2600)', summary.deposits.held_at_end_cents, 'total')}
      </div>` : ''}
      ${box('cash')}
      ${box('bank')}
    </div>`;
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
        ${emptyState({
    iconName: 'invoice',
    title: 'No sales in this period',
    message: 'Send an invoice, confirm a booking or submit a visa application to see the daily sales report.',
  })}
      </div>
    `;
  }

  const printed = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `
    <div class="report-card dsr-report ${profitShown() ? 'show-profit' : ''}" data-dsr>
      ${reportHeader('Daily Sales Report', periodLabel(data.from, data.to), company)}
      <div class="dsr-meta">
        <span>Amounts in AED · printed ${esc(printed)}</span>
        <label class="checkbox-row dsr-profit-toggle no-print"><input type="checkbox" data-dsr-profit ${profitShown() ? 'checked' : ''}> <span>Show cost &amp; gross profit</span></label>
      </div>
      ${section('B', 'Ticket & booking sales', ticketTable(s.tickets), { id: 'tickets' })}
      ${section('C', 'Visa sales', visaTable(s.visas), { id: 'visas' })}
      ${section('D', 'Service income', serviceTable(s.services), { id: 'services' })}
      ${section('E', 'Cancellations & refunds', cancellationTables(s.cancellations, s.refunds) + depositKeptTable(s.deposit_kept || []), { id: 'cancellations' })}
      ${section('F', 'Money collected for older invoices & advances', collectionsTable(s.collections), { id: 'collections' })}
      ${section('G', 'Money paid out', cashOutTable(s.cash_out, s.summary.position), { id: 'cash-out' })}
      <section class="dsr-section" data-dsr-section="summary">
        <h3 class="dsr-section-title"><span class="dsr-letter">H</span>Summary</h3>
        ${summaryHtml(data)}
      </section>
      <div class="report-balance-note">
        ${icon('check', 14)} A sale stays on the day it was made; a cancellation is its own line on the cancellation date. Cash, Card, Bank and Other show how each sale was settled by the end of the period (Other is a customer advance or credit note); Credit is still unpaid. Fare is everything except service fees and commission. Visa security deposits are not sales: they show in their own column and summary box, and the money received for them is counted in the cash, card and bank columns. Cash and bank figures come from the ledger accounts 1000 and 1010.
      </div>
    </div>
  `;
}
