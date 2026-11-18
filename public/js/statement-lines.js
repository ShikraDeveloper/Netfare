import { esc, fmtDate, fmtMoney } from './ui.js';

// A statement line is one row per document. Its particulars are two short
// lines: who it was for on top (name and nationality), and below the passport,
// visa type and days, or the PNR and ticket. Customer statements carry the
// passport masked; supplier statements (ours) in full, with the customer.
const shortRef = (number) => String(number || '').replace(/-\d{4}-/, '-');
const titleCase = (value) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : '');

// "INV-0011, 0012": invoice numbers a receipt paid, without repeating the prefix.
function documentList(numbers) {
  return numbers.map((number, i) => (i ? shortRef(number).replace(/^[A-Z]+-/, '') : shortRef(number))).join(', ');
}

export function particulars(row, kind) {
  const { booking, visa } = row;
  const customer = kind === 'vendor' ? row.customer_name : '';
  const ref = row.supplier_ref ? `Ref ${row.supplier_ref}` : '';
  if (visa && visa.applicant_name) {
    return {
      top: [visa.applicant_name, visa.nationality],
      sub: [kind === 'vendor' ? visa.passport : visa.passport_masked, titleCase(visa.visa_type),
        Number(visa.duration_days) > 0 ? `${visa.duration_days} days` : '', customer, ref],
    };
  }
  if (booking) {
    const passengers = booking.passengers || [];
    const ticketList = passengers.map((p) => p.ticket).filter(Boolean);
    // Several passengers or tickets: the first +N on the line, each one in the
    // list under it (open on screen, always printed).
    const group = passengers.length > 1 || ticketList.length > 1;
    const tickets = group ? (ticketList.length ? `${ticketList[0]}${ticketList.length > 1 ? ` +${ticketList.length - 1}` : ''}` : '') : ticketList.join(', ');
    const known = booking.pnr || tickets;
    const dates = booking.travel_date ? `${fmtDate(booking.travel_date, { short: true })}${booking.return_date ? ` – ${fmtDate(booking.return_date, { short: true })}` : ''}` : '';
    const ids = kind === 'vendor'
      ? [tickets ? `Ticket ${tickets}` : '', booking.pnr ? `PNR ${booking.pnr}` : '']
      : [booking.pnr ? `PNR ${booking.pnr}` : '', group ? booking.destination : (tickets ? `Ticket ${tickets}` : '')];
    return {
      top: [passengers.length ? `${passengers[0].name}${passengers.length > 1 ? ` +${passengers.length - 1}` : ''}` : booking.destination],
      sub: [...(known ? ids : [passengers.length ? booking.destination : '', dates]), customer, ref],
      list: group ? passengers.map((p) => ({ text: p.name, detail: p.ticket ? `Ticket ${p.ticket}` : '' })) : [],
      listLabel: `${passengers.length} passengers`,
    };
  }
  switch (row.kind) {
    case 'invoice': {
      const items = row.items || [];
      const what = items.length ? `${items[0].description}${items.length > 1 ? ` +${items.length - 1}` : ''}` : 'Invoice';
      // A service for someone else names that person, as the invoice does.
      return row.beneficiary?.name
        ? { top: [row.beneficiary.name, row.beneficiary.nationality], sub: [what, row.related ? `Cancelled by ${row.related}` : ''] }
        : { top: [what], sub: [row.related ? `Cancelled by ${row.related}` : ''] };
    }
    case 'bill': return { top: [row.first_item ? `${row.first_item}${row.item_count > 1 ? ` +${row.item_count - 1}` : ''}` : 'Bill'], sub: [ref] };
    case 'receipt': return { top: [row.method], sub: [documentList(row.allocations.map((share) => share.invoice))] };
    case 'payment': return { top: [kind === 'vendor' ? `Paid · ${row.method}` : row.method], sub: [row.related] };
    case 'credit_note': return { top: [row.status === 'opening' ? 'Opening balance owed to you' : 'Credit note'], sub: [] };
    case 'cancellation': return { top: ['Cancelled'], sub: [`${row.related} reversed`] };
    case 'cancellation_charge': return { top: ['Cancellation charges'], sub: [] };
    case 'refund': return { top: [kind === 'vendor' ? 'Supplier refund' : 'Refund'], sub: [row.method, row.related] };
    case 'deposit': return topupLines(row, kind);
    case 'deposit_return': return { top: ['Withdrawal'], sub: [row.method] };
    case 'supplier_credit': return { top: ['Supplier credit'], sub: [row.related] };
    case 'credit_refund': return { top: ['Refund received'], sub: [row.method] };
    default: return { top: [row.description], sub: [] };
  }
}

// A top-up, with the bills it paid (and any withdrawal or visa deposit)
// listed under it, as a receipt lists the invoices it paid.
function topupLines(row, kind) {
  const paid = row.paid || [];
  const bills = [...new Set(paid.filter((use) => use.kind === 'bill').map((use) => use.number))];
  const list = paid.map((use) => {
    if (use.kind !== 'bill') {
      return { text: use.kind === 'withdrawal' ? `Withdrawal${use.number ? ` ${use.number}` : ''}` : `Visa deposit ${use.number}`, detail: fmtMoney(use.amount_cents) };
    }
    const lines = use.bill ? particulars({ kind: 'bill', ...use.bill }, kind) : { top: [] };
    return {
      text: [shortRef(use.number), lines.top[0], use.bill?.customer_name].filter(Boolean).join(' · '),
      detail: `${fmtMoney(use.amount_cents)}${use.part ? ' · part' : ''}`,
    };
  });
  return {
    top: ['Top-up'],
    sub: [row.method, bills.length ? `Paid ${documentList(bills)}` : ''],
    list,
    listLabel: bills.length === paid.length ? `${bills.length} ${bills.length === 1 ? 'bill' : 'bills'}` : `Paid for ${paid.length}`,
  };
}

// A list under a line (a group booking's passengers, the bills a top-up
// paid), one row each: folded on screen until its button opens it, always
// printed.
export function listToggleHtml(lines, index) {
  return lines.list?.length
    ? ` <button type="button" class="statement-pax-toggle no-print" data-statement-pax="${index}" aria-expanded="false">${esc(lines.listLabel)}</button>`
    : '';
}

export function listRowsHtml(lines, index, colspan = 4) {
  return (lines.list || []).map((item) => `
    <tr class="statement-pax" data-pax-of="${index}" hidden>
      <td></td><td></td>
      <td colspan="${colspan}"><div class="statement-pax-line"><span>${esc(item.text)}</span>${item.detail ? `<span>${esc(item.detail)}</span>` : ''}</div></td>
    </tr>`).join('');
}

export function bindListToggles(container) {
  container.querySelectorAll('[data-statement-pax]').forEach((button) => {
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      button.closest('tr').classList.toggle('open', open);
      container.querySelectorAll(`[data-pax-of="${button.dataset.statementPax}"]`).forEach((line) => { line.hidden = !open; });
    });
  });
}
