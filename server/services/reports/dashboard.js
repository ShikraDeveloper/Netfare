'use strict';

const { todayISO, monthRange, shiftMonth } = require('../../util');
const { invoiceDisplayStatus, billDisplayStatus } = require('../../accounting');
const bookingService = require('../bookings');
const visaService = require('../visas');
const portalService = require('../portals');
const complianceService = require('../compliance');

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
    SELECT COALESCE(SUM(total_cents - amount_paid_cents - credit_applied_cents), 0) AS total, COUNT(*) AS count
    FROM invoices WHERE status = 'sent' AND total_cents > amount_paid_cents + credit_applied_cents
  `).get();
  const ap = db.prepare(`
    SELECT COALESCE(SUM(total_cents - amount_paid_cents), 0) AS total, COUNT(*) AS count
    FROM bills WHERE status = 'received' AND total_cents > amount_paid_cents
  `).get();

  const overdueAr = db.prepare(`
    SELECT COALESCE(SUM(total_cents - amount_paid_cents - credit_applied_cents), 0) AS total
    FROM invoices
    WHERE status = 'sent' AND total_cents > amount_paid_cents + credit_applied_cents AND due_date < ?
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
    balance_cents: Math.max(0, row.total_cents - row.amount_paid_cents - (row.credit_applied_cents || 0)),
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


module.exports = { dashboard };
