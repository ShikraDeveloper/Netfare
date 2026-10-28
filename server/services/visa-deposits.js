'use strict';

const { bad, notFound, optionalStr, cents, dateISO, todayISO } = require('../util');
const { systemAccount, isCashAccount, postEntry, reverseEntry, SYSTEM_CODES } = require('../accounting');
const { allocateNumber } = require('./numbering');
const audit = require('./audit');

// Visa security deposits. A deposit is the customer's money, not a sale:
//   collect          Dr cash/bank            Cr 2600 deposits held
//   to_supplier      Dr 1460 with suppliers  Cr cash/bank
//   supplier_return  Dr cash/bank (net)      Cr 1460 (gross); a deduction is
//                    Dr 2600 (the customer bears the supplier's fine)
//   refund           Dr 2600                 Cr cash/bank
//   apply            Dr 2600                 Cr 1100 (pays an open invoice)
//   forfeit          Dr 2600                 Cr 4340 (we keep it) or Cr 1460 (supplier kept it)
// Balances are always worked out from the events, so voiding one is simple.

const EVENT_LABELS = {
  collect: 'Deposit received',
  to_supplier: 'Paid to supplier',
  supplier_return: 'Returned by supplier',
  refund: 'Refunded to customer',
  apply: 'Applied to invoice',
  forfeit: 'Forfeited',
};

function cashAccount(db, accountId, label) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!account) throw bad(`Choose the ${label}`);
  if (!account.is_active) throw bad('That account is archived');
  if (!isCashAccount(account)) throw bad(`The ${label} must be a cash or bank account`);
  return account;
}

function accounts(db) {
  return {
    held: systemAccount(db, SYSTEM_CODES.VISA_DEPOSITS, 'Visa Security Deposits Held'),
    withSuppliers: systemAccount(db, SYSTEM_CODES.DEPOSITS_WITH_SUPPLIERS, 'Deposits with Suppliers'),
    forfeited: systemAccount(db, SYSTEM_CODES.FORFEITED_DEPOSITS, 'Forfeited Deposit Income'),
    ar: systemAccount(db, SYSTEM_CODES.AR, 'Accounts Receivable'),
  };
}

// Running position of one deposit from its active events.
function position(deposit, events) {
  const active = events.filter((event) => !event.voided_at);
  const total = (type, pick = (event) => event.amount_cents) => active
    .filter((event) => event.event_type === type).reduce((sum, event) => sum + pick(event), 0);
  const collected = total('collect');
  const toSupplier = total('to_supplier');
  const returned = total('supplier_return');
  const deductions = total('supplier_return', (event) => event.deduction_cents);
  const refunded = total('refund');
  const applied = total('apply');
  const forfeitedAgency = active.filter((e) => e.event_type === 'forfeit' && e.forfeit_to === 'agency').reduce((s, e) => s + e.amount_cents, 0);
  const forfeitedSupplier = active.filter((e) => e.event_type === 'forfeit' && e.forfeit_to === 'supplier').reduce((s, e) => s + e.amount_cents, 0);
  const held = collected - refunded - applied - forfeitedAgency - forfeitedSupplier - deductions;
  const withSupplier = toSupplier - returned - forfeitedSupplier;
  return {
    collected_cents: collected,
    to_supplier_cents: toSupplier,
    supplier_returned_cents: returned - deductions,
    supplier_deductions_cents: deductions,
    refunded_cents: refunded,
    applied_cents: applied,
    forfeited_cents: forfeitedAgency + forfeitedSupplier + deductions,
    forfeited_income_cents: forfeitedAgency,
    held_cents: held,
    with_supplier_cents: withSupplier,
    in_hand_cents: held - withSupplier,
  };
}

function statusOf(deposit, pos) {
  if (deposit.voided_at) return 'void';
  if (pos.held_cents <= 0) {
    if (pos.forfeited_cents && !pos.refunded_cents && !pos.applied_cents) return 'forfeited';
    return 'settled';
  }
  if (pos.with_supplier_cents > 0) return 'with_supplier';
  return 'held';
}

