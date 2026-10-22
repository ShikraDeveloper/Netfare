'use strict';

const { bad, notFound, str, optionalStr, cents } = require('../../util');
const {
  PORTAL_TYPES,
  SETTLEMENTS,
  portalSelect,
  aggregates,
  outstandingByVendor,
  serializePortal,
} = require('./common');

function listPortals(db, { search, settlement, type, status } = {}) {
  const agg = aggregates(db);
  const outstanding = outstandingByVendor(db);
  let rows = db.prepare(`${portalSelect} ORDER BY p.is_active DESC, p.name COLLATE NOCASE`)
    .all()
    .map((portal) => serializePortal(portal, agg, outstanding));

  if (search) {
    const term = String(search).trim().toLowerCase();
    rows = rows.filter((portal) => (
      portal.name.toLowerCase().includes(term)
      || (portal.vendor_name || '').toLowerCase().includes(term)
      || (portal.login_ref || '').toLowerCase().includes(term)
    ));
  }
  if (settlement && settlement !== 'all') rows = rows.filter((portal) => portal.settlement === settlement);
  if (type && type !== 'all') rows = rows.filter((portal) => portal.portal_type === type);
  if (status === 'active') rows = rows.filter((portal) => portal.is_active);
  if (status === 'archived') rows = rows.filter((portal) => !portal.is_active);
  return rows;
}

function getPortal(db, id) {
  const portal = db.prepare(`${portalSelect} WHERE p.id = ?`).get(id);
  if (!portal) throw notFound('Portal not found');
  const result = serializePortal(portal, aggregates(db), outstandingByVendor(db));

  result.topups = db.prepare(`
    SELECT t.*, a.name AS deposit_account_name
    FROM portal_topups t
    JOIN accounts a ON a.id = t.deposit_account_id
    WHERE t.portal_id = ? AND t.status = 'posted'
    ORDER BY t.topup_date DESC, t.id DESC
  `).all(id);

  result.refunds = db.prepare(`
    SELECT r.*, a.name AS payment_account_name
    FROM portal_refunds r
    JOIN accounts a ON a.id = r.payment_account_id
    WHERE r.portal_id = ? AND r.status = 'posted'
    ORDER BY r.refund_date DESC, r.id DESC
  `).all(id);

  result.credits = db.prepare(`
    SELECT pc.*, scn.number AS supplier_credit_number, b.number AS bill_number
    FROM portal_credits pc
    LEFT JOIN supplier_credit_notes scn ON scn.id = pc.supplier_credit_note_id
    LEFT JOIN bills b ON b.id = pc.bill_id
    WHERE pc.portal_id = ? AND pc.status = 'posted'
    ORDER BY pc.credit_date DESC, pc.id DESC
  `).all(id);

  result.settlements = db.prepare(`
    SELECT bp.id, bp.number, bp.payment_date, bp.amount_cents, bp.reference, bp.status,
           bp.journal_entry_id,
           b.id AS bill_id, b.number AS bill_number, b.total_cents AS bill_total_cents,
           b.status AS bill_status, b.booking_id AS booking_id, b.visa_id AS visa_id,
           va.number AS visa_number, va.applicant_name AS visa_applicant_name,
           va.nationality AS visa_nationality, va.passport_number AS visa_passport_number,
           v.name AS vendor_name
    FROM bill_payments bp
    JOIN bills b ON b.id = bp.bill_id
    JOIN vendors v ON v.id = bp.vendor_id
    LEFT JOIN visa_applications va ON va.id = b.visa_id
    WHERE bp.portal_id = ? AND bp.status = 'posted'
    ORDER BY bp.payment_date DESC, bp.id DESC
  `).all(id);

  result.open_bills = portal.vendor_id ? db.prepare(`
    SELECT b.id, b.number, b.bill_date, b.total_cents, b.amount_paid_cents, b.credit_applied_cents,
           (b.total_cents - b.amount_paid_cents - b.credit_applied_cents) AS balance_cents,
           b.booking_id, b.visa_id,
           va.number AS visa_number, va.applicant_name AS visa_applicant_name,
           va.nationality AS visa_nationality, va.passport_number AS visa_passport_number
    FROM bills b
    LEFT JOIN visa_applications va ON va.id = b.visa_id
    WHERE b.vendor_id = ? AND b.status = 'received'
      AND b.total_cents > b.amount_paid_cents + b.credit_applied_cents
    ORDER BY b.bill_date, b.id
  `).all(portal.vendor_id) : [];

  return result;
}

function portalForVendor(db, vendorId) {
  if (!vendorId) return null;
  return db.prepare(
    'SELECT * FROM supplier_portals WHERE vendor_id = ? AND is_active = 1 ORDER BY id LIMIT 1',
  ).get(vendorId) || null;
}

