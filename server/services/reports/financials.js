'use strict';

const { dateISO, todayISO } = require('../../util');

function trialBalance(db, asOf = todayISO()) {
  const date = dateISO(asOf, 'As-of date');
  const rows = db.prepare(`
    SELECT a.id, a.code, a.name, a.type, a.normal_balance, a.is_active,
      (SELECT COALESCE(SUM(l.debit_cents), 0)
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = a.id AND e.entry_date <= ?) AS debit_cents,
      (SELECT COALESCE(SUM(l.credit_cents), 0)
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = a.id AND e.entry_date <= ?) AS credit_cents
    FROM accounts a
    ORDER BY a.code
  `).all(date, date);
  const totals = rows.reduce((acc, row) => {
    acc.debit_cents += row.debit_cents;
    acc.credit_cents += row.credit_cents;
    return acc;
  }, { debit_cents: 0, credit_cents: 0 });
  return {
    as_of: date,
    rows: rows.map((row) => ({ ...row, balance_cents: row.debit_cents - row.credit_cents })),
    totals,
    balanced: totals.debit_cents === totals.credit_cents,
  };
}

function incomeStatement(db, from, to) {
  const start = dateISO(from, 'From date');
  const end = dateISO(to, 'To date');
  const rows = db.prepare(`
    SELECT a.id, a.code, a.name, a.type, a.subtype,
      SUM(CASE WHEN a.type = 'revenue' THEN l.credit_cents - l.debit_cents
               ELSE l.debit_cents - l.credit_cents END) AS amount_cents
    FROM accounts a
    JOIN journal_lines l ON l.account_id = a.id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE e.entry_date >= ? AND e.entry_date <= ?
      AND a.type IN ('revenue', 'expense')
    GROUP BY a.id
    HAVING amount_cents != 0
    ORDER BY a.code
  `).all(start, end);

  const revenue = rows.filter((row) => row.type === 'revenue');
  const expenses = rows.filter((row) => row.type === 'expense');
  const revenueTotal = revenue.reduce((sum, row) => sum + row.amount_cents, 0);
  const expenseTotal = expenses.reduce((sum, row) => sum + row.amount_cents, 0);

  return {
    from: start,
    to: end,
    revenue,
    expenses,
    revenue_total_cents: revenueTotal,
    expenses_total_cents: expenseTotal,
    net_income_cents: revenueTotal - expenseTotal,
  };
}

function balanceSheet(db, asOf = todayISO()) {
  const date = dateISO(asOf, 'As-of date');
  const rows = db.prepare(`
    SELECT a.id, a.code, a.name, a.type, a.subtype, a.normal_balance, a.is_active,
      (SELECT COALESCE(SUM(l.debit_cents), 0)
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = a.id AND e.entry_date <= ?) AS debit_cents,
      (SELECT COALESCE(SUM(l.credit_cents), 0)
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = a.id AND e.entry_date <= ?) AS credit_cents
    FROM accounts a
    ORDER BY a.code
  `).all(date, date);

  const assets = [];
  const liabilities = [];
  const equity = [];
  let revenueTotal = 0;
  let expenseTotal = 0;

  for (const row of rows) {
    const debitNet = row.debit_cents - row.credit_cents;
    const creditNet = row.credit_cents - row.debit_cents;
    if (row.type === 'asset' && debitNet !== 0) {
      assets.push({ ...row, amount_cents: debitNet });
    } else if (row.type === 'liability' && creditNet !== 0) {
      liabilities.push({ ...row, amount_cents: creditNet });
    } else if (row.type === 'equity' && creditNet !== 0) {
      equity.push({ ...row, amount_cents: creditNet });
    } else if (row.type === 'revenue') {
      revenueTotal += creditNet;
    } else if (row.type === 'expense') {
      expenseTotal += debitNet;
    }
  }

  const currentEarnings = revenueTotal - expenseTotal;
  if (currentEarnings !== 0) {
    equity.push({
      id: null,
      code: '—',
      name: 'Current Period Earnings',
      type: 'equity',
      amount_cents: currentEarnings,
      is_current_earnings: true,
    });
  }

  const assetTotal = assets.reduce((sum, row) => sum + row.amount_cents, 0);
  const liabilityTotal = liabilities.reduce((sum, row) => sum + row.amount_cents, 0);
  const equityTotal = equity.reduce((sum, row) => sum + row.amount_cents, 0);

  return {
    as_of: date,
    assets,
    liabilities,
    equity,
    asset_total_cents: assetTotal,
    liability_total_cents: liabilityTotal,
    equity_total_cents: equityTotal,
    liabilities_and_equity_cents: liabilityTotal + equityTotal,
    difference_cents: assetTotal - (liabilityTotal + equityTotal),
    balanced: assetTotal === liabilityTotal + equityTotal,
  };
}


module.exports = { trialBalance, incomeStatement, balanceSheet };
