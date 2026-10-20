'use strict';

const {
  bad,
  notFound,
  str,
  optionalStr,
  num,
  cents,
  dateISO,
} = require('../util');
const { allocateNumber } = require('./numbering');
const { isPurchaseAccount } = require('../accounting');
const invoiceService = require('./invoices');
const billService = require('./bills');
const portalService = require('./portals');

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

function normalizeItems(db, items, itemType) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const isSale = itemType === 'sale';
    const label = `${isSale ? 'Sale' : 'Cost'} line ${index + 1}`;
    const description = str(item.description, `${label} description`, { max: 300 });
    const quantity = num(item.quantity ?? 1, `${label} quantity`, { min: 0.0001, max: 1_000_000 });
    const unitPrice = cents(item.unit_price_cents, `${label} unit price`);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(item.account_id));
    if (!account) throw bad(`${label}: choose an account`);
    if (!account.is_active) throw bad(`${label}: account "${account.name}" is archived`);
    if (isSale && account.type !== 'revenue') throw bad(`${label}: choose a revenue account`);
    if (!isSale && !isPurchaseAccount(account)) {
      throw bad(`${label}: choose an expense account or a valid non-cash asset`);
    }

    let vendorId = null;
    if (!isSale) {
      const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(item.vendor_id));
      if (!vendor) throw bad(`${label}: choose a supplier`);
      if (!vendor.is_active) throw bad(`${label}: supplier "${vendor.name}" is archived`);
      vendorId = vendor.id;
    }

    return {
      item_type: itemType,
      description,
      quantity,
      unit_price_cents: unitPrice,
      amount_cents: Math.round(quantity * unitPrice),
      account_id: account.id,
      vendor_id: vendorId,
      supplier_ref: optionalStr(item.supplier_ref, `${label} supplier reference`, 120),
    };
  });
}

function insertItems(db, bookingId, saleItems, costItems) {
  const insert = db.prepare(`
    INSERT INTO booking_items (booking_id, item_type, description, quantity, unit_price_cents,
      amount_cents, account_id, vendor_id, supplier_ref, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  saleItems.forEach((item, index) => {
    insert.run(bookingId, 'sale', item.description, item.quantity, item.unit_price_cents,
      item.amount_cents, item.account_id, null, item.supplier_ref, index);
  });
  costItems.forEach((item, index) => {
    insert.run(bookingId, 'cost', item.description, item.quantity, item.unit_price_cents,
      item.amount_cents, item.account_id, item.vendor_id, item.supplier_ref, index);
  });
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
    booking.invoice.balance_cents = Math.max(0, booking.invoice.total_cents - booking.invoice.amount_paid_cents);
  }

  booking.bills = db.prepare(`
    SELECT b.*, v.name AS vendor_name, p.name AS portal_name, p.settlement AS portal_settlement
    FROM bills b
    JOIN vendors v ON v.id = b.vendor_id
    LEFT JOIN supplier_portals p ON p.id = b.portal_id
    WHERE b.booking_id = ?
    ORDER BY b.id
  `).all(id).map((bill) => ({
    ...bill,
    balance_cents: Math.max(0, bill.total_cents - bill.amount_paid_cents),
  }));

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
  `).all(id);

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
    const dueDate = payload.due_date ? dateISO(payload.due_date, 'Due date') : bookingDate;
    if (dueDate < bookingDate) throw bad('Due date cannot be before the booking date');
    const travelDate = payload.travel_date ? dateISO(payload.travel_date, 'Travel date') : null;
    const returnDate = payload.return_date ? dateISO(payload.return_date, 'Return date') : null;
    const taxRate = num(payload.tax_rate ?? 0, 'Tax rate', { min: 0, max: 100 });
    const saleItems = normalizeItems(db, payload.sale_items || [], 'sale');
    const costItems = normalizeItems(db, payload.cost_items || [], 'cost');
    if (!saleItems.length) throw bad('Add at least one sale item');
    const saleTotal = itemTotals(saleItems);
    if (saleTotal <= 0) throw bad('Booking sale total must be greater than zero');

    const number = allocateNumber(db, 'booking', bookingDate);
    const info = db.prepare(`
      INSERT INTO bookings (number, customer_id, booking_date, due_date, travel_date, return_date,
        status, destination, pnr, notes, tax_rate, sale_total_cents, cost_total_cents)
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
      taxRate,
      saleTotal,
      costItems.length ? itemTotals(costItems) : 0,
    );
    const bookingId = Number(info.lastInsertRowid);
    insertItems(db, bookingId, saleItems, costItems);
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
    const dueDate = payload.due_date ? dateISO(payload.due_date, 'Due date') : bookingDate;
    if (dueDate < bookingDate) throw bad('Due date cannot be before the booking date');
    const travelDate = payload.travel_date ? dateISO(payload.travel_date, 'Travel date') : null;
    const returnDate = payload.return_date ? dateISO(payload.return_date, 'Return date') : null;
    const taxRate = num(payload.tax_rate ?? existing.tax_rate, 'Tax rate', { min: 0, max: 100 });
    const saleItems = normalizeItems(db, payload.sale_items || [], 'sale');
    const costItems = normalizeItems(db, payload.cost_items || [], 'cost');
    if (!saleItems.length) throw bad('Add at least one sale item');
    const saleTotal = itemTotals(saleItems);
    if (saleTotal <= 0) throw bad('Booking sale total must be greater than zero');

    db.prepare(`
      UPDATE bookings SET customer_id = ?, booking_date = ?, due_date = ?, travel_date = ?,
        return_date = ?, destination = ?, pnr = ?, notes = ?, tax_rate = ?,
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
      taxRate,
      saleTotal,
      itemTotals(costItems),
      id,
    );
    db.prepare('DELETE FROM booking_items WHERE booking_id = ?').run(id);
    insertItems(db, id, saleItems, costItems);
    return getBooking(db, id);
  })();
}

