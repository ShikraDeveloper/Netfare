'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-dsr-sections-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const visaService = require('../server/services/visas');
const invoiceService = require('../server/services/invoices');
const billService = require('../server/services/bills');
const advanceService = require('../server/services/advances');
const cancellationService = require('../server/services/cancellations');
const { dailySales } = require('../server/services/reports/daily-sales');
const { modeOf } = require('../server/services/reports/dsr-sections');
const visaDeposits = require('../server/services/visa-deposits');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

const DAY = '2026-11-10';
const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Counter Customer')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Counter Airline')").run().lastInsertRowid);

function pay(invoiceId, cents, method, accountCode = method === 'Cash' ? '1000' : '1010', date = DAY) {
  return invoiceService.recordInvoicePayment(db, invoiceId, {
    amount_cents: cents, payment_date: date, deposit_account_id: account(accountCode).id, method,
  });
}

const pax = (name, group, extra) => ({ description: name, passenger_name: name, line_group: group, quantity: 1, ...extra });

// One ticket booking with two passengers and a service fee, paid in cash and by card.
const ticket = bookingService.confirmBooking(db, bookingService.createBooking(db, {
  customer_id: customerId,
  booking_date: DAY,
  due_date: DAY,
  destination: 'Dubai–London',
  pnr: 'CTR001',
  sale_items: [
    pax('Ali', 1, { unit_price_cents: 200_000, account_id: account('4000').id }),
    pax('Sara', 2, { unit_price_cents: 200_000, account_id: account('4000').id }),
    { description: 'Service fee', quantity: 1, unit_price_cents: 6_000, account_id: account('4300').id },
  ],
  cost_items: [
    pax('Ali', 1, { unit_price_cents: 180_000, account_id: account('5000').id, vendor_id: vendorId, supplier_ref: '176-1' }),
    pax('Sara', 2, { unit_price_cents: 180_000, account_id: account('5000').id, vendor_id: vendorId, supplier_ref: '176-2' }),
  ],
}).id);
pay(ticket.invoice_id, 300_000, 'Cash');
pay(ticket.invoice_id, 6_000, 'Credit card');

// A visa paid by bank transfer.
const visa = visaService.submitVisa(db, visaService.createVisa(db, {
  customer_id: customerId,
  application_date: DAY,
  destination_country: 'France',
  applicant_is_customer: false,
  applicant_name: 'Omar',
  sale_items: [
    { description: 'Schengen visa', quantity: 1, unit_price_cents: 40_000, account_id: account('4320').id },
    { description: 'Processing', quantity: 1, unit_price_cents: 5_000, account_id: account('4300').id },
  ],
}).id);
pay(visa.invoice_id, 45_000, 'Bank transfer');

// A service invoice left on credit.
const service = invoiceService.createInvoice(db, {
  customer_id: customerId,
  issue_date: DAY,
  items: [{ description: 'Meet and assist', quantity: 1, unit_price_cents: 15_000, account_id: account('4300').id }],
});

// An older invoice paid today, and an advance received today.
const older = invoiceService.createInvoice(db, {
  customer_id: customerId,
  issue_date: '2026-11-01',
  items: [{ description: 'Old service', quantity: 1, unit_price_cents: 20_000, account_id: account('4300').id }],
});
pay(older.id, 20_000, 'Cash');
advanceService.createAdvance(db, {
  customer_id: customerId, amount_cents: 50_000, advance_date: DAY, deposit_account_id: account('1010').id, method: 'Bank transfer',
});

// The airline is paid from the bank.
billService.recordBillPayment(db, ticket.bills[0].id, {
  amount_cents: 360_000, payment_date: DAY, payment_account_id: account('1010').id, method: 'Bank transfer',
});

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const report = () => dailySales(db, DAY, DAY).sections;

test('payment methods map to cash, card, bank and other', () => {
  assert.deepEqual(['Cash', 'Credit card', 'Bank transfer', 'Cheque', 'Other', ''].map(modeOf),
    ['cash', 'card', 'bank', 'bank', 'other', 'other']);
});

test('a ticket sale lists its passengers with ticket numbers, fare, fee and how it was paid', () => {
  const [row] = report().tickets;
  assert.equal(row.id, ticket.invoice_id);
  assert.equal(row.pnr, 'CTR001');
  assert.equal(row.route, 'Dubai–London');
  assert.deepEqual(row.passengers, [{ name: 'Ali', ticket_no: '176-1' }, { name: 'Sara', ticket_no: '176-2' }]);
  assert.deepEqual([row.fare_cents, row.fee_cents, row.total_cents], [400_000, 6_000, 406_000]);
  assert.deepEqual(row.split, { cash: 300_000, card: 6_000, bank: 0, other: 0, credit: 100_000 });
  assert.deepEqual([row.cost_cents, row.margin_cents], [360_000, 46_000]);
});

