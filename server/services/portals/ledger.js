'use strict';

const { dateISO, todayISO } = require('../../util');
const { SUPPLIER_ADVANCES, AP } = require('./common');
const { getPortal } = require('./lifecycle');

function creditPortalLedger(db, portal, options = {}) {
  const today = todayISO();
  const vendorId = portal.vendor_id;

  const bills = vendorId
    ? db.prepare(`
        SELECT b.*
        FROM bills b
        WHERE b.vendor_id = ? AND b.status = 'received'
        ORDER BY b.bill_date, b.id
      `).all(vendorId)
    : [];

  const payments = vendorId
    ? db.prepare(`
        SELECT p.*, b.number AS bill_number, b.bill_date,
               a.name AS payment_account_name
        FROM bill_payments p
        JOIN bills b ON b.id = p.bill_id
        JOIN accounts a ON a.id = p.payment_account_id
        WHERE p.vendor_id = ? AND b.status = 'received' AND p.status = 'posted'
        ORDER BY p.payment_date, p.id
      `).all(vendorId)
    : [];

  // Old supplier refunds reduced a bill payment and reopened A/P. Supplier
  // credit refunds settle 1450 and must not appear as A/P activity.
  const supplierRefunds = vendorId
    ? db.prepare(`
        SELECT r.*, b.number AS bill_number, a.name AS account_name
        FROM refunds r
        JOIN bills b ON b.id = r.bill_id
        JOIN accounts a ON a.id = r.account_id
        WHERE r.party_id = ? AND r.refund_type = 'supplier' AND r.status = 'paid'
          AND r.supplier_credit_note_id IS NULL
        ORDER BY r.refund_date, r.id
      `).all(vendorId)
    : [];

  const supplierCredits = vendorId
    ? db.prepare(`
        SELECT scn.*
        FROM supplier_credit_notes scn
        WHERE scn.vendor_id = ? AND scn.status = 'issued'
        ORDER BY scn.credit_date, scn.id
      `).all(vendorId)
    : [];

  const creditApplications = vendorId
    ? db.prepare(`
        SELECT sca.*, scn.number AS credit_number, scn.credit_date,
               b.number AS bill_number
        FROM supplier_credit_applications sca
        JOIN supplier_credit_notes scn ON scn.id = sca.credit_note_id
        JOIN bills b ON b.id = sca.bill_id
        WHERE scn.vendor_id = ?
        ORDER BY sca.applied_date, sca.id
      `).all(vendorId)
    : [];

  const openSupplierCredits = supplierCredits.reduce(
    (sum, credit) => sum + Math.max(0, credit.amount_cents - credit.applied_cents - credit.refunded_cents - credit.portal_settled_cents),
    0,
  );

  const entryIds = [
    ...bills.map((bill) => bill.journal_entry_id),
    ...payments.map((payment) => payment.journal_entry_id),
    ...supplierRefunds.map((refund) => refund.journal_entry_id),
    ...supplierCredits.map((credit) => credit.journal_entry_id),
    ...creditApplications.map((application) => application.journal_entry_id),
  ].filter(Boolean);

  const linesByEntry = new Map();
  if (entryIds.length) {
    const placeholders = entryIds.map(() => '?').join(',');
    const lines = db.prepare(`
      SELECT l.entry_id, l.debit_cents, l.credit_cents, l.description,
             a.code AS account_code, a.name AS account_name, a.type AS account_type
      FROM journal_lines l
      JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id IN (${placeholders})
      ORDER BY l.sort_order, l.id
    `).all(...entryIds);
    for (const line of lines) {
      if (!linesByEntry.has(line.entry_id)) linesByEntry.set(line.entry_id, []);
      linesByEntry.get(line.entry_id).push({
        account_code: line.account_code,
        account_name: line.account_name,
        account_type: line.account_type,
        description: line.description,
        debit_cents: line.debit_cents,
        credit_cents: line.credit_cents,
      });
    }
  }

  const movements = [
    ...bills.map((bill) => ({
      key: `bill-${bill.id}`,
      kind: 'bill',
      date: bill.bill_date,
      order: 0,
      reference: bill.number,
      description: bill.notes || 'Supplier bill',
      detail: 'Bill received',
      debit_cents: 0,
      credit_cents: bill.total_cents,
      entry_id: bill.journal_entry_id || null,
      bill_id: bill.id,
      source_id: bill.id,
      lines: linesByEntry.get(bill.journal_entry_id) || [],
    })),
    ...payments.map((payment) => ({
      key: `billpay-${payment.id}`,
      kind: 'bill_payment',
      date: payment.payment_date,
      order: 1,
      reference: payment.number,
      description: `Payment · ${payment.method}`,
      detail: [payment.payment_account_name, payment.reference].filter(Boolean).join(' · '),
      debit_cents: payment.amount_cents,
      credit_cents: 0,
      entry_id: payment.journal_entry_id || null,
      bill_id: payment.bill_id,
      source_id: payment.id,
      lines: linesByEntry.get(payment.journal_entry_id) || [],
    })),
    ...supplierRefunds.map((refund) => ({
      key: `supplier-refund-${refund.id}`,
      kind: 'supplier_refund',
      date: refund.refund_date,
      order: 2,
      reference: refund.number,
      description: `Supplier refund · ${refund.method}`,
      detail: [refund.account_name, refund.reference, refund.bill_number ? `Bill ${refund.bill_number}` : ''].filter(Boolean).join(' · '),
      debit_cents: 0,
      credit_cents: refund.amount_cents,
      entry_id: refund.journal_entry_id || null,
      bill_id: refund.bill_id,
      source_id: refund.id,
      lines: linesByEntry.get(refund.journal_entry_id) || [],
    })),
    ...creditApplications.map((application) => ({
      key: `supplier-credit-app-${application.id}`,
      kind: 'supplier_credit_applied',
      date: application.applied_date,
      order: 3,
      reference: application.credit_number,
      description: `Supplier credit applied · Bill ${application.bill_number}`,
      detail: `Credit ${application.credit_number}`,
      debit_cents: application.amount_cents,
      credit_cents: 0,
      entry_id: application.journal_entry_id || null,
      bill_id: application.bill_id,
      source_id: application.id,
      lines: linesByEntry.get(application.journal_entry_id) || [],
    })),
    ...supplierCredits.map((credit) => ({
      key: `supplier-credit-${credit.id}`,
      kind: 'supplier_credit',
      date: credit.credit_date,
      order: 4,
      reference: credit.number,
      description: 'Supplier credit issued',
      detail: credit.bill_id ? 'Credited against a bill' : 'Standalone credit',
      debit_cents: 0,
      credit_cents: 0,
      entry_id: credit.journal_entry_id || null,
      source_id: credit.id,
      lines: linesByEntry.get(credit.journal_entry_id) || [],
    })),
  ].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.source_id - b.source_id;
  });

  let running = 0;
  const ledger = movements.map((movement) => {
    running += movement.credit_cents - movement.debit_cents;
    return { ...movement, balance_cents: running };
  });

  const activityDates = movements.map((movement) => movement.date).filter(Boolean).sort();
  const defaultFrom = activityDates[0] || today;
  const lastActivity = activityDates[activityDates.length - 1] || today;
  const defaultTo = lastActivity > today ? lastActivity : today;

  let from = options.from ? dateISO(options.from, 'From date') : defaultFrom;
  let to = options.to ? dateISO(options.to, 'To date') : defaultTo;
  if (from > to) [from, to] = [to, from];

  const openingCents = ledger
    .filter((row) => row.date < from)
    .reduce((sum, row) => sum + row.credit_cents - row.debit_cents, 0);
  const rows = ledger.filter((row) => row.date >= from && row.date <= to);
  const totalCreditCents = rows.reduce((sum, row) => sum + row.credit_cents, 0);
  const totalDebitCents = rows.reduce((sum, row) => sum + row.debit_cents, 0);
  const closingCents = openingCents + totalCreditCents - totalDebitCents;
  const periodBills = rows.filter((row) => row.kind === 'bill').length;
  const periodPayments = rows.filter((row) => row.kind === 'bill_payment').length;
  const periodRefunds = rows.filter((row) => row.kind === 'supplier_refund').length;
  const periodCredits = rows.filter((row) => row.kind === 'supplier_credit_applied').length;

  return {
    mode: 'credit',
    portal: {
      id: portal.id,
      name: portal.name,
      portal_type: portal.portal_type,
      settlement: portal.settlement,
      vendor_id: portal.vendor_id,
      vendor_name: portal.vendor_name || null,
      login_ref: portal.login_ref,
      is_active: portal.is_active,
      balance_cents: portal.balance_cents,
      topup_total_cents: portal.topup_total_cents,
      credit_total_cents: portal.credit_total_cents,
      refunded_total_cents: portal.refunded_total_cents,
      consumed_total_cents: portal.consumed_total_cents,
      outstanding_ap_cents: portal.outstanding_ap_cents,
      credit_limit_cents: portal.credit_limit_cents,
      credit_available_cents: portal.credit_available_cents,
    },
    from,
    to,
    default_from: defaultFrom,
    default_to: defaultTo,
    opening_cents: openingCents,
    total_debit_cents: totalDebitCents,
    total_credit_cents: totalCreditCents,
    closing_cents: closingCents,
    current_balance_cents: portal.outstanding_ap_cents,
    unapplied_supplier_credits_cents: openSupplierCredits,
    account_code: AP,
    account_name: 'Trade Payables',
    rows,
    counts: {
      bills: bills.length,
      payments: payments.length,
      refunds: supplierRefunds.length,
      credits: supplierCredits.length,
      period_bills: periodBills,
      period_payments: periodPayments,
      period_refunds: periodRefunds,
      period_credits: periodCredits,
      topups: 0,
      settlements: 0,
    },
    reconciliation: null,
  };
}

