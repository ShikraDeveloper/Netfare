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
  OR (i.status = 'void' AND EXISTS (SELECT 1 FROM cancellations x WHERE x.invoice_id = i.id)))`;

// Same-day order: the sale, then money in, then the cancellation and its follow-ups.
const KIND_ORDER = {
  invoice: 1, payment: 2, credit: 3, cancellation: 4, cancellation_charge: 5, cancellation_credit: 6, refund: 7,
};

// A cancellation-charges invoice follows the cancellation that raised it.
const rank = (row) => (row.kind === 'invoice' && row.charge_of ? KIND_ORDER.cancellation_charge : KIND_ORDER[row.kind] || 9);

function customerTransactions(db, customerId) {
  const rows = db.prepare(`
    SELECT 'invoice' AS kind, i.id, i.number AS reference, i.issue_date AS date,
           i.due_date, i.total_cents AS amount_cents, i.status,
           '' AS method, COALESCE((SELECT x.number FROM cancellations x WHERE x.invoice_id = i.id), '') AS related,
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
    WHERE x.customer_id = ? AND i.status = 'void'
    UNION ALL
    SELECT 'cancellation_charge', x.id, x.number, x.cancellation_date, NULL,
           MIN(x.received_cents, x.customer_charges_cents), 'charged', '', COALESCE(i.number, ''), NULL, x.created_at AS created_at
    FROM cancellations x
    LEFT JOIN invoices i ON i.id = x.invoice_id
    WHERE x.customer_id = ? AND MIN(x.received_cents, x.customer_charges_cents) > 0
    UNION ALL
    SELECT 'cancellation_credit', cn.id, cn.number, cn.credit_date, NULL, cn.amount_cents, 'issued', '', x.number, NULL, cn.created_at AS created_at
    FROM credit_notes cn
    JOIN cancellations x ON x.id = cn.cancellation_id
    WHERE cn.customer_id = ? AND cn.status = 'issued'
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, x.number, NULL, r.created_at AS created_at
    FROM refunds r
    JOIN cancellations x ON x.id = r.cancellation_id
    WHERE r.refund_type = 'customer' AND r.party_id = ? AND r.status = 'paid'
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, COALESCE(i.number, ''), NULL, r.created_at AS created_at
    FROM refunds r
    LEFT JOIN invoices i ON i.id = r.invoice_id
    WHERE r.refund_type = 'customer' AND r.party_id = ? AND r.status = 'paid'
      AND r.cancellation_id IS NULL AND r.credit_note_id IS NULL AND r.advance_id IS NULL
      -- Visa deposit refunds belong to the separate deposit section.
      AND r.deposit_id IS NULL
    UNION ALL
    SELECT 'credit', ca.id, cn.number, ca.applied_date, NULL, ca.amount_cents, 'applied', 'Credit note', i.number, NULL, ca.created_at AS created_at
    FROM credit_applications ca
    JOIN credit_notes cn ON cn.id = ca.credit_note_id
    JOIN invoices i ON i.id = ca.invoice_id
    WHERE cn.customer_id = ? AND cn.status = 'issued'
  `).all(customerId, customerId, customerId, customerId, customerId, customerId, customerId, customerId)
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
    if (row.kind === 'credit') {
      return {
        ...row,
        description: `Credit ${row.reference}${row.related ? ` applied to ${row.related}` : ''}`,
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
    if (row.kind === 'cancellation_credit') {
      return {
        ...row,
        description: `Refund kept as credit note ${row.reference} · ${row.related}`,
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

  return rows.map((row) => row.kind === 'invoice'
    ? {
        ...row,
        items: itemsByInvoice.get(row.id) || [],
        visa: visasByInvoice.get(row.id) || null,
        beneficiary: beneficiaryByInvoice.get(row.id) || null,
      }
    : row);
}

// Statement lines run by date, then by when each was entered (created_at is
// the entry time), so a day reads in the order the work was done.
function byDateThenEntry(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const x = a.created_at || '';
  const y = b.created_at || '';
  return x < y ? -1 : x > y ? 1 : 0;
}

const VENDOR_KIND_ORDER = { bill: 1, payment: 2, supplier_credit: 3, credit_refund: 4, refund: 5 };

function vendorTransactions(db, vendorId) {
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
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, COALESCE(b.number, ''), r.created_at AS created_at
    FROM refunds r
    LEFT JOIN bills b ON b.id = r.bill_id
    WHERE r.refund_type = 'supplier' AND r.party_id = ? AND r.status = 'paid'
      AND r.supplier_credit_note_id IS NULL
    UNION ALL
    -- A supplier credit counts when it is issued: it lowers what we owe, or
    -- (once bills are clear) is money the supplier holds for us. The part
    -- moved to a prepaid portal wallet shows on the portal instead.
    SELECT 'supplier_credit', scn.id, scn.number, scn.credit_date, NULL,
           scn.amount_cents - scn.portal_settled_cents, 'issued', 'Supplier credit', COALESCE(b.number, ''), scn.created_at AS created_at
    FROM supplier_credit_notes scn
    LEFT JOIN bills b ON b.id = scn.bill_id
    WHERE scn.vendor_id = ? AND scn.status = 'issued' AND scn.amount_cents > scn.portal_settled_cents
    UNION ALL
    -- Credit the supplier paid back to us.
    SELECT 'credit_refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, scn.number, r.created_at AS created_at
    FROM refunds r
    JOIN supplier_credit_notes scn ON scn.id = r.supplier_credit_note_id
    WHERE r.refund_type = 'supplier' AND r.party_id = ? AND r.status = 'paid'
  `).all(vendorId, vendorId, vendorId, vendorId, vendorId)
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
      };
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
      SELECT 'received' AS event_type, a.id, a.number AS reference, a.advance_date AS date, a.amount_cents,
             b.number AS booking_number, v.number AS visa_number, '' AS invoice_number
, a.created_at AS created_at
      FROM customer_advances a
      LEFT JOIN bookings b ON b.id = a.booking_id
      LEFT JOIN visa_applications v ON v.id = a.visa_id
      WHERE a.customer_id = ? AND a.voided_at IS NULL
    `).all(customerId),
    ...db.prepare(`
      SELECT 'applied' AS event_type, p.id, a.number AS reference, p.payment_date AS date, p.amount_cents,
             '' AS booking_number, '' AS visa_number, i.number AS invoice_number
, p.created_at AS created_at
      FROM payments p
      JOIN customer_advances a ON a.id = p.advance_id
      JOIN invoices i ON i.id = p.invoice_id
      WHERE a.customer_id = ? AND a.voided_at IS NULL AND p.status = 'posted'
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
