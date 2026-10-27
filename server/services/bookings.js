'use strict';

const {
  bad,
  notFound,
  optionalStr,
  dateISO,
  todayISO,
} = require('../util');
const { allocateNumber } = require('./numbering');
const cancellationService = require('./cancellations');
const jobs = require('./jobs');
const jobCosts = require('./job-costs');

const bookingSelect = `
  SELECT b.*, c.name AS customer_name, c.email AS customer_email,
         c.phone AS customer_phone, c.address AS customer_address
  FROM bookings b
  JOIN customers c ON c.id = b.customer_id
`;

function itemTotals(items) {
  return items.reduce((sum, item) => sum + item.amount_cents, 0);
}

function serializeBooking(booking) {
  return {
    ...booking,
    margin_cents: booking.sale_total_cents - booking.cost_total_cents,
    status_display: booking.status,
  };
}

function assertCustomer(db, customerId) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(customerId));
  if (!customer) throw bad('Choose a customer');
  if (!customer.is_active) throw bad('That customer is archived');
  return customer;
}

function tripDates(payload) {
  const travelDate = payload.travel_date ? dateISO(payload.travel_date, 'Travel date') : null;
  const returnDate = payload.return_date ? dateISO(payload.return_date, 'Return date') : null;
  if (travelDate && returnDate && returnDate < travelDate) {
    throw bad('Return date cannot be before the travel date');
  }
  return { travelDate, returnDate };
}

function getBooking(db, id) {
  const booking = db.prepare(`${bookingSelect} WHERE b.id = ?`).get(id);
  if (!booking) throw notFound('Booking not found');

  booking.items = db.prepare(`
    SELECT bi.*, a.code AS account_code, a.name AS account_name, v.name AS vendor_name
    FROM booking_items bi
    JOIN accounts a ON a.id = bi.account_id
    LEFT JOIN vendors v ON v.id = bi.vendor_id
    WHERE bi.booking_id = ?
    ORDER BY bi.item_type, bi.sort_order, bi.id
  `).all(id);
  booking.sale_items = booking.items.filter((item) => item.item_type === 'sale');
  booking.cost_items = booking.items.filter((item) => item.item_type === 'cost');

  booking.invoice = booking.invoice_id
    ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(booking.invoice_id)
    : null;
  if (booking.invoice) {
    booking.invoice.balance_cents = booking.invoice.status === 'sent'
      ? Math.max(0, booking.invoice.total_cents - booking.invoice.amount_paid_cents - (booking.invoice.credit_applied_cents || 0))
      : 0;
  }

  booking.bills = db.prepare(`
    SELECT b.*, v.name AS vendor_name, p.name AS portal_name, p.settlement AS portal_settlement,
      (SELECT COALESCE(SUM(scn.amount_cents), 0)
       FROM supplier_credit_notes scn
       WHERE scn.bill_id = b.id AND scn.status = 'issued') AS supplier_credit_total_cents
    FROM bills b
    JOIN vendors v ON v.id = b.vendor_id
    LEFT JOIN supplier_portals p ON p.id = b.portal_id
    WHERE b.booking_id = ?
    ORDER BY b.id
  `).all(id).map((bill) => ({
    ...bill,
    balance_cents: bill.status === 'received'
      ? Math.max(0, bill.total_cents - bill.amount_paid_cents - (bill.credit_applied_cents || 0))
      : 0,
    supplier_credit_available_cents: bill.status === 'received'
      ? Math.max(0, bill.total_cents - (bill.supplier_credit_total_cents || 0))
      : 0,
  }));
  booking.cancellation = cancellationService.getCancellationForSource(db, 'booking', id);
  booking.status_history = jobs.statusHistory(db, 'booking', id);

  booking.payments = booking.invoice
    ? db.prepare(`
        SELECT p.*, a.name AS deposit_account_name
        FROM payments p
        JOIN accounts a ON a.id = p.deposit_account_id
        WHERE p.invoice_id = ?
        ORDER BY p.payment_date, p.id
      `).all(booking.invoice_id)
    : [];

  const billIds = booking.bills.map((bill) => bill.id);
  booking.bill_payments = billIds.length
    ? db.prepare(`
        SELECT bp.*, a.name AS payment_account_name
        FROM bill_payments bp
        JOIN accounts a ON a.id = bp.payment_account_id
        WHERE bp.bill_id IN (${billIds.map(() => '?').join(', ')})
        ORDER BY bp.payment_date, bp.id
      `).all(...billIds)
    : [];

  booking.advances = db.prepare(`
    SELECT * FROM customer_advances
    WHERE booking_id = ?
    ORDER BY advance_date, id
  `).all(id).map((advance) => {
    const voided = Boolean(advance.voided_at);
    return {
      ...advance,
      status_display: voided ? 'void' : advance.status,
      voided,
      remaining_cents: voided
        ? 0
        : Math.max(0, advance.amount_cents - advance.applied_cents - advance.refunded_cents),
    };
  });

  booking.amount_paid_cents = booking.invoice ? booking.invoice.amount_paid_cents : 0;
  booking.balance_cents = booking.invoice ? booking.invoice.balance_cents : booking.sale_total_cents;

  return serializeBooking(booking);
}