const depositSelect = `
  SELECT d.*, c.name AS customer_name, v.number AS visa_number, v.applicant_name,
         v.status AS visa_status, v.destination_country, v.travel_date
  FROM visa_deposits d
  JOIN customers c ON c.id = d.customer_id
  JOIN visa_applications v ON v.id = d.visa_id
`;

function eventsFor(db, depositIds) {
  if (!depositIds.length) return new Map();
  const rows = db.prepare(`
    SELECT e.*, a.name AS account_name, vd.name AS vendor_name, i.number AS invoice_number,
           r.number AS refund_number, p.number AS payment_number
    FROM visa_deposit_events e
    LEFT JOIN accounts a ON a.id = e.account_id
    LEFT JOIN vendors vd ON vd.id = e.vendor_id
    LEFT JOIN invoices i ON i.id = e.invoice_id
    LEFT JOIN refunds r ON r.id = e.refund_id
    LEFT JOIN payments p ON p.id = e.payment_id
    WHERE e.deposit_id IN (${depositIds.map(() => '?').join(',')})
    ORDER BY e.event_date, e.id
  `).all(...depositIds);
  const byDeposit = new Map();
  for (const row of rows) {
    if (!byDeposit.has(row.deposit_id)) byDeposit.set(row.deposit_id, []);
    byDeposit.get(row.deposit_id).push({ ...row, label: EVENT_LABELS[row.event_type] });
  }
  return byDeposit;
}

function serialize(deposit, events = []) {
  const pos = position(deposit, events);
  return { ...deposit, ...pos, status: statusOf(deposit, pos), events };
}

function getDeposit(db, id) {
  const deposit = db.prepare(`${depositSelect} WHERE d.id = ?`).get(Number(id));
  if (!deposit) throw notFound('Deposit not found');
  return serialize(deposit, eventsFor(db, [deposit.id]).get(deposit.id) || []);
}

function listDeposits(db, { visa_id, customer_id, status, search } = {}) {
  const clauses = [];
  const params = [];
  if (visa_id) { clauses.push('d.visa_id = ?'); params.push(Number(visa_id)); }
  if (customer_id) { clauses.push('d.customer_id = ?'); params.push(Number(customer_id)); }
  if (search) {
    clauses.push('(d.number LIKE ? OR c.name LIKE ? OR v.number LIKE ? OR v.applicant_name LIKE ?)');
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`${depositSelect} ${where} ORDER BY d.deposit_date DESC, d.id DESC`).all(...params);
  const events = eventsFor(db, rows.map((row) => row.id));
  const list = rows.map((row) => serialize(row, events.get(row.id) || []));
  if (!status || status === 'all') return list;
  if (status === 'open') return list.filter((row) => row.held_cents > 0 && !row.voided_at);
  return list.filter((row) => row.status === status);
}

