'use strict';

const { bad } = require('../../util');
const { isCashAccount } = require('../../accounting');

const SUPPLIER_ADVANCES = '1400';
const AP = '2000';

const PORTAL_TYPES = ['airline', 'iata_agency', 'consolidator', 'gds', 'other'];
const SETTLEMENTS = ['prepaid', 'credit'];

const portalSelect = `
  SELECT p.*, v.name AS vendor_name
  FROM supplier_portals p
  LEFT JOIN vendors v ON v.id = p.vendor_id
`;

// ---------------------------------------------------------------------------
// Balance helpers
//
// A portal balance is derived, never stored:
//   balance = top-ups − withdrawals − value already consumed by bills
// Because bill payments tagged with a portal_id are the consumption record,
// deleting such a payment automatically restores the balance.
// ---------------------------------------------------------------------------

function aggregates(db) {
  const topups = new Map();
  const refunds = new Map();
  const consumed = new Map();
  for (const row of db.prepare(
    'SELECT portal_id, COALESCE(SUM(amount_cents), 0) AS total FROM portal_topups GROUP BY portal_id',
  ).all()) topups.set(row.portal_id, row.total);
  for (const row of db.prepare(
    'SELECT portal_id, COALESCE(SUM(amount_cents), 0) AS total FROM portal_refunds GROUP BY portal_id',
  ).all()) refunds.set(row.portal_id, row.total);
  for (const row of db.prepare(
    'SELECT portal_id, COALESCE(SUM(amount_cents), 0) AS total FROM bill_payments WHERE portal_id IS NOT NULL GROUP BY portal_id',
  ).all()) consumed.set(row.portal_id, row.total);
  return { topups, refunds, consumed };
}

function outstandingByVendor(db) {
  const map = new Map();
  const rows = db.prepare(`
    SELECT vendor_id, COALESCE(SUM(total_cents - amount_paid_cents), 0) AS outstanding
    FROM bills
    WHERE status = 'received'
    GROUP BY vendor_id
  `).all();
  for (const row of rows) map.set(row.vendor_id, Math.max(0, row.outstanding));
  return map;
}

function lockBalance(db, portalId) {
  const topup = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM portal_topups WHERE portal_id = ?').get(portalId).t;
  const refunded = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM portal_refunds WHERE portal_id = ?').get(portalId).t;
  const consumed = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM bill_payments WHERE portal_id = ?').get(portalId).t;
  return topup - refunded - consumed;
}

function serializePortal(portal, agg, outstanding) {
  const topup = agg.topups.get(portal.id) || 0;
  const refunded = agg.refunds.get(portal.id) || 0;
  const consumed = agg.consumed.get(portal.id) || 0;
  const balance = topup - refunded - consumed;
  const outstandingAp = portal.vendor_id ? (outstanding.get(portal.vendor_id) || 0) : 0;
  return {
    ...portal,
    topup_total_cents: topup,
    refunded_total_cents: refunded,
    consumed_total_cents: consumed,
    balance_cents: balance,
    outstanding_ap_cents: outstandingAp,
    credit_available_cents: portal.settlement === 'credit' && portal.credit_limit_cents > 0
      ? Math.max(0, portal.credit_limit_cents - outstandingAp)
      : 0,
  };
}

function assertAccount(db, accountId, label) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!account) throw bad(`Choose ${label}`);
  if (!account.is_active) throw bad(`That ${label} is archived`);
  if (!isCashAccount(account)) throw bad(`${label} must be an active bank or cash account`);
  return account;
}

module.exports = {
  SUPPLIER_ADVANCES,
  AP,
  PORTAL_TYPES,
  SETTLEMENTS,
  portalSelect,
  aggregates,
  outstandingByVendor,
  lockBalance,
  serializePortal,
  assertAccount,
};