function listBookings(db, { status, search, from, to } = {}) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('b.booking_date >= ?');
    params.push(dateISO(from, 'From date'));
  }
  if (to) {
    clauses.push('b.booking_date <= ?');
    params.push(dateISO(to, 'To date'));
  }
  if (search) {
    clauses.push('(b.number LIKE ? OR c.name LIKE ? OR b.destination LIKE ? OR b.pnr LIKE ?)');
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`${bookingSelect} ${where} ORDER BY b.booking_date DESC, b.id DESC`).all(...params);
  const serialized = rows.map(serializeBooking);
  if (!status || status === 'all') return serialized;
  return serialized.filter((row) => row.status === status);
}

function createBooking(db, payload) {
  return db.transaction(() => {
    const customer = assertCustomer(db, payload.customer_id);
    const bookingDate = dateISO(payload.booking_date, 'Booking date');
    const dueDate = payload.due_date ? dateISO(payload.due_date, 'Due date') : jobs.defaultDueDate(db, bookingDate);
    if (dueDate < bookingDate) throw bad('Due date cannot be before the booking date');
    const { travelDate, returnDate } = tripDates(payload);
    const saleItems = jobs.normalizeJobItems(db, payload.sale_items || [], 'sale');
    const costItems = jobs.normalizeJobItems(db, payload.cost_items || [], 'cost');
    if (!saleItems.length) throw bad('Add at least one sale item');
    const saleTotal = itemTotals(saleItems);
    if (saleTotal <= 0) throw bad('Booking sale total must be greater than zero');

    const number = allocateNumber(db, 'booking', bookingDate);
    const info = db.prepare(`
      INSERT INTO bookings (number, customer_id, booking_date, due_date, travel_date, return_date,
        status, destination, pnr, notes, invoice_notes, sale_total_cents, cost_total_cents)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      customer.id,
      bookingDate,
      dueDate,
      travelDate,
      returnDate,
      optionalStr(payload.destination, 'Destination', 200),
      optionalStr(payload.pnr, 'PNR / ticket number', 60),
      optionalStr(payload.notes, 'Notes', 2000),
      optionalStr(payload.invoice_notes, 'Invoice note', 2000),
      saleTotal,
      costItems.length ? itemTotals(costItems) : 0,
    );
    const bookingId = Number(info.lastInsertRowid);
    jobs.insertJobItems(db, 'booking', bookingId, saleItems, costItems);
    jobs.recordStatus(db, 'booking', bookingId, { to: 'draft', remarks: 'Booking created' });
    return getBooking(db, bookingId);
  })();
}

function updateBooking(db, id, payload) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!existing) throw notFound('Booking not found');
    if (existing.status !== 'draft') throw bad('Only draft bookings can be edited');
    const customer = assertCustomer(db, payload.customer_id ?? existing.customer_id);
    const bookingDate = dateISO(payload.booking_date ?? existing.booking_date, 'Booking date');
    const dueDate = payload.due_date
      ? dateISO(payload.due_date, 'Due date')
      : (existing.due_date && existing.due_date >= bookingDate ? existing.due_date : jobs.defaultDueDate(db, bookingDate));
    if (dueDate < bookingDate) throw bad('Due date cannot be before the booking date');
    const { travelDate, returnDate } = tripDates(payload);
    const saleItems = jobs.normalizeJobItems(db, payload.sale_items || [], 'sale');
    const costItems = jobs.normalizeJobItems(db, payload.cost_items || [], 'cost');
    if (!saleItems.length) throw bad('Add at least one sale item');
    const saleTotal = itemTotals(saleItems);
    if (saleTotal <= 0) throw bad('Booking sale total must be greater than zero');

    db.prepare(`
      UPDATE bookings SET customer_id = ?, booking_date = ?, due_date = ?, travel_date = ?,
        return_date = ?, destination = ?, pnr = ?, notes = ?, invoice_notes = ?,
        sale_total_cents = ?, cost_total_cents = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      customer.id,
      bookingDate,
      dueDate,
      travelDate,
      returnDate,
      optionalStr(payload.destination, 'Destination', 200),
      optionalStr(payload.pnr, 'PNR / ticket number', 60),
      optionalStr(payload.notes, 'Notes', 2000),
      optionalStr(payload.invoice_notes ?? existing.invoice_notes, 'Invoice note', 2000),
      saleTotal,
      itemTotals(costItems),
      id,
    );
    db.prepare('DELETE FROM booking_items WHERE booking_id = ?').run(id);
    jobs.insertJobItems(db, 'booking', id, saleItems, costItems);
    return getBooking(db, id);
  })();
}

