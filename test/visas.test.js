'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-visa-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const visaService = require('../server/services/visas');
const invoiceService = require('../server/services/invoices');
const portalService = require('../server/services/portals');
const statements = require('../server/services/statements');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

function insertCustomer(name) {
  return Number(db.prepare('INSERT INTO customers (name) VALUES (?)').run(name).lastInsertRowid);
}

function insertVendor(name) {
  return Number(db.prepare('INSERT INTO vendors (name) VALUES (?)').run(name).lastInsertRowid);
}

function visaPayload(customerId, overrides = {}) {
  return {
    customer_id: customerId,
    application_date: '2026-10-21',
    due_date: '2026-10-21',
    destination_country: 'UAE',
    visa_type: 'tourist',
    sale_items: [{
      description: 'Visa service',
      quantity: 1,
      unit_price_cents: 35_000,
      account_id: account('4320').id,
    }],
    ...overrides,
  };
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('visa applications track whether the applicant is the customer', () => {
  const customerId = insertCustomer('Priya Gulati');

  const customerVisa = visaService.createVisa(db, visaPayload(customerId, {
    applicant_is_customer: true,
    applicant_name: 'Ignored name',
  }));
  assert.equal(customerVisa.applicant_is_customer, 1);
  assert.equal(customerVisa.applicant_name, 'Priya Gulati');

  const visitorVisa = visaService.createVisa(db, visaPayload(customerId, {
    applicant_is_customer: false,
    applicant_name: 'Rahul Visitor',
  }));
  assert.equal(visitorVisa.applicant_is_customer, 0);
  assert.equal(visitorVisa.applicant_name, 'Rahul Visitor');

  const updated = visaService.updateVisa(db, visitorVisa.id, visaPayload(customerId, {
    applicant_is_customer: true,
    applicant_name: 'Rahul Visitor',
  }));
  assert.equal(updated.applicant_is_customer, 1);
  assert.equal(updated.applicant_name, 'Priya Gulati');
});

test('a submitted visa invoice carries the visitor applicant details', () => {
  const customerId = insertCustomer('Sponsor Customer');
  const visitor = visaService.createVisa(db, visaPayload(customerId, {
    applicant_is_customer: false,
    applicant_name: 'Rahul Visitor',
    nationality: 'Indian',
    passport_number: 'P1234567',
    passport_expiry: '2030-05-01',
    date_of_birth: '1990-02-03',
    duration_days: 60,
    reference: 'REF-9',
  }));

  const submitted = visaService.submitVisa(db, visitor.id);
  const invoice = invoiceService.getInvoice(db, submitted.invoice_id);

  assert.equal(invoice.customer_name, 'Sponsor Customer');
  assert.equal(invoice.visa_number, visitor.number);
  assert.equal(invoice.visa_applicant_name, 'Rahul Visitor');
  assert.equal(invoice.visa_applicant_is_customer, 0);
  assert.equal(invoice.visa_nationality, 'Indian');
  assert.equal(invoice.visa_passport_number, 'P1234567');
  assert.equal(invoice.visa_passport_expiry, '2030-05-01');
  assert.equal(invoice.visa_date_of_birth, '1990-02-03');
  assert.equal(invoice.visa_destination_country, 'UAE');
  assert.equal(invoice.visa_type, 'tourist');
  assert.equal(invoice.visa_duration_days, 60);
  assert.equal(invoice.visa_reference, 'REF-9');
  assert.match(invoice.terms, /60 days/);
});

test('customer statement carries the invoice item and visa applicant details', () => {
  const customerId = insertCustomer('Statement Visa Customer');
  const visitor = visaService.createVisa(db, visaPayload(customerId, {
    applicant_is_customer: false,
    applicant_name: 'Statement Visitor',
    nationality: 'Indian',
    passport_number: 'P7654321',
    passport_expiry: '2031-04-05',
    date_of_birth: '1991-06-07',
    duration_days: 30,
    reference: 'REF-STMT',
  }));

  const submitted = visaService.submitVisa(db, visitor.id);
  const statement = statements.customerStatement(db, customerId, {});
  const invoiceRow = statement.transactions.find((row) => row.kind === 'invoice' && row.id === submitted.invoice_id);
  assert.ok(invoiceRow, 'statement should include the submitted invoice');
  assert.equal(invoiceRow.items.length, 1);
  assert.equal(invoiceRow.items[0].description, 'Visa service');
  assert.equal(invoiceRow.items[0].quantity, 1);
  assert.equal(invoiceRow.visa.applicant_name, 'Statement Visitor');
  assert.equal(invoiceRow.visa.applicant_is_customer, 0);
  assert.equal(invoiceRow.visa.nationality, 'Indian');
  assert.equal(invoiceRow.visa.passport_number, 'P7654321');
  assert.equal(invoiceRow.visa.passport_expiry, '2031-04-05');
  assert.equal(invoiceRow.visa.date_of_birth, '1991-06-07');
  assert.equal(invoiceRow.visa.number, visitor.number);
  assert.equal(invoiceRow.visa.visa_type, 'tourist');
  assert.equal(invoiceRow.visa.duration_days, 30);
  assert.equal(invoiceRow.visa.reference, 'REF-STMT');
});

test('portal settlements show the linked visa applicant', () => {
  const customerId = insertCustomer('Portal Visa Customer');
  const vendorId = insertVendor('Portal Visa Supplier');
  const portal = portalService.createPortal(db, {
    name: 'Portal Visa Supplier',
    portal_type: 'visa_agent',
    settlement: 'prepaid',
    vendor_id: vendorId,
  });
  portalService.topUp(db, {
    portal_id: portal.id,
    topup_date: '2026-10-20',
    amount_cents: 30_000,
    deposit_account_id: account('1010').id,
    method: 'Bank transfer',
  });

  const visa = visaService.createVisa(db, visaPayload(customerId, {
    applicant_is_customer: false,
    applicant_name: 'Portal Visitor',
    nationality: 'Pakistani',
    passport_number: 'AX9999999',
    cost_items: [{
      description: 'Visa supplier cost',
      quantity: 1,
      unit_price_cents: 30_000,
      account_id: account('5120').id,
      vendor_id: vendorId,
    }],
  }));
  visaService.submitVisa(db, visa.id);

  const refreshed = portalService.getPortal(db, portal.id);
  assert.equal(refreshed.settlements.length, 1);
  const settlement = refreshed.settlements[0];
  assert.equal(settlement.visa_id, visa.id);
  assert.equal(settlement.visa_number, visa.number);
  assert.equal(settlement.visa_applicant_name, 'Portal Visitor');
  assert.equal(settlement.visa_nationality, 'Pakistani');
  assert.equal(settlement.visa_passport_number, 'AX9999999');
});

test('visa duration is optional, editable and must be whole days', () => {
  const customerId = insertCustomer('Duration Customer');

  const created = visaService.createVisa(db, visaPayload(customerId, { duration_days: 30 }));
  assert.equal(created.duration_days, 30);

  const updated = visaService.updateVisa(db, created.id, visaPayload(customerId, { duration_days: 60 }));
  assert.equal(updated.duration_days, 60);

  const cleared = visaService.updateVisa(db, created.id, visaPayload(customerId, { duration_days: null }));
  assert.equal(cleared.duration_days, 0);

  const defaulted = visaService.createVisa(db, visaPayload(customerId));
  assert.equal(defaulted.duration_days, 0);

  assert.throws(
    () => visaService.createVisa(db, visaPayload(customerId, { duration_days: 1.5 })),
    /whole number of days/i,
  );
  assert.throws(
    () => visaService.createVisa(db, visaPayload(customerId, { duration_days: 0 })),
    /at least 1/i,
  );
});

test('a visitor applicant requires a name', () => {
  const customerId = insertCustomer('Another Customer');
  assert.throws(
    () => visaService.createVisa(db, visaPayload(customerId, {
      applicant_is_customer: false,
      applicant_name: '   ',
    })),
    /enter the visitor name/i,
  );
});

test('older callers without the applicant flag keep the previous behaviour', () => {
  const customerId = insertCustomer('Legacy Caller Customer');

  const named = visaService.createVisa(db, visaPayload(customerId, {
    applicant_name: 'Legacy Visitor',
  }));
  assert.equal(named.applicant_is_customer, 0);
  assert.equal(named.applicant_name, 'Legacy Visitor');

  const defaulted = visaService.createVisa(db, visaPayload(customerId));
  assert.equal(defaulted.applicant_is_customer, 1);
  assert.equal(defaulted.applicant_name, 'Legacy Caller Customer');
});
