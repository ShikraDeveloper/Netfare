'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-service-invoice-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const bookingService = require('../server/services/bookings');
const visaService = require('../server/services/visas');
const cancellationService = require('../server/services/cancellations');
const dailySales = require('../server/services/reports/daily-sales');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Service Customer')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Service Airline')").run().lastInsertRowid);

function invoicePayload(code, extra = {}) {
  return {
    customer_id: customerId,
    issue_date: '2026-08-01',
    items: [{ description: 'Line', quantity: 1, unit_price_cents: 10_000, account_id: account(code).id }],
    ...extra,
  };
}

function assertJobRevenueRefused(fn, code) {
  assert.throws(fn, (error) => error.status === 400
    && error.message.includes(code)
    && /Create a booking or visa/.test(error.message));
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a direct invoice cannot use ticket, package or visa revenue', () => {
  for (const code of ['4000', '4100', '4320']) {
    assertJobRevenueRefused(() => invoiceService.createInvoice(db, invoicePayload(code)), code);
    assertJobRevenueRefused(() => invoiceService.createInvoice(db, invoicePayload(code, { status: 'draft' })), code);
  }
  // A mixed invoice is refused as a whole, naming the line.
  assert.throws(
    () => invoiceService.createInvoice(db, {
      customer_id: customerId,
      issue_date: '2026-08-01',
      items: [
        { description: 'Service fee', quantity: 1, unit_price_cents: 5_000, account_id: account('4300').id },
        { description: 'Ticket', quantity: 1, unit_price_cents: 90_000, account_id: account('4000').id },
      ],
    }),
    /Line 2: 4000/,
  );
});

test('service, commission, other income and custom revenue accounts are allowed', () => {
  db.prepare("INSERT INTO accounts (code, name, type, subtype, normal_balance) VALUES ('4500', 'Insurance Commission', 'revenue', 'operating_revenue', 'credit')").run();
  for (const code of ['4300', '4310', '4200', '4500']) {
    const invoice = invoiceService.createInvoice(db, invoicePayload(code));
    assert.equal(invoice.status, 'sent', `${code} is a valid service invoice account`);
  }
});

test('draft edits and posting older drafts follow the same rule', () => {
  const draft = invoiceService.createInvoice(db, invoicePayload('4300', { status: 'draft' }));
  assertJobRevenueRefused(
    () => invoiceService.updateInvoice(db, draft.id, { items: invoicePayload('4100').items }),
    '4100',
  );
  // A draft saved before the rule may still hold a ticket line.
  db.prepare('UPDATE invoice_items SET account_id = ? WHERE invoice_id = ?').run(account('4000').id, draft.id);
  assertJobRevenueRefused(() => invoiceService.finalizeInvoice(db, draft.id), '4000');
  assert.equal(invoiceService.getInvoice(db, draft.id).status, 'draft', 'nothing is posted');
});

test('booking, visa and cancellation invoices still post ticket and visa revenue', () => {
  const booking = bookingService.confirmBooking(db, bookingService.createBooking(db, {
    customer_id: customerId,
    booking_date: '2026-08-02',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 100_000, account_id: account('4000').id }],
    cost_items: [{ description: 'Fare', quantity: 1, unit_price_cents: 80_000, account_id: account('5000').id, vendor_id: vendorId }],
  }).id);
  assert.equal(invoiceService.getInvoice(db, booking.invoice_id).items[0].account_code, '4000');

  const visa = visaService.submitVisa(db, visaService.createVisa(db, {
    customer_id: customerId,
    application_date: '2026-08-02',
    sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 30_000, account_id: account('4320').id }],
  }).id);
  assert.equal(invoiceService.getInvoice(db, visa.invoice_id).items[0].account_code, '4320');

  bookingService.cancelBooking(db, booking.id, { cancellation_date: '2026-08-03', customer_charges_cents: 20_000 });
  const cancellation = cancellationService.getCancellationForSource(db, 'booking', booking.id);
  assert.ok(cancellation.cancellation_invoice_id, 'the charges invoice is still created');

  // Sent invoices made before the rule keep working: they can still be paid.
  const legacyId = Number(db.prepare(`
    INSERT INTO invoices (number, customer_id, issue_date, due_date, status, subtotal_cents, total_cents)
    VALUES ('INV-LEGACY-1', ?, '2026-08-01', '2026-08-01', 'sent', 5000, 5000)
  `).run(customerId).lastInsertRowid);
  db.prepare('INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, amount_cents, account_id) VALUES (?, ?, 1, 5000, 5000, ?)')
    .run(legacyId, 'Old ticket', account('4000').id);
  const paid = invoiceService.recordInvoicePayment(db, legacyId, {
    amount_cents: 5_000, payment_date: '2026-08-04', deposit_account_id: account('1000').id,
  });
  assert.equal(paid.status_display, 'paid');
});

test('the DSR shows service invoices as income with no supplier cost', () => {
  const report = dailySales.dailySales(db, '2026-08-01', '2026-08-31');
  const service = report.days.flatMap((day) => day.rows).filter((row) => row.kind === 'direct');
  assert.ok(service.length > 0);
  assert.ok(service.every((row) => row.cost_cents === 0 && row.margin_cents === row.sale_cents));
});
