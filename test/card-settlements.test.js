'use strict';

// Card and payment link money: received into 1030 Card & Payment Link
// Clearing, settled into the bank in a batch less the gateway fee.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-card-settlements-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const cards = require('../server/services/card-settlements');
const cashDeposits = require('../server/services/cash-deposits');
const reconciliation = require('../server/services/reconciliation');

const account = (code) => db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
const balance = (code) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
`).get(code).total;
const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Card Customer')").run().lastInsertRowid);

function cardPayment(amount, method = 'Credit card', date = '2026-10-10') {
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId, issue_date: '2026-10-01', status: 'sent',
    items: [{ description: 'Ticket', quantity: 1, unit_price_cents: amount, account_id: account('4300').id }],
  });
  return invoiceService.recordInvoicePayment(db, invoice.id, {
    amount_cents: amount, payment_date: date, method, deposit_account_id: account('1030').id,
  });
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('1030 is a cash-type clearing account kept out of the bank total', () => {
  assert.equal(account('1030').name, 'Card & Payment Link Clearing');
  cardPayment(10_000);
  const balances = cashDeposits.cashBalances(db);
  assert.equal(balances.card_clearing_cents, 10_000);
  assert.equal(balances.bank_balance_cents, 0);
});

test('a payout settles chosen items: bank gets the net, the fee goes to 6700', () => {
  cardPayment(50_000, 'Payment link', '2026-10-11');
  cardPayment(20_000, 'Credit card', '2026-10-12');
  const before = cards.getCardSettlements(db);
  assert.equal(before.in_transit_cents, 80_000);
  assert.equal(before.open_total_cents, 80_000);
  const chosen = before.items.filter((item) => item.entry_date >= '2026-10-11');
  assert.equal(chosen.length, 2);

  assert.throws(
    () => cards.createSettlement(db, { line_ids: chosen.map((i) => i.id), net_cents: 70_001, bank_account_id: account('1010').id }),
    (error) => error.status === 400 && /more than the items/.test(error.message),
  );
  assert.throws(
    () => cards.createSettlement(db, { line_ids: chosen.map((i) => i.id), net_cents: 68_000, bank_account_id: account('1010').id, settlement_date: '2026-10-11' }),
    (error) => error.status === 400 && /before the last item/.test(error.message),
  );
  const settlement = cards.createSettlement(db, {
    line_ids: chosen.map((i) => i.id), net_cents: 68_250, bank_account_id: account('1010').id, settlement_date: '2026-10-14',
  });
  assert.match(settlement.number, /^CS-2026-/);
  assert.deepEqual([settlement.gross_cents, settlement.fee_cents, settlement.net_cents], [70_000, 1_750, 68_250]);
  assert.equal(balance('1010'), 68_250);
  assert.equal(balance('6700'), 1_750);
  assert.equal(balance('1030'), 10_000, 'the first card payment still waits');
  const after = cards.getCardSettlements(db);
  assert.equal(after.items.length, 1);
  assert.equal(after.open_total_cents, after.in_transit_cents);
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);

  assert.throws(
    () => cards.createSettlement(db, { line_ids: [chosen[0].id], net_cents: 1, bank_account_id: account('1010').id }),
    (error) => error.status === 400 && /already settled/.test(error.message),
  );
});

test('settled card money cannot be voided until the settlement is voided; voids drop out of the list', () => {
  const settlement = db.prepare("SELECT * FROM card_settlements WHERE status = 'posted'").get();
  const settledPayment = db.prepare(`
    SELECT p.* FROM payments p JOIN journal_lines l ON l.entry_id = p.journal_entry_id
    JOIN card_settlement_lines sl ON sl.journal_line_id = l.id WHERE sl.settlement_id = ? LIMIT 1
  `).get(settlement.id);
  assert.throws(
    () => invoiceService.deleteInvoicePayment(db, settledPayment.id, { remarks: 'Chargeback' }),
    (error) => error.status === 400 && /card settlement CS-/.test(error.message),
  );
  cards.voidSettlement(db, settlement.id, { remarks: 'Wrong payout' });
  assert.equal(balance('1010'), 0);
  assert.equal(cards.getCardSettlements(db).items.length, 3, 'items wait again');
  invoiceService.deleteInvoicePayment(db, settledPayment.id, { remarks: 'Chargeback' });
  const data = cards.getCardSettlements(db);
  assert.equal(data.items.length, 2, 'the voided payment is not offered');
  assert.equal(data.open_total_cents, data.in_transit_cents);
});

test('1030 is a control account and an invoice can carry a payment link', () => {
  const { assertManualEntryAccounts } = require('../server/accounting');
  assert.throws(() => assertManualEntryAccounts(db, [{ account_id: account('1030').id }]), /control account 1030/);
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId, issue_date: '2026-10-20', status: 'sent',
    items: [{ description: 'Service', quantity: 1, unit_price_cents: 30_000, account_id: account('4300').id }],
  });
  const linked = invoiceService.setPaymentLink(db, invoice.id, { payment_link: 'https://pay.example.com/abc123' });
  assert.equal(linked.payment_link, 'https://pay.example.com/abc123');
  assert.throws(
    () => invoiceService.setPaymentLink(db, invoice.id, { payment_link: 'http://not-secure.example.com' }),
    (error) => error.status === 400 && /https:\/\//.test(error.message),
  );
  assert.equal(invoiceService.setPaymentLink(db, invoice.id, { payment_link: '' }).payment_link, '');
});
