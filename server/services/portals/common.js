'use strict';

const { bad } = require('../../util');
const { isCashAccount } = require('../../accounting');

const SUPPLIER_ADVANCES = '1400';
const AP = '2000';

const PORTAL_TYPES = ['airline', 'iata_agency', 'consolidator', 'gds', 'visa_agent', 'other'];
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

// Visa deposits paid from a wallet use it up; a supplier return into the
// wallet gives the net back. Voided events do not count.
const DEPOSIT_WALLET_NET = `
  SELECT portal_id, COALESCE(SUM(CASE WHEN event_type = 'to_supplier' THEN amount_cents
                                      ELSE -(amount_cents - deduction_cents) END), 0) AS total
  FROM visa_deposit_events
  WHERE portal_id IS NOT NULL AND voided_at IS NULL AND event_type IN ('to_supplier', 'supplier_return')
`;

function depositWalletNet(db, portalId, asOf = '9999-12-31') {
  return db.prepare(`${DEPOSIT_WALLET_NET} AND portal_id = ? AND event_date <= ?`).get(portalId, asOf)?.total || 0;
}

function aggregates(db) {
  const topups = new Map();
  const credits = new Map();
  const refunds = new Map();
  const consumed = new Map();
  for (const row of db.prepare(
    "SELECT portal_id, COALESCE(SUM(amount_cents), 0) AS total FROM portal_topups WHERE status = 'posted' GROUP BY portal_id",
  ).all()) topups.set(row.portal_id, row.total);
  for (const row of db.prepare(
    "SELECT portal_id, COALESCE(SUM(amount_cents), 0) AS total FROM portal_credits WHERE status = 'posted' GROUP BY portal_id",
  ).all()) credits.set(row.portal_id, row.total);
  for (const row of db.prepare(
    "SELECT portal_id, COALESCE(SUM(amount_cents), 0) AS total FROM portal_refunds WHERE status = 'posted' GROUP BY portal_id",
  ).all()) refunds.set(row.portal_id, row.total);
  for (const row of db.prepare(
    "SELECT portal_id, COALESCE(SUM(amount_cents), 0) AS total FROM bill_payments WHERE portal_id IS NOT NULL AND status = 'posted' GROUP BY portal_id",
  ).all()) consumed.set(row.portal_id, row.total);
  for (const row of db.prepare(`${DEPOSIT_WALLET_NET} GROUP BY portal_id`).all()) {
    consumed.set(row.portal_id, (consumed.get(row.portal_id) || 0) + row.total);
  }
  return { topups, credits, refunds, consumed };
}

function outstandingByVendor(db) {
  const map = new Map();
  const rows = db.prepare(`
    SELECT vendor_id, COALESCE(SUM(total_cents - amount_paid_cents - credit_applied_cents), 0) AS outstanding
    FROM bills
    WHERE status = 'received'
    GROUP BY vendor_id
  `).all();
  for (const row of rows) map.set(row.vendor_id, Math.max(0, row.outstanding));
  return map;
}

function balanceAsOf(db, portalId, asOf) {
  const topup = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS t FROM portal_topups WHERE portal_id = ? AND status = 'posted' AND topup_date <= ?",
  ).get(portalId, asOf).t;
  const credits = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS t FROM portal_credits WHERE portal_id = ? AND status = 'posted' AND credit_date <= ?",
  ).get(portalId, asOf).t;
  const refunded = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS t FROM portal_refunds WHERE portal_id = ? AND status = 'posted' AND refund_date <= ?",
  ).get(portalId, asOf).t;
  const consumed = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS t FROM bill_payments WHERE portal_id = ? AND status = 'posted' AND payment_date <= ?",
  ).get(portalId, asOf).t;
  return topup + credits - refunded - consumed - depositWalletNet(db, portalId, asOf);
}

function lockBalance(db, portalId) {
  const topup = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS t FROM portal_topups WHERE portal_id = ? AND status = 'posted'").get(portalId).t;
  const credit = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS t FROM portal_credits WHERE portal_id = ? AND status = 'posted'").get(portalId).t;
  const refunded = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS t FROM portal_refunds WHERE portal_id = ? AND status = 'posted'").get(portalId).t;
  const consumed = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS t FROM bill_payments WHERE portal_id = ? AND status = 'posted'").get(portalId).t;
  return topup + credit - refunded - consumed - depositWalletNet(db, portalId);
}

