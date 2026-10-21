'use strict';

const { dateISO, todayISO } = require('../../util');

function agingBuckets(db, table, statusValue, partyTable, partyColumn, partyName, asOf) {
  const today = asOf ? dateISO(asOf, 'As-of date') : todayISO();
  const dateColumn = table === 'invoices' ? 'issue_date' : 'bill_date';
  const creditExpr = 'd.credit_applied_cents';
  const rows = db.prepare(`
    SELECT d.id, d.number, d.${dateColumn} AS document_date, d.due_date, d.total_cents, d.amount_paid_cents,
           d.credit_applied_cents,
           p.id AS party_id, p.name AS party_name,
           d.total_cents - d.amount_paid_cents - ${creditExpr} AS balance_cents
    FROM ${table} d
    JOIN ${partyTable} p ON p.id = d.${partyColumn}
    WHERE d.status = '${statusValue}' AND d.total_cents > d.amount_paid_cents + ${creditExpr}
    ORDER BY p.name, d.due_date
  `).all();

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
    const ref = new Date(`${today}T00:00:00Z`);
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
    as_of: today,
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