function deleteBooking(db, id) {
  return db.transaction(() => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!booking) throw notFound('Booking not found');
    if (booking.status !== 'draft') throw bad('Only draft bookings can be deleted. Cancel it instead.');
    db.prepare("DELETE FROM attachments WHERE entity_type = 'booking' AND entity_id = ?").run(id);
    jobs.deleteStatusHistory(db, 'booking', id);
    db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
    return { deleted: true };
  })();
}

function confirmBooking(db, id) {
  return db.transaction(() => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!booking) throw notFound('Booking not found');
    if (booking.status !== 'draft') throw bad('Only draft bookings can be confirmed');
    const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ? ORDER BY item_type, sort_order, id').all(id);
    const { invoice, warnings } = jobs.postJobDocuments(db, {
      sourceType: 'booking',
      jobId: id,
      customerId: booking.customer_id,
      issueDate: booking.booking_date,
      dueDate: booking.due_date || booking.booking_date,
      // Only the customer-facing note is copied; booking notes stay internal.
      invoiceNotes: booking.invoice_notes,
      invoiceTerms: booking.destination ? `Destination: ${booking.destination}` : '',
      billNotes: `Booking ${booking.number}${booking.pnr ? ` · PNR ${booking.pnr}` : ''}`,
      items,
    });

    db.prepare("UPDATE bookings SET status = 'confirmed', invoice_id = ?, updated_at = datetime('now') WHERE id = ?").run(invoice.id, id);
    jobs.recordStatus(db, 'booking', id, { from: 'draft', to: 'confirmed', remarks: `Invoice ${invoice.number} posted` });
    const result = getBooking(db, id);
    if (warnings.length) result.warnings = warnings;
    return result;
  })();
}

function markTravelled(db, id) {
  return db.transaction(() => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!booking) throw notFound('Booking not found');
    if (booking.status !== 'confirmed') throw bad('Only confirmed bookings can be marked as travelled');
    if (booking.travel_date && booking.travel_date > todayISO()) {
      throw bad(`The travel date is ${booking.travel_date}. Mark the booking as travelled on or after that date.`);
    }
    db.prepare("UPDATE bookings SET status = 'travelled', updated_at = datetime('now') WHERE id = ?").run(id);
    jobs.recordStatus(db, 'booking', id, { from: 'confirmed', to: 'travelled' });
    return getBooking(db, id);
  })();
}

function cancelBooking(db, id, payload = {}) {
  cancellationService.cancelSource(db, {
    sourceType: 'booking',
    sourceId: id,
    payload,
    finalStatus: 'cancelled',
  });
  return getBooking(db, id);
}

function bookingStats(db, from, to) {
  const rows = db.prepare('SELECT * FROM bookings').all();
  const inRange = rows.filter((row) => (!from || row.booking_date >= from) && (!to || row.booking_date <= to));
  const valued = jobCosts.valueJobs(db, 'booking', inRange);
  const sale = valued.reduce((sum, row) => sum + row.sale_total_cents, 0);
  const cost = valued.reduce((sum, row) => sum + row.cost_total_cents, 0);
  const counts = { total: rows.length, draft: 0, confirmed: 0, travelled: 0, cancelled: 0 };
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  return {
    counts,
    booking_count: valued.length,
    draft_count: inRange.filter((row) => row.status === 'draft').length,
    sale_cents: sale,
    cost_cents: cost,
    margin_cents: sale - cost,
  };
}

function bookingMarginReport(db, from, to) {
  const start = dateISO(from, 'From date');
  const end = dateISO(to, 'To date');
  const rows = db.prepare(`
    ${bookingSelect}
    WHERE b.booking_date >= ? AND b.booking_date <= ?
    ORDER BY b.booking_date DESC, b.id DESC
  `).all(start, end);
  const serialised = jobCosts.valueJobs(db, 'booking', rows.map(serializeBooking));
  const totals = serialised.reduce((acc, row) => {
    acc.sale_cents += row.sale_total_cents;
    acc.cost_cents += row.cost_total_cents;
    acc.margin_cents += row.margin_cents;
    return acc;
  }, { sale_cents: 0, cost_cents: 0, margin_cents: 0 });
  totals.margin_percent = totals.sale_cents ? (totals.margin_cents / totals.sale_cents) * 100 : 0;
  return { from: start, to: end, rows: serialised, totals };
}

module.exports = {
  listBookings,
  getBooking,
  createBooking,
  updateBooking,
  deleteBooking,
  confirmBooking,
  markTravelled,
  cancelBooking,
  bookingStats,
  bookingMarginReport,
};
