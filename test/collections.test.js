'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-collections-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const bookingService = require('../server/services/bookings');
const visaService = require('../server/services/visas');
const invoiceService = require('../server/services/invoices');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

const customerId = Number(db.prepare("INSERT INTO customers (name, phone) VALUES ('Collections Customer', '050 123 4567')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Collections Airline')").run().lastInsertRowid);

function booking(date, dueDate = '2099-01-01') {
  return bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: date,
    due_date: dueDate,
    destination: 'Dubai–Doha',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 100_000, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: 80_000, account_id: account('5000').id, vendor_id: vendorId }],
  });
}

function pay(invoiceId, cents, date = '2026-09-10') {
  return invoiceService.recordInvoicePayment(db, invoiceId, {
    amount_cents: cents, payment_date: date, deposit_account_id: account('1000').id, method: 'Cash', reference: 'RCPT-1',
  });
}

const statusOf = (id) => bookingService.listBookings(db, {}).find((row) => row.id === id);

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('bookings show not invoiced, unpaid, partial and paid from their invoice', () => {
  const draft = booking('2026-09-01');
  assert.equal(statusOf(draft.id).payment_status, 'not_invoiced');

  const confirmed = bookingService.confirmBooking(db, draft.id);
  assert.equal(statusOf(draft.id).payment_status, 'unpaid');
  assert.equal(statusOf(draft.id).payment_balance_cents, 100_000);

  pay(confirmed.invoice_id, 40_000);
  assert.deepEqual(
    [statusOf(draft.id).payment_status, statusOf(draft.id).payment_balance_cents],
    ['partial', 60_000],
  );
  pay(confirmed.invoice_id, 60_000);
  assert.equal(statusOf(draft.id).payment_status, 'paid');
  assert.equal(bookingService.getBooking(db, draft.id).payment_status, 'paid', 'the detail payload carries it too');
});

test('an unpaid invoice past its due date is overdue, and a cancelled booking has nothing to collect', () => {
  const late = bookingService.confirmBooking(db, booking('2026-01-05', '2026-01-10').id);
  assert.equal(statusOf(late.id).payment_status, 'overdue');

  bookingService.cancelBooking(db, late.id, { cancellation_date: '2026-01-20' });
  assert.equal(statusOf(late.id).payment_status, null);
});

test('visas show the same payment status; rejected ones have none', () => {
  const visa = visaService.createVisa(db, {
    customer_id: customerId,
    application_date: '2026-09-01',
    due_date: '2099-01-01',
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 30_000, account_id: account('4320').id }],
  });
  const find = () => visaService.listVisas(db, {}).find((row) => row.id === visa.id);
  assert.equal(find().payment_status, 'not_invoiced');
  const submitted = visaService.submitVisa(db, visa.id);
  pay(submitted.invoice_id, 10_000);
  assert.equal(find().payment_status, 'partial');
  visaService.rejectVisa(db, visa.id, { reason: 'Refused', rejection_date: '2026-09-15' });
  assert.equal(find().payment_status, null);
});

test('a receipt voucher carries the payment, invoice, job and customer details', () => {
  const confirmed = bookingService.confirmBooking(db, booking('2026-09-05').id);
  const payment = pay(confirmed.invoice_id, 25_000, '2026-09-06');
  const paymentId = payment.payments ? payment.payments.at(-1).id : payment.id;
  const receipt = invoiceService.getPaymentReceipt(db, paymentId);
  assert.equal(receipt.amount_cents, 25_000);
  assert.equal(receipt.payment_date, '2026-09-06');
  assert.equal(receipt.method, 'Cash');
  assert.equal(receipt.reference, 'RCPT-1');
  assert.equal(receipt.customer_name, 'Collections Customer');
  assert.equal(receipt.booking_number, confirmed.number);
  assert.equal(receipt.invoice_total_cents, 100_000);
  assert.equal(receipt.invoice_balance_cents, 75_000);
  assert.ok(receipt.deposit_account_name);
  assert.match(receipt.number, /\S/);
  assert.throws(() => invoiceService.getPaymentReceipt(db, 999_999), (error) => error.status === 404);
});

test('amounts print in words in dirhams and fils', async () => {
  const { amountInWords } = await import('../public/js/amount-words.js');
  assert.equal(amountInWords(73_000), 'UAE Dirhams Seven Hundred Thirty Only');
  assert.equal(amountInWords(510_050), 'UAE Dirhams Five Thousand One Hundred and Fifty Fils Only');
  assert.equal(amountInWords(123_456_789), 'UAE Dirhams One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven and Eighty-Nine Fils Only');
  assert.equal(amountInWords(0), 'UAE Dirhams Zero Only');
});

test('share links use the customer number in international form and the message text', async () => {
  const { whatsappNumber, whatsappUrl, mailtoUrl, invoiceMessage } = await import('../public/js/share-links.js');
  assert.equal(whatsappNumber('050 123 4567'), '971501234567');
  assert.equal(whatsappNumber('+971 55 555 0121'), '971555550121');
  assert.equal(whatsappNumber('00971501234567'), '971501234567');
  assert.equal(whatsappNumber(''), '');
  assert.equal(whatsappUrl('', 'Hi'), 'https://wa.me/?text=Hi');
  assert.equal(mailtoUrl('a@b.com', 'Invoice 1', 'Line 1\nLine 2'), 'mailto:a@b.com?subject=Invoice%201&body=Line%201%0ALine%202');

  const message = invoiceMessage({
    customer_name: 'Aisha', number: 'INV-1', booking_number: 'BK-1', booking_destination: 'Dubai–Doha',
    issue_date: '2026-09-01', due_date: '2026-09-30', total_cents: 100_000, balance_cents: 60_000, status_display: 'partial',
  }, { company: 'Skyline', title: 'Ticket invoice', format: (c) => `AED ${(c / 100).toFixed(2)}`, date: (d) => d });
  assert.match(message, /^Dear Aisha,/);
  assert.match(message, /ticket invoice INV-1 for booking BK-1 \(Dubai–Doha\), dated 2026-09-01/);
  assert.match(message, /Amount due: AED 600\.00 by 2026-09-30/);
  assert.match(message, /Skyline$/);
  assert.doesNotMatch(message, /Pay online/);
  const linked = invoiceMessage({
    customer_name: 'Aisha', number: 'INV-2', issue_date: '2026-09-01', due_date: '2026-09-30',
    total_cents: 10_000, balance_cents: 10_000, status_display: 'sent', payment_link: 'https://pay.example.com/x',
  }, { company: 'Skyline', format: (c) => `AED ${(c / 100).toFixed(2)}`, date: (d) => d });
  assert.match(linked, /Pay online by card: https:\/\/pay\.example\.com\/x/);
});
