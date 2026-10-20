'use strict';

const router = require('express').Router();
const db = require('../db');
const { dateISO, todayISO, monthRange } = require('../util');
const reports = require('../services/reports');
const bookings = require('../services/bookings');
const visas = require('../services/visas');
const portals = require('../services/portals');

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

module.exports = router;
