import { store } from '../../store.js';
import { emptyState, esc, fmtDate, icon } from '../../ui.js';
import { periodLabel, reportHeader } from './common.js';

// Daily Sales Report: the totals first (sales, received, on credit, cash and
// bank), then a section per kind of work that folds open: ticket and booking
// sales, visa sales, service income, cancellations and refunds, money
// collected for older invoices, money paid out and sales by staff. Each sale
// shows how it was paid ("Paid by") and what is still due. Cost and margin
// show only with "Show profit". In print every section is open.

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

const PAID_LABELS = { cash: 'Cash', card: 'Card', bank: 'Bank', other: 'Advance / credit' };
const PAY_HEADS = '<th scope="col">Paid by</th><th scope="col" class="num">Due</th>';
const PROFIT_HEADS = '<th scope="col" class="num dsr-profit">Cost</th><th scope="col" class="num dsr-profit">Gross profit</th>';

// "Cash 3,000.00 · Card 1,500.00" as small chips, then what is still due.
function paidChips(parts) {
  const chips = Object.entries(PAID_LABELS)
    .filter(([key]) => parts[key])
    .map(([key, label]) => `<span class="dsr-pay" data-mode="${key}">${esc(label)} ${amt(parts[key])}</span>`);
  return chips.length ? chips.join('') : '<span class="dsr-zero">—</span>';
}

function payCells(split) {
  return `<td class="dsr-paid">${paidChips(split)}</td><td class="num ${split.credit ? 'dsr-due' : ''}">${amt(split.credit)}</td>`;
}

function profitCells(row) {
  return `<td class="num dsr-profit">${amt(row.cost_cents)}</td>
    <td class="num dsr-profit ${row.margin_cents >= 0 ? 'margin-positive' : 'margin-negative'}">${amt(row.margin_cents, { blank: false })}</td>`;
}

function sumOf(rows, pick) {
  return rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
}

function payTotals(rows) {
  const total = (key) => sumOf(rows, (row) => row.split[key]);
  return `<td class="dsr-paid">${paidChips({ cash: total('cash'), card: total('card'), bank: total('bank'), other: total('other') })}</td>
    <td class="num">${amt(total('credit'), { blank: false })}</td>`;
}

// Who made the sale: the staff member who created the booking, visa or invoice.
function staffLine(row) {
  return row.staff ? `<div class="cell-sub dsr-staff">by ${esc(row.staff)}</div>` : '';
}

function cancelledNote(row) {
  if (!row.cancelled_by) return '';
  return `<div class="cell-sub"><span class="badge badge-cancelled">Cancelled</span> ${esc(fmtDate(row.cancelled_by.date))} · <a href="#/cancellations/${row.cancelled_by.id}">${esc(row.cancelled_by.number)}</a></div>`;
}

