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
           i.cancellation_id AS charge_of
    FROM invoices i
    WHERE i.customer_id = ? AND ${ON_STATEMENT}
    UNION ALL
    SELECT 'payment', p.id, p.number, p.payment_date, NULL, p.amount_cents, 'paid', p.method, i.number, NULL
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    WHERE p.customer_id = ? AND ${ON_STATEMENT} AND p.status = 'posted'
    UNION ALL
    SELECT 'cancellation', x.id, x.number, x.cancellation_date, NULL, i.total_cents, 'cancelled', '', i.number, NULL
    FROM cancellations x
    JOIN invoices i ON i.id = x.invoice_id
    WHERE x.customer_id = ? AND i.status = 'void'
    UNION ALL
    SELECT 'cancellation_charge', x.id, x.number, x.cancellation_date, NULL,
           MIN(x.received_cents, x.customer_charges_cents), 'charged', '', COALESCE(i.number, ''), NULL
    FROM cancellations x
    LEFT JOIN invoices i ON i.id = x.invoice_id
    WHERE x.customer_id = ? AND MIN(x.received_cents, x.customer_charges_cents) > 0
    UNION ALL
    SELECT 'cancellation_credit', cn.id, cn.number, cn.credit_date, NULL, cn.amount_cents, 'issued', '', x.number, NULL
    FROM credit_notes cn
    JOIN cancellations x ON x.id = cn.cancellation_id
    WHERE cn.customer_id = ? AND cn.status = 'issued'
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, x.number, NULL
    FROM refunds r
    JOIN cancellations x ON x.id = r.cancellation_id
    WHERE r.refund_type = 'customer' AND r.party_id = ? AND r.status = 'paid'
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, COALESCE(i.number, ''), NULL
    FROM refunds r
    LEFT JOIN invoices i ON i.id = r.invoice_id
    WHERE r.refund_type = 'customer' AND r.party_id = ? AND r.status = 'paid'
      AND r.cancellation_id IS NULL AND r.credit_note_id IS NULL AND r.advance_id IS NULL
    UNION ALL
    SELECT 'credit', ca.id, cn.number, ca.applied_date, NULL, ca.amount_cents, 'applied', 'Credit note', i.number, NULL
    FROM credit_applications ca
    JOIN credit_notes cn ON cn.id = ca.credit_note_id
    JOIN invoices i ON i.id = ca.invoice_id
    WHERE cn.customer_id = ? AND cn.status = 'issued'
  `).all(customerId, customerId, customerId, customerId, customerId, customerId, customerId, customerId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
      || rank(a) - rank(b)
      || a.id - b.id)
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

function vendorTransactions(db, vendorId) {
  return db.prepare(`
    SELECT 'bill' AS kind, b.id, b.number AS reference, b.bill_date AS date,
           b.due_date, b.total_cents AS amount_cents, b.status,
           '' AS method, '' AS related
    FROM bills b
    WHERE b.vendor_id = ? AND b.status = 'received'
    UNION ALL
    SELECT 'payment', p.id, p.number, p.payment_date, NULL, p.amount_cents, 'paid', p.method, b.number
    FROM bill_payments p
    JOIN bills b ON b.id = p.bill_id
    WHERE p.vendor_id = ? AND b.status <> 'void' AND p.status = 'posted'
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, COALESCE(b.number, '')
    FROM refunds r
    LEFT JOIN bills b ON b.id = r.bill_id
    WHERE r.refund_type = 'supplier' AND r.party_id = ? AND r.status = 'paid'
      AND r.supplier_credit_note_id IS NULL
    UNION ALL
    SELECT 'supplier_credit', sca.id, scn.number, sca.applied_date, NULL,
           sca.amount_cents, 'applied', 'Supplier credit', b.number
    FROM supplier_credit_applications sca
    JOIN supplier_credit_notes scn ON scn.id = sca.credit_note_id
    JOIN bills b ON b.id = sca.bill_id
    WHERE scn.vendor_id = ? AND scn.status = 'issued'
    ORDER BY date, kind, id
  `).all(vendorId, vendorId, vendorId, vendorId).map((row) => {
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
    return {
      ...row,
      description: `Supplier refund ${row.reference}${row.related ? ` · ${row.related}` : ''}`,
      debit_cents: 0,
      credit_cents: row.amount_cents,
    };
  });
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
