'use strict';

const { dateISO, notFound, todayISO, maskPassport } = require('../util');

function normalizeRange({ from, to } = {}) {
  let start = from ? dateISO(from, 'From date') : '';
  let end = to ? dateISO(to, 'To date') : todayISO();
  if (start && start > end) [start, end] = [end, start];
  return { from: start, to: end };
}

// Invoices that belong on a statement: open ones, and ones later cancelled by
// the customer (the cancellation appears as its own line). Invoices voided as
// mistakes are left out.
const ON_STATEMENT = `(i.status = 'sent'
  OR (i.status = 'void' AND EXISTS (SELECT 1 FROM cancellations x WHERE x.invoice_id = i.id AND x.voided_at IS NULL)))`;

// Same-day order: the sale, then money in, then the cancellation and its follow-ups.
const KIND_ORDER = {
  invoice: 1, payment: 2, receipt: 2, credit_note: 3, cancellation: 4, cancellation_charge: 5, refund: 7,
};

// A cancellation-charges invoice follows the cancellation that raised it.
const rank = (row) => (row.kind === 'invoice' && row.charge_of ? KIND_ORDER.cancellation_charge : KIND_ORDER[row.kind] || 9);

// What a booking line names on a statement: number, route, PNR, travel dates
// and the passengers with their ticket numbers (the ticket is the supplier
// reference on the passenger's cost line). With a supplier, only that
// supplier's passengers.
function bookingDetails(db, bookingId, vendorId = null) {
  const booking = db.prepare('SELECT number, destination, pnr, travel_date, return_date FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return null;
  const lines = db.prepare(`
    SELECT item_type, passenger_name, supplier_ref, vendor_id, amount_cents FROM booking_items
    WHERE booking_id = ? AND passenger_name <> '' ORDER BY sort_order, id
  `).all(bookingId);
  const tickets = new Map();
  for (const line of lines) {
    if (line.item_type !== 'cost' || (vendorId && line.vendor_id !== vendorId)) continue;
    const ref = String(line.supplier_ref || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
    if (!ref) continue;
    tickets.set(line.passenger_name, [...(tickets.get(line.passenger_name) || []), ref]);
  }
  // Sale lines on the customer's statement, this supplier's cost lines on theirs.
  const own = lines.filter((line) => (vendorId ? line.item_type === 'cost' && line.vendor_id === vendorId : line.item_type === 'sale'));
  const amounts = new Map();
  for (const line of own) amounts.set(line.passenger_name, (amounts.get(line.passenger_name) || 0) + line.amount_cents);
  return { ...booking, passengers: [...amounts.keys()].map((name) => ({ name, ticket: (tickets.get(name) || []).join(', '), amount_cents: amounts.get(name) })) };
}

// Receive payment shares one receipt over several invoices, one payment on
// each. On the statement that is money received once: one line for the
// receipt, with what it paid in its details.
function groupReceipts(db, customerId, lines) {
  const shares = new Map(db.prepare(`
    SELECT p.id, a.id AS receipt_id, a.number AS receipt_number
    FROM payments p JOIN customer_advances a ON a.id = p.advance_id
    WHERE p.customer_id = ? AND p.from_receipt = 1
  `).all(customerId).map((row) => [row.id, row]));
  const receipts = new Map();
  const rest = [];
  for (const line of lines) {
    const share = line.kind === 'payment' ? shares.get(line.id) : null;
    if (!share) { rest.push(line); continue; }
    const receipt = receipts.get(share.receipt_id) || {
      ...line, kind: 'receipt', id: share.receipt_id, reference: share.receipt_number, related: '', amount_cents: 0, allocations: [],
    };
    receipt.amount_cents += line.amount_cents;
    receipt.allocations.push({ invoice: line.related, payment: line.reference, amount_cents: line.amount_cents });
    if (line.created_at < receipt.created_at) receipt.created_at = line.created_at;
    receipts.set(share.receipt_id, receipt);
  }
  return [...rest, ...receipts.values()];
}

function customerTransactions(db, customerId) {
  const lines = db.prepare(`
    SELECT 'invoice' AS kind, i.id, i.number AS reference, i.issue_date AS date,
           i.due_date, i.total_cents AS amount_cents, i.status,
           '' AS method, COALESCE((SELECT x.number FROM cancellations x WHERE x.invoice_id = i.id AND x.voided_at IS NULL), '') AS related,
           i.cancellation_id AS charge_of, i.created_at AS created_at
    FROM invoices i
    WHERE i.customer_id = ? AND ${ON_STATEMENT}
    UNION ALL
    SELECT 'payment', p.id, p.number, p.payment_date, NULL, p.amount_cents, 'paid', p.method, i.number, NULL, p.created_at AS created_at
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    WHERE p.customer_id = ? AND ${ON_STATEMENT} AND p.status = 'posted'
    UNION ALL
    SELECT 'cancellation', x.id, x.number, x.cancellation_date, NULL, i.total_cents, 'cancelled', '', i.number, NULL, x.created_at AS created_at
    FROM cancellations x
    JOIN invoices i ON i.id = x.invoice_id
    WHERE x.customer_id = ? AND i.status = 'void' AND x.voided_at IS NULL
    UNION ALL
    SELECT 'cancellation_charge', x.id, x.number, x.cancellation_date, NULL,
           MIN(x.received_cents, x.customer_charges_cents), 'charged', '', COALESCE(i.number, ''), NULL, x.created_at AS created_at
    FROM cancellations x
    LEFT JOIN invoices i ON i.id = x.invoice_id
    WHERE x.customer_id = ? AND MIN(x.received_cents, x.customer_charges_cents) > 0 AND x.voided_at IS NULL
    UNION ALL
    -- A credit note counts when issued (it lowers what the customer owes).
    -- One made from a cancellation refund needs no line: that money already
    -- shows as owed back on the cancellation.
    SELECT 'credit_note', cn.id, cn.number, cn.credit_date, NULL, cn.amount_cents,
           CASE WHEN cn.is_opening = 1 THEN 'opening' ELSE 'issued' END, '', '', NULL, cn.created_at AS created_at
    FROM credit_notes cn
    WHERE cn.customer_id = ? AND cn.status = 'issued' AND cn.cancellation_id IS NULL
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, x.number, NULL, r.created_at AS created_at
    FROM refunds r
    JOIN cancellations x ON x.id = r.cancellation_id
    WHERE r.refund_type = 'customer' AND r.party_id = ? AND r.status = 'paid'
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, COALESCE(i.number, cr.number, ''), NULL, r.created_at AS created_at
    FROM refunds r
    LEFT JOIN invoices i ON i.id = r.invoice_id
    LEFT JOIN credit_notes cr ON cr.id = r.credit_note_id
    WHERE r.refund_type = 'customer' AND r.party_id = ? AND r.status = 'paid'
      AND r.cancellation_id IS NULL AND r.advance_id IS NULL
      -- Visa deposit refunds belong to the separate deposit section.
      AND r.deposit_id IS NULL
  `).all(customerId, customerId, customerId, customerId, customerId, customerId, customerId);
  const rows = groupReceipts(db, customerId, lines)
    .sort((a, b) => byDateThenEntry(a, b) || rank(a) - rank(b) || a.id - b.id)
    .map((row) => {
    if (row.kind === 'invoice') {
      return {
        ...row,
        description: `Invoice ${row.reference}${row.related ? ` · cancelled by ${row.related}` : ''}`,
        debit_cents: row.amount_cents,
        credit_cents: 0,
      };
    }
    if (row.kind === 'payment') {
      return {
        ...row,
        description: `Payment ${row.reference}${row.related ? ` · ${row.related}` : ''}`,
        debit_cents: 0,
        credit_cents: row.amount_cents,
      };
    }
    if (row.kind === 'receipt') {
      return {
        ...row,
        description: `Receipt ${row.reference} · ${row.method}`,
        debit_cents: 0,
        credit_cents: row.amount_cents,
      };
    }
    if (row.kind === 'credit_note') {
      return {
        ...row,
        description: row.status === 'opening' ? `Opening balance owed to you ${row.reference}` : `Credit note ${row.reference}`,
        debit_cents: 0,
        credit_cents: row.amount_cents,
      };
    }
    // A cancellation reverses the invoice on the cancellation date; money the
    // customer paid is then owed back to them until it is charged, refunded or
    // kept as a credit note.
    if (row.kind === 'cancellation') {
      return {
        ...row,
        description: `Cancellation ${row.reference} · invoice ${row.related} reversed`,
        debit_cents: 0,
        credit_cents: row.amount_cents,
      };
    }
    if (row.kind === 'cancellation_charge') {
      return {
        ...row,
        description: `Cancellation charges ${row.reference}`,
        debit_cents: row.amount_cents,
        credit_cents: 0,
      };
    }
    return {
      ...row,
      description: `Refund ${row.reference}${row.related ? ` · ${row.related}` : ''}`,
      debit_cents: row.amount_cents,
      credit_cents: 0,
    };
  });

  const itemsByInvoice = new Map();
  const itemRows = db.prepare(`
    SELECT ii.invoice_id, ii.description, ii.quantity, ii.unit_price_cents, ii.amount_cents
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.customer_id = ? AND ${ON_STATEMENT}
    ORDER BY ii.invoice_id, ii.sort_order, ii.id
  `).all(customerId);
  for (const item of itemRows) {
    if (!itemsByInvoice.has(item.invoice_id)) itemsByInvoice.set(item.invoice_id, []);
    itemsByInvoice.get(item.invoice_id).push({
      description: item.description,
      quantity: item.quantity,
      unit_price_cents: item.unit_price_cents,
      amount_cents: item.amount_cents,
    });
  }

  const visasByInvoice = new Map();
  const visaRows = db.prepare(`
    SELECT i.id AS invoice_id, v.id, v.number, v.visa_type, v.destination_country,
           v.duration_days, v.applicant_name, v.applicant_is_customer, v.nationality,
           v.passport_number, v.passport_expiry, v.reference
    FROM invoices i
    JOIN visa_applications v ON v.id = i.visa_id
    WHERE i.customer_id = ? AND ${ON_STATEMENT} AND i.visa_id IS NOT NULL
  `).all(customerId);
  for (const visa of visaRows) {
    // Statements are sent to the customer: mask the passport number and leave
    // out the date of birth.
    const { invoice_id: invoiceId, passport_number: passportNumber, ...details } = visa;
    visasByInvoice.set(invoiceId, { ...details, passport_masked: maskPassport(passportNumber) });
  }

  // Invoices for someone other than the customer name that person too.
  const beneficiaryByInvoice = new Map();
  for (const row of db.prepare(`
    SELECT i.id, i.beneficiary_name, i.beneficiary_nationality, i.beneficiary_passport
    FROM invoices i
    WHERE i.customer_id = ? AND ${ON_STATEMENT} AND i.beneficiary_is_customer = 0
  `).all(customerId)) {
    beneficiaryByInvoice.set(row.id, {
      name: row.beneficiary_name,
      nationality: row.beneficiary_nationality,
      passport_masked: maskPassport(row.beneficiary_passport),
    });
  }

  // Where each credit note went: the invoices it was used on.
  const creditUse = new Map();
  for (const use of db.prepare(`
    SELECT ca.credit_note_id, i.number AS invoice, ca.amount_cents FROM credit_applications ca
    JOIN credit_notes cn ON cn.id = ca.credit_note_id JOIN invoices i ON i.id = ca.invoice_id
    WHERE cn.customer_id = ? ORDER BY ca.applied_date, ca.id
  `).all(customerId)) creditUse.set(use.credit_note_id, [...(creditUse.get(use.credit_note_id) || []), { document: use.invoice, amount_cents: use.amount_cents }]);

  const bookingByInvoice = new Map(db.prepare(`
    SELECT i.id, i.booking_id FROM invoices i WHERE i.customer_id = ? AND ${ON_STATEMENT} AND i.booking_id IS NOT NULL
  `).all(customerId).map((row) => [row.id, bookingDetails(db, row.booking_id)]));

  return rows.map((row) => row.kind === 'invoice'
    ? {
        ...row,
        items: itemsByInvoice.get(row.id) || [],
        visa: visasByInvoice.get(row.id) || null,
        booking: bookingByInvoice.get(row.id) || null,
        beneficiary: beneficiaryByInvoice.get(row.id) || null,
      }
    : row.kind === 'credit_note' ? { ...row, used_on: creditUse.get(row.id) || [] } : row);
}

// Statement lines run by date, then by when each was entered (created_at is
// the entry time), so a day reads in the order the work was done.
function byDateThenEntry(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const x = a.created_at || '';
  const y = b.created_at || '';
  return x < y ? -1 : x > y ? 1 : 0;
}

const VENDOR_KIND_ORDER = { bill: 1, payment: 2, deposit: 2, supplier_credit: 3, credit_refund: 4, refund: 5, deposit_return: 6 };

// Money held on the supplier's portals (prepaid wallets) is part of the
// account: a top-up is money sent to the supplier, a withdrawal is money back.
// A bill paid from the wallet only moves that money onto the bill, so it is
// not a line of its own; the bill's details say so.
const WALLET = "(SELECT id FROM accounts WHERE code = '1400')";

function vendorTransactions(db, vendorId) {
  const paidFromDeposit = new Map();
  for (const row of db.prepare(`
    SELECT bill_id, number, payment_date, amount_cents FROM bill_payments
    WHERE vendor_id = ? AND status = 'posted' AND payment_account_id = ${WALLET}
    ORDER BY payment_date, id
  `).all(vendorId)) {
    if (!paidFromDeposit.has(row.bill_id)) paidFromDeposit.set(row.bill_id, []);
    paidFromDeposit.get(row.bill_id).push({ payment: row.number, date: row.payment_date, amount_cents: row.amount_cents });
  }
  const creditUse = new Map();
  for (const use of db.prepare(`
    SELECT sca.credit_note_id, b.number AS bill, sca.amount_cents FROM supplier_credit_applications sca
    JOIN supplier_credit_notes scn ON scn.id = sca.credit_note_id JOIN bills b ON b.id = sca.bill_id
    WHERE scn.vendor_id = ? ORDER BY sca.applied_date, sca.id
  `).all(vendorId)) creditUse.set(use.credit_note_id, [...(creditUse.get(use.credit_note_id) || []), { document: use.bill, amount_cents: use.amount_cents }]);
  const movedToWallet = new Map(db.prepare(`
    SELECT id, portal_settled_cents FROM supplier_credit_notes WHERE vendor_id = ? AND portal_settled_cents > 0
  `).all(vendorId).map((row) => [row.id, row.portal_settled_cents]));
  const depositFrom = new Map(db.prepare(`
    SELECT t.id, a.name AS account FROM portal_topups t JOIN supplier_portals p ON p.id = t.portal_id
    LEFT JOIN accounts a ON a.id = t.deposit_account_id WHERE p.vendor_id = ?
  `).all(vendorId).map((row) => [row.id, row.account || '']));
  const billLines = new Map();
  for (const line of db.prepare(`
    SELECT bi.bill_id, bi.description, bi.amount_cents FROM bill_items bi JOIN bills b ON b.id = bi.bill_id
    WHERE b.vendor_id = ? AND b.status = 'received' ORDER BY bi.bill_id, bi.sort_order, bi.id
  `).all(vendorId)) billLines.set(line.bill_id, [...(billLines.get(line.bill_id) || []), { description: line.description, amount_cents: line.amount_cents }]);
  // What each bill was for: its booking or visa (with the customer and, for
  // our own records, the full passport), its first line and the supplier's reference.
  const billInfo = new Map(db.prepare(`
    SELECT b.id, b.booking_id, b.supplier_ref,
           (SELECT bi.description FROM bill_items bi WHERE bi.bill_id = b.id ORDER BY bi.sort_order, bi.id LIMIT 1) AS first_item,
           (SELECT COUNT(*) FROM bill_items bi WHERE bi.bill_id = b.id) AS item_count,
           v.number AS visa_number, v.applicant_name, v.visa_type, v.destination_country, v.duration_days, v.nationality, v.passport_number,
           COALESCE(vc.name, bc.name, '') AS customer_name
    FROM bills b
    LEFT JOIN visa_applications v ON v.id = b.visa_id
    LEFT JOIN customers vc ON vc.id = v.customer_id
    LEFT JOIN bookings bk ON bk.id = b.booking_id
    LEFT JOIN customers bc ON bc.id = bk.customer_id
    WHERE b.vendor_id = ? AND b.status = 'received'
  `).all(vendorId).map((row) => [row.id, {
    supplier_ref: row.supplier_ref,
    first_item: row.first_item || '',
    item_count: row.item_count,
    customer_name: row.customer_name,
    booking: row.booking_id ? bookingDetails(db, row.booking_id, vendorId) : null,
    visa: row.visa_number ? {
      number: row.visa_number, applicant_name: row.applicant_name, visa_type: row.visa_type,
      destination_country: row.destination_country, duration_days: row.duration_days,
      nationality: row.nationality, passport: row.passport_number,
    } : null,
  }]));
  return db.prepare(`
    SELECT 'bill' AS kind, b.id, b.number AS reference, b.bill_date AS date,
           b.due_date, b.total_cents AS amount_cents, b.status,
           '' AS method, '' AS related, b.created_at AS created_at
    FROM bills b
    WHERE b.vendor_id = ? AND b.status = 'received'
    UNION ALL
    SELECT 'payment', p.id, p.number, p.payment_date, NULL, p.amount_cents, 'paid', p.method, b.number, p.created_at AS created_at
    FROM bill_payments p
    JOIN bills b ON b.id = p.bill_id
    WHERE p.vendor_id = ? AND b.status <> 'void' AND p.status = 'posted'
      AND COALESCE(p.payment_account_id, 0) <> ${WALLET}
    UNION ALL
    SELECT 'deposit', t.id, t.number, t.topup_date, NULL, t.amount_cents, t.status, t.method, p.name, t.created_at
    FROM portal_topups t JOIN supplier_portals p ON p.id = t.portal_id
    WHERE p.vendor_id = ? AND t.status = 'posted'
    UNION ALL
    SELECT 'deposit_return', w.id, COALESCE(NULLIF(w.reference, ''), 'Withdrawal'), w.refund_date, NULL, w.amount_cents, w.status, w.method, p.name, w.created_at
    FROM portal_refunds w JOIN supplier_portals p ON p.id = w.portal_id
    WHERE p.vendor_id = ? AND w.status = 'posted'
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, COALESCE(b.number, ''), r.created_at AS created_at
    FROM refunds r
    LEFT JOIN bills b ON b.id = r.bill_id
    WHERE r.refund_type = 'supplier' AND r.party_id = ? AND r.status = 'paid'
      AND r.supplier_credit_note_id IS NULL
    UNION ALL
    -- A supplier credit counts when it is issued: it lowers what we owe, or
    -- (once bills are clear) is money the supplier holds for us. Moving it
    -- into the wallet keeps it with the supplier, so it is not a line.
    SELECT 'supplier_credit', scn.id, scn.number, scn.credit_date, NULL,
           scn.amount_cents, 'issued', 'Supplier credit', COALESCE(b.number, ''), scn.created_at AS created_at
    FROM supplier_credit_notes scn
    LEFT JOIN bills b ON b.id = scn.bill_id
    WHERE scn.vendor_id = ? AND scn.status = 'issued'
    UNION ALL
    -- Credit the supplier paid back to us.
    SELECT 'credit_refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, scn.number, r.created_at AS created_at
    FROM refunds r
    JOIN supplier_credit_notes scn ON scn.id = r.supplier_credit_note_id
    WHERE r.refund_type = 'supplier' AND r.party_id = ? AND r.status = 'paid'
  `).all(vendorId, vendorId, vendorId, vendorId, vendorId, vendorId, vendorId)
    // Same day: in the order they were entered (then bill, payment, credit,
    // refund when entered in the same second).
    .sort((a, b) => byDateThenEntry(a, b)
      || (VENDOR_KIND_ORDER[a.kind] || 9) - (VENDOR_KIND_ORDER[b.kind] || 9)
      || a.id - b.id)
    .map((row) => {
    if (row.kind === 'bill') {
      return {
        ...row,
        description: `Bill ${row.reference}`,
        debit_cents: 0,
        credit_cents: row.amount_cents,
        paid_from_deposit: paidFromDeposit.get(row.id) || [],
        lines: billLines.get(row.id) || [],
        ...billInfo.get(row.id),
      };
    }
    if (row.kind === 'deposit') {
      return { ...row, description: `Deposit ${row.reference} · ${row.method}`, debit_cents: row.amount_cents, credit_cents: 0, from_account: depositFrom.get(row.id) || '' };
    }
    if (row.kind === 'deposit_return') {
      return { ...row, description: `Deposit returned · ${row.method}`, debit_cents: 0, credit_cents: row.amount_cents };
    }
    if (row.kind === 'payment') {
      return {
        ...row,
        description: `Payment ${row.reference}${row.related ? ` · ${row.related}` : ''}`,
        debit_cents: row.amount_cents,
        credit_cents: 0,
      };
    }
    if (row.kind === 'supplier_credit') {
      return {
        ...row,
        used_on: creditUse.get(row.id) || [],
        moved_to_wallet_cents: movedToWallet.get(row.id) || 0,
        description: `Supplier credit ${row.reference}${row.related ? ` · ${row.related}` : ''}`,
        debit_cents: row.amount_cents,
        credit_cents: 0,
      };
    }
    if (row.kind === 'credit_refund') {
      return {
        ...row,
        description: `Refund received ${row.reference} · ${row.method || 'Bank transfer'}`,
        debit_cents: 0,
        credit_cents: row.amount_cents,
      };
    }
    return {
      ...row,
      description: `Supplier refund ${row.reference}${row.related ? ` · ${row.related}` : ''}`,
      debit_cents: 0,
      credit_cents: row.amount_cents,
    };
  });
}

// Security deposits are the customer's money held by us, so they run as a
// separate balance beside the invoice balance. Passing a deposit to the visa
// supplier does not change what the customer is owed; a supplier deduction does.
function customerDeposits(db, customerId, range) {
  const rows = db.prepare(`
    SELECT e.id, e.event_type, e.event_date AS date, e.created_at, e.amount_cents, e.deduction_cents, e.forfeit_to, e.notes,
           d.number AS reference, v.number AS visa_number, v.applicant_name, i.number AS invoice_number
    FROM visa_deposit_events e
    JOIN visa_deposits d ON d.id = e.deposit_id
    JOIN visa_applications v ON v.id = d.visa_id
    LEFT JOIN invoices i ON i.id = e.invoice_id
    WHERE d.customer_id = ? AND e.voided_at IS NULL
      AND (e.event_type IN ('collect', 'refund', 'apply', 'forfeit') OR (e.event_type = 'supplier_return' AND e.deduction_cents > 0))
    ORDER BY e.event_date, e.id
  `).all(customerId).map((row) => {
    const visa = `${row.visa_number}${row.applicant_name ? ` · ${row.applicant_name}` : ''}`;
    if (row.event_type === 'collect') return { ...row, description: `Security deposit received · ${visa}`, debit_cents: 0, credit_cents: row.amount_cents };
    if (row.event_type === 'refund') return { ...row, description: 'Deposit refunded', debit_cents: row.amount_cents, credit_cents: 0 };
    if (row.event_type === 'apply') return { ...row, description: `Deposit used to pay invoice ${row.invoice_number || ''}`.trim(), debit_cents: row.amount_cents, credit_cents: 0 };
    if (row.event_type === 'forfeit') return { ...row, description: `Deposit forfeited${row.notes ? ` · ${row.notes}` : ''}`, debit_cents: row.amount_cents, credit_cents: 0 };
    return { ...row, description: `Deducted by the visa supplier${row.notes ? ` · ${row.notes}` : ''}`, debit_cents: row.deduction_cents, credit_cents: 0 };
  });
  if (!rows.length) return null;
  const movement = (row) => row.credit_cents - row.debit_cents;
  const opening = rows.filter((row) => range.from && row.date < range.from).reduce((sum, row) => sum + movement(row), 0);
  let balance = opening;
  const transactions = rows
    .filter((row) => (!range.from || row.date >= range.from) && row.date <= range.to)
    .map((row) => {
      balance += movement(row);
      return { ...row, balance_cents: balance };
    });
  return { opening_held_cents: opening, closing_held_cents: balance, transactions };
}

// Customer advances are money received before an invoice, held in 2400. Like
// security deposits they run as their own balance: received adds, used for an
// invoice or refunded reduces. Voided advances, applications and refunds drop out.
function customerAdvances(db, customerId, range) {
  const rows = [
    ...db.prepare(`
      SELECT * FROM (
        SELECT 'received' AS event_type, a.id, a.number AS reference, a.advance_date AS date,
               a.amount_cents - COALESCE((SELECT SUM(p.amount_cents) FROM payments p
                 WHERE p.advance_id = a.id AND p.from_receipt = 1 AND p.status = 'posted'), 0) AS amount_cents,
               b.number AS booking_number, v.number AS visa_number, '' AS invoice_number
, a.created_at AS created_at
        FROM customer_advances a
        LEFT JOIN bookings b ON b.id = a.booking_id
        LEFT JOIN visa_applications v ON v.id = a.visa_id
        WHERE a.customer_id = ? AND a.voided_at IS NULL
      ) WHERE amount_cents > 0
    `).all(customerId),
    ...db.prepare(`
      SELECT 'applied' AS event_type, p.id, a.number AS reference, p.payment_date AS date, p.amount_cents,
             '' AS booking_number, '' AS visa_number, i.number AS invoice_number
, p.created_at AS created_at
      FROM payments p
      JOIN customer_advances a ON a.id = p.advance_id
      JOIN invoices i ON i.id = p.invoice_id
      WHERE a.customer_id = ? AND a.voided_at IS NULL AND p.status = 'posted' AND p.from_receipt = 0
    `).all(customerId),
    ...db.prepare(`
      SELECT 'refunded' AS event_type, r.id, a.number AS reference, r.refund_date AS date, r.amount_cents,
             '' AS booking_number, '' AS visa_number, '' AS invoice_number
, r.created_at AS created_at
      FROM refunds r
      JOIN customer_advances a ON a.id = r.advance_id
      WHERE a.customer_id = ? AND a.voided_at IS NULL AND r.status = 'paid'
    `).all(customerId),
  ];
  if (!rows.length) return null;
  const order = { received: 1, applied: 2, refunded: 3 };
  rows.sort((a, b) => byDateThenEntry(a, b) || order[a.event_type] - order[b.event_type] || a.id - b.id);
  const described = rows.map((row) => {
    if (row.event_type === 'received') {
      const job = row.booking_number ? ` · booking ${row.booking_number}` : row.visa_number ? ` · visa ${row.visa_number}` : '';
      return { ...row, description: `Advance received${job}`, debit_cents: 0, credit_cents: row.amount_cents };
    }
    if (row.event_type === 'applied') return { ...row, description: `Advance used to pay invoice ${row.invoice_number}`, debit_cents: row.amount_cents, credit_cents: 0 };
    return { ...row, description: 'Advance refunded', debit_cents: row.amount_cents, credit_cents: 0 };
  });
  const movement = (row) => row.credit_cents - row.debit_cents;
  const opening = described.filter((row) => range.from && row.date < range.from).reduce((sum, row) => sum + movement(row), 0);
  let balance = opening;
  const transactions = described
    .filter((row) => (!range.from || row.date >= range.from) && row.date <= range.to)
    .map((row) => {
      balance += movement(row);
      return { ...row, balance_cents: balance };
    });
  return { opening_held_cents: opening, closing_held_cents: balance, transactions };
}

// How late the open invoices (or bills) are on the statement's end date:
// not yet due, 1-30, 31-60, 61-90 and over 90 days past due. Credits and money
// owed back are the difference to the closing balance.
// shortcut: balances are today's, so ageing is shown only for a statement ending today or later; work out past balances if older statements need it.
function ageing(db, kind, partyId, asOf, closing) {
  if (asOf < todayISO()) return null;
  const open = kind === 'customer'
    ? db.prepare(`SELECT due_date, total_cents - amount_paid_cents - credit_applied_cents AS due FROM invoices
        WHERE customer_id = ? AND status = 'sent' AND issue_date <= ? AND total_cents > amount_paid_cents + credit_applied_cents`).all(partyId, asOf)
    : db.prepare(`SELECT due_date, total_cents - amount_paid_cents - credit_applied_cents AS due FROM bills
        WHERE vendor_id = ? AND status = 'received' AND bill_date <= ? AND total_cents > amount_paid_cents + credit_applied_cents`).all(partyId, asOf);
  const buckets = { current: 0, days_30: 0, days_60: 0, days_90: 0, over_90: 0 };
  const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  for (const row of open) {
    const late = day(asOf) - day(row.due_date);
    const key = late <= 0 ? 'current' : late <= 30 ? 'days_30' : late <= 60 ? 'days_60' : late <= 90 ? 'days_90' : 'over_90';
    buckets[key] += row.due;
  }
  const total = Object.values(buckets).reduce((sum, cents) => sum + cents, 0);
  return { as_of: asOf, ...buckets, other_cents: closing - total };
}

// What the supplier's prepaid wallets hold for us now: top-ups and credits
// moved in, less bills paid from them and withdrawals.
function depositHeld(db, vendorId) {
  return db.prepare(`
    SELECT
      COALESCE((SELECT SUM(t.amount_cents) FROM portal_topups t JOIN supplier_portals p ON p.id = t.portal_id WHERE p.vendor_id = ? AND t.status = 'posted'), 0)
    + COALESCE((SELECT SUM(c.amount_cents) FROM portal_credits c JOIN supplier_portals p ON p.id = c.portal_id WHERE p.vendor_id = ? AND c.status = 'posted'), 0)
    - COALESCE((SELECT SUM(w.amount_cents) FROM portal_refunds w JOIN supplier_portals p ON p.id = w.portal_id WHERE p.vendor_id = ? AND w.status = 'posted'), 0)
    - COALESCE((SELECT SUM(bp.amount_cents) FROM bill_payments bp WHERE bp.vendor_id = ? AND bp.status = 'posted' AND bp.payment_account_id = ${WALLET}), 0) AS held
  `).get(vendorId, vendorId, vendorId, vendorId).held;
}

function buildStatement(db, { kind, partyId, from, to }) {
  const partyTable = kind === 'customer' ? 'customers' : 'vendors';
  const party = db.prepare(`SELECT * FROM ${partyTable} WHERE id = ?`).get(partyId);
  if (!party) throw notFound(kind === 'customer' ? 'Customer not found' : 'Vendor not found');
  const range = normalizeRange({ from, to });
  const all = kind === 'customer' ? customerTransactions(db, partyId) : vendorTransactions(db, partyId);

  const before = all.filter((row) => range.from && row.date < range.from);
  const inRange = all.filter((row) => (!range.from || row.date >= range.from) && row.date <= range.to);

  const movement = (row) => kind === 'vendor'
    ? row.credit_cents - row.debit_cents
    : row.debit_cents - row.credit_cents;
  const opening = before.reduce((sum, row) => sum + movement(row), 0);
  let balance = opening;
  const transactions = inRange.map((row) => {
    balance += movement(row);
    return { ...row, balance_cents: balance };
  });

  const totals = transactions.reduce((sum, row) => {
    sum.debit_cents += row.debit_cents;
    sum.credit_cents += row.credit_cents;
    return sum;
  }, { debit_cents: 0, credit_cents: 0 });

  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const unappliedCredits = kind === 'customer'
    ? db.prepare(`
        SELECT COALESCE(SUM(amount_cents - applied_cents - refunded_cents), 0) AS total
        FROM credit_notes WHERE customer_id = ? AND status = 'issued'
      `).get(partyId).total
    : db.prepare(`
        SELECT COALESCE(SUM(amount_cents - applied_cents - refunded_cents - portal_settled_cents), 0) AS total
        FROM supplier_credit_notes WHERE vendor_id = ? AND status = 'issued'
      `).get(partyId).total;
  return {
    kind,
    party,
    company: settings,
    from: range.from,
    to: range.to,
    opening_balance_cents: opening,
    closing_balance_cents: balance,
    unapplied_credits_cents: kind === 'customer' ? unappliedCredits : 0,
    unapplied_supplier_credits_cents: kind === 'vendor' ? unappliedCredits : 0,
    total_debit_cents: totals.debit_cents,
    total_credit_cents: totals.credit_cents,
    transactions,
    deposits: kind === 'customer' ? customerDeposits(db, partyId, range) : null,
    advances: kind === 'customer' ? customerAdvances(db, partyId, range) : null,
    ageing: ageing(db, kind, partyId, range.to, balance),
    deposit_held_cents: kind === 'vendor' ? depositHeld(db, partyId) : 0,
  };
}

module.exports = {
  customerStatement(db, customerId, range = {}) {
    return buildStatement(db, { kind: 'customer', partyId: Number(customerId), ...range });
  },
  vendorStatement(db, vendorId, range = {}) {
    return buildStatement(db, { kind: 'vendor', partyId: Number(vendorId), ...range });
  },
};