function insertEvent(db, depositId, fields) {
  const info = db.prepare(`
    INSERT INTO visa_deposit_events (
      deposit_id, event_type, event_date, amount_cents, deduction_cents, forfeit_to, vendor_id,
      account_id, method, reference, notes, invoice_id, payment_id, refund_id, journal_entry_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    depositId, fields.event_type, fields.event_date, fields.amount_cents, fields.deduction_cents || 0,
    fields.forfeit_to || null, fields.vendor_id || null, fields.account_id || null,
    fields.method || '', fields.reference || '', fields.notes || '',
    fields.invoice_id || null, fields.payment_id || null, fields.refund_id || null, fields.journal_entry_id || null,
  );
  return Number(info.lastInsertRowid);
}

function loadOpen(db, id) {
  const deposit = getDeposit(db, id);
  if (deposit.voided_at) throw bad('This deposit is void');
  return deposit;
}

function eventDate(deposit, value, label) {
  const date = dateISO(value || todayISO(), label);
  if (date < deposit.deposit_date) throw bad(`${label} cannot be before the deposit date`);
  return date;
}

function collectDeposit(db, payload = {}) {
  return db.transaction(() => {
    const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(Number(payload.visa_id));
    if (!visa) throw bad('Visa application not found');
    if (['cancelled', 'rejected'].includes(visa.status)) throw bad('Deposits cannot be taken on a cancelled or rejected visa');
    const amount = cents(payload.amount_cents, 'Deposit amount', { min: 1 });
    const date = dateISO(payload.deposit_date || todayISO(), 'Deposit date');
    const account = cashAccount(db, payload.account_id, 'account the deposit was received into');
    const { held } = accounts(db);
    const number = allocateNumber(db, 'deposit', date);
    const depositId = Number(db.prepare(`
      INSERT INTO visa_deposits (number, customer_id, visa_id, deposit_date, amount_cents, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(number, visa.customer_id, visa.id, date, amount, optionalStr(payload.notes, 'Notes', 1000)).lastInsertRowid);
    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Visa security deposit ${number} — ${visa.number}${visa.applicant_name ? ` (${visa.applicant_name})` : ''}`,
      reference: number,
      source_type: 'deposit_collect',
      source_id: depositId,
      lines: [
        { account_id: account.id, debit_cents: amount, credit_cents: 0, description: `Deposit ${number}` },
        { account_id: held.id, debit_cents: 0, credit_cents: amount, description: `Deposit ${number} held` },
      ],
    });
    insertEvent(db, depositId, {
      event_type: 'collect', event_date: date, amount_cents: amount, account_id: account.id,
      method: optionalStr(payload.method, 'Method', 100) || 'Cash',
      reference: optionalStr(payload.reference, 'Reference', 200), journal_entry_id: entryId,
    });
    audit.record(db, {
      entity_type: 'visa_deposit', entity_id: depositId, entity_number: number, action: 'create',
      amount_cents: amount, metadata: { visa_id: visa.id },
    });
    return getDeposit(db, depositId);
  })();
}

function payToSupplier(db, id, payload = {}) {
  return db.transaction(() => {
    const deposit = loadOpen(db, id);
    const amount = payload.amount_cents == null ? deposit.in_hand_cents : cents(payload.amount_cents, 'Amount', { min: 1 });
    if (amount <= 0 || amount > deposit.in_hand_cents) {
      throw bad(`Only ${(deposit.in_hand_cents / 100).toFixed(2)} of this deposit is in hand to pass to a supplier`);
    }
    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(payload.vendor_id));
    if (!vendor) throw bad('Choose the supplier');
    const account = cashAccount(db, payload.account_id, 'account the deposit was paid from');
    const date = eventDate(deposit, payload.event_date, 'Payment date');
    const { withSuppliers } = accounts(db);
    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Deposit ${deposit.number} paid to ${vendor.name}`,
      reference: deposit.number,
      source_type: 'deposit_to_supplier',
      source_id: deposit.id,
      lines: [
        { account_id: withSuppliers.id, debit_cents: amount, credit_cents: 0, description: `Deposit ${deposit.number} with ${vendor.name}` },
        { account_id: account.id, debit_cents: 0, credit_cents: amount, description: `Deposit ${deposit.number}` },
      ],
    });
    insertEvent(db, deposit.id, {
      event_type: 'to_supplier', event_date: date, amount_cents: amount, vendor_id: vendor.id, account_id: account.id,
      method: optionalStr(payload.method, 'Method', 100) || 'Bank transfer',
      reference: optionalStr(payload.reference, 'Reference', 200), journal_entry_id: entryId,
    });
    return getDeposit(db, deposit.id);
  })();
}

