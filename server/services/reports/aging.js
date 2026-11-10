'use strict';

const { dateISO, todayISO } = require('../../util');

// What was still owed on each document. Today it is the stored balance. For a
// past date only documents dated by then count, and only the payments,
// refunds and credits dated by then; a document or payment voided after that
// date still counts, as it did in the books on that day.
// shortcut: a credit application reversed later is deleted, so a past date
// misses it; keep reversed applications if month-end aging must match exactly.
function openDocuments(db, table, statusValue, partyTable, partyColumn, asOf, today) {
  const invoice = table === 'invoices';
  const dateColumn = invoice ? 'issue_date' : 'bill_date';
  const columns = `d.id, d.number, d.${dateColumn} AS document_date, d.due_date, d.total_cents,
           p.id AS party_id, p.name AS party_name`;
  if (asOf >= today) {
    return db.prepare(`
      SELECT ${columns}, d.amount_paid_cents, d.credit_applied_cents,
             d.total_cents - d.amount_paid_cents - d.credit_applied_cents AS balance_cents
      FROM ${table} d
      JOIN ${partyTable} p ON p.id = d.${partyColumn}
      WHERE d.status = '${statusValue}' AND d.total_cents > d.amount_paid_cents + d.credit_applied_cents
      ORDER BY p.name, d.due_date
    `).all();
  }
  // Still in the books on the date: posted by then and not reversed by then.
  const live = (alias, dateExpr) => `${dateExpr} <= @asOf AND NOT EXISTS (
      SELECT 1 FROM journal_entries v WHERE v.id = ${alias}.void_entry_id AND v.entry_date <= @asOf)`;
  const payments = invoice ? 'payments' : 'bill_payments';
  const paymentKey = invoice ? 'invoice_id' : 'bill_id';
  const applications = invoice ? 'credit_applications' : 'supplier_credit_applications';
  // A refund of a customer payment reopens the invoice; a supplier refund is a
  // credit note and leaves the bill alone.
  const refunded = invoice
    ? `(SELECT COALESCE(SUM(r.amount_cents), 0) FROM refunds r
        WHERE r.invoice_id = d.id AND r.payment_id IS NOT NULL AND ${live('r', 'r.refund_date')})`
    : '0';
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT ${columns},
        (SELECT COALESCE(SUM(x.amount_cents), 0) FROM ${payments} x
          WHERE x.${paymentKey} = d.id AND ${live('x', 'x.payment_date')}) - ${refunded} AS amount_paid_cents,
        (SELECT COALESCE(SUM(a.amount_cents), 0) FROM ${applications} a
          WHERE a.${paymentKey} = d.id AND a.applied_date <= @asOf) AS credit_applied_cents
      FROM ${table} d
      JOIN ${partyTable} p ON p.id = d.${partyColumn}
      WHERE d.status IN ('${statusValue}', 'void') AND d.${dateColumn} <= @asOf
        AND d.journal_entry_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries v WHERE v.reversal_of_id = d.journal_entry_id AND v.entry_date <= @asOf)
    )
    WHERE total_cents > amount_paid_cents + credit_applied_cents
    ORDER BY party_name, due_date
  `).all({ asOf });
  return rows.map((row) => ({ ...row, balance_cents: row.total_cents - row.amount_paid_cents - row.credit_applied_cents }));
}

function agingBuckets(db, table, statusValue, partyTable, partyColumn, partyName, asOf) {
  const today = todayISO();
  const date = asOf ? dateISO(asOf, 'As-of date') : today;
  const rows = openDocuments(db, table, statusValue, partyTable, partyColumn, date, today);

  const byParty = new Map();
  const buckets = {
    current_cents: 0,
    days_1_30_cents: 0,
    days_31_60_cents: 0,
    days_61_90_cents: 0,
    days_90_plus_cents: 0,
    total_cents: 0,
  };

  for (const row of rows) {
    const due = new Date(`${row.due_date}T00:00:00Z`);
    const ref = new Date(`${date}T00:00:00Z`);
    const daysOverdue = Math.round((ref - due) / 86_400_000);
    let bucket;
    if (daysOverdue <= 0) bucket = 'current_cents';
    else if (daysOverdue <= 30) bucket = 'days_1_30_cents';
    else if (daysOverdue <= 60) bucket = 'days_31_60_cents';
    else if (daysOverdue <= 90) bucket = 'days_61_90_cents';
    else bucket = 'days_90_plus_cents';

    if (!byParty.has(row.party_id)) {
      byParty.set(row.party_id, {
        party_id: row.party_id,
        party_name: row.party_name,
        current_cents: 0,
        days_1_30_cents: 0,
        days_31_60_cents: 0,
        days_61_90_cents: 0,
        days_90_plus_cents: 0,
        total_cents: 0,
        invoices: [],
      });
    }
    const party = byParty.get(row.party_id);
    party[bucket] += row.balance_cents;
    party.total_cents += row.balance_cents;
    buckets[bucket] += row.balance_cents;
    buckets.total_cents += row.balance_cents;
    party.invoices.push({
      id: row.id,
      number: row.number,
      document_date: row.document_date,
      due_date: row.due_date,
      total_cents: row.total_cents,
      amount_paid_cents: row.amount_paid_cents,
      credit_applied_cents: row.credit_applied_cents,
      balance_cents: row.balance_cents,
      days_overdue: daysOverdue,
    });
  }

  return {
    as_of: date,
    rows: Array.from(byParty.values()).sort((a, b) => b.total_cents - a.total_cents),
    totals: buckets,
  };
}

function arAging(db, asOf) {
  return agingBuckets(db, 'invoices', 'sent', 'customers', 'customer_id', 'name', asOf);
}

function apAging(db, asOf) {
  return agingBuckets(db, 'bills', 'received', 'vendors', 'vendor_id', 'name', asOf);
}

function cashBalances(db, asOf) {
  const accounts = db.prepare("SELECT code, name FROM accounts WHERE code IN ('1000', '1010')").all();
  const cashAccount = accounts.find((account) => account.code === '1000');
  const bankAccount = accounts.find((account) => account.code === '1010');
  const rows = db.prepare(`
    SELECT e.entry_date AS date, a.code,
           COALESCE(SUM(l.debit_cents), 0) AS debit_cents,
           COALESCE(SUM(l.credit_cents), 0) AS credit_cents
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE a.code IN ('1000', '1010') AND e.entry_date <= ?
    GROUP BY e.entry_date, a.code
    ORDER BY e.entry_date
  `).all(asOf);

  let cash = 0;
  let bank = 0;
  const byDate = new Map();
  for (const row of rows) {
    if (row.code === '1000') cash += row.debit_cents - row.credit_cents;
    if (row.code === '1010') bank += row.debit_cents - row.credit_cents;
    byDate.set(row.date, { cash_cents: cash, bank_cents: bank });
  }

  return {
    cash_cents: cash,
    bank_cents: bank,
    cash_label: cashAccount?.name || 'Cash',
    bank_label: bankAccount?.name || 'Bank',
    byDate,
  };
}


module.exports = { agingBuckets, arAging, apAging, cashBalances };
