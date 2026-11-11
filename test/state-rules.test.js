'use strict';

// A status that follows from the amounts must not depend on the order things
// were done in, and every screen must show the same status for a record.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-state-rules-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const invoiceService = require('../server/services/invoices');
const advances = require('../server/services/advances');
const refunds = require('../server/services/refunds');
const customerBalances = require('../server/services/customer-balances');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const account = (code) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
const customer = (name) => Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
const invoice = (customerId, amount, due = '2026-11-01') => invoiceService.createInvoice(db, {
  customer_id: customerId, issue_date: '2026-11-01', due_date: due, status: 'sent',
  items: [{ description: 'Service', quantity: 1, unit_price_cents: amount, account_id: account('4300') }],
});
const advance = (customerId) => advances.createAdvance(db, {
  customer_id: customerId, amount_cents: 10_000, advance_date: '2026-11-01', deposit_account_id: account('1010'),
});
const status = (id) => db.prepare('SELECT status FROM customer_advances WHERE id = ?').get(id).status;
const refund = (id, amount) => advances.refundAdvance(db, id, { amount_cents: amount, refund_date: '2026-11-02', payment_account_id: account('1010') });

test('an advance used for 70 and refunded 30 has one status, whatever came first', () => {
  const first = customer('Refund First');
  const a = advance(first);
  refund(a.id, 3_000);
  advances.applyAdvance(db, a.id, { invoice_id: invoice(first, 7_000).id, payment_date: '2026-11-02' });

  const second = customer('Apply First');
  const b = advance(second);
  advances.applyAdvance(db, b.id, { invoice_id: invoice(second, 7_000).id, payment_date: '2026-11-02' });
  refund(b.id, 3_000);

  assert.equal(status(a.id), status(b.id));
  assert.equal(status(a.id), 'refunded', 'fully used with a refund in it reads refunded');

  // Undoing the refund leaves 30 open again, the same for both.
  for (const id of [a.id, b.id]) {
    const row = db.prepare("SELECT id FROM refunds WHERE advance_id = ? AND status = 'paid'").get(id);
    refunds.voidRefund(db, row.id, { remarks: 'Undo' });
    assert.equal(status(id), 'open');
  }
});

test('the customer page shows the same invoice status as everywhere else', () => {
  const id = customer('Part Paid');
  const notDue = invoice(id, 10_000, '2099-12-31');
  invoiceService.recordInvoicePayment(db, notDue.id, { amount_cents: 4_000, payment_date: '2026-11-02', method: 'Cash', deposit_account_id: account('1000') });
  const late = invoice(id, 5_000, '2026-11-01');

  const page = customerBalances.getCustomerBalance(db, id).open_invoices;
  const shown = Object.fromEntries(page.map((row) => [row.number, row.status_display]));
  assert.equal(shown[invoiceService.getInvoice(db, notDue.id).number], 'partial');
  assert.equal(shown[invoiceService.getInvoice(db, late.id).number], invoiceService.getInvoice(db, late.id).status_display);
});
