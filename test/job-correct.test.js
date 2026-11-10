'use strict';

// Correcting a posted booking or visa: the job keeps its number, the invoice
// and bills are re-posted, and payments move across with the same numbers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-job-correct-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookings = require('../server/services/bookings');
const visas = require('../server/services/visas');
const invoices = require('../server/services/invoices');
const bills = require('../server/services/bills');
const portals = require('../server/services/portals');
const reconciliation = require('../server/services/reconciliation');
const { correctJob } = require('../server/services/job-correct');
const { dailySales } = require('../server/services/reports/daily-sales');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const balance = (code) => db.prepare(`
  SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS n
  FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
`).get(code).n;
const party = (table, name) => Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);

function checksMatch() {
  const totals = db.prepare('SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM journal_lines').get();
  assert.equal(totals.d, totals.c);
  assert.deepEqual(reconciliation.reconciliationSummary(db).checks.filter((check) => !check.matched).map((check) => check.code || check.label), []);
}

const lines = (sale, cost, vendor) => ({
  sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: sale, account_id: account('4000') }],
  cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: cost, account_id: account('5000'), vendor_id: vendor }],
});

function paidBooking(name) {
  const customer = party('customers', name);
  const vendor = party('vendors', `Airline ${name}`);
  const draft = bookings.createBooking(db, { customer_id: customer, booking_date: '2026-11-01', due_date: '2026-11-01', destination: 'London', ...lines(100_000, 80_000, vendor) });
  const booking = bookings.confirmBooking(db, draft.id);
  invoices.recordInvoicePayment(db, booking.invoice_id, { amount_cents: 60_000, payment_date: '2026-11-02', method: 'Cash', deposit_account_id: account('1000') });
  bills.recordBillPayment(db, booking.bills[0].id, { amount_cents: 80_000, payment_date: '2026-11-02', method: 'Bank transfer', payment_account_id: account('1010') });
  return { booking, vendor, customer };
}

test('a booking: fare and cost corrected; payments keep their numbers; same date', () => {
  const { booking, vendor, customer } = paidBooking('Fare Fix');
  const payment = db.prepare('SELECT number FROM payments WHERE invoice_id = ?').get(booking.invoice_id).number;
  const billPayment = db.prepare('SELECT number FROM bill_payments WHERE bill_id = ?').get(booking.bills[0].id).number;
  const before = { sales: balance('4000'), cost: balance('5000'), cash: balance('1000'), bank: balance('1010') };

  assert.throws(() => correctJob(db, 'booking', booking.id, { values: { customer_id: customer, booking_date: '2026-11-01', ...lines(120_000, 85_000, vendor) } }), /Reason is required/);
  const fixed = correctJob(db, 'booking', booking.id, {
    remarks: 'Fare was 1,200 and cost 850',
    values: { customer_id: customer, booking_date: '2026-11-01', destination: 'London', ...lines(120_000, 85_000, vendor) },
  });
  assert.equal(fixed.number, booking.number, 'the booking keeps its number');
  assert.equal(fixed.status, 'confirmed');
  assert.notEqual(fixed.invoice_id, booking.invoice_id);
  assert.equal(fixed.invoice.total_cents, 120_000);
  assert.equal(fixed.invoice.issue_date, '2026-11-01');
  assert.equal(fixed.invoice.amount_paid_cents, 60_000);
  assert.deepEqual(fixed.payments.map((row) => row.number), [payment]);
  const bill = fixed.bills.find((row) => row.status === 'received');
  assert.equal(bill.total_cents, 85_000);
  assert.equal(bill.amount_paid_cents, 80_000);
  assert.deepEqual(fixed.bill_payments.filter((row) => row.status === 'posted').map((row) => row.number), [billPayment]);
  assert.equal(balance('4000') - before.sales, -20_000, 'sales up by 200');
  assert.equal(balance('5000') - before.cost, 5_000, 'cost up by 50');
  assert.equal(balance('1000'), before.cash, 'no money moved');
  assert.equal(balance('1010'), before.bank);
  const day = dailySales(db, '2026-11-01', '2026-11-01').days.flatMap((d) => d.rows).filter((row) => row.reference_id === booking.id && row.kind === 'booking');
  assert.deepEqual(day.map((row) => [row.sale_cents, row.cost_cents]), [[120_000, 85_000]], 'the sale day reads the corrected figures');
  checksMatch();
});

