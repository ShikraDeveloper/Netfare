'use strict';

const supplierCreditService = require('./supplier-credits');
const portalService = require('./portals');

function accountBalanceCents(db, code) {
  return db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ?
  `).get(code).total;
}

function refundPayableReconciliation(db) {
  const balance = -accountBalanceCents(db, '2500');
  const open = db.prepare(`
    SELECT COALESCE(SUM(remainder), 0) AS total
    FROM (
      SELECT cc.refund_due_cents
        - COALESCE((SELECT SUM(r.amount_cents) FROM refunds r
                    WHERE r.cancellation_id = cc.id AND r.status = 'paid'), 0)
        - COALESCE((SELECT SUM(cn.amount_cents) FROM credit_notes cn
                    WHERE cn.cancellation_id = cc.id AND cn.status = 'issued'), 0) AS remainder
      FROM cancellations cc
    )
    WHERE remainder > 0
  `).get().total;
  return {
    account_code: '2500',
    account_name: 'Refund Payable',
    account_balance_cents: balance,
    open_refund_cents: open,
    difference_cents: balance - open,
    matched: balance === open,
  };
}

function customerCreditsReconciliation(db) {
  const balance = -accountBalanceCents(db, '2450');
  const open = db.prepare(`
    SELECT COALESCE(SUM(amount_cents - applied_cents - refunded_cents), 0) AS total
    FROM credit_notes WHERE status = 'issued'
  `).get().total;
  return {
    account_code: '2450',
    account_name: 'Customer Credits',
    account_balance_cents: balance,
    open_credit_cents: open,
    difference_cents: balance - open,
    matched: balance === open,
  };
}

function reconciliationSummary(db) {
  const supplierCredits = supplierCreditService.supplierCreditReconciliation(db);
  const refundPayable = refundPayableReconciliation(db);
  const customerCredits = customerCreditsReconciliation(db);
  const portal = portalService.portalReport(db);
  const supplierAdvances = accountBalanceCents(db, '1400');
  return {
    supplier_credits: supplierCredits,
    refund_payable: refundPayable,
    customer_credits: customerCredits,
    supplier_advances: {
      account_code: '1400',
      account_name: 'Supplier Advances',
      account_balance_cents: supplierAdvances,
      portal_balance_cents: portal.totals.balance_cents,
      difference_cents: supplierAdvances - portal.totals.balance_cents,
      matched: supplierAdvances === portal.totals.balance_cents,
    },
    all_matched: supplierCredits.matched
      && refundPayable.matched
      && customerCredits.matched
      && supplierAdvances === portal.totals.balance_cents,
  };
}

module.exports = {
  reconciliationSummary,
  refundPayableReconciliation,
  customerCreditsReconciliation,
};
