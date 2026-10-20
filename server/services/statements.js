'use strict';

const { dateISO, notFound, todayISO } = require('../util');

function normalizeRange({ from, to } = {}) {
  let start = from ? dateISO(from, 'From date') : '';
  let end = to ? dateISO(to, 'To date') : todayISO();
  if (start && start > end) [start, end] = [end, start];
  return { from: start, to: end };
}

function customerTransactions(db, customerId) {
  return db.prepare(`
    SELECT 'invoice' AS kind, i.id, i.number AS reference, i.issue_date AS date,
           i.due_date, i.total_cents AS amount_cents, i.status,
           '' AS method, '' AS related
    FROM invoices i
    WHERE i.customer_id = ? AND i.status = 'sent'
    UNION ALL
    SELECT 'payment', p.id, p.number, p.payment_date, NULL, p.amount_cents, 'paid', p.method, i.number
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    WHERE p.customer_id = ? AND i.status <> 'void'
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, COALESCE(i.number, '')
    FROM refunds r
    LEFT JOIN invoices i ON i.id = r.invoice_id
    WHERE r.refund_type = 'customer' AND r.party_id = ? AND r.status = 'paid'
    UNION ALL
    SELECT 'credit', ca.id, cn.number, ca.applied_date, NULL, ca.amount_cents, 'applied', 'Credit note', i.number
    FROM credit_applications ca
    JOIN credit_notes cn ON cn.id = ca.credit_note_id
    JOIN invoices i ON i.id = ca.invoice_id
    WHERE cn.customer_id = ? AND cn.status = 'issued'
    ORDER BY date, kind, id
  `).all(customerId, customerId, customerId, customerId).map((row) => {
    if (row.kind === 'invoice') {
      return {
        ...row,
        description: `Invoice ${row.reference}`,
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
    return {
      ...row,
      description: `Refund ${row.reference}${row.related ? ` · ${row.related}` : ''}`,
      debit_cents: row.amount_cents,
      credit_cents: 0,
    };
  });
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
    WHERE p.vendor_id = ? AND b.status <> 'void'
    UNION ALL
    SELECT 'refund', r.id, r.number, r.refund_date, NULL, r.amount_cents, r.status, r.method, COALESCE(b.number, '')
    FROM refunds r
    LEFT JOIN bills b ON b.id = r.bill_id
    WHERE r.refund_type = 'supplier' AND r.party_id = ? AND r.status = 'paid'
    ORDER BY date, kind, id
  `).all(vendorId, vendorId, vendorId).map((row) => {
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
        SELECT COALESCE(SUM(amount_cents - applied_cents), 0) AS total
        FROM credit_notes WHERE customer_id = ? AND status = 'issued'
      `).get(partyId).total
    : 0;
  return {
    kind,
    party,
    company: settings,
    from: range.from,
    to: range.to,
    opening_balance_cents: opening,
    closing_balance_cents: balance,
    unapplied_credits_cents: unappliedCredits,
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