function section(title, table, { id, count = '', total = null, open = false } = {}) {
  return `
    <section class="dsr-section ${open ? 'is-open' : ''}" data-dsr-section="${id}">
      <h3 class="dsr-section-title">
        <button type="button" class="dsr-fold" data-dsr-fold aria-expanded="${open}">
          <span class="dsr-chev" aria-hidden="true">${icon('chevron', 14)}</span>
          <span class="dsr-section-name">${esc(title)}</span>
          ${count ? `<span class="dsr-section-count">${esc(count)}</span>` : ''}
          ${total === null ? '' : `<span class="dsr-section-total ${total < 0 ? 'margin-negative' : ''}">${amt(total, { blank: false })}</span>`}
        </button>
      </h3>
      <div class="dsr-section-body table-wrap">${table}</div>
    </section>
  `;
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

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
          <div class="cell-sub"><a href="#/bookings/${row.reference_id}">${esc(row.reference || '')}</a></div>${staffLine(row)}${cancelledNote(row)}</td>
        <td><div class="cell-main">${esc(row.customer_name)}</div><div class="dsr-people">${people}</div>${row.remarks ? `<div class="cell-sub">${esc(row.remarks)}</div>` : ''}</td>
        <td><span class="dsr-pnr">${esc(row.pnr || '—')}</span><div class="cell-sub">${esc(row.route)}</div></td>
        <td class="num"><strong>${amt(row.total_cents, { blank: false })}</strong>${row.fee_cents ? `<div class="cell-sub">fee ${amt(row.fee_cents)}</div>` : ''}</td>
        ${profitCells(row)}
        ${payCells(row.split)}
      </tr>`;
  }).join('') : emptyRow(8, 'No ticket or booking sales in this period.');
  return `
    <table class="report-table dsr-table" data-dsr-table="tickets"><caption class="sr-only">Ticket and booking sales</caption>
      <thead><tr>
        <th scope="col">Invoice / booking</th><th scope="col">Customer · passengers · ticket no.</th>
        <th scope="col">PNR / route</th><th scope="col" class="num">Total</th>${PROFIT_HEADS}${PAY_HEADS}
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="3">Total · ${plural(rows.length, 'sale')}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.total_cents), { blank: false })}</td>
        <td class="num dsr-profit">${amt(sumOf(rows, (r) => r.cost_cents), { blank: false })}</td>
        <td class="num dsr-profit">${amt(sumOf(rows, (r) => r.margin_cents), { blank: false })}</td>
        ${payTotals(rows)}
      </tr></tfoot>
    </table>`;
}

function visaTable(rows) {
  const typeLabel = (type) => (type ? `${type.charAt(0).toUpperCase()}${type.slice(1)}` : '');
  const body = rows.length ? rows.map((row) => `
      <tr>
        <td class="dsr-doc"><a href="#/invoices/${row.id}">${esc(row.number)}</a>${dateLine(row.date, row.created_at)}
          <div class="cell-sub"><a href="#/visas/${row.reference_id}">${esc(row.reference || '')}</a></div>${staffLine(row)}${cancelledNote(row)}</td>
        <td><div class="cell-main">${esc(row.applicant_name)}</div>${row.applicant_name !== row.customer_name ? `<div class="cell-sub">Paid by ${esc(row.customer_name)}</div>` : ''}${row.remarks ? `<div class="cell-sub">${esc(row.remarks)}</div>` : ''}</td>
        <td>${esc([row.country, typeLabel(row.visa_type)].filter(Boolean).join(' · ') || '—')}</td>
        <td class="num"><strong>${amt(row.total_cents, { blank: false })}</strong>${row.fee_cents ? `<div class="cell-sub">fee ${amt(row.fee_cents)}</div>` : ''}${row.deposit_cents ? `<div class="cell-sub" title="${esc((row.deposit_numbers || []).join(', '))}">+ deposit ${amt(row.deposit_cents)}</div>` : ''}</td>
        ${profitCells(row)}
        ${payCells(row.split)}
      </tr>`).join('') : emptyRow(8, 'No visa sales in this period.');
  return `
    <table class="report-table dsr-table" data-dsr-table="visas"><caption class="sr-only">Visa sales</caption>
      <thead><tr>
        <th scope="col">Invoice / visa</th><th scope="col">Applicant</th>
        <th scope="col">Country / type</th><th scope="col" class="num">Total</th>${PROFIT_HEADS}${PAY_HEADS}
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="3">Total · ${plural(rows.length, 'application')}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.total_cents), { blank: false })}</td>
        <td class="num dsr-profit">${amt(sumOf(rows, (r) => r.cost_cents), { blank: false })}</td>
        <td class="num dsr-profit">${amt(sumOf(rows, (r) => r.margin_cents), { blank: false })}</td>
        ${payTotals(rows)}
      </tr></tfoot>
    </table>`;
}

function serviceTable(rows) {
  const body = rows.length ? rows.map((row) => `
      <tr>
        <td class="dsr-doc"><a href="#/invoices/${row.id}">${esc(row.number)}</a>${dateLine(row.date, row.created_at)}${staffLine(row)}</td>
        <td><div class="cell-main">${esc(row.customer_name)}</div>${row.remarks ? `<div class="cell-sub">${esc(row.remarks)}</div>` : ''}</td>
        <td>${esc(row.description || '—')}</td>
        <td class="num"><strong>${amt(row.total_cents, { blank: false })}</strong></td>
        ${payCells(row.split)}
      </tr>`).join('') : emptyRow(6, 'No service income in this period.');
  return `
    <table class="report-table dsr-table" data-dsr-table="services"><caption class="sr-only">Service income</caption>
      <thead><tr>
        <th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Description</th>
        <th scope="col" class="num">Total</th>${PAY_HEADS}
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="3">Total · ${plural(rows.length, 'invoice')}</td>
        <td class="num">${amt(sumOf(rows, (r) => r.total_cents), { blank: false })}</td>
        ${payTotals(rows)}
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
        <td class="nowrap"><a href="${row.href || `#/cancellations/${row.cancellation_id}`}">${esc(row.number)}</a>${row.is_refund ? `<div class="cell-sub">${esc(row.particulars.split(' · ')[0])}</div>` : ''}
          <div class="cell-sub"><a href="#/${row.kind === 'booking' ? 'bookings' : 'visas'}/${row.reference_id}">${esc(row.reference || '')}</a>${row.charges_invoice_number ? ` · <a href="#/invoices/${row.charges_invoice_id}">${esc(row.charges_invoice_number)}</a>` : ''}</div>${staffLine(row)}</td>
        <td>${esc(row.customer_name)}</td>
        <td class="num">${amt(-row.reversed_sale_cents)}</td>
        <td class="num">${amt(row.charges_cents)}</td>
        <td class="num">${amt(row.supplier_credits_cents)}</td>
        <td class="num"><strong>${amt(row.sale_cents, { blank: false })}</strong></td>
        <td class="num dsr-profit ${row.margin_cents >= 0 ? 'margin-positive' : 'margin-negative'}">${amt(row.margin_cents, { blank: false })}</td>
      </tr>`).join('') : emptyRow(8, 'No cancellations or refunds in this period.');
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
        <th scope="col">Date</th><th scope="col">Cancellation or refund</th><th scope="col">Customer</th>
        <th scope="col" class="num">Sale reversed</th><th scope="col" class="num">Charges kept</th>
        <th scope="col" class="num">Supplier credit</th><th scope="col" class="num">Net sale</th><th scope="col" class="num dsr-profit">Gross profit</th>
      </tr></thead>
      <tbody>${cancelBody}</tbody>
      <tfoot><tr>
        <td colspan="3">Total · ${cancellations.length}</td>
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
  const body = rows.length ? rows.map((row) => `
      <tr>
        <td class="nowrap">${esc(fmtDate(row.date))}</td>
        <td class="nowrap">${row.kind === 'payment' ? `<a href="#/receipts/${row.id}">${esc(row.number)}</a>` : esc(row.number)}</td>
        <td>${esc(row.customer_name)}</td>
        <td>${esc(row.against)}</td>
        <td class="dsr-paid">${paidChips({ [row.mode]: row.amount_cents })}</td>
      </tr>`).join('') : emptyRow(5, 'No other money received in this period.');
  const byMode = (mode) => sumOf(rows.filter((r) => r.mode === mode), (r) => r.amount_cents);
  return `
    <table class="report-table dsr-table" data-dsr-table="collections"><caption class="sr-only">Money collected for older invoices and advances</caption>
      <thead><tr>
        <th scope="col">Date</th><th scope="col">Receipt</th><th scope="col">Customer</th><th scope="col">Against</th>
        <th scope="col">Paid by</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="4">Total · ${amt(sumOf(rows, (r) => r.amount_cents), { blank: false })}</td>
        <td class="dsr-paid">${paidChips({ cash: byMode('cash'), card: byMode('card'), bank: byMode('bank'), other: byMode('other') })}</td>
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