test('visa and service sales sit in their own sections', () => {
  const sections = report();
  assert.equal(sections.visas.length, 1);
  assert.deepEqual(
    [sections.visas[0].applicant_name, sections.visas[0].country, sections.visas[0].fare_cents, sections.visas[0].fee_cents],
    ['Omar', 'France', 40_000, 5_000],
  );
  assert.deepEqual(sections.visas[0].split, { cash: 0, card: 0, bank: 45_000, other: 0, credit: 0 });
  assert.equal(sections.services.length, 1);
  assert.equal(sections.services[0].id, service.id);
  assert.equal(sections.services[0].split.credit, 15_000);
});

test('money for older invoices and advances is listed separately', () => {
  const rows = report().collections;
  assert.deepEqual(rows.map((row) => [row.kind, row.mode, row.amount_cents]), [
    ['payment', 'cash', 20_000],
    ['advance', 'bank', 50_000],
  ]);
});

test('cash and bank reconcile: opening + in − out = closing, and receipts match the sections', () => {
  const sections = report();
  const { position, settlement, collected } = sections.summary;
  assert.equal(position.cash.in_cents, settlement.cash + collected.cash);
  assert.equal(position.bank.in_cents, settlement.bank + settlement.card + collected.bank, 'card receipts land in the bank account here');
  for (const key of ['cash', 'bank']) {
    const p = position[key];
    assert.equal(p.closing_cents, p.opening_cents + p.in_cents - p.out_cents);
  }
  assert.deepEqual(sections.cash_out.map((row) => [row.label, row.bank_out_cents]), [['Supplier payments', 360_000]]);
  assert.deepEqual(sections.summary.sales, {
    tickets_cents: 406_000, visas_cents: 45_000, services_cents: 15_000, cancellations_cents: 0, total_cents: 466_000,
  });
});

test('a cancellation and its refund appear in section E on the cancellation day', () => {
  const later = '2026-11-12';
  const cancellation = cancellationService.cancelSource(db, {
    sourceType: 'visa', sourceId: visa.id, finalStatus: 'cancelled',
    payload: { cancellation_date: later, customer_charges_cents: 5_000 },
  });
  cancellationService.refundCancellation(db, cancellation.id, {
    refund_date: later, method: 'Cash', account_id: account('1000').id,
  });
  const sections = dailySales(db, later, later).sections;
  assert.equal(sections.cancellations.length, 1);
  assert.deepEqual(
    [sections.cancellations[0].reversed_sale_cents, sections.cancellations[0].charges_cents, sections.cancellations[0].sale_cents],
    [45_000, 5_000, -40_000],
  );
  assert.deepEqual(sections.refunds.map((row) => [row.amount_cents, row.mode, row.against]), [[40_000, 'cash', `Cancellation ${cancellation.number}`]]);
  assert.equal(sections.summary.refunds_cents, 40_000);
  assert.ok(sections.cash_out.some((row) => row.cash_out_cents === 40_000));
  const saleDay = dailySales(db, DAY, DAY).sections.visas[0];
  assert.equal(saleDay.cancelled_by, null, 'the sale-day report reads as it did before the cancellation');
  const covering = dailySales(db, DAY, later).sections.visas[0];
  assert.equal(covering.cancelled_by.number, cancellation.number, 'a report covering the cancellation marks it cancelled');
  assert.equal(covering.split.credit, 0);
});

test('a second bank account counts in the DSR bank figures', () => {
  const day = '2026-11-13';
  const second = Number(db.prepare("INSERT INTO accounts (code, name, type, subtype, normal_balance, is_cash, is_system) VALUES ('1011', 'Second Bank', 'asset', 'current_asset', 'debit', 1, 0)").run().lastInsertRowid);
  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId, issue_date: day, due_date: day, status: 'sent',
    items: [{ description: 'Second bank sale', quantity: 1, unit_price_cents: 7_000, account_id: account('4300').id }],
  });
  invoiceService.recordInvoicePayment(db, invoice.id, { amount_cents: 7_000, payment_date: day, method: 'Bank transfer', deposit_account_id: second });
  const { position, settlement } = dailySales(db, day, day).sections.summary;
  assert.equal(position.bank.in_cents, settlement.bank, 'the second bank receipt is in Bank');
  assert.equal(position.bank.in_cents, 7_000);
  assert.equal(position.bank.label, 'Bank accounts');
  assert.equal(position.bank.closing_cents, position.bank.opening_cents + position.bank.in_cents - position.bank.out_cents);
});

