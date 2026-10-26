'use strict';

const { bad, todayISO } = require('../util');

const TYPE_META = {
  cancellation_refund: {
    label: 'Cancellation refund',
    action: 'Pay refund',
    source: 'cancellation',
  },
  customer_credit: {
    label: 'Customer credit',
    action: 'Apply or refund',
    source: 'credit',
  },
  customer_advance: {
    label: 'Customer advance',
    action: 'Apply or refund',
    source: 'advance',
  },
  supplier_credit: {
    label: 'Supplier credit',
    action: 'Apply or refund',
    source: 'supplier_credit',
  },
};

const TYPE_ORDER = ['cancellation_refund', 'customer_credit', 'customer_advance', 'supplier_credit'];

function ageDays(date) {
  if (!date) return 0;
  const start = new Date(`${date}T00:00:00`);
  const today = new Date(`${todayISO()}T00:00:00`);
  if (Number.isNaN(start.getTime())) return 0;
  return Math.max(0, Math.round((today - start) / 86_400_000));
}

function cancellationRefunds(db) {
  return db.prepare(`
    SELECT cc.id, cc.number, cc.cancellation_date AS date, cc.source_type, cc.source_id,
           cc.customer_id AS party_id, c.name AS party_name,
           MAX(0, cc.refund_due_cents
             - COALESCE((
                 SELECT SUM(r.amount_cents) FROM refunds r
                 WHERE r.cancellation_id = cc.id AND r.status = 'paid'
               ), 0)
             - COALESCE((
                 SELECT SUM(cn.amount_cents) FROM credit_notes cn
                 WHERE cn.cancellation_id = cc.id AND cn.status = 'issued'
               ), 0)
           ) AS remaining_cents,
           bk.number AS booking_number, vi.number AS visa_number
    FROM cancellations cc
    JOIN customers c ON c.id = cc.customer_id
    LEFT JOIN bookings bk ON cc.source_type = 'booking' AND bk.id = cc.source_id
    LEFT JOIN visa_applications vi ON cc.source_type = 'visa' AND vi.id = cc.source_id
    ORDER BY cc.cancellation_date, cc.id
  `).all().filter((row) => Number(row.remaining_cents) > 0).map((row) => {
    const sourceNumber = row.source_type === 'booking' ? row.booking_number : row.visa_number;
    return {
      ...row,
      type: 'cancellation_refund',
      type_label: TYPE_META.cancellation_refund.label,
      action_label: TYPE_META.cancellation_refund.action,
      detail: `${row.source_type === 'booking' ? 'Booking' : 'Visa'} ${sourceNumber || ''}`.trim(),
      href: `#/cancellations/${row.id}`,
    };
  });
}

function customerCredits(db) {
  return db.prepare(`
    SELECT cn.id, cn.number, cn.credit_date AS date, cn.customer_id AS party_id,
           c.name AS party_name, cn.cancellation_id, cc.number AS cancellation_number,
           (cn.amount_cents - cn.applied_cents - cn.refunded_cents) AS remaining_cents
    FROM credit_notes cn
    JOIN customers c ON c.id = cn.customer_id
    LEFT JOIN cancellations cc ON cc.id = cn.cancellation_id
    WHERE cn.status = 'issued' AND cn.amount_cents > cn.applied_cents + cn.refunded_cents
    ORDER BY cn.credit_date, cn.id
  `).all().map((row) => ({
    ...row,
    type: 'customer_credit',
    type_label: TYPE_META.customer_credit.label,
    action_label: TYPE_META.customer_credit.action,
    detail: row.cancellation_number
      ? `From cancellation ${row.cancellation_number}`
      : 'Standalone customer credit',
    href: `#/credits/${row.id}`,
  }));
}