// The wallet's lowest balance over time, and the first date it is reached:
// every top-up, credit, withdrawal, bill settlement and visa deposit step,
// netted per day. `skip` leaves one top-up or credit out (to test a void).
function walletLow(db, portalId, skip = {}) {
  const events = new Map();
  const add = (date, delta) => events.set(date, (events.get(date) || 0) + delta);
  for (const row of db.prepare("SELECT id, topup_date AS date, amount_cents AS amount FROM portal_topups WHERE portal_id = ? AND status = 'posted'")
    .all(portalId)) {
    if (skip.type !== 'topup' || row.id !== skip.id) add(row.date, row.amount);
  }
  for (const row of db.prepare("SELECT id, credit_date AS date, amount_cents AS amount FROM portal_credits WHERE portal_id = ? AND status = 'posted'")
    .all(portalId)) {
    if (skip.type !== 'credit' || row.id !== skip.id) add(row.date, row.amount);
  }
  for (const row of db.prepare("SELECT refund_date AS date, amount_cents AS amount FROM portal_refunds WHERE portal_id = ? AND status = 'posted'")
    .all(portalId)) add(row.date, -row.amount);
  for (const row of db.prepare(
    "SELECT payment_date AS date, amount_cents AS amount FROM bill_payments WHERE portal_id = ? AND status = 'posted'",
  ).all(portalId)) add(row.date, -row.amount);
  for (const row of db.prepare(`
    SELECT event_date AS date, CASE WHEN event_type = 'to_supplier' THEN -amount_cents ELSE amount_cents - deduction_cents END AS amount
    FROM visa_deposit_events
    WHERE portal_id = ? AND voided_at IS NULL AND event_type IN ('to_supplier', 'supplier_return')
  `).all(portalId)) add(row.date, row.amount);
  let balance = 0;
  let low = { min: 0, date: null };
  for (const date of [...events.keys()].sort()) {
    balance += events.get(date);
    if (balance < low.min) low = { min: balance, date };
  }
  return low;
}

// A void may not take the wallet below zero, or lower than it already is.
function canRemove(db, portalId, skip) {
  const without = walletLow(db, portalId, skip).min;
  return without >= 0 || without >= walletLow(db, portalId).min;
}

function canRemoveTopup(db, topup) {
  return canRemove(db, topup.portal_id, { type: 'topup', id: topup.id });
}

function canRemoveCredit(db, credit) {
  return canRemove(db, credit.portal_id, { type: 'credit', id: credit.id });
}

// Call with the walletLow from before a change, after making it (inside the
// transaction): refuses a change that leaves the wallet below zero on any
// date. A wallet already below zero from older entries is not blocked by
// that alone, only made no worse.
function assertWalletNotLower(db, portalId, before) {
  const after = walletLow(db, portalId);
  if (after.min < 0 && after.min < before.min) {
    throw bad(`This would leave the portal wallet below zero on ${after.date} (${(after.min / 100).toFixed(2)}). Record a top-up on or before that date first.`);
  }
}

function serializePortal(portal, agg, outstanding) {
  const topup = agg.topups.get(portal.id) || 0;
  const credits = agg.credits.get(portal.id) || 0;
  const refunded = agg.refunds.get(portal.id) || 0;
  const consumed = agg.consumed.get(portal.id) || 0;
  const balance = topup + credits - refunded - consumed;
  const outstandingAp = portal.vendor_id ? (outstanding.get(portal.vendor_id) || 0) : 0;
  return {
    ...portal,
    topup_total_cents: topup,
    credit_total_cents: credits,
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
  depositWalletNet,
  SUPPLIER_ADVANCES,
  AP,
  PORTAL_TYPES,
  SETTLEMENTS,
  portalSelect,
  aggregates,
  outstandingByVendor,
  balanceAsOf,
  lockBalance,
  canRemoveTopup,
  canRemoveCredit,
  walletLow,
  assertWalletNotLower,
  serializePortal,
  assertAccount,
};