function portalLedger(db, portalId, options = {}) {
  const id = Number(portalId);
  const portal = getPortal(db, id);
  if (portal.settlement === 'credit') return creditPortalLedger(db, portal, options);
  const today = todayISO();

  const activityDates = [
    ...portal.topups.map((topup) => topup.topup_date),
    ...portal.credits.map((credit) => credit.credit_date),
    ...portal.refunds.map((refund) => refund.refund_date),
    ...portal.settlements.map((settlement) => settlement.payment_date),
    ...portal.deposit_movements.map((event) => event.event_date),
  ].filter(Boolean).sort();
  const defaultFrom = activityDates[0] || today;
  const lastActivity = activityDates[activityDates.length - 1] || today;
  const defaultTo = lastActivity > today ? lastActivity : today;

  let from = options.from ? dateISO(options.from, 'From date') : defaultFrom;
  let to = options.to ? dateISO(options.to, 'To date') : defaultTo;
  if (from > to) [from, to] = [to, from];

  const entryIds = [
    ...portal.topups.map((topup) => topup.journal_entry_id),
    ...portal.credits.map((credit) => credit.journal_entry_id),
    ...portal.refunds.map((refund) => refund.journal_entry_id),
    ...portal.settlements.map((settlement) => settlement.journal_entry_id),
    ...portal.deposit_movements.map((event) => event.journal_entry_id),
  ].filter(Boolean);

  const linesByEntry = new Map();
  if (entryIds.length) {
    const placeholders = entryIds.map(() => '?').join(',');
    const lines = db.prepare(`
      SELECT l.entry_id, l.debit_cents, l.credit_cents, l.description,
             a.code AS account_code, a.name AS account_name, a.type AS account_type
      FROM journal_lines l
      JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id IN (${placeholders})
      ORDER BY l.sort_order, l.id
    `).all(...entryIds);
    for (const line of lines) {
      if (!linesByEntry.has(line.entry_id)) linesByEntry.set(line.entry_id, []);
      linesByEntry.get(line.entry_id).push({
        account_code: line.account_code,
        account_name: line.account_name,
        account_type: line.account_type,
        description: line.description,
        debit_cents: line.debit_cents,
        credit_cents: line.credit_cents,
      });
    }
  }

  const movements = [
    ...portal.topups.map((topup) => ({
      key: `topup-${topup.id}`,
      kind: 'topup',
      date: topup.topup_date,
      order: 0,
      reference: topup.number,
      description: `Top-up · ${topup.method}`,
      detail: `${topup.deposit_account_name}${topup.reference ? ` · ${topup.reference}` : ''}`,
      debit_cents: topup.amount_cents,
      credit_cents: 0,
      entry_id: topup.journal_entry_id || null,
      source_id: topup.id,
    })),
    ...portal.credits.map((credit) => ({
      key: `portal-credit-${credit.id}`,
      kind: 'portal_credit',
      date: credit.credit_date,
      order: 0,
      reference: credit.number,
      description: 'Supplier credit added to wallet',
      detail: [credit.supplier_credit_number, credit.bill_number ? `Bill ${credit.bill_number}` : ''].filter(Boolean).join(' · '),
      debit_cents: credit.amount_cents,
      credit_cents: 0,
      entry_id: credit.journal_entry_id || null,
      source_id: credit.id,
    })),
    ...portal.refunds.map((refund) => ({
      key: `refund-${refund.id}`,
      kind: 'refund',
      date: refund.refund_date,
      order: 1,
      reference: refund.reference || '—',
      description: `Withdrawal · ${refund.method}`,
      detail: refund.payment_account_name,
      debit_cents: 0,
      credit_cents: refund.amount_cents,
      entry_id: refund.journal_entry_id || null,
      source_id: refund.id,
    })),
    ...portal.settlements.map((settlement) => ({
      key: `settle-${settlement.id}`,
      kind: 'settlement',
      date: settlement.payment_date,
      order: 2,
      reference: settlement.number,
      description: `Bill ${settlement.bill_number} settled`,
      detail: `${settlement.vendor_name}${settlement.booking_id ? ' · from a booking' : settlement.visa_id ? ' · from a visa application' : ''}`,
      debit_cents: 0,
      credit_cents: settlement.amount_cents,
      entry_id: settlement.journal_entry_id || null,
      source_id: settlement.id,
      bill_id: settlement.bill_id,
      booking_id: settlement.booking_id || null,
      visa_id: settlement.visa_id || null,
    })),
    ...portal.deposit_movements.map((event) => {
      const net = event.event_type === 'to_supplier' ? event.amount_cents : event.amount_cents - event.deduction_cents;
      return {
        key: `deposit-${event.id}`,
        kind: event.event_type === 'to_supplier' ? 'deposit_paid' : 'deposit_returned',
        date: event.event_date,
        order: 2,
        reference: event.deposit_number,
        description: event.event_type === 'to_supplier' ? `Visa deposit ${event.deposit_number} paid` : `Visa deposit ${event.deposit_number} returned`,
        detail: `${event.applicant_name || ''}${event.visa_number ? ` · ${event.visa_number}` : ''}`,
        debit_cents: event.event_type === 'to_supplier' ? 0 : net,
        credit_cents: event.event_type === 'to_supplier' ? net : 0,
        entry_id: event.journal_entry_id || null,
        source_id: event.id,
        visa_id: event.visa_id,
      };
    }),
  ].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.source_id - b.source_id;
  });

  let running = 0;
  const ledger = movements.map((movement) => {
    running += movement.debit_cents - movement.credit_cents;
    return {
      ...movement,
      balance_cents: running,
      lines: linesByEntry.get(movement.entry_id) || [],
    };
  });

  const openingCents = ledger
    .filter((row) => row.date < from)
    .reduce((sum, row) => sum + row.debit_cents - row.credit_cents, 0);
  const rows = ledger.filter((row) => row.date >= from && row.date <= to);
  const totalDebitCents = rows.reduce((sum, row) => sum + row.debit_cents, 0);
  const totalCreditCents = rows.reduce((sum, row) => sum + row.credit_cents, 0);
  const closingCents = openingCents + totalDebitCents - totalCreditCents;

  const gl = db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS balance
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ?
  `).get(SUPPLIER_ADVANCES);
  const allPortalBalanceCents = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(amount_cents), 0) FROM portal_topups WHERE status = 'posted')
      + (SELECT COALESCE(SUM(amount_cents), 0) FROM portal_credits WHERE status = 'posted')
      - (SELECT COALESCE(SUM(amount_cents), 0) FROM portal_refunds WHERE status = 'posted')
      - (SELECT COALESCE(SUM(amount_cents), 0) FROM bill_payments WHERE portal_id IS NOT NULL AND status = 'posted')
      - (SELECT COALESCE(SUM(CASE WHEN event_type = 'to_supplier' THEN amount_cents ELSE -(amount_cents - deduction_cents) END), 0)
         FROM visa_deposit_events WHERE portal_id IS NOT NULL AND voided_at IS NULL AND event_type IN ('to_supplier', 'supplier_return'))
      AS balance
  `).get().balance;

  return {
    mode: 'wallet',
    portal: {
      id: portal.id,
      name: portal.name,
      portal_type: portal.portal_type,
      settlement: portal.settlement,
      vendor_id: portal.vendor_id,
      vendor_name: portal.vendor_name || null,
      login_ref: portal.login_ref,
      is_active: portal.is_active,
      balance_cents: portal.balance_cents,
      topup_total_cents: portal.topup_total_cents,
      credit_total_cents: portal.credit_total_cents,
      refunded_total_cents: portal.refunded_total_cents,
      consumed_total_cents: portal.consumed_total_cents,
      outstanding_ap_cents: portal.outstanding_ap_cents,
      credit_limit_cents: portal.credit_limit_cents,
      credit_available_cents: portal.credit_available_cents,
    },
    from,
    to,
    default_from: defaultFrom,
    default_to: defaultTo,
    opening_cents: openingCents,
    total_debit_cents: totalDebitCents,
    total_credit_cents: totalCreditCents,
    closing_cents: closingCents,
    current_balance_cents: portal.balance_cents,
    account_code: SUPPLIER_ADVANCES,
    account_name: 'Advances to Suppliers',
    rows,
    counts: {
      topups: portal.topups.length,
      credits: portal.credits.length,
      refunds: portal.refunds.length,
      settlements: portal.settlements.length,
    },
    reconciliation: {
      account_code: SUPPLIER_ADVANCES,
      account_name: 'Advances to Suppliers',
      gl_balance_cents: gl.balance,
      portal_total_cents: allPortalBalanceCents,
      difference_cents: gl.balance - allPortalBalanceCents,
    },
  };
}

module.exports = {
  creditPortalLedger,
  portalLedger,
};
