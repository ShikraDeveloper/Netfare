'use strict';

// Statements of account: one line per receipt, credit notes when issued,
// supplier deposits as money sent, ageing, and above all every statement
// together agrees with the ledger.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-statements-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const advances = require('../server/services/advances');
const credits = require('../server/services/credits');
const bookings = require('../server/services/bookings');
const cancellations = require('../server/services/cancellations');
const portals = require('../server/services/portals');
const statements = require('../server/services/statements');
const visas = require('../server/services/visas');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const ledger = (code) => db.prepare(`SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS b
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?`).get(code).b;
const party = (table, name) => Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);
const invoice = (customerId, date, cents) => invoices.createInvoice(db, {
  customer_id: customerId, issue_date: date, due_date: date, status: 'sent',
  items: [{ description: 'Service', quantity: 1, unit_price_cents: cents, account_id: account('4300') }],
});

const customerId = party('customers', 'Statement Customer');
const vendorId = party('vendors', 'Statement Airline');
const walletVendor = party('vendors', 'Statement Consolidator');
const wallet = portals.createPortal(db, { name: 'Consolidator wallet', portal_type: 'consolidator', settlement: 'prepaid', vendor_id: walletVendor });

test('a receipt over several invoices is one line; credit notes show when issued', () => {
  const first = invoice(customerId, '2026-01-05', 100_000);
  const second = invoice(customerId, '2026-01-06', 50_000);
  const third = invoice(customerId, '2026-01-07', 30_000);
  // 1,850 received: the three invoices (1,800), 50 left as advance.
  const receipt = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 185_000, receipt_date: '2026-01-10', method: 'Bank transfer', deposit_account_id: account('1010'),
  });
  const later = invoice(customerId, '2026-01-20', 40_000);
  const credit = credits.createCredit(db, { customer_id: customerId, credit_date: '2026-01-15', amount_cents: 20_000, revenue_account_id: account('4300') });
  credits.applyCredit(db, credit.id, { invoice_id: later.id, amount_cents: 8_000, applied_date: '2026-01-20' });
  credits.refundCredit(db, credit.id, { amount_cents: 5_000, refund_date: '2026-01-21', account_id: account('1000') });

  const statement = statements.customerStatement(db, customerId, { from: '2026-01-01' });
  const kinds = statement.transactions.map((row) => row.kind);
  assert.deepEqual(kinds, ['invoice', 'invoice', 'invoice', 'receipt', 'credit_note', 'invoice', 'refund']);
  const line = statement.transactions.find((row) => row.kind === 'receipt');
  assert.equal(line.reference, receipt.number);
  assert.equal(line.credit_cents, 180_000, 'the part used on invoices; the 50 left is an advance');
  assert.deepEqual(line.allocations.map((share) => [share.invoice, share.amount_cents]),
    [[first.number, 100_000], [second.number, 50_000], [third.number, 30_000]]);
  assert.equal(statement.advances.closing_held_cents, 5_000);
  // 400 due on the last invoice, less the 200 credit, plus the 50 paid back = 250.
  assert.equal(statement.closing_balance_cents, 25_000);
});

test('a cancellation kept as credit and used later needs no extra lines', () => {
  const booking = bookings.confirmBooking(db, bookings.createBooking(db, {
    customer_id: customerId, booking_date: '2026-02-01', due_date: '2026-02-01', destination: 'DXB–KHI',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 70_000, account_id: account('4000') }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: 60_000, account_id: account('5000'), vendor_id: vendorId }],
  }).id);
  invoices.recordInvoicePayment(db, booking.invoice_id, { amount_cents: 70_000, payment_date: '2026-02-01', deposit_account_id: account('1000'), method: 'Cash' });
  const note = cancellations.cancelSource(db, {
    sourceType: 'booking', sourceId: booking.id,
    payload: { cancellation_date: '2026-02-05', customer_charges_cents: 10_000, supplier_credits: [{ bill_id: booking.bills[0].id, amount_cents: 50_000 }] },
  });
  cancellations.convertCancellationToCredit(db, note.id, { credit_date: '2026-02-06' });
  const before = statements.customerStatement(db, customerId, { from: '2026-01-01' });
  assert.ok(!before.transactions.some((row) => row.kind === 'credit_note' && row.date === '2026-02-06'), 'kept as credit: no line');
  assert.equal(before.closing_balance_cents, 25_000 - 60_000, '600 is still owed back, as credit');
});

test('a prepaid supplier: deposits are the money sent; wallet payments sit in the bill', () => {
  portals.topUp(db, { portal_id: wallet.id, amount_cents: 100_000, topup_date: '2026-03-01', deposit_account_id: account('1010'), method: 'Bank transfer' });
  const bill = bills.createBill(db, {
    vendor_id: walletVendor, bill_date: '2026-03-02', due_date: '2026-03-02', status: 'received',
    items: [{ description: 'Fare', quantity: 1, unit_price_cents: 30_000, account_id: account('5000') }],
  });
  portals.settleBillFromPortal(db, { bill_id: bill.id, portal_id: wallet.id, settle_date: '2026-03-02' });
  portals.refundPortal(db, wallet.id, { amount_cents: 10_000, refund_date: '2026-03-05', payment_account_id: account('1010') });

  const statement = statements.vendorStatement(db, walletVendor, { from: '2026-01-01' });
  assert.deepEqual(statement.transactions.map((row) => [row.kind, row.debit_cents, row.credit_cents]), [
    ['deposit', 100_000, 0], ['bill', 0, 30_000], ['deposit_return', 0, 10_000],
  ]);
  assert.equal(statement.closing_balance_cents, -60_000, 'the supplier holds 600 for us');
  assert.equal(statement.deposit_held_cents, portals.getPortal(db, wallet.id).balance_cents);
});