function customerAdvances(db) {
  return db.prepare(`
    SELECT a.id, a.number, a.advance_date AS date, a.customer_id AS party_id,
           c.name AS party_name, a.booking_id, a.visa_id,
           b.number AS booking_number, v.number AS visa_number,
           (a.amount_cents - a.applied_cents - a.refunded_cents) AS remaining_cents
    FROM customer_advances a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN bookings b ON b.id = a.booking_id
    LEFT JOIN visa_applications v ON v.id = a.visa_id
    WHERE a.voided_at IS NULL AND a.amount_cents > a.applied_cents + a.refunded_cents
    ORDER BY a.advance_date, a.id
  `).all().map((row) => {
    const href = row.booking_id
      ? `#/bookings/${row.booking_id}`
      : row.visa_id
        ? `#/visas/${row.visa_id}`
        : `#/customer-balances/${row.party_id}`;
    const source = row.booking_number
      ? `Booking ${row.booking_number}`
      : row.visa_number
        ? `Visa ${row.visa_number}`
        : 'Unallocated advance';
    return {
      ...row,
      type: 'customer_advance',
      type_label: TYPE_META.customer_advance.label,
      action_label: TYPE_META.customer_advance.action,
      detail: source,
      href,
    };
  });
}

function supplierCredits(db) {
  return db.prepare(`
    SELECT scn.id, scn.number, scn.credit_date AS date, scn.vendor_id AS party_id,
           v.name AS party_name, scn.bill_id, b.number AS bill_number,
           (scn.amount_cents - scn.applied_cents - scn.refunded_cents - scn.portal_settled_cents) AS remaining_cents
    FROM supplier_credit_notes scn
    JOIN vendors v ON v.id = scn.vendor_id
    LEFT JOIN bills b ON b.id = scn.bill_id
    WHERE scn.status = 'issued'
      AND scn.amount_cents > scn.applied_cents + scn.refunded_cents + scn.portal_settled_cents
    ORDER BY scn.credit_date, scn.id
  `).all().map((row) => ({
    ...row,
    type: 'supplier_credit',
    type_label: TYPE_META.supplier_credit.label,
    action_label: TYPE_META.supplier_credit.action,
    detail: row.bill_number ? `Against bill ${row.bill_number}` : 'Standalone supplier credit',
    href: `#/supplier-credits/${row.id}`,
  }));
}

function listSettlementQueue(db, { type, search, party_id } = {}) {
  if (type && type !== 'all' && !TYPE_META[type]) {
    throw bad('Settlement queue type must be a cancellation refund, customer credit, customer advance or supplier credit');
  }
  const items = [
    ...cancellationRefunds(db),
    ...customerCredits(db),
    ...customerAdvances(db),
    ...supplierCredits(db),
  ].map((row) => ({
    ...row,
    document_id: row.id,
    id: `${row.type}-${row.id}`,
    remaining_cents: Number(row.remaining_cents) || 0,
    age_days: ageDays(row.date),
  }));

  const partyId = party_id == null || party_id === '' ? null : Number(party_id);
  const term = String(search || '').trim().toLowerCase();
  const filtered = items.filter((row) => {
    if (type && type !== 'all' && row.type !== type) return false;
    if (partyId != null && row.party_id !== partyId) return false;
    if (!term) return true;
    return [row.number, row.party_name, row.detail, row.type_label]
      .some((value) => String(value || '').toLowerCase().includes(term));
  }).sort((a, b) => {
    if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
    return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
  });

  const byType = {};
  for (const key of TYPE_ORDER) {
    const rows = filtered.filter((row) => row.type === key);
    byType[key] = {
      label: TYPE_META[key].label,
      count: rows.length,
      amount_cents: rows.reduce((sum, row) => sum + row.remaining_cents, 0),
    };
  }

  return {
    generated_at: todayISO(),
    items: filtered,
    totals: {
      count: filtered.length,
      amount_cents: filtered.reduce((sum, row) => sum + row.remaining_cents, 0),
      by_type: byType,
    },
  };
}

module.exports = {
  listSettlementQueue,
  TYPE_META,
};
