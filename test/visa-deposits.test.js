'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-visa-deposits-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const visaService = require('../server/services/visas');
const invoiceService = require('../server/services/invoices');
const deposits = require('../server/services/visa-deposits');
const reconciliation = require('../server/services/reconciliation');
const statements = require('../server/services/statements');
const { dailySales } = require('../server/services/reports/daily-sales');

function account(code) {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  assert.ok(row, `account ${code} exists`);
  return row;
}

function balance(code) {
  return db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ?
  `).get(code).total;
}

function assertBadRequest(fn, pattern) {
  assert.throws(fn, (error) => error.status === 400 && pattern.test(error.message));
}

function assertChecksMatch() {
  const checks = reconciliation.reconciliationSummary(db).checks;
  for (const key of ['visa_deposits', 'deposits_with_suppliers', 'trial_balance', 'receivables']) {
    const check = checks.find((item) => item.key === key);
    assert.equal(check.matched, true, `${key} ledger check matches (${check.ledger_cents} vs ${check.documents_cents})`);
  }
}

const customerId = Number(db.prepare("INSERT INTO customers (name) VALUES ('Deposit Sponsor')").run().lastInsertRowid);
const vendorId = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Visa Agent')").run().lastInsertRowid);
const cash = () => account('1000').id;
const bank = () => account('1010').id;

function visa(name, date = '2026-11-01') {
  return visaService.createVisa(db, {
    customer_id: customerId,
    application_date: date,
    applicant_is_customer: false,
    applicant_name: name,
    destination_country: 'UAE',
    sale_items: [{ description: 'Visit visa', quantity: 1, unit_price_cents: 35_000, account_id: account('4320').id }],
  });
}

function take(visaId, amount = 400_000, date = '2026-11-01') {
  return deposits.collectDeposit(db, { visa_id: visaId, amount_cents: amount, deposit_date: date, account_id: cash(), method: 'Cash' });
}

after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the three deposit accounts exist as system accounts', () => {
  for (const code of ['1460', '2600', '4340']) assert.equal(account(code).is_system, 1);
});

test('a deposit is held in 2600, not counted as a sale, and refunded in full', () => {
  const v = visa('Full Refund');
  const salesBefore = balance('4320');
  const dep = take(v.id);
  assert.match(dep.number, /^SD-2026-/);
  assert.deepEqual([dep.held_cents, dep.in_hand_cents, dep.status], [400_000, 400_000, 'held']);
  assert.equal(balance('2600'), -400_000);
  assert.equal(balance('4320'), salesBefore, 'no revenue');
  const done = deposits.refundDeposit(db, dep.id, { account_id: cash(), event_date: '2026-11-12', method: 'Cash' });
  assert.deepEqual([done.held_cents, done.refunded_cents, done.status], [0, 400_000, 'settled']);
  assert.equal(balance('2600'), 0);
  const refund = db.prepare('SELECT * FROM refunds WHERE deposit_id = ?').get(dep.id);
  assert.equal(refund.amount_cents, 400_000);
  assertChecksMatch();
});

test('a deposit passed to the supplier comes back less a fine, and the rest is refunded', () => {
  const v = visa('Supplier Route');
  const dep = take(v.id);
  const sent = deposits.payToSupplier(db, dep.id, { vendor_id: vendorId, account_id: bank(), event_date: '2026-11-02' });
  assert.deepEqual([sent.with_supplier_cents, sent.in_hand_cents, sent.status], [400_000, 0, 'with_supplier']);
  assertBadRequest(() => deposits.refundDeposit(db, dep.id, { account_id: cash() }), /still with the supplier/);
  assertChecksMatch();

  const back = deposits.supplierReturn(db, dep.id, {
    amount_cents: 400_000, deduction_cents: 50_000, account_id: bank(), event_date: '2026-11-10', notes: 'Overstay 2 days',
  });
  assert.deepEqual(
    [back.with_supplier_cents, back.supplier_deductions_cents, back.held_cents, back.in_hand_cents],
    [0, 50_000, 350_000, 350_000],
  );
  const done = deposits.refundDeposit(db, dep.id, { account_id: cash(), event_date: '2026-11-11' });
  assert.deepEqual([done.held_cents, done.status], [0, 'settled']);
  assertChecksMatch();
});

test('a deposit can pay an open invoice', () => {
  const v = visaService.submitVisa(db, visa('Apply Route').id);
  const dep = take(v.id, 100_000);
  const used = deposits.applyToInvoice(db, dep.id, { invoice_id: v.invoice_id, event_date: '2026-11-03' });
  assert.equal(used.applied_cents, 35_000, 'only the invoice balance');
  assert.equal(used.held_cents, 65_000);
  const invoice = invoiceService.getInvoice(db, v.invoice_id);
  assert.equal(invoice.status_display, 'paid');
  assert.equal(invoice.payments.at(-1).method, 'Deposit applied');
  assertBadRequest(() => deposits.applyToInvoice(db, dep.id, { invoice_id: v.invoice_id }), /already fully paid/);
  assertChecksMatch();
});

test('forfeits post to 4340 when we keep it, or clear 1460 when the supplier keeps it', () => {
  const ours = take(visa('Absconded').id, 200_000);
  assertBadRequest(() => deposits.forfeitDeposit(db, ours.id, { forfeit_to: 'agency' }), /reason/);
  const incomeBefore = balance('4340');
  const kept = deposits.forfeitDeposit(db, ours.id, { forfeit_to: 'agency', amount_cents: 150_000, notes: 'Visitor absconded', event_date: '2026-11-15' });
  assert.equal(balance('4340') - incomeBefore, -150_000, 'income credited');
  assert.deepEqual([kept.held_cents, kept.forfeited_income_cents], [50_000, 150_000]);

  const theirs = take(visa('Supplier Kept').id, 300_000);
  deposits.payToSupplier(db, theirs.id, { vendor_id: vendorId, account_id: bank(), event_date: '2026-11-02' });
  const lost = deposits.forfeitDeposit(db, theirs.id, { forfeit_to: 'supplier', notes: 'Immigration kept it', event_date: '2026-11-20' });
  assert.deepEqual([lost.held_cents, lost.with_supplier_cents, lost.status], [0, 0, 'forfeited']);
  assert.equal(balance('4340') - incomeBefore, -150_000, 'no income when the supplier kept it');
  assertChecksMatch();
});

test('voiding steps reverses them one at a time, and the first step voids the deposit', () => {
  const dep = take(visa('Void Steps').id, 120_000);
  deposits.refundDeposit(db, dep.id, { account_id: cash(), amount_cents: 20_000, event_date: '2026-11-04' });
  assertBadRequest(() => deposits.voidLastEvent(db, dep.id, {}), /reason/);
  const afterRefundVoid = deposits.voidLastEvent(db, dep.id, { remarks: 'Wrong amount' });
  assert.equal(afterRefundVoid.held_cents, 120_000);
  assert.equal(db.prepare('SELECT status FROM refunds WHERE deposit_id = ?').get(dep.id).status, 'void');
  const gone = deposits.voidLastEvent(db, dep.id, { remarks: 'Entered twice' });
  assert.ok(gone.voided_at);
  assert.equal(gone.status, 'void');
  assertChecksMatch();
});

test('taking more back than is held is refused, and cancelled visas take no new deposit', () => {
  const dep = take(visa('Limits').id, 50_000);
  assertBadRequest(() => deposits.refundDeposit(db, dep.id, { account_id: cash(), amount_cents: 60_000 }), /Only 500\.00/);
  assertBadRequest(() => deposits.supplierReturn(db, dep.id, { account_id: cash() }), /supplier holds 0\.00/);
  const v = visa('Cancelled Visa');
  visaService.cancelVisa(db, v.id, { cancellation_date: '2026-11-05' });
  assertBadRequest(() => take(v.id), /cancelled or rejected/);
});

test('deposits entered with a new visa group are recorded per applicant', () => {
  const { applications } = visaService.createVisaGroup(db, {
    customer_id: customerId,
    application_date: '2026-11-06',
    destination_country: 'UAE',
    deposit: { account_id: cash(), method: 'Cash' },
    applicants: [
      { applicant_name: 'Group One', deposit_cents: 150_000, sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 30_000, account_id: account('4320').id }] },
      { applicant_name: 'Group Two', sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 30_000, account_id: account('4320').id }] },
    ],
  });
  assert.deepEqual(applications.map((row) => row.deposits.length), [1, 0]);
  assert.equal(applications[0].deposits[0].held_cents, 150_000);
});

test('the DSR counts a deposit once when it is taken and used for the invoice in the same period', () => {
  const day = '2026-11-10';
  const v = visaService.submitVisa(db, visa('Same Day Visa', day).id);
  const dep = take(v.id, 200_000, day);
  deposits.applyToInvoice(db, dep.id, { invoice_id: v.invoice_id, event_date: day });
  const sections = dailySales(db, day, day).sections;
  const row = sections.visas.find((item) => item.reference_id === v.id);
  assert.deepEqual(row.split, { cash: 200_000, card: 0, bank: 0, other: 0, credit: 0 }, 'the 2,000 received once, the 350 sale not on credit');
  assert.equal(sections.summary.settlement.other, 0, 'not shown again as advance / credit');
});

test('the DSR shows the deposit on the visa row and the statement keeps a separate deposit balance', () => {
  const day = '2026-11-11';
  const v = visaService.submitVisa(db, visa('Report Visa', day).id);
  invoiceService.recordInvoicePayment(db, v.invoice_id, { amount_cents: 35_000, payment_date: day, deposit_account_id: cash(), method: 'Cash' });
  const dep = take(v.id, 200_000, day);
  const sections = dailySales(db, day, day).sections;
  const row = sections.visas.find((item) => item.reference_id === v.id);
  assert.equal(row.deposit_cents, 200_000);
  assert.equal(row.split.cash, 235_000, 'fee and deposit both counted as cash received');
  assert.equal(row.split.credit, 0);
  assert.equal(sections.summary.deposits.received_cents, 200_000);
  assert.equal(sections.summary.sales.visas_cents, 35_000, 'the deposit is not a sale');

  const refundDay = '2026-11-12';
  deposits.refundDeposit(db, dep.id, { account_id: cash(), event_date: refundDay, method: 'Cash' });
  const refunds = dailySales(db, refundDay, refundDay).sections.refunds;
  assert.ok(refunds.some((item) => item.against === `Visa deposit ${dep.number}` && item.amount_cents === 200_000));

  const statement = statements.customerStatement(db, customerId, { from: day, to: '2026-12-31' });
  const deps = statement.deposits.transactions.filter((item) => item.reference === dep.number);
  assert.deepEqual(deps.map((item) => [item.event_type, item.credit_cents, item.debit_cents]), [['collect', 200_000, 0], ['refund', 0, 200_000]]);
  assert.ok(!statement.transactions.some((item) => item.reference === dep.number), 'deposits stay out of the invoice balance');
});

test('a deposit can be paid from a prepaid portal wallet and returned into it', () => {
  const portalService = require('../server/services/portals');
  const portal = portalService.createPortal(db, { name: 'Visa Agent Wallet', portal_type: 'visa_agent', settlement: 'prepaid', vendor_id: vendorId });
  portalService.topUp(db, { portal_id: portal.id, topup_date: '2026-11-01', amount_cents: 500_000, deposit_account_id: bank(), method: 'Bank transfer' });
  const bankBefore = balance('1010');
  const v = visa('Wallet Deposit');
  const dep = take(v.id, 300_000);

  assertBadRequest(
    () => deposits.payToSupplier(db, dep.id, { portal_id: portal.id, event_date: '2026-10-01' }),
    /before|date/i,
  );
  const sent = deposits.payToSupplier(db, dep.id, { portal_id: portal.id, event_date: '2026-11-02' });
  assert.equal(sent.with_supplier_cents, 300_000);
  assert.equal(portalService.getPortal(db, portal.id).balance_cents, 200_000, 'the wallet pays it');
  assert.equal(balance('1010'), bankBefore, 'no bank payment');
  assertChecksMatch();
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true, '1400 still matches the wallets');

  const ledger = portalService.portalLedger(db, portal.id);
  assert.ok(ledger.rows.some((row) => row.kind === 'deposit_paid' && row.credit_cents === 300_000));
  assert.equal(ledger.reconciliation.difference_cents, 0);

  deposits.supplierReturn(db, dep.id, { amount_cents: 300_000, deduction_cents: 20_000, event_date: '2026-11-20', to_wallet: true });
  assert.equal(portalService.getPortal(db, portal.id).balance_cents, 480_000, 'the net comes back to the wallet');
  assertChecksMatch();
  assert.equal(reconciliation.reconciliationSummary(db).all_matched, true);

  assertBadRequest(
    () => deposits.payToSupplier(db, take(visa('Too Big').id, 900_000).id, { portal_id: portal.id, event_date: '2026-11-21' }),
    /only .* available/i,
  );
});

test("a deposit put on a credit supplier's account is a bill on their statement, paid later, and voids cleanly", () => {
  const bills = require('../server/services/bills');
  const corrections = require('../server/services/corrections');
  const { paySupplier } = require('../server/services/supplier-payments');
  const v = visa('On Account');
  const dep = take(v.id, 204_000, '2026-11-26');
  const bankBefore = balance('1010');
  const sent = deposits.payToSupplier(db, dep.id, { vendor_id: vendorId, on_account: true, event_date: '2026-11-26' });
  assert.deepEqual([sent.with_supplier_cents, sent.in_hand_cents], [204_000, 0]);
  assert.equal(balance('1010'), bankBefore, 'no money moves now');
  const event = sent.events.find((e) => e.event_type === 'to_supplier' && !e.voided_at);
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(event.bill_id);
  assert.deepEqual([bill.vendor_id, bill.total_cents, bill.status, bill.visa_id], [vendorId, 204_000, 'received', null], 'not a visa cost');
  assert.equal(event.reference, bill.number);
  const line = statements.vendorStatement(db, vendorId, {}).transactions.find((row) => row.reference === bill.number || row.number === bill.number);
  assert.ok(line, 'the deposit is on the supplier statement');
  assert.match(JSON.stringify(line), /Security deposit .*On Account/);
  assertChecksMatch();

  assertBadRequest(() => deposits.supplierReturn(db, dep.id, { account_id: bank(), event_date: '2026-11-26' }), /not paid yet/);
  assert.equal(balance('1010'), bankBefore, 'no return of money we never paid');
  assertBadRequest(() => bills.voidBill(db, bill.id, { remarks: 'x' }), /security deposit .* deposit card/i);
  assertBadRequest(() => corrections.correctDocument(db, 'bill', bill.id, { remarks: 'x' }), /security deposit/i);

  // Paid with Pay supplier like any bill; then the step can't be voided until that payment is.
  const payment = paySupplier(db, {
    vendor_id: vendorId, payment_date: '2026-11-26', amount_cents: 204_000, payment_account_id: bank(), method: 'Bank transfer',
    allocations: [{ bill_id: bill.id, amount_cents: 204_000 }],
  });
  assert.equal(balance('1010'), bankBefore - 204_000, 'the bank pays when HolidaySpace is paid');
  assertBadRequest(() => deposits.voidLastEvent(db, dep.id, { remarks: 'Wrong' }), /already paid/);
  // Once paid, a return into the bank is fine; voiding it puts the step back.
  deposits.supplierReturn(db, dep.id, { account_id: bank(), event_date: '2026-11-26' });
  deposits.voidLastEvent(db, dep.id, { remarks: 'Not yet back' });
  require('../server/services/supplier-payments').voidSupplierPayment(db, payment.id, { remarks: 'Sent twice' });
  const undone = deposits.voidLastEvent(db, dep.id, { remarks: 'Wrong supplier' });
  assert.deepEqual([undone.in_hand_cents, undone.with_supplier_cents], [204_000, 0]);
  assert.equal(db.prepare('SELECT status FROM bills WHERE id = ?').get(bill.id).status, 'void');
  assertChecksMatch();
});

test('a deposit not received yet waits as due, then is received with the invoice in one payment', () => {
  const advances = require('../server/services/advances');
  const { applications } = visaService.createVisaGroup(db, {
    customer_id: customerId, application_date: '2026-11-26', destination_country: 'UAE',
    deposit: { not_received: true },
    applicants: [{ applicant_name: 'Due Later', deposit_cents: 204_000, sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 103_000, account_id: account('4320').id }] }],
  });
  const [due] = applications[0].deposits;
  assert.deepEqual([due.status, due.held_cents, due.events.length], ['due', 0, 0], 'no money, no entry');
  assertBadRequest(() => deposits.payToSupplier(db, due.id, { vendor_id: vendorId, on_account: true }), /in hand/);
  assertChecksMatch();

  const submitted = db.prepare('SELECT * FROM invoices WHERE id = ?').get(visaService.submitVisa(db, applications[0].id).invoice_id);
  const bankBefore = balance('1010');
  const result = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 307_000, receipt_date: '2026-11-26', method: 'Bank transfer', deposit_account_id: bank(),
    allocations: [{ invoice_id: submitted.id, amount_cents: 103_000 }], deposits: [due.id],
  });
  assert.equal(balance('1010'), bankBefore + 307_000, 'the bank gets the whole 3,070');
  assert.equal(result.amount_cents, 103_000, 'the receipt is the invoice part');
  assert.deepEqual(result.deposits.map((d) => d.number), [due.number]);
  const received = deposits.getDeposit(db, due.id);
  assert.deepEqual([received.status, received.held_cents, received.events[0].reference], ['held', 204_000, result.number]);
  assert.equal(db.prepare('SELECT amount_paid_cents FROM invoices WHERE id = ?').get(submitted.id).amount_paid_cents, 103_000);
  assertBadRequest(() => advances.receivePayment(db, { customer_id: customerId, amount_cents: 204_000, deposit_account_id: bank(), deposits: [due.id] }), /not due/);
  assertChecksMatch();

  // A deposit alone is received without a receipt; a due one can be dropped.
  const alone = deposits.collectDeposit(db, { visa_id: visa('Alone').id, amount_cents: 50_000, deposit_date: '2026-11-26', not_received: true });
  const onlyDeposit = advances.receivePayment(db, { customer_id: customerId, amount_cents: 50_000, receipt_date: '2026-11-26', method: 'Cash', deposit_account_id: cash(), deposits: [alone.id] });
  assert.deepEqual([onlyDeposit.id, deposits.getDeposit(db, alone.id).held_cents], [null, 50_000]);
  const dropped = deposits.collectDeposit(db, { visa_id: visa('Dropped').id, amount_cents: 10_000, deposit_date: '2026-11-26', not_received: true });
  assert.equal(deposits.voidLastEvent(db, dropped.id, { remarks: 'Not needed' }).status, 'void');
  assertChecksMatch();
});

test('"with the visa to the supplier": sent on submit onto a credit account, or from a wallet; otherwise it stays with a warning', () => {
  const portals = require('../server/services/portals');
  const creditVendor = Number(db.prepare("INSERT INTO vendors (name) VALUES ('Credit Visa Co')").run().lastInsertRowid);
  portals.createPortal(db, { name: 'Credit Visa Co', portal_type: 'visa_agent', settlement: 'credit', vendor_id: creditVendor });
  const plainVendor = Number(db.prepare("INSERT INTO vendors (name) VALUES ('No Portal Visa Co')").run().lastInsertRowid);
  const group = (name, vendor, deposit) => visaService.createVisaGroup(db, {
    customer_id: customerId, application_date: '2026-11-26', destination_country: 'UAE', deposit: { ...deposit, send_with_visa: true },
    applicants: [{
      applicant_name: name, deposit_cents: 204_000,
      sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 103_000, account_id: account('4320').id }],
      cost_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 100_000, account_id: account('5120').id, vendor_id: vendor }],
    }],
  }).applications[0];

  const bankBefore = balance('1010');
  const onCredit = group('With Credit', creditVendor, { account_id: bank(), method: 'Bank transfer' });
  assert.equal(deposits.getDeposit(db, onCredit.deposits[0].id).in_hand_cents, 204_000, 'nothing goes before submit');
  const submitted = visaService.submitVisa(db, onCredit.id);
  const sent = deposits.getDeposit(db, onCredit.deposits[0].id);
  assert.deepEqual([sent.with_supplier_cents, sent.events.at(-1).method], [204_000, 'On account']);
  assert.equal(balance('1010'), bankBefore + 204_000, 'received into the bank, nothing paid out');
  assert.equal(db.prepare('SELECT vendor_id FROM bills WHERE id = ?').get(sent.events.at(-1).bill_id).vendor_id, creditVendor);
  assert.ok(!(submitted.warnings || []).some((w) => /stays with you/.test(w)));

  const noPortal = group('No Portal', plainVendor, { account_id: bank(), method: 'Bank transfer' });
  const result = visaService.submitVisa(db, noPortal.id);
  assert.ok(result.warnings.some((w) => /stays with you: the supplier has no portal account/.test(w)));
  assert.equal(deposits.getDeposit(db, noPortal.deposits[0].id).in_hand_cents, 204_000);

  // Not received yet: it goes once the customer pays, as the visa is already in.
  const due = group('Due Then Sent', creditVendor, { not_received: true });
  visaService.submitVisa(db, due.id);
  assert.equal(deposits.getDeposit(db, due.deposits[0].id).status, 'due');
  const later = deposits.receiveDeposit(db, due.deposits[0].id, { account_id: bank(), method: 'Bank transfer', event_date: '2026-11-26' });
  assert.equal(later.with_supplier_cents, 204_000);
  assertChecksMatch();
});

test('voiding the receipt puts its deposit back to due; a due deposit of a rejected visa cannot be received', () => {
  const advances = require('../server/services/advances');
  const make = (name) => visaService.createVisaGroup(db, {
    customer_id: customerId, application_date: '2026-11-26', destination_country: 'UAE', deposit: { not_received: true },
    applicants: [{ applicant_name: name, deposit_cents: 60_000, sale_items: [{ description: 'Visa', quantity: 1, unit_price_cents: 20_000, account_id: account('4320').id }] }],
  }).applications[0];
  const v = make('Receipt Voided');
  const invoiceId = visaService.submitVisa(db, v.id).invoice_id;
  const bankBefore = balance('1010');
  const receipt = advances.receivePayment(db, {
    customer_id: customerId, amount_cents: 80_000, receipt_date: '2026-11-26', method: 'Bank transfer', deposit_account_id: bank(),
    allocations: [{ invoice_id: invoiceId, amount_cents: 20_000 }], deposits: [v.deposits[0].id],
  });
  advances.voidAdvance(db, receipt.id, { remarks: 'Wrong customer' });
  assert.equal(balance('1010'), bankBefore, 'both parts undone');
  assert.equal(deposits.getDeposit(db, v.deposits[0].id).status, 'due');
  assertChecksMatch();

  const rejected = make('Rejected Later');
  visaService.submitVisa(db, rejected.id);
  visaService.rejectVisa(db, rejected.id, { reason: 'Refused' });
  assertBadRequest(() => deposits.receiveDeposit(db, rejected.deposits[0].id, { account_id: bank() }), /rejected: drop deposit/);
  assert.ok(!deposits.listDeposits(db, { customer_id: customerId, status: 'due' }).some((d) => d.id === rejected.deposits[0].id), 'not offered in Receive payment');
  assert.ok(deposits.listDeposits(db, { customer_id: customerId, status: 'due' }).some((d) => d.id === v.deposits[0].id));
});
