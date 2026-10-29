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
    account_name: 'Refund Liabilities',
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

// Each check compares a control account with the open documents behind it.
// Assets carry debit balances and liabilities credit balances; both are shown
// as positive amounts so the card can compare like with like.
function documentTotal(db, sql) {
  return db.prepare(sql).get().total || 0;
}

function controlCheck({ key, code, name, ledger, documents, label, href }) {
  const ledgerCents = 0 + ledger;
  const documentsCents = 0 + documents;
  return {
    key,
    account_code: code,
    account_name: name,
    ledger_cents: ledgerCents,
    documents_cents: documentsCents,
    documents_label: label,
    difference_cents: ledgerCents - documentsCents,
    matched: ledgerCents === documentsCents,
    href,
  };
}

function controlChecks(db, summary) {
  const trial = db.prepare(`
    SELECT COALESCE(SUM(debit_cents), 0) AS debit, COALESCE(SUM(credit_cents), 0) AS credit
    FROM journal_lines
  `).get();
  return [
    {
      key: 'trial_balance',
      account_code: '',
      account_name: 'Trial balance',
      ledger_cents: trial.debit,
      documents_cents: trial.credit,
      documents_label: 'Total debits vs total credits',
      difference_cents: trial.debit - trial.credit,
      matched: trial.debit === trial.credit,
      href: '#/reports/trial-balance',
    },
    controlCheck({
      key: 'receivables',
      code: '1100',
      name: 'Trade Receivables',
      ledger: accountBalanceCents(db, '1100'),
      documents: documentTotal(db, `
        SELECT COALESCE(SUM(MAX(0, total_cents - amount_paid_cents - credit_applied_cents)), 0) AS total
        FROM invoices WHERE status = 'sent'
      `),
      label: 'Open invoices',
      href: '#/invoices',
    }),
    controlCheck({
      key: 'payables',
      code: '2000',
      name: 'Trade Payables',
      ledger: -accountBalanceCents(db, '2000'),
      documents: documentTotal(db, `
        SELECT COALESCE(SUM(MAX(0, total_cents - amount_paid_cents - credit_applied_cents)), 0) AS total
        FROM bills WHERE status = 'received'
      `),
      label: 'Open bills',
      href: '#/bills',
    }),
    controlCheck({
      key: 'customer_advances',
      code: '2400',
      name: 'Contract Liabilities (Customer Advances)',
      ledger: -accountBalanceCents(db, '2400'),
      documents: documentTotal(db, `
        SELECT COALESCE(SUM(amount_cents - applied_cents - refunded_cents), 0) AS total
        FROM customer_advances WHERE voided_at IS NULL
      `),
      label: 'Unapplied advances',
      href: '#/settlement-queue',
    }),
    controlCheck({
      key: 'refund_payable',
      code: '2500',
      name: 'Refund Liabilities',
      ledger: summary.refund_payable.account_balance_cents,
      documents: summary.refund_payable.open_refund_cents,
      label: 'Unpaid cancellation refunds',
      href: '#/settlement-queue',
    }),
    controlCheck({
      key: 'customer_credits',
      code: '2450',
      name: 'Customer Credits',
      ledger: summary.customer_credits.account_balance_cents,
      documents: summary.customer_credits.open_credit_cents,
      label: 'Open customer credit notes',
      href: '#/credits',
    }),
    controlCheck({
      key: 'supplier_credits',
      code: '1450',
      name: 'Supplier Credits',
      ledger: summary.supplier_credits.account_balance_cents,
      documents: summary.supplier_credits.open_credit_cents,
      label: 'Open supplier credits',
      href: '#/supplier-credits',
    }),
    controlCheck({
      key: 'supplier_advances',
      code: '1400',
      name: 'Advances to Suppliers',
      ledger: summary.supplier_advances.account_balance_cents,
      documents: summary.supplier_advances.portal_balance_cents,
      label: 'Portal wallet balances',
      href: '#/portals',
    }),
    ...depositChecks(db),
  ];
}

function depositChecks(db) {
  const totals = require('./visa-deposits').depositTotals(db);
  return [
    controlCheck({
      key: 'visa_deposits',
      code: '2600',
      name: 'Refundable Security Deposits Held',
      ledger: -accountBalanceCents(db, '2600'),
      documents: totals.held_cents,
      label: 'Deposits still held',
      href: '#/reports/visa-deposits',
    }),
    controlCheck({
      key: 'deposits_with_suppliers',
      code: '1460',
      name: 'Refundable Deposits Paid',
      ledger: accountBalanceCents(db, '1460'),
      documents: totals.with_supplier_cents,
      label: 'Deposits held by suppliers',
      href: '#/reports/visa-deposits',
    }),
  ];
}

function reconciliationSummary(db) {
  const supplierCredits = supplierCreditService.supplierCreditReconciliation(db);
  const refundPayable = refundPayableReconciliation(db);
  const customerCredits = customerCreditsReconciliation(db);
  const portal = portalService.portalReport(db);
  const supplierAdvances = accountBalanceCents(db, '1400');
  const summary = {
    supplier_credits: supplierCredits,
    refund_payable: refundPayable,
    customer_credits: customerCredits,
    supplier_advances: {
      account_code: '1400',
      account_name: 'Advances to Suppliers',
      account_balance_cents: supplierAdvances,
      portal_balance_cents: portal.totals.balance_cents,
      difference_cents: supplierAdvances - portal.totals.balance_cents,
      matched: supplierAdvances === portal.totals.balance_cents,
    },
  };
  summary.checks = controlChecks(db, summary);
  summary.all_matched = summary.checks.every((check) => check.matched);
  summary.difference_count = summary.checks.filter((check) => !check.matched).length;
  return summary;
}

module.exports = {
  reconciliationSummary,
  refundPayableReconciliation,
  customerCreditsReconciliation,
};