test('suppliers and wallets at the end of the day: only those with a balance, as on their statements', () => {
  const statements = require('../server/services/statements');
  const portals = require('../server/services/portals');
  const quiet = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Zero Supplier')").run().lastInsertRowid);
  const walletVendor = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Wallet Consolidator')").run().lastInsertRowid);
  const wallet = portals.createPortal(db, { name: 'Wallet', portal_type: 'consolidator', settlement: 'prepaid', vendor_id: walletVendor });
  portals.topUp(db, { portal_id: wallet.id, amount_cents: 50_000, topup_date: DAY, deposit_account_id: account('1010').id, method: 'Bank transfer' });

  const parties = dailySales(db, DAY, DAY).sections.parties;
  assert.ok(!parties.some((row) => row.id === quiet), 'a supplier at 0.00 is left out');
  const held = parties.find((row) => row.id === walletVendor);
  assert.deepEqual([held.kind, held.balance_cents], ['Wallet', -50_000], 'money of ours in the wallet is a minus');
  for (const row of parties) {
    assert.equal(row.balance_cents, statements.vendorStatement(db, row.id, { to: DAY }).closing_balance_cents, row.name);
  }
});

test('a sale cancelled before it was paid: the unpaid part is in no column, and every row adds up', () => {
  const later = '2026-11-14';
  cancellationService.cancelSource(db, { sourceType: 'booking', sourceId: ticket.id, finalStatus: 'cancelled', payload: { cancellation_date: later } });
  const sections = dailySales(db, DAY, later).sections;
  const row = sections.tickets.find((r) => r.id === ticket.invoice_id);
  assert.deepEqual([row.split.credit, row.unpaid_cancelled_cents], [0, 100_000], '406,000 sold, 306,000 paid, the rest cancelled');
  for (const sale of [...sections.tickets, ...sections.visas, ...sections.services]) {
    const columns = ['cash', 'card', 'bank', 'other', 'credit'].reduce((sum, key) => sum + sale.split[key], 0);
    assert.equal(columns - (sale.deposit_cents || 0) + sale.from_deposit_cents + sale.unpaid_cancelled_cents, sale.total_cents, sale.number);
  }
});

test('a visa with a deposit taken in cash, part of it used on the invoice: every row still adds up', () => {
  const day = '2026-11-20';
  const withDeposit = visaService.submitVisa(db, visaService.createVisa(db, {
    customer_id: customerId, application_date: day, destination_country: 'Italy', applicant_is_customer: false, applicant_name: 'Hina',
    sale_items: [{ description: 'Schengen visa', quantity: 1, unit_price_cents: 50_000, account_id: account('4320').id }],
  }).id);
  const deposit = visaDeposits.collectDeposit(db, { visa_id: withDeposit.id, amount_cents: 100_000, deposit_date: day, account_id: account('1000').id, method: 'Cash' });
  visaDeposits.applyToInvoice(db, deposit.id, { invoice_id: withDeposit.invoice_id, amount_cents: 20_000, event_date: day });
  pay(withDeposit.invoice_id, 10_000, 'Cash', '1000', day);
  const sections = dailySales(db, day, day).sections;
  const row = sections.visas.find((r) => r.id === withDeposit.invoice_id);
  assert.deepEqual(
    [row.deposit_cents, row.deposit_cash_cents, row.from_deposit_cents, row.split.cash, row.split.credit],
    [100_000, 100_000, 20_000, 110_000, 20_000],
    'the deposit and the sale share the Cash column; 20,000 paid from the deposit, 20,000 still due',
  );
  for (const sale of [...sections.tickets, ...sections.visas, ...sections.services]) {
    const columns = ['cash', 'card', 'bank', 'other', 'credit'].reduce((sum, key) => sum + sale.split[key], 0);
    assert.equal(columns - (sale.deposit_cents || 0) + sale.from_deposit_cents + sale.unpaid_cancelled_cents, sale.total_cents, sale.number);
  }
});

test('cash moved to petty cash: listed as a move, petty cash has its own position', () => {
  const { createDeposit } = require('../server/services/cash-deposits');
  const day = '2026-11-21';
  pay(service.id, 5_000, 'Cash', '1000', day);
  const move = createDeposit(db, { amount_cents: 2_000, deposit_date: day, from_account_id: account('1000').id, to_account_id: account('1020').id });
  const sections = dailySales(db, day, day).sections;
  assert.deepEqual(sections.transfers.map((row) => [row.number, row.from_code, row.to_code, row.amount_cents]), [[move.number, '1000', '1020', 2_000]]);
  const flow = sections.cash_out.find((row) => row.source_type === 'cash_deposit');
  assert.deepEqual([flow.cash_out_cents, flow.petty_in_cents], [2_000, 2_000]);
  const { petty, cash } = sections.summary.position;
  assert.equal(petty.closing_cents, petty.opening_cents + 2_000);
  assert.equal(cash.closing_cents, cash.opening_cents + 5_000 - 2_000);
});
