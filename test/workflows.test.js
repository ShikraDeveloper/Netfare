'use strict';

// The booking and visa workflows: what each status allows (the same moves the
// services and screens allowed before the rules moved to server/workflows.js),
// the same refusal messages, and allowed_actions on every record.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-workflows-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const { allowedActions, isVoid } = require('../server/workflows');
const bookings = require('../server/services/bookings');
const visas = require('../server/services/visas');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const EXPECTED = {
  booking: {
    draft: ['edit', 'delete', 'confirm', 'cancel'],
    confirmed: ['travel', 'cancel', 'edit_details', 'correct', 'void'],
    travelled: ['cancel', 'edit_details', 'correct', 'void'],
    cancelled: ['edit_details'],
  },
  visa: {
    draft: ['edit', 'delete', 'submit', 'cancel'],
    submitted: ['approve', 'reject', 'cancel', 'edit_details', 'correct', 'void'],
    approved: ['issue', 'reject', 'cancel', 'edit_details', 'correct', 'void'],
    issued: ['cancel', 'edit_details', 'correct', 'void'],
    rejected: ['edit_details', 'correct', 'void'],
    cancelled: ['edit_details'],
  },
};

// Invoices, bills and advances: what the screens offered before, by record.
const DOCUMENTS = [
  ['invoice', { status: 'draft', total_cents: 100 }, ['edit', 'delete', 'finalize', 'payment_link']],
  ['invoice', { status: 'sent', total_cents: 100 }, ['record_payment', 'payment_link', 'correct', 'void']],
  ['invoice', { status: 'sent', total_cents: 100, amount_paid_cents: 60, credit_applied_cents: 40 }, ['payment_link', 'correct', 'void']],
  ['invoice', { status: 'sent', total_cents: 100, booking_id: 1 }, ['record_payment', 'payment_link']],
  ['invoice', { status: 'sent', total_cents: 100, visa_id: 1, cancellation_id: 2 }, ['record_payment', 'payment_link']],
  ['invoice', { status: 'sent', total_cents: 100, is_opening: 1 }, ['record_payment', 'payment_link', 'void']],
  ['invoice', { status: 'void', total_cents: 100 }, []],
  ['bill', { status: 'draft', total_cents: 100 }, ['edit', 'delete', 'finalize']],
  ['bill', { status: 'received', total_cents: 100 }, ['record_payment', 'correct', 'void']],
  ['bill', { status: 'received', total_cents: 100, amount_paid_cents: 100 }, ['correct', 'void']],
  ['bill', { status: 'received', total_cents: 100, visa_id: 3 }, ['record_payment']],
  ['bill', { status: 'received', total_cents: 100, is_opening: 1 }, ['record_payment', 'void']],
  ['bill', { status: 'void', total_cents: 100 }, []],
  ['advance', { status: 'open', amount_cents: 100 }, ['apply', 'refund', 'correct', 'void']],
  ['advance', { status: 'open', amount_cents: 100, applied_cents: 40 }, ['apply', 'refund', 'void']],
  ['advance', { status: 'open', amount_cents: 100, is_receipt: 1 }, ['apply', 'refund', 'void']],
  ['advance', { status: 'applied', amount_cents: 100, applied_cents: 100 }, ['void']],
  ['advance', { status: 'refunded', amount_cents: 100, refunded_cents: 100 }, ['void']],
  ['advance', { status: 'open', amount_cents: 100, voided_at: '2026-11-12' }, []],
];

test('invoices, bills and advances offer exactly what their screens offered before', () => {
  for (const [kind, record, actions] of DOCUMENTS) {
    assert.deepEqual(allowedActions(kind, record), actions, `${kind} ${JSON.stringify(record)}`);
  }
});