// The totals first: tiles, how the money came in, and cash and bank.
function overviewHtml(data) {
  const { summary } = data.sections;
  const { sales, settlement, collected, position } = summary;
  const mode = (key) => settlement[key] + (collected[key] || 0);
  const modes = [['cash', 'Cash'], ['card', 'Card & payment link'], ['bank', 'Bank / cheque']];
  const totalIn = modes.reduce((sum, [key]) => sum + mode(key), 0);
  const s = data.sections;
  const tile = (label, cents, sub, className = '') => `
    <div class="dsr-tile ${className}"><span class="dsr-tile-label">${esc(label)}</span><strong class="dsr-tile-value">${amt(cents, { blank: false })}</strong>${sub ? `<span class="dsr-tile-sub">${esc(sub)}</span>` : ''}</div>`;
  const sold = s.tickets.length + s.visas.length + s.services.length;
  // The cancellations list also carries refunds from suppliers; count them apart.
  const supplierRefunds = s.cancellations.filter((row) => row.is_refund).length;
  const cancelled = s.cancellations.length - supplierRefunds;
  const bar = totalIn > 0 ? modes.map(([key]) => `<span class="dsr-bar-${key}" style="width:${((mode(key) / totalIn) * 100).toFixed(2)}%"></span>`).join('') : '';
  const box = (key) => position[key];
  const cashBank = ['cash', 'bank'].filter(box);
  const line = (label, pick, className = '') => `<span class="${className}">${esc(label)}</span>${cashBank.map((key) => `<span class="num ${className}">${amt(pick(position[key]), { blank: false })}</span>`).join('')}`;
  return `
    <div class="dsr-overview" data-dsr-summary data-dsr-section="summary">
      <div class="dsr-tiles">
        ${tile('Total sales', sales.total_cents, [plural(sold, 'sale'), cancelled ? plural(cancelled, 'cancellation') : '', supplierRefunds ? plural(supplierRefunds, 'supplier refund') : ''].filter(Boolean).join(' · '))}
        ${tile('Received', totalIn, 'cash, card and bank')}
        ${tile('On credit', settlement.credit, 'still unpaid', settlement.credit ? 'is-due' : '')}
        ${tile('Gross profit', data.totals.margin_cents, `${data.totals.margin_percent.toFixed(1)}% of sales`, 'dsr-profit')}
        ${tile('Refunds paid', summary.refunds_cents, 'to customers')}
      </div>
      <div class="dsr-cards">
        <div class="dsr-card">
          <h4>How the money came in</h4>
          <div class="dsr-bar">${bar}</div>
          <div class="dsr-legend">${modes.map(([key, label]) => `<span><i class="dsr-bar-${key}"></i>${esc(label)} ${amt(mode(key), { blank: false })}</span>`).join('')}</div>
          ${mode('other') ? `<div class="dsr-card-note">Advance or credit note used: ${amt(mode('other'))}</div>` : ''}
          ${summary.deposits ? `<div class="dsr-card-note" data-dsr-deposits>Visa deposits: received ${amt(summary.deposits.received_cents, { blank: false })} · refunded ${amt(summary.deposits.refunded_cents, { blank: false })} · kept ${amt(summary.deposits.kept_cents, { blank: false })} · still held ${amt(summary.deposits.held_at_end_cents, { blank: false })}</div>` : ''}
        </div>
        ${cashBank.length ? `
        <div class="dsr-card">
          <h4>Cash and bank</h4>
          <div class="dsr-cashbank" style="grid-template-columns:auto repeat(${cashBank.length}, 1fr)">
            <span></span>${cashBank.map((key) => `<span class="num dsr-cb-head">${esc(position[key].label)}</span>`).join('')}
            ${line('Opening', (p) => p.opening_cents)}
            ${line('In', (p) => p.in_cents)}
            ${line('Out', (p) => -p.out_cents)}
            ${line('Closing', (p) => p.closing_cents, 'dsr-cb-total')}
          </div>
        </div>` : ''}
      </div>
    </div>`;
}

