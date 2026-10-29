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
  const balances = rows.map((row) => {
    const net = row.debit_cents - row.credit_cents;
    return {
      ...row,
      gross_debit_cents: row.debit_cents,
      gross_credit_cents: row.credit_cents,
      debit_cents: net > 0 ? net : 0,
      credit_cents: net < 0 ? -net : 0,
      balance_cents: net,
    };
  });
  const totals = balances.reduce((acc, row) => {
    acc.debit_cents += row.debit_cents;
    acc.credit_cents += row.credit_cents;
    return acc;
  }, { debit_cents: 0, credit_cents: 0 });
  return {
    as_of: date,
    rows: balances,
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

  // IAS 1 layout: revenue, cost of sales, gross profit, other expenses,
  // profit for the period. Cost of sales is every expense account of subtype
  // 'cogs' (air tickets, hotels and tours, visas).
  const revenue = rows.filter((row) => row.type === 'revenue');
  const expenses = rows.filter((row) => row.type === 'expense');
  const costOfSales = expenses.filter((row) => row.subtype === 'cogs');
  const operatingExpenses = expenses.filter((row) => row.subtype !== 'cogs');
  const sum = (list) => list.reduce((total, row) => total + row.amount_cents, 0);
  const revenueTotal = sum(revenue);
  const expenseTotal = sum(expenses);
  const costOfSalesTotal = sum(costOfSales);

  return {
    from: start,
    to: end,
    revenue,
    expenses,
    cost_of_sales: costOfSales,
    operating_expenses: operatingExpenses,
    revenue_total_cents: revenueTotal,
    cost_of_sales_total_cents: costOfSalesTotal,
    gross_profit_cents: revenueTotal - costOfSalesTotal,
    operating_expenses_total_cents: expenseTotal - costOfSalesTotal,
    expenses_total_cents: expenseTotal,
    net_income_cents: revenueTotal - expenseTotal,
    profit_cents: revenueTotal - expenseTotal,
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
      name: 'Profit for the period (not yet closed to retained earnings)',
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
