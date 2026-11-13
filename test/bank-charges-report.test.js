'use strict';

// Bank charges report: every charge in 6700 Bank Charges and 6710 Card &
// Payment Link Fees, read from the ledger, with what it was on. Card and
// payment-link fees go to 6710, and each card payment shows its share of the
// settlement's fee.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-bank-charges-report-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const advances = require('../server/services/advances');
const portals = require('../server/services/portals');
const cards = require('../server/services/card-settlements');
const journal = require('../server/services/journal');
const { bankChargesReport } = require('../server/services/reports/bank-charges');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const moved = (code, from, to) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS n
  FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
  WHERE a.code = ? AND e.entry_date BETWEEN ? AND ?
`).get(code, from, to).n;
const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Fee Customer')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Fee Supplier')").run().lastInsertRowid);
const invoice = (amount) => invoices.createInvoice(db, {
  customer_id: customerId, issue_date: '2026-11-01', due_date: '2026-11-01', status: 'sent',
  items: [{ description: 'Service', quantity: 1, unit_price_cents: amount, account_id: account('4300').id }],
});

test('card and payment-link fees have their own account, 6710', () => {
  const fees = account('6710');
  assert.deepEqual([fees.name, fees.type], ['Card & Payment Link Fees', 'expense']);
  const card = invoice(10_000);
  invoices.recordInvoicePayment(db, card.id, { amount_cents: 10_000, payment_date: '2026-11-02', method: 'Payment link', deposit_account_id: account('1030').id });
  const item = cards.getCardSettlements(db).items[0];
  cards.createSettlement(db, { line_ids: [item.id], net_cents: 9_700, bank_account_id: account('1010').id, settlement_date: '2026-11-03' });
  assert.equal(moved('6710', '2026-11-01', '2026-11-30'), 300, 'the gateway fee');
  assert.equal(moved('6700', '2026-11-01', '2026-11-30'), 0, 'not in bank charges');
});

test('every kind of charge is listed with what it was on; voids drop out; totals match the ledger', () => {
  const a = invoice(50_000);
  invoices.recordInvoicePayment(db, a.id, { amount_cents: 50_000, payment_date: '2026-11-04', deposit_account_id: account('1010').id, bank_charges_cents: 1_500 });
  const b = invoice(20_000);
  advances.receivePayment(db, { customer_id: customerId, amount_cents: 20_000, receipt_date: '2026-11-05', deposit_account_id: account('1010').id, bank_charges_cents: 700 });
  const bill = bills.createBill(db, {
    vendor_id: vendorId, bill_date: '2026-11-05', due_date: '2026-11-05', status: 'received',
    items: [{ description: 'Fare', quantity: 1, unit_price_cents: 30_000, account_id: account('5000').id }],
  });
  bills.recordBillPayment(db, bill.id, { amount_cents: 30_000, payment_date: '2026-11-06', payment_account_id: account('1010').id, bank_charges_cents: 1_050 });
  const portal = portals.createPortal(db, { name: 'Fee Portal', portal_type: 'consolidator', settlement: 'prepaid', vendor_id: vendorId });
  portals.topUp(db, { portal_id: portal.id, amount_cents: 40_000, topup_date: '2026-11-07', deposit_account_id: account('1010').id, bank_charges_cents: 400 });
  require('../server/services/bank-reconciliations').recordBankCharge(db, { account_id: account('1010').id, amount_cents: 9_900, charge_date: '2026-11-08', description: 'Monthly fee' });
  db.transaction(() => journal.createManualEntry(db, {
    entry_date: '2026-11-09', memo: 'Cheque book',
    lines: [{ account_id: account('6700').id, debit_cents: 250, credit_cents: 0 }, { account_id: account('1010').id, debit_cents: 0, credit_cents: 250 }],
  }))();
  // A payment with a charge, voided in the same month: neither the charge nor its undoing is listed.
  const c = invoice(5_000);
  const voided = invoices.recordInvoicePayment(db, c.id, { amount_cents: 5_000, payment_date: '2026-11-10', deposit_account_id: account('1010').id, bank_charges_cents: 999 });
  invoices.deleteInvoicePayment(db, voided.payments[0].id, { remarks: 'Bounced' });

  const report = bankChargesReport(db, '2026-11-01', '2026-11-30');
  const kinds = report.rows.map((row) => [row.kind, row.amount_cents]);
  assert.deepEqual(kinds, [
    ['card_fee', 300], ['payment', 1_500], ['receipt', 700], ['bill_payment', 1_050], ['portal_topup', 400], ['bank_fee', 9_900], ['journal', 250],
  ]);
  assert.ok(!report.rows.some((row) => row.amount_cents === 999 || row.amount_cents === -999), 'a charge voided in the period is left out');
  const card = report.rows.find((row) => row.kind === 'card_fee');
  assert.match(card.detail, /1 payment/);
  assert.match(card.detail, /3\.00%/);
  assert.equal(report.rows.find((row) => row.kind === 'payment').document.number, a.number);
  assert.equal(report.rows.find((row) => row.kind === 'bank_fee').party, 'Bank Account (bank debits)');
  assert.equal(report.totals.total_cents, 14_100);
  assert.equal(report.totals.total_cents, moved('6700', '2026-11-01', '2026-11-30') + moved('6710', '2026-11-01', '2026-11-30'), 'the same as the ledger');
  assert.equal(report.totals.by_kind.card_fee, 300);
  assert.equal(b.number.length > 0, true);
});

test('a payment-link payment shows the settlement it went into and its share of the fee', () => {
  const x = invoice(30_000);
  const y = invoice(10_000);
  invoices.recordInvoicePayment(db, x.id, { amount_cents: 30_000, payment_date: '2026-11-11', method: 'Payment link', deposit_account_id: account('1030').id });
  invoices.recordInvoicePayment(db, y.id, { amount_cents: 10_000, payment_date: '2026-11-11', method: 'Credit card', deposit_account_id: account('1030').id });
  const items = cards.getCardSettlements(db).items.map((item) => item.id);
  const settlement = cards.createSettlement(db, { line_ids: items, net_cents: 39_000, bank_account_id: account('1010').id, settlement_date: '2026-11-12' });
  const share = (id) => invoices.getInvoice(db, id).payments[0].card_settlement;
  assert.deepEqual(share(x.id), { id: settlement.id, number: settlement.number, fee_share_cents: 750 });
  assert.deepEqual(share(y.id), { id: settlement.id, number: settlement.number, fee_share_cents: 250 });
});
