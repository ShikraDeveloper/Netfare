import { esc, fmtDate } from './ui.js';

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
      passengers: group ? passengers : [],
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
    case 'deposit': return { top: ['Deposit'], sub: [row.method] };
    case 'deposit_return': return { top: ['Deposit returned'], sub: [row.method] };
    case 'supplier_credit': return { top: ['Supplier credit'], sub: [row.related] };
    case 'credit_refund': return { top: ['Refund received'], sub: [row.method] };
    default: return { top: [row.description], sub: [] };
  }
}

// A group booking's passengers, one row each under its line: folded on
// screen until the "N passengers" button opens them, always printed.
export function paxToggleHtml(passengers, index) {
  return passengers.length
    ? ` <button type="button" class="statement-pax-toggle no-print" data-statement-pax="${index}" aria-expanded="false">${passengers.length} passengers</button>`
    : '';
}

export function paxRowsHtml(passengers, index, colspan = 4) {
  return passengers.map((p) => `
    <tr class="statement-pax" data-pax-of="${index}" hidden>
      <td></td><td></td>
      <td colspan="${colspan}"><div class="statement-pax-line"><span>${esc(p.name)}</span>${p.ticket ? `<span>Ticket ${esc(p.ticket)}</span>` : ''}</div></td>
    </tr>`).join('');
}

export function bindPaxToggles(container) {
  container.querySelectorAll('[data-statement-pax]').forEach((button) => {
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      button.closest('tr').classList.toggle('open', open);
      container.querySelectorAll(`[data-pax-of="${button.dataset.statementPax}"]`).forEach((line) => { line.hidden = !open; });
    });
  });
}