function supplierReturn(db, id, payload = {}) {
  return db.transaction(() => {
    const deposit = loadOpen(db, id);
    const gross = payload.amount_cents == null ? deposit.with_supplier_cents : cents(payload.amount_cents, 'Amount', { min: 1 });
    if (gross <= 0 || gross > deposit.with_supplier_cents) {
      throw bad(`The supplier holds ${(deposit.with_supplier_cents / 100).toFixed(2)} of this deposit`);
    }
    const deduction = cents(payload.deduction_cents ?? 0, 'Deduction', { min: 0 });
    if (deduction > gross) throw bad('The deduction cannot be more than the amount the supplier settles');
    const net = gross - deduction;
    const date = eventDate(deposit, payload.event_date, 'Return date');
    const { held, withSuppliers } = accounts(db);
    const vendorId = (deposit.events.filter((e) => e.event_type === 'to_supplier' && !e.voided_at).at(-1) || {}).vendor_id || null;
    const lines = [
      { account_id: withSuppliers.id, debit_cents: 0, credit_cents: gross, description: `Deposit ${deposit.number} settled by supplier` },
    ];
    let accountId = null;
    if (net > 0) {
      const account = cashAccount(db, payload.account_id, 'account the supplier paid into');
      accountId = account.id;
      lines.unshift({ account_id: account.id, debit_cents: net, credit_cents: 0, description: `Deposit ${deposit.number} returned` });
    }
    if (deduction > 0) {
      lines.unshift({ account_id: held.id, debit_cents: deduction, credit_cents: 0, description: `Deposit ${deposit.number} deduction` });
    }
    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Deposit ${deposit.number} returned by supplier${deduction ? ` less ${(deduction / 100).toFixed(2)} deducted` : ''}`,
      reference: deposit.number,
      source_type: 'deposit_supplier_return',
      source_id: deposit.id,
      lines,
    });
    insertEvent(db, deposit.id, {
      event_type: 'supplier_return', event_date: date, amount_cents: gross, deduction_cents: deduction,
      vendor_id: vendorId, account_id: accountId, method: optionalStr(payload.method, 'Method', 100),
      reference: optionalStr(payload.reference, 'Reference', 200),
      notes: optionalStr(payload.notes, 'Reason for the deduction', 500), journal_entry_id: entryId,
    });
    return getDeposit(db, deposit.id);
  })();
}

function stillWithSupplier(deposit) {
  return deposit.with_supplier_cents > 0
    ? ` ${(deposit.with_supplier_cents / 100).toFixed(2)} is still with the supplier; record the supplier return first.`
    : '';
}

function refundDeposit(db, id, payload = {}) {
  return db.transaction(() => {
    const deposit = loadOpen(db, id);
    const amount = payload.amount_cents == null ? deposit.in_hand_cents : cents(payload.amount_cents, 'Refund amount', { min: 1 });
    if (amount <= 0 || amount > deposit.in_hand_cents) {
      throw bad(`Only ${(deposit.in_hand_cents / 100).toFixed(2)} of this deposit can be refunded now.${stillWithSupplier(deposit)}`);
    }
    const account = cashAccount(db, payload.account_id, 'account to refund from');
    const date = eventDate(deposit, payload.event_date, 'Refund date');
    const method = optionalStr(payload.method, 'Refund method', 100) || 'Cash';
    const { held } = accounts(db);
    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Refund of visa deposit ${deposit.number} — ${deposit.customer_name}`,
      reference: deposit.number,
      source_type: 'deposit_refund',
      source_id: deposit.id,
      lines: [
        { account_id: held.id, debit_cents: amount, credit_cents: 0, description: `Deposit ${deposit.number}` },
        { account_id: account.id, debit_cents: 0, credit_cents: amount, description: 'Deposit refund to customer' },
      ],
    });
    const number = allocateNumber(db, 'refund', date);
    const refundId = Number(db.prepare(`
      INSERT INTO refunds (number, refund_type, status, party_id, deposit_id, refund_date, amount_cents,
        method, reference, notes, account_id, journal_entry_id)
      VALUES (?, 'customer', 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number, deposit.customer_id, deposit.id, date, amount, method, deposit.number,
      optionalStr(payload.notes, 'Notes', 1000) || `Refund of visa deposit ${deposit.number}`, account.id, entryId,
    ).lastInsertRowid);
    insertEvent(db, deposit.id, {
      event_type: 'refund', event_date: date, amount_cents: amount, account_id: account.id, method,
      reference: optionalStr(payload.reference, 'Reference', 200), refund_id: refundId, journal_entry_id: entryId,
    });
    return getDeposit(db, deposit.id);
  })();
}

function applyToInvoice(db, id, payload = {}) {
  return db.transaction(() => {
    const deposit = loadOpen(db, id);
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(payload.invoice_id));
    if (!invoice) throw bad('Choose an invoice');
    if (invoice.status !== 'sent') throw bad('Only a sent invoice can be paid from a deposit');
    if (invoice.customer_id !== deposit.customer_id) throw bad('That invoice belongs to a different customer');
    const balance = Math.max(0, invoice.total_cents - invoice.amount_paid_cents - (invoice.credit_applied_cents || 0));
    if (balance <= 0) throw bad('That invoice is already fully paid');
    const requested = payload.amount_cents == null ? Math.min(balance, deposit.in_hand_cents) : cents(payload.amount_cents, 'Amount', { min: 1 });
    if (requested <= 0 || requested > deposit.in_hand_cents) {
      throw bad(`Only ${(deposit.in_hand_cents / 100).toFixed(2)} of this deposit can be used now.${stillWithSupplier(deposit)}`);
    }
    if (requested > balance) throw bad(`That invoice only has ${(balance / 100).toFixed(2)} left to pay`);
    const date = eventDate(deposit, payload.event_date, 'Date');
    const { held, ar } = accounts(db);
    const number = allocateNumber(db, 'payment', date);
    const paymentId = Number(db.prepare(`
      INSERT INTO payments (number, customer_id, invoice_id, payment_date, amount_cents, method,
        reference, deposit_account_id, deposit_id)
      VALUES (?, ?, ?, ?, ?, 'Deposit applied', ?, ?, ?)
    `).run(number, deposit.customer_id, invoice.id, date, requested, deposit.number, held.id, deposit.id).lastInsertRowid);
    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Visa deposit ${deposit.number} applied to invoice ${invoice.number}`,
      reference: invoice.number,
      source_type: 'deposit_apply',
      source_id: paymentId,
      lines: [
        { account_id: held.id, debit_cents: requested, credit_cents: 0, description: `Deposit ${deposit.number}` },
        { account_id: ar.id, debit_cents: 0, credit_cents: requested, description: `Invoice ${invoice.number}` },
      ],
    });
    db.prepare('UPDATE payments SET journal_entry_id = ? WHERE id = ?').run(entryId, paymentId);
    db.prepare("UPDATE invoices SET amount_paid_cents = amount_paid_cents + ?, updated_at = datetime('now') WHERE id = ?").run(requested, invoice.id);
    insertEvent(db, deposit.id, {
      event_type: 'apply', event_date: date, amount_cents: requested, invoice_id: invoice.id,
      payment_id: paymentId, journal_entry_id: entryId,
    });
    return getDeposit(db, deposit.id);
  })();
}

