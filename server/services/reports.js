'use strict';

const financials = require('./reports/financials');
const aging = require('./reports/aging');
const daily = require('./reports/daily-sales');
const dashboard = require('./reports/dashboard');

module.exports = {
  trialBalance: financials.trialBalance,
  incomeStatement: financials.incomeStatement,
  balanceSheet: financials.balanceSheet,
  arAging: aging.arAging,
  apAging: aging.apAging,
  dailySales: daily.dailySales,
  dashboard: dashboard.dashboard,
};
