'use strict';

const { lockBalance } = require('./portals/common');
const lifecycle = require('./portals/lifecycle');
const money = require('./portals/transactions');
const ledger = require('./portals/ledger');

module.exports = {
  listPortals: lifecycle.listPortals,
  getPortal: lifecycle.getPortal,
  createPortal: lifecycle.createPortal,
  updatePortal: lifecycle.updatePortal,
  deletePortal: lifecycle.deletePortal,
  topUp: money.topUp,
  voidTopup: money.voidTopup,
  voidPortalRefund: money.voidPortalRefund,
  voidPortalCredit: money.voidPortalCredit,
  refundPortal: money.refundPortal,
  settleBillFromPortal: money.settleBillFromPortal,
  autoSettleBill: money.autoSettleBill,
  recordPortalCredit: money.recordPortalCredit,
  portalForVendor: lifecycle.portalForVendor,
  portalReport: lifecycle.portalReport,
  portalStats: lifecycle.portalStats,
  portalLedger: ledger.portalLedger,
  lockBalance,
};