function forfeitDeposit(db, id, payload = {}) {
  return db.transaction(() => {
    const deposit = loadOpen(db, id);
    const to = payload.forfeit_to === 'supplier' ? 'supplier' : 'agency';
    const limit = to === 'supplier' ? deposit.with_supplier_cents : deposit.in_hand_cents;
    const amount = payload.amount_cents == null ? limit : cents(payload.amount_cents, 'Amount', { min: 1 });
    if (amount <= 0 || amount > limit) {
      throw bad(to === 'supplier'
        ? `The supplier holds ${(limit / 100).toFixed(2)} of this deposit`
        : `Only ${(limit / 100).toFixed(2)} of this deposit is in hand.${stillWithSupplier(deposit)}`);
    }
    const reason = optionalStr(payload.notes, 'Reason', 500);
    if (!reason) throw bad('Enter the reason for the forfeit');
    const date = eventDate(deposit, payload.event_date, 'Forfeit date');
    const { held, withSuppliers, forfeited } = accounts(db);
    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Visa deposit ${deposit.number} forfeited${to === 'supplier' ? ' to the supplier' : ''} — ${reason}`,
      reference: deposit.number,
      source_type: 'deposit_forfeit',
      source_id: deposit.id,
      lines: [
        { account_id: held.id, debit_cents: amount, credit_cents: 0, description: `Deposit ${deposit.number}` },
        to === 'supplier'
          ? { account_id: withSuppliers.id, debit_cents: 0, credit_cents: amount, description: `Kept by supplier` }
          : { account_id: forfeited.id, debit_cents: 0, credit_cents: amount, description: `Forfeited deposit ${deposit.number}` },
      ],
    });
    insertEvent(db, deposit.id, {
      event_type: 'forfeit', event_date: date, amount_cents: amount, forfeit_to: to, notes: reason, journal_entry_id: entryId,
    });
    audit.record(db, {
      entity_type: 'visa_deposit', entity_id: deposit.id, entity_number: deposit.number, action: 'forfeit',
      remarks: reason, amount_cents: amount, metadata: { forfeit_to: to },
    });
    return getDeposit(db, deposit.id);
  })();
}

// Undo the latest step only, so every balance stays valid. Voiding the first
// step (the deposit received) voids the whole deposit.
function voidLastEvent(db, id, payload = {}) {
  return db.transaction(() => {
    const deposit = getDeposit(db, id);
    if (deposit.voided_at) throw bad('This deposit is already void');
    const remarks = optionalStr(payload.remarks, 'Remarks', 2000);
    if (!remarks) throw bad('Enter the reason for the void');
    const last = deposit.events.filter((event) => !event.voided_at).at(-1);
    if (!last) throw bad('Nothing to void');
    if (last.event_type === 'apply' && last.payment_id) {
      // The payment voids its own entry and the invoice balance.
      require('./invoices').deleteInvoicePayment(db, last.payment_id, { remarks });
      db.prepare("UPDATE visa_deposit_events SET voided_at = datetime('now'), void_remarks = ? WHERE id = ?").run(remarks, last.id);
    } else {
      const voidEntryId = last.journal_entry_id
        ? reverseEntry(db, last.journal_entry_id, {
          entry_date: todayISO(),
          memo: audit.withRemarks(`Void ${EVENT_LABELS[last.event_type].toLowerCase()} on deposit ${deposit.number}`, remarks),
          source_type: 'void',
        })
        : null;
      db.prepare("UPDATE visa_deposit_events SET voided_at = datetime('now'), void_entry_id = ?, void_remarks = ? WHERE id = ?")
        .run(voidEntryId, remarks, last.id);
      if (last.refund_id) {
        db.prepare("UPDATE refunds SET status = 'void', void_entry_id = ? WHERE id = ?").run(voidEntryId, last.refund_id);
      }
    }
    if (last.event_type === 'collect') {
      db.prepare("UPDATE visa_deposits SET voided_at = datetime('now') WHERE id = ?").run(deposit.id);
    }
    audit.record(db, {
      entity_type: 'visa_deposit', entity_id: deposit.id, entity_number: deposit.number, action: 'void',
      remarks, amount_cents: last.amount_cents, metadata: { event_type: last.event_type },
    });
    return getDeposit(db, deposit.id);
  })();
}

// Ledger checks: 2600 must equal what is still held, 1460 what suppliers hold.
function depositTotals(db) {
  const list = listDeposits(db, {}).filter((row) => !row.voided_at);
  return {
    held_cents: list.reduce((sum, row) => sum + row.held_cents, 0),
    with_supplier_cents: list.reduce((sum, row) => sum + row.with_supplier_cents, 0),
  };
}

module.exports = {
  EVENT_LABELS,
  getDeposit,
  listDeposits,
  collectDeposit,
  payToSupplier,
  supplierReturn,
  refundDeposit,
  applyToInvoice,
  forfeitDeposit,
  voidLastEvent,
  depositTotals,
};
