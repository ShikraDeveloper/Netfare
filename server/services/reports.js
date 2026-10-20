'use strict';

const { dateISO, todayISO, monthRange, shiftMonth } = require('../util');
const { invoiceDisplayStatus, billDisplayStatus } = require('../accounting');
const bookingService = require('./bookings');
const visaService = require('./visas');
const portalService = require('./portals');
const complianceService = require('./compliance');

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

function agingBuckets(db, table, statusValue, partyTable, partyColumn, partyName, asOf) {
  const today = asOf ? dateISO(asOf, 'As-of date') : todayISO();
  const dateColumn = table === 'invoices' ? 'issue_date' : 'bill_date';
  const rows = db.prepare(`
    SELECT d.id, d.number, d.${dateColumn} AS document_date, d.due_date, d.total_cents, d.amount_paid_cents,
           p.id AS party_id, p.name AS party_name,
           d.total_cents - d.amount_paid_cents AS balance_cents
    FROM ${table} d
    JOIN ${partyTable} p ON p.id = d.${partyColumn}
    WHERE d.status = '${statusValue}' AND d.total_cents > d.amount_paid_cents
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

function dailySales(db, from, to) {
  const start = dateISO(from, 'From date');
  const end = dateISO(to, 'To date');
  const today = todayISO();

  const rows = db.prepare(`
    SELECT i.id, i.number, i.issue_date, i.status, i.subtotal_cents, i.tax_cents,
           i.total_cents, i.amount_paid_cents, i.booking_id, i.visa_id,
           c.name AS customer_name,
           b.number AS booking_number, b.destination,
           b.cost_total_cents AS booking_cost_cents,
           v.number AS visa_number, v.destination_country, v.visa_type,
           v.applicant_name, v.cost_total_cents AS visa_cost_cents,
           (SELECT ii.description FROM invoice_items ii
            WHERE ii.invoice_id = i.id
            ORDER BY ii.sort_order, ii.id LIMIT 1) AS particulars
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN bookings b ON b.id = i.booking_id
    LEFT JOIN visa_applications v ON v.id = i.visa_id
    WHERE i.status = 'sent' AND i.issue_date >= ? AND i.issue_date <= ?
    ORDER BY i.issue_date, i.id
  `).all(start, end);

  const days = [];
  const totals = {
    invoice_count: 0,
    sale_cents: 0,
    tax_cents: 0,
    cost_cents: 0,
    margin_cents: 0,
    paid_cents: 0,
    balance_cents: 0,
  };

  let day = null;
  for (const row of rows) {
    const kind = row.booking_id ? 'booking' : row.visa_id ? 'visa' : 'direct';
    const cost = kind === 'booking'
      ? (row.booking_cost_cents || 0)
      : kind === 'visa'
        ? (row.visa_cost_cents || 0)
        : 0;
    const sale = row.subtotal_cents;
    let particulars = row.particulars || '';
    if (!particulars && kind === 'booking') particulars = row.destination || '';
    if (!particulars && kind === 'visa') {
      const type = row.visa_type ? row.visa_type.charAt(0).toUpperCase() + row.visa_type.slice(1) : '';
      particulars = [row.destination_country, type ? `${type} visa` : ''].filter(Boolean).join(' · ');
    }

    const item = {
      id: row.id,
      number: row.number,
      issue_date: row.issue_date,
      customer_name: row.customer_name,
      kind,
      reference: row.booking_number || row.visa_number || null,
      reference_id: row.booking_id || row.visa_id || null,
      particulars,
      sale_cents: sale,
      tax_cents: row.tax_cents,
      cost_cents: cost,
      margin_cents: sale - cost,
      paid_cents: row.amount_paid_cents,
      balance_cents: Math.max(0, row.total_cents - row.amount_paid_cents),
      status_display: invoiceDisplayStatus(row, today),
    };

    if (!day || day.date !== row.issue_date) {
      day = {
        date: row.issue_date,
        invoice_count: 0,
        sale_cents: 0,
        tax_cents: 0,
        cost_cents: 0,
        margin_cents: 0,
        paid_cents: 0,
        balance_cents: 0,
        rows: [],
      };
      days.push(day);
    }

    day.rows.push(item);
    day.invoice_count += 1;
    totals.invoice_count += 1;
    for (const key of ['sale_cents', 'tax_cents', 'cost_cents', 'margin_cents', 'paid_cents', 'balance_cents']) {
      day[key] += item[key];
      totals[key] += item[key];
    }
  }

  totals.margin_percent = totals.sale_cents ? (totals.margin_cents / totals.sale_cents) * 100 : 0;

  const cash = cashBalances(db, end);
  const cashDates = [...cash.byDate.keys()].sort();
  let cashIndex = 0;
  let runningCash = 0;
  let runningBank = 0;
  for (const day of days) {
    while (cashIndex < cashDates.length && cashDates[cashIndex] <= day.date) {
      const balance = cash.byDate.get(cashDates[cashIndex]);
      runningCash = balance.cash_cents;
      runningBank = balance.bank_cents;
      cashIndex += 1;
    }
    day.cash_cents = runningCash;
    day.bank_cents = runningBank;
  }

  return {
    from: start,
    to: end,
    days,
    totals,
    cash: {
      cash_cents: cash.cash_cents,
      bank_cents: cash.bank_cents,
      cash_label: cash.cash_label,
      bank_label: cash.bank_label,
    },
  };
}

function dashboard(db) {
  const today = todayISO();
  const { start, end } = monthRange(today);
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();

  const typeTotal = (type, from, to) => {
    const row = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN a.type = 'revenue' THEN l.credit_cents - l.debit_cents
                               ELSE l.debit_cents - l.credit_cents END), 0) AS total
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      JOIN accounts a ON a.id = l.account_id
      WHERE a.type = ? AND e.entry_date >= ? AND e.entry_date <= ?
    `).get(type, from, to);
    return row.total;
  };

  const revenueMtd = typeTotal('revenue', start, end);
  const expensesMtd = typeTotal('expense', start, end);

  const cashRow = db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.is_cash = 1
  `).get();
  const cashOnlyRow = db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.code = '1000'
  `).get();
  const bankOnlyRow = db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.is_cash = 1 AND a.code <> '1000'
  `).get();

  const ar = db.prepare(`
    SELECT COALESCE(SUM(total_cents - amount_paid_cents), 0) AS total, COUNT(*) AS count
    FROM invoices WHERE status = 'sent' AND total_cents > amount_paid_cents
  `).get();
  const ap = db.prepare(`
    SELECT COALESCE(SUM(total_cents - amount_paid_cents), 0) AS total, COUNT(*) AS count
    FROM bills WHERE status = 'received' AND total_cents > amount_paid_cents
  `).get();

  const overdueAr = db.prepare(`
    SELECT COALESCE(SUM(total_cents - amount_paid_cents), 0) AS total
    FROM invoices WHERE status = 'sent' AND total_cents > amount_paid_cents AND due_date < ?
  `).get(today);
  const overdueAp = db.prepare(`
    SELECT COALESCE(SUM(total_cents - amount_paid_cents), 0) AS total
    FROM bills WHERE status = 'received' AND total_cents > amount_paid_cents AND due_date < ?
  `).get(today);

  const currentMonthStart = start;
  const chartMonths = [];
  for (let i = 5; i >= 0; i -= 1) {
    const monthStart = shiftMonth(currentMonthStart, -i);
    const month = monthStart.slice(0, 7);
    chartMonths.push({ month, start: monthStart, end: monthRange(monthStart).end, revenue_cents: 0, expense_cents: 0 });
  }
  const firstMonth = chartMonths[0].start;
  const trendRows = db.prepare(`
    SELECT substr(e.entry_date, 1, 7) AS month,
      COALESCE(SUM(CASE WHEN a.type = 'revenue' THEN l.credit_cents - l.debit_cents ELSE 0 END), 0) AS revenue_cents,
      COALESCE(SUM(CASE WHEN a.type = 'expense' THEN l.debit_cents - l.credit_cents ELSE 0 END), 0) AS expense_cents
    FROM journal_entries e
    JOIN journal_lines l ON l.entry_id = e.id
    JOIN accounts a ON a.id = l.account_id
    WHERE e.entry_date >= ? AND e.entry_date <= ? AND a.type IN ('revenue', 'expense')
    GROUP BY month
    ORDER BY month
  `).all(firstMonth, end);
  const trendMap = new Map(trendRows.map((row) => [row.month, row]));
  for (const item of chartMonths) {
    const found = trendMap.get(item.month);
    if (found) {
      item.revenue_cents = found.revenue_cents;
      item.expense_cents = found.expense_cents;
    }
  }

  const expenseBreakdown = db.prepare(`
    SELECT a.id, a.code, a.name, SUM(l.debit_cents - l.credit_cents) AS amount_cents
    FROM accounts a
    JOIN journal_lines l ON l.account_id = a.id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE a.type = 'expense' AND e.entry_date >= ? AND e.entry_date <= ?
    GROUP BY a.id
    HAVING amount_cents > 0
    ORDER BY amount_cents DESC
    LIMIT 6
  `).all(start, end);

  const recentInvoices = db.prepare(`
    SELECT i.*, c.name AS customer_name
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    ORDER BY i.issue_date DESC, i.id DESC LIMIT 5
  `).all().map((row) => ({
    ...row,
    status_display: invoiceDisplayStatus(row, today),
    balance_cents: Math.max(0, row.total_cents - row.amount_paid_cents),
  }));

  const recentBills = db.prepare(`
    SELECT b.*, v.name AS vendor_name
    FROM bills b JOIN vendors v ON v.id = b.vendor_id
    ORDER BY b.bill_date DESC, b.id DESC LIMIT 5
  `).all().map((row) => ({
    ...row,
    status_display: billDisplayStatus(row, today),
    balance_cents: Math.max(0, row.total_cents - row.amount_paid_cents),
  }));

  const recentBookings = db.prepare(`
    SELECT b.*, c.name AS customer_name
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    ORDER BY b.booking_date DESC, b.id DESC LIMIT 5
  `).all();

  const recentVisas = db.prepare(`
    SELECT v.*, c.name AS customer_name
    FROM visa_applications v JOIN customers c ON c.id = v.customer_id
    ORDER BY v.application_date DESC, v.id DESC LIMIT 5
  `).all();

  const recentTopups = db.prepare(`
    SELECT t.*, p.name AS portal_name, p.settlement AS portal_settlement
    FROM portal_topups t JOIN supplier_portals p ON p.id = t.portal_id
    ORDER BY t.topup_date DESC, t.id DESC LIMIT 5
  `).all();

  const counts = {
    customers: db.prepare('SELECT COUNT(*) AS c FROM customers WHERE is_active = 1').get().c,
    vendors: db.prepare('SELECT COUNT(*) AS c FROM vendors WHERE is_active = 1').get().c,
    invoices: db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c,
    bills: db.prepare('SELECT COUNT(*) AS c FROM bills').get().c,
    bookings: db.prepare('SELECT COUNT(*) AS c FROM bookings').get().c,
    visas: db.prepare('SELECT COUNT(*) AS c FROM visa_applications').get().c,
    portals: db.prepare('SELECT COUNT(*) AS c FROM supplier_portals').get().c,
  };

  return {
    as_of: today,
    period: { start, end },
    currency: settings.currency,
    revenue_mtd_cents: revenueMtd,
    expenses_mtd_cents: expensesMtd,
    net_income_mtd_cents: revenueMtd - expensesMtd,
    cash_cents: cashRow.total,
    cash_only_cents: cashOnlyRow.total,
    bank_cents: bankOnlyRow.total,
    ar_outstanding_cents: ar.total,
    ar_count: ar.count,
    ap_outstanding_cents: ap.total,
    ap_count: ap.count,
    overdue_ar_cents: overdueAr.total,
    overdue_ap_cents: overdueAp.total,
    chart: chartMonths,
    expense_breakdown: expenseBreakdown,
    recent_invoices: recentInvoices,
    recent_bills: recentBills,
    recent_bookings: recentBookings,
    recent_visas: recentVisas,
    recent_topups: recentTopups,
    bookings: bookingService.bookingStats(db, start, end),
    visas: visaService.visaStats(db, start, end),
    portals: portalService.portalStats(db),
    compliance: complianceService.complianceStats(db),
    counts,
  };
}

module.exports = {
  trialBalance,
  incomeStatement,
  balanceSheet,
  arAging,
  apAging,
  dailySales,
  dashboard,
};
