'use strict';

const router = require('express').Router();
const db = require('../db');
const { dateISO, todayISO, monthRange } = require('../util');
const reports = require('../services/reports');
const bookings = require('../services/bookings');
const visas = require('../services/visas');
const portals = require('../services/portals');
const reconciliation = require('../services/reconciliation');

router.get('/dashboard', (req, res) => {
  res.json(reports.dashboard(db));
});

router.get('/portals', (req, res) => {
  res.json(portals.portalReport(db));
});

router.get('/bookings', (req, res) => {
  const { start, end } = monthRange(todayISO());
  res.json(bookings.bookingMarginReport(db, req.query.from || start, req.query.to || end));
});

router.get('/visas', (req, res) => {
  const { start, end } = monthRange(todayISO());
  res.json(visas.visaMarginReport(db, req.query.from || start, req.query.to || end));
});

router.get('/daily-sales', (req, res) => {
  const { start, end } = monthRange(todayISO());
  res.json(reports.dailySales(db, req.query.from || start, req.query.to || end));
});

// Deposit register: every visa security deposit, what is still held and
// which ones need attention.
router.get('/visa-deposits', (req, res) => {
  const today = todayISO();
  const ageDays = (date) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  const rows = require('../services/visa-deposits').listDeposits(db, { search: req.query.search })
    .filter((row) => !row.voided_at && (req.query.status === 'all' || row.held_cents > 0))
    .map((row) => {
      const age = ageDays(row.deposit_date);
      let flag = '';
      if (row.held_cents > 0 && ['cancelled', 'rejected'].includes(row.visa_status)) flag = 'refund_due';
      else if (row.held_cents > 0 && age > 90) flag = 'old';
      const { events, ...rest } = row;
      return { ...rest, age_days: age, flag };
    });
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  res.json({
    as_of: today,
    status: req.query.status === 'all' ? 'all' : 'open',
    rows,
    totals: {
      collected_cents: sum('collected_cents'),
      held_cents: sum('held_cents'),
      with_supplier_cents: sum('with_supplier_cents'),
      in_hand_cents: sum('in_hand_cents'),
      refunded_cents: sum('refunded_cents'),
      forfeited_cents: sum('forfeited_cents'),
      refund_due_count: rows.filter((row) => row.flag === 'refund_due').length,
    },
  });
});

router.get('/trial-balance', (req, res) => {
  res.json(reports.trialBalance(db, req.query.as_of || todayISO()));
});

router.get('/income-statement', (req, res) => {
  const { start, end } = monthRange(todayISO());
  res.json(reports.incomeStatement(db, req.query.from || start, req.query.to || end));
});

router.get('/balance-sheet', (req, res) => {
  res.json(reports.balanceSheet(db, req.query.as_of || todayISO()));
});

router.get('/ar-aging', (req, res) => {
  res.json(reports.arAging(db, req.query.as_of));
});

router.get('/ap-aging', (req, res) => {
  res.json(reports.apAging(db, req.query.as_of));
});

router.get('/reconciliation', (req, res) => {
  res.json(reconciliation.reconciliationSummary(db));
});

module.exports = router;
