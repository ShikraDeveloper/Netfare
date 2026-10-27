'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-visa-groups-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const visaService = require('../server/services/visas');
const invoiceService = require('../server/services/invoices');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Ahmed Family')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('VFS Global')").run().lastInsertRowid);

function applicant(name, { sale = 45_000, cost = 38_000, isCustomer = false } = {}) {
  return {
    applicant_is_customer: isCustomer,
    applicant_name: name,
    passport_number: `P-${name.replace(/\W/g, '').toUpperCase()}`,
    sale_items: [{ description: 'Tourist visa · Schengen', quantity: 1, unit_price_cents: sale, account_id: account('4320').id }],
    cost_items: cost ? [{ description: 'Tourist visa · Schengen', quantity: 1, unit_price_cents: cost, account_id: account('5120').id, vendor_id: vendorId }] : [],
  };
}

function groupPayload(applicants, extra = {}) {
  return {
    customer_id: customerId,
    application_date: '2026-09-10',
    visa_type: 'tourist',
    destination_country: 'Schengen',
    notes: 'Shared note',
    applicants,
    ...extra,
  };
}

function assertBadRequest(fn, pattern) {
  assert.throws(fn, (error) => error.status === 400 && pattern.test(error.message));
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('several applicants become linked applications that share the trip details', () => {
  const { group, applications } = visaService.createVisaGroup(db, groupPayload([
    applicant('Ahmed Family', { isCustomer: true }),
    applicant('Sara Ahmed'),
    applicant('Omar Ahmed', { sale: 30_000, cost: 0 }),
  ]));
  assert.match(group.number, /^VG-/);
  assert.equal(group.size, 3);
  assert.equal(group.draft_count, 3);
  assert.deepEqual(applications.map((visa) => visa.applicant_name), ['Ahmed Family', 'Sara Ahmed', 'Omar Ahmed']);
  for (const visa of applications) {
    assert.equal(visa.status, 'draft');
    assert.equal(visa.destination_country, 'Schengen');
    assert.equal(visa.notes, 'Shared note');
    assert.equal(visa.group_number, group.number);
    assert.equal(visa.group_size, 3);
  }
  assert.equal(applications[2].cost_total_cents, 0, 'an applicant may have no supplier cost');
  const detail = visaService.getVisa(db, applications[1].id);
  assert.deepEqual(detail.group.applications.map((row) => row.applicant_name), ['Ahmed Family', 'Sara Ahmed', 'Omar Ahmed']);
});

test('one applicant creates a plain application with no group', () => {
  const { group, applications } = visaService.createVisaGroup(db, groupPayload([applicant('Solo Traveller')]));
  assert.equal(group, null);
  assert.equal(applications.length, 1);
  assert.equal(visaService.getVisa(db, applications[0].id).group, null);
});

test('a problem with one applicant saves nothing and names the applicant', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM visa_applications').get().n;
  const groupsBefore = db.prepare('SELECT COUNT(*) AS n FROM visa_groups').get().n;
  assertBadRequest(
    () => visaService.createVisaGroup(db, groupPayload([applicant('Good One'), { ...applicant(''), applicant_name: '  ' }])),
    /^Applicant 2:/,
  );
  const missingSupplier = applicant('No Supplier');
  delete missingSupplier.cost_items[0].vendor_id;
  assertBadRequest(() => visaService.createVisaGroup(db, groupPayload([applicant('Good One'), missingSupplier])), /^Applicant 2:/);
  assertBadRequest(() => visaService.createVisaGroup(db, groupPayload([])), /at least one applicant/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visa_applications').get().n, before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visa_groups').get().n, groupsBefore);
});

test('submit all posts one invoice per applicant and leaves the others alone when one is already submitted', () => {
  const { group, applications } = visaService.createVisaGroup(db, groupPayload([
    applicant('Group A One'),
    applicant('Group A Two'),
  ], { application_date: '2026-09-12' }));
  visaService.submitVisa(db, applications[0].id);
  const result = visaService.submitVisaGroup(db, group.id);
  assert.deepEqual(result.submitted, [applications[1].id], 'only the remaining draft is submitted');
  assert.equal(result.group.draft_count, 0);
  const invoices = applications.map((visa) => invoiceService.getInvoice(db, visaService.getVisa(db, visa.id).invoice_id));
  assert.notEqual(invoices[0].id, invoices[1].id);
  assert.ok(invoices.every((invoice) => invoice.total_cents === 45_000 && invoice.customer_id === customerId));
  assertBadRequest(() => visaService.submitVisaGroup(db, group.id), /no draft applications/);
});

test('rejecting one application in a group does not touch the others', () => {
  const { applications } = visaService.createVisaGroup(db, groupPayload([
    applicant('Group B One'),
    applicant('Group B Two'),
  ], { application_date: '2026-09-14' }));
  for (const visa of applications) visaService.submitVisa(db, visa.id);
  visaService.rejectVisa(db, applications[0].id, { reason: 'Embassy refused', rejection_date: '2026-09-20' });
  assert.equal(visaService.getVisa(db, applications[0].id).status, 'rejected');
  assert.equal(visaService.getVisa(db, applications[1].id).status, 'submitted');
});