test('each status allows exactly the moves it allowed before', () => {
  for (const [kind, states] of Object.entries(EXPECTED)) {
    for (const [status, actions] of Object.entries(states)) {
      assert.deepEqual(allowedActions(kind, { status }), actions, `${kind} ${status}`);
    }
    assert.deepEqual(allowedActions(kind, { status: 'cancelled', voided_at: '2026-11-12' }), [], `a void ${kind} allows nothing`);
  }
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const vendor = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Workflow Air')").run().lastInsertRowid);
const customer = Number(db.prepare("INSERT INTO customers (name) VALUES ('Workflow Customer')").run().lastInsertRowid);

test('records carry allowed_actions and refused moves keep their messages', () => {
  const booking = bookings.createBooking(db, {
    customer_id: customer, booking_date: '2026-11-01', travel_date: '2026-11-05', destination: 'DXB-LHR',
    sale_items: [{ description: 'Ticket', passenger_name: 'Ali', quantity: 1, unit_price_cents: 50_000, account_id: account('4000'), line_group: 1 }],
    cost_items: [{ description: 'Ticket', passenger_name: 'Ali', quantity: 1, unit_price_cents: 40_000, account_id: account('5000'), vendor_id: vendor, line_group: 1 }],
  });
  assert.deepEqual(bookings.getBooking(db, booking.id).allowed_actions, EXPECTED.booking.draft);
  assert.throws(() => bookings.markTravelled(db, booking.id), /Only confirmed bookings can be marked as travelled/);
  bookings.confirmBooking(db, booking.id);
  const confirmed = bookings.getBooking(db, booking.id);
  assert.deepEqual(confirmed.allowed_actions, EXPECTED.booking.confirmed);
  assert.throws(() => bookings.confirmBooking(db, booking.id), /Only draft bookings can be confirmed/);
  assert.throws(() => bookings.deleteBooking(db, booking.id), /Only draft bookings can be deleted\. Cancel it instead\./);
  assert.ok(bookings.listBookings(db).find((row) => row.id === booking.id).allowed_actions.includes('travel'));

  const visa = visas.createVisa(db, {
    customer_id: customer, application_date: '2026-11-01', applicant_name: 'Sara', destination_country: 'UAE', visa_type: 'tourist',
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 30_000, account_id: account('4320') }],
    cost_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 25_000, account_id: account('5120'), vendor_id: vendor }],
  });
  assert.deepEqual(visas.getVisa(db, visa.id).allowed_actions, EXPECTED.visa.draft);
  assert.throws(() => visas.approveVisa(db, visa.id), /Only submitted applications can be approved/);
  visas.submitVisa(db, visa.id);
  assert.deepEqual(visas.getVisa(db, visa.id).allowed_actions, EXPECTED.visa.submitted);
  assert.throws(() => visas.issueVisa(db, visa.id), /Only approved applications can be marked as issued/);
});

test('invoices, bills and advances carry allowed_actions from the server', () => {
  const invoices = require('../server/services/invoices');
  const billsService = require('../server/services/bills');
  const advancesService = require('../server/services/advances');
  const draft = invoices.createInvoice(db, {
    customer_id: customer, issue_date: '2026-11-01', due_date: '2026-11-01', status: 'draft',
    items: [{ description: 'Consultancy', quantity: 1, unit_price_cents: 10_000, account_id: account('4300') }],
  });
  assert.deepEqual(invoices.getInvoice(db, draft.id).allowed_actions, ['edit', 'delete', 'finalize', 'payment_link']);
  assert.ok(invoices.listInvoices(db).find((row) => row.id === draft.id).allowed_actions.includes('finalize'));
  const bill = billsService.createBill(db, {
    vendor_id: vendor, bill_date: '2026-11-01', due_date: '2026-11-01',
    items: [{ description: 'Rent', quantity: 1, unit_price_cents: 5_000, account_id: account('6100') }],
  });
  assert.deepEqual(billsService.getBill(db, bill.id).allowed_actions, ['record_payment', 'correct', 'void']);
  const advance = advancesService.createAdvance(db, { customer_id: customer, amount_cents: 1_000, advance_date: '2026-11-01', deposit_account_id: account('1010') });
  assert.deepEqual(advance.allowed_actions, ['apply', 'refund', 'correct', 'void']);
  const page = require('../server/services/customer-balances').getCustomerBalance(db, customer);
  assert.deepEqual(page.advances.find((row) => row.id === advance.id).allowed_actions, ['apply', 'refund', 'correct', 'void']);
});

test('isVoid reads both ways a void is stored, and a void record allows nothing', () => {
  assert.equal(isVoid({ status: 'void' }), true);
  assert.equal(isVoid({ status: 'cancelled', voided_at: '2026-11-12 10:00:00' }), true);
  assert.equal(isVoid({ status: 'sent' }), false);
  for (const kind of ['booking', 'visa', 'invoice', 'bill', 'advance']) {
    assert.deepEqual(allowedActions(kind, { status: 'void', total_cents: 100 }), [], kind);
  }
});