// Sales by staff for the whole period, whatever the staff filter shows.
function staffTable(data) {
  const rows = data.staff_totals || [];
  if (!rows.length) return '';
  return `
    <table class="report-table dsr-table dsr-narrow dsr-staff-table" data-dsr-table="staff"><caption class="sr-only">Sales by staff</caption>
      <thead><tr><th scope="col">Staff</th><th scope="col" class="num">Sales</th><th scope="col" class="num">Amount</th><th scope="col" class="num dsr-profit">Gross profit</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr${row.staff === data.staff ? ' class="is-selected"' : ''}>
          <td>${esc(row.staff)}</td>
          <td class="num">${row.sales}</td>
          <td class="num">${amt(row.sale_cents, { blank: false })}</td>
          <td class="num dsr-profit">${amt(row.margin_cents, { blank: false })}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
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
        ${emptyState({
    iconName: 'invoice',
    title: 'No sales in this period',
  })}
      </div>
    `;
  }

  const printed = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const total = (rows, pick) => sumOf(rows, pick);
  const refundsAndCancellations = s.cancellations.length + s.refunds.length + (s.deposit_kept || []).length;
  const staffRows = data.staff_totals || [];
  return `
    <div class="report-card dsr-report ${profitShown() ? 'show-profit' : ''}" data-dsr>
      ${reportHeader('Daily Sales Report', `${periodLabel(data.from, data.to)}${data.staff ? ` · ${data.staff}` : ''}`, company)}
      <div class="dsr-meta">
        <span>Amounts in AED · printed ${esc(printed)}${store.user?.full_name ? ` by ${esc(store.user.full_name)}` : ''}${data.staff ? ` · sales and cancellations by ${esc(data.staff)} only` : ''}</span>
        ${staffPicker(data)}
        <label class="checkbox-row dsr-profit-toggle no-print"><input type="checkbox" data-dsr-profit ${profitShown() ? 'checked' : ''}> <span>Show profit</span></label>
      </div>
      ${overviewHtml(data)}
      ${section('Tickets & bookings', ticketTable(s.tickets), { id: 'tickets', open: true, count: plural(s.tickets.length, 'sale'), total: total(s.tickets, (r) => r.total_cents) })}
      ${section('Visas', visaTable(s.visas), { id: 'visas', open: true, count: plural(s.visas.length, 'application'), total: total(s.visas, (r) => r.total_cents) })}
      ${section('Service income', serviceTable(s.services), { id: 'services', open: true, count: plural(s.services.length, 'invoice'), total: total(s.services, (r) => r.total_cents) })}
      ${section('Cancellations & refunds', cancellationTables(s.cancellations, s.refunds) + depositKeptTable(s.deposit_kept || []), { id: 'cancellations', count: String(refundsAndCancellations), total: total(s.cancellations, (r) => r.sale_cents) })}
      ${section('Collected for older invoices & advances', collectionsTable(s.collections), { id: 'collections', count: String(s.collections.length), total: total(s.collections, (r) => r.amount_cents) })}
      ${section('Money paid out', cashOutTable(s.cash_out, s.summary.position), { id: 'cash-out', count: 'own transfers not counted', total: total(s.cash_out.filter((r) => r.source_type !== 'cash_deposit'), (r) => r.cash_out_cents + r.bank_out_cents) })}
      ${staffRows.length ? section('By staff', staffTable(data), { id: 'staff', count: plural(staffRows.length, 'person', 'people'), total: total(staffRows, (r) => r.sale_cents) }) : ''}
      <div class="dsr-footnote">A sale stays on its own day; a cancellation is a line on its cancellation day. Paid by shows how each sale was settled by the end of the period; Due is still unpaid. Visa deposits are not sales.</div>
    </div>
  `;
}