test('refused, with nothing changed: total below paid, paid supplier dropped, customer changed', () => {
  const { booking, vendor, customer } = paidBooking('Refused');
  const other = party('vendors', 'Other Airline');
  const attempt = (values) => () => correctJob(db, 'booking', booking.id, { remarks: 'x', values: { customer_id: customer, booking_date: '2026-11-01', ...values } });
  assert.throws(attempt(lines(50_000, 80_000, vendor)), /less than what was paid/);
  assert.throws(attempt(lines(100_000, 80_000, other)), /has payments or credits/);
  assert.throws(attempt(lines(100_000, 70_000, vendor)), /less than what was paid or credited/);
  assert.throws(() => correctJob(db, 'booking', booking.id, { remarks: 'x', values: { customer_id: party('customers', 'Someone'), booking_date: '2026-11-01', ...lines(100_000, 80_000, vendor) } }), /belong to its customer/);
  const same = bookings.getBooking(db, booking.id);
  assert.equal(same.invoice_id, booking.invoice_id, 'nothing changed');
  assert.equal(same.invoice.status, 'sent');
  checksMatch();
});

test('a visa paid from a prepaid wallet: the wallet pays only the extra cost', () => {
  const customer = party('customers', 'Visa Fix');
  const vendor = party('vendors', 'Visa Wallet Supplier');
  const portal = portals.createPortal(db, { name: 'Visa wallet', portal_type: 'other', settlement: 'prepaid', vendor_id: vendor });
  portals.topUp(db, { portal_id: portal.id, topup_date: '2026-11-01', amount_cents: 100_000, deposit_account_id: account('1010') });
  const draft = visas.createVisa(db, {
    customer_id: customer, application_date: '2026-11-01', destination_country: 'UAE', visa_type: 'tourist', applicant_is_customer: true,
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 50_000, account_id: account('4320') }],
    cost_items: [{ description: 'Fee', quantity: 1, unit_price_cents: 30_000, account_id: account('5120'), vendor_id: vendor }],
  });
  const visa = visas.submitVisa(db, draft.id);
  assert.equal(portals.getPortal(db, portal.id).balance_cents, 70_000, 'the wallet paid 300');
  const fixed = correctJob(db, 'visa', visa.id, {
    remarks: 'Fee was 350',
    values: {
      customer_id: customer, application_date: '2026-11-01', destination_country: 'UAE', visa_type: 'tourist', applicant_is_customer: true,
      sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 50_000, account_id: account('4320') }],
      cost_items: [{ description: 'Fee', quantity: 1, unit_price_cents: 35_000, account_id: account('5120'), vendor_id: vendor }],
    },
  });
  assert.equal(fixed.number, visa.number);
  assert.equal(fixed.status, 'submitted');
  assert.equal(portals.getPortal(db, portal.id).balance_cents, 65_000, 'only the extra 50 came from the wallet');
  const bill = fixed.bills.find((row) => row.status === 'received');
  assert.equal(bill.balance_cents, 0);
  checksMatch();
});

test('edit details: dates, PNR and passenger names change with no money moved; logged', () => {
  const { updateJobDetails } = require('../server/services/job-details');
  const { booking } = paidBooking('Details');
  const entries = db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  const saleLine = db.prepare("SELECT id FROM booking_items WHERE booking_id = ? AND item_type = 'sale'").get(booking.id);
  updateJobDetails(db, 'booking', booking.id, {
    pnr: 'XQ12AB', travel_date: '2026-12-01', return_date: '2026-12-10', notes: 'Window seats',
    items: [{ id: saleLine.id, passenger_name: 'Ali Khan' }],
  });
  const fresh = bookings.getBooking(db, booking.id);
  assert.deepEqual([fresh.pnr, fresh.travel_date, fresh.return_date, fresh.notes], ['XQ12AB', '2026-12-01', '2026-12-10', 'Window seats']);
  assert.equal(db.prepare('SELECT passenger_name FROM booking_items WHERE id = ?').get(saleLine.id).passenger_name, 'Ali Khan');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, entries, 'nothing posted');
  const log = db.prepare("SELECT remarks FROM audit_logs WHERE entity_type = 'booking' AND entity_id = ? AND action = 'edit'").get(booking.id);
  assert.match(log.remarks, /pnr: — → XQ12AB/);
  assert.throws(() => updateJobDetails(db, 'booking', booking.id, { travel_date: '2026-12-20' }), /Return date cannot be before/);
  assert.throws(() => updateJobDetails(db, 'booking', booking.id, { items: [{ id: 999_999, passenger_name: 'X' }] }), /not on this booking/);
});