function portalReport(db) {
  const agg = aggregates(db);
  const outstanding = outstandingByVendor(db);
  const rows = db.prepare(`${portalSelect} ORDER BY p.name COLLATE NOCASE`)
    .all()
    .map((portal) => serializePortal(portal, agg, outstanding));
  const totals = rows.reduce((acc, row) => {
    acc.topup_total_cents += row.topup_total_cents;
    acc.credit_total_cents += row.credit_total_cents;
    acc.refunded_total_cents += row.refunded_total_cents;
    acc.consumed_total_cents += row.consumed_total_cents;
    acc.balance_cents += row.balance_cents;
    acc.outstanding_ap_cents += row.outstanding_ap_cents;
    return acc;
  }, {
    topup_total_cents: 0,
    credit_total_cents: 0,
    refunded_total_cents: 0,
    consumed_total_cents: 0,
    balance_cents: 0,
    outstanding_ap_cents: 0,
  });
  return { rows, totals };
}

function portalStats(db) {
  const report = portalReport(db);
  return {
    count: report.rows.length,
    active_count: report.rows.filter((row) => row.is_active).length,
    prepaid_balance_cents: report.rows
      .filter((row) => row.settlement === 'prepaid')
      .reduce((sum, row) => sum + row.balance_cents, 0),
    balance_cents: report.totals.balance_cents,
    outstanding_ap_cents: report.totals.outstanding_ap_cents,
  };
}

// ---------------------------------------------------------------------------
// Portal master data
// ---------------------------------------------------------------------------

function normalizePortal(db, payload, existing = null) {
  const name = payload.name != null
    ? str(payload.name, 'Portal name', { max: 160 })
    : existing.name;

  const portalType = payload.portal_type != null
    ? String(payload.portal_type)
    : (existing ? existing.portal_type : 'other');
  if (!PORTAL_TYPES.includes(portalType)) throw bad('Choose a valid portal type');

  const settlement = payload.settlement != null
    ? String(payload.settlement)
    : (existing ? existing.settlement : 'prepaid');
  if (!SETTLEMENTS.includes(settlement)) throw bad('Choose prepaid or credit');

  let vendorId = existing ? existing.vendor_id : null;
  if (payload.vendor_id !== undefined) {
    if (payload.vendor_id === null || payload.vendor_id === '') {
      vendorId = null;
    } else {
      const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(payload.vendor_id));
      if (!vendor) throw bad('Choose a valid supplier');
      vendorId = vendor.id;
    }
  }

  const creditLimit = payload.credit_limit_cents != null
    ? cents(payload.credit_limit_cents, 'Credit limit')
    : (existing ? existing.credit_limit_cents : 0);

  const isActive = payload.is_active != null
    ? (payload.is_active ? 1 : 0)
    : (existing ? existing.is_active : 1);

  return {
    name,
    portal_type: portalType,
    settlement,
    vendor_id: vendorId,
    login_ref: optionalStr(payload.login_ref ?? (existing ? existing.login_ref : ''), 'Login / URL reference', 240),
    notes: optionalStr(payload.notes ?? (existing ? existing.notes : ''), 'Notes', 2000),
    credit_limit_cents: creditLimit,
    is_active: isActive,
  };
}

function createPortal(db, payload) {
  return db.transaction(() => {
    const data = normalizePortal(db, payload);
    if (!data.vendor_id) throw bad('Link this portal to a supplier');
    const info = db.prepare(`
      INSERT INTO supplier_portals (name, portal_type, settlement, vendor_id, login_ref, notes, credit_limit_cents, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name,
      data.portal_type,
      data.settlement,
      data.vendor_id,
      data.login_ref,
      data.notes,
      data.credit_limit_cents,
      data.is_active,
    );
    return getPortal(db, Number(info.lastInsertRowid));
  })();
}

function updatePortal(db, id, payload) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(id);
    if (!existing) throw notFound('Portal not found');
    const data = normalizePortal(db, payload, existing);
    if (!data.vendor_id) throw bad('Link this portal to a supplier');
    db.prepare(`
      UPDATE supplier_portals SET name = ?, portal_type = ?, settlement = ?, vendor_id = ?,
        login_ref = ?, notes = ?, credit_limit_cents = ?, is_active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      data.name,
      data.portal_type,
      data.settlement,
      data.vendor_id,
      data.login_ref,
      data.notes,
      data.credit_limit_cents,
      data.is_active,
      id,
    );
    return getPortal(db, id);
  })();
}

function deletePortal(db, id) {
  return db.transaction(() => {
    const portal = db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(id);
    if (!portal) throw notFound('Portal not found');
    const topups = db.prepare('SELECT COUNT(*) AS c FROM portal_topups WHERE portal_id = ?').get(id).c;
    const credits = db.prepare('SELECT COUNT(*) AS c FROM portal_credits WHERE portal_id = ?').get(id).c;
    const refunds = db.prepare('SELECT COUNT(*) AS c FROM portal_refunds WHERE portal_id = ?').get(id).c;
    const settlements = db.prepare('SELECT COUNT(*) AS c FROM bill_payments WHERE portal_id = ?').get(id).c;
    if (topups || credits || refunds || settlements) {
      throw bad('This portal has activity. Archive it instead of deleting.');
    }
    db.prepare('DELETE FROM supplier_portals WHERE id = ?').run(id);
    return { deleted: true };
  })();
}

module.exports = {
  listPortals,
  getPortal,
  portalForVendor,
  portalReport,
  portalStats,
  normalizePortal,
  createPortal,
  updatePortal,
  deletePortal,
};