test('all statements together agree with the ledger', () => {
  const sum = (table, statementOf) => db.prepare(`SELECT id FROM ${table}`).all()
    .reduce((total, row) => total + statementOf(db, row.id, { from: '2000-01-01' }).closing_balance_cents, 0);
  // Customers: receivables less refunds owed back and credit notes.
  assert.equal(sum('customers', statements.customerStatement), ledger('1100') + ledger('2500') + ledger('2450'));
  // Suppliers: payables less supplier credits and money in their wallets.
  assert.equal(sum('vendors', statements.vendorStatement), -ledger('2000') - ledger('1450') - ledger('1400'));
});

test('ageing splits what is open by how late it is, and adds up to the balance', () => {
  const statement = statements.customerStatement(db, customerId, {});
  const { as_of: asOf, other_cents: other, ...buckets } = statement.ageing;
  assert.ok(asOf);
  assert.equal(buckets.over_90, 32_000, 'the January invoice is long overdue');
  assert.equal(Object.values(buckets).reduce((a, b) => a + b, 0) + other, statement.closing_balance_cents);
  assert.equal(statements.customerStatement(db, customerId, { to: '2026-01-31' }).ageing, null, 'not for a statement that ended earlier');
});

test('each line says what it was for: booking route, PNR, passengers and tickets; visa applicant and passport', () => {
  const traveller = party('customers', 'Line Customer');
  const airline = party('vendors', 'Line Airline');
  const booking = bookings.confirmBooking(db, bookings.createBooking(db, {
    customer_id: traveller, booking_date: '2026-04-01', due_date: '2026-04-01', destination: 'DXB/DAC/DXB', pnr: 'CJYUEN',
    travel_date: '2026-04-10', return_date: '2026-04-20',
    sale_items: [{ description: 'DXB/DAC/DXB – Mr REPON', passenger_name: 'Mr REPON', line_group: 1, quantity: 1, unit_price_cents: 272_000, account_id: account('4000') }],
    cost_items: [{ description: 'DXB/DAC/DXB – Mr REPON', passenger_name: 'Mr REPON', line_group: 1, quantity: 1, unit_price_cents: 255_700, account_id: account('5000'), vendor_id: airline, supplier_ref: '1763936143734' }],
  }).id);
  const visa = visas.submitVisa(db, visas.createVisa(db, {
    customer_id: traveller, application_date: '2026-04-02', applicant_is_customer: false, applicant_name: 'Samina Akram',
    nationality: 'Pakistani', passport_number: 'HV1232151', visa_type: 'tourist', destination_country: 'UAE',
    sale_items: [{ description: 'Tourist visa', quantity: 1, unit_price_cents: 32_000, account_id: account('4320') }],
    cost_items: [{ description: 'Tourist visa', quantity: 1, unit_price_cents: 30_000, account_id: account('5120'), vendor_id: airline }],
  }).id);

  const sold = statements.customerStatement(db, traveller, { from: '2026-01-01' }).transactions;
  const ticketLine = sold.find((row) => row.id === booking.invoice_id && row.kind === 'invoice');
  assert.deepEqual([ticketLine.booking.number, ticketLine.booking.pnr, ticketLine.booking.travel_date], [booking.number, 'CJYUEN', '2026-04-10']);
  assert.deepEqual(ticketLine.booking.passengers, [{ name: 'Mr REPON', ticket: '1763936143734' }]);
  const visaLine = sold.find((row) => row.id === visa.invoice_id && row.kind === 'invoice');
  assert.equal(visaLine.visa.applicant_name, 'Samina Akram');
  assert.ok(visaLine.visa.passport_masked.endsWith('2151'));
  assert.ok(!JSON.stringify(sold).includes('HV1232151'), 'the customer statement never carries the full passport');

  const bought = statements.vendorStatement(db, airline, { from: '2026-01-01' }).transactions.filter((row) => row.kind === 'bill');
  const ticketBill = bought.find((row) => row.booking);
  assert.deepEqual(ticketBill.booking.passengers, [{ name: 'Mr REPON', ticket: '1763936143734' }], 'this supplier\'s passenger and ticket');
  assert.equal(ticketBill.customer_name, 'Line Customer');
  const visaBill = bought.find((row) => row.visa);
  assert.equal(visaBill.visa.passport, 'HV1232151', 'the supplier statement has the full passport');
  assert.equal(visaBill.customer_name, 'Line Customer');

  // The supplier's own reference, set on a posted bill; it changes no amount.
  bills.setSupplierRef(db, visaBill.id, { supplier_ref: 'HS-INV-5521' });
  const again = statements.vendorStatement(db, airline, { from: '2026-01-01' }).transactions.find((row) => row.id === visaBill.id && row.kind === 'bill');
  assert.equal(again.supplier_ref, 'HS-INV-5521');
  assert.equal(again.credit_cents, 30_000);
});