function deleteBooking(db, id) {
  return db.transaction(() => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!booking) throw notFound('Booking not found');
    if (booking.status !== 'draft') throw bad('Only draft bookings can be deleted. Cancel it instead.');
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
    const saleItems = items.filter((item) => item.item_type === 'sale');
    const costItems = items.filter((item) => item.item_type === 'cost');
    if (!saleItems.length) throw bad('Add sale items before confirming this booking');

    const invoice = invoiceService.createInvoice(db, {
      customer_id: booking.customer_id,
      issue_date: booking.booking_date,
      due_date: booking.due_date || booking.booking_date,
      tax_rate: booking.tax_rate,
      notes: booking.notes,
      terms: booking.destination ? `Destination: ${booking.destination}` : '',
      status: 'sent',
      items: saleItems.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        account_id: item.account_id,
      })),
    });
    db.prepare('UPDATE invoices SET booking_id = ? WHERE id = ?').run(id, invoice.id);

    const groups = new Map();
    for (const item of costItems) {
      if (!item.vendor_id) continue;
      if (!groups.has(item.vendor_id)) groups.set(item.vendor_id, []);
      groups.get(item.vendor_id).push(item);
    }
    for (const [vendorId, vendorItems] of groups.entries()) {
      const bill = billService.createBill(db, {
        vendor_id: vendorId,
        bill_date: booking.booking_date,
        due_date: booking.due_date || booking.booking_date,
        tax_rate: 0,
        notes: `Booking ${booking.number}${booking.pnr ? ` · PNR ${booking.pnr}` : ''}`,
        status: 'received',
        items: vendorItems.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unit_price_cents: item.unit_price_cents,
          account_id: item.account_id,
        })),
      });
      db.prepare('UPDATE bills SET booking_id = ? WHERE id = ?').run(id, bill.id);
      const portal = portalService.portalForVendor(db, vendorId);
      if (portal) {
        db.prepare('UPDATE bills SET portal_id = ? WHERE id = ?').run(portal.id, bill.id);
      }
    }

    // Prepaid portals settle their supplier's bill straight away from the balance.
    const warnings = [];
    const bookingBills = db.prepare('SELECT id, number FROM bills WHERE booking_id = ?').all(id);
    for (const bill of bookingBills) {
      let settled;
      try {
        settled = portalService.autoSettleBill(db, bill.id, booking.booking_date);
      } catch (error) {
        warnings.push(`Bill ${bill.number}: ${error.message}`);
        continue;
      }
      if (settled && settled.shortfall_cents > 0) {
        const short = (settled.shortfall_cents / 100).toFixed(2);
        warnings.push(settled.settled_cents > 0
          ? `Portal "${settled.portal_name}" had only part of the amount for bill ${bill.number}. ${short} is still payable.`
          : `Portal "${settled.portal_name}" has no balance for bill ${bill.number}. ${short} is still payable.`);
      }
    }

    db.prepare("UPDATE bookings SET status = 'confirmed', invoice_id = ?, updated_at = datetime('now') WHERE id = ?").run(invoice.id, id);
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
    db.prepare("UPDATE bookings SET status = 'travelled', updated_at = datetime('now') WHERE id = ?").run(id);
    return getBooking(db, id);
  })();
}

function cancelBooking(db, id) {
  return db.transaction(() => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!booking) throw notFound('Booking not found');
    if (booking.status === 'cancelled') throw bad('Booking is already cancelled');

    if (booking.status !== 'draft' && booking.invoice_id) {
      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(booking.invoice_id);
      if (invoice && invoice.status === 'sent') {
        const payments = db.prepare('SELECT id FROM payments WHERE invoice_id = ?').all(invoice.id);
        for (const payment of payments) invoiceService.deleteInvoicePayment(db, payment.id);
        invoiceService.voidInvoice(db, invoice.id);
      }
    }

    if (booking.status !== 'draft') {
      const bills = db.prepare('SELECT * FROM bills WHERE booking_id = ?').all(id);
      for (const bill of bills) {
        if (bill.status !== 'received') continue;
        const payments = db.prepare('SELECT id FROM bill_payments WHERE bill_id = ?').all(bill.id);
        for (const payment of payments) billService.deleteBillPayment(db, payment.id);
        billService.voidBill(db, bill.id);
      }
    }

    db.prepare("UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(id);
    return getBooking(db, id);
  })();
}

function bookingStats(db, from, to) {
  const rows = db.prepare('SELECT * FROM bookings').all();
  const inRange = rows.filter((row) => (!from || row.booking_date >= from) && (!to || row.booking_date <= to));
  const sale = inRange.reduce((sum, row) => sum + row.sale_total_cents, 0);
  const cost = inRange.reduce((sum, row) => sum + row.cost_total_cents, 0);
  const counts = { total: rows.length, draft: 0, confirmed: 0, travelled: 0, cancelled: 0 };
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  return {
    counts,
    booking_count: inRange.length,
    sale_cents: sale,
    cost_cents: cost,
    margin_cents: sale - cost,
  };
}

function bookingMarginReport(db, from, to) {
  const start = dateISO(from, 'From date');
  const end = dateISO(to, 'To date');
  const where = ['b.booking_date >= ?', 'b.booking_date <= ?'];
  const params = [start, end];
  const rows = db.prepare(`
    ${bookingSelect}
    WHERE ${where.join(' AND ')}
    ORDER BY b.booking_date DESC, b.id DESC
  `).all(...params);
  const serialised = rows.map(serializeBooking);
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
