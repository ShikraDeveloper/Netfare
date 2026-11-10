'use strict';

// An opening balance for one customer, supplier or portal, entered by the
// admin when the record is created. Each becomes an ordinary document, so it
// shows on statements and aging and is paid or used the normal way. The other
// side is 3900 Opening Balance Equity, and opening invoices are not sales.
//
//   customer owes us              → invoice          Dr 1100 · Cr 3900
//   we owe the customer           → credit note      Dr 3900 · Cr 2450
//   we owe the supplier           → bill             Dr 3900 · Cr 2000
//   the supplier owes us          → supplier credit  Dr 1450 · Cr 3900
//   money held on a portal        → portal top-up    Dr 1400 · Cr 3900
//   we owe the portal's supplier  → bill             Dr 3900 · Cr 2000

const { bad, cents, dateISO, todayISO, optionalStr } = require('../util');
const { assertOpenDate, postEntry, reverseEntry, systemAccount, SYSTEM_CODES } = require('../accounting');
const { markCreated } = require('../created-by');
const { allocateNumber } = require('./numbering');
const audit = require('./audit');

const DESCRIPTION = 'Opening balance';
const DIRECTIONS = ['they_owe', 'we_owe'];

// payload.opening = { direction: 'they_owe' | 'we_owe', amount_cents, as_of, notes }
// Returns null when no opening balance was entered.
function parseOpening(input) {
  if (!input || input.amount_cents == null || input.amount_cents === '' || Number(input.amount_cents) === 0) return null;
  if (!DIRECTIONS.includes(input.direction)) throw bad('Choose who owes the opening balance');
  return {
    direction: input.direction,
    amount: cents(input.amount_cents, 'Opening balance', { min: 1 }),
    date: dateISO(input.as_of || todayISO(), 'Opening balance date'),
    notes: optionalStr(input.notes, 'Opening balance notes', 500),
  };
}

function equity(db) {
  return systemAccount(db, SYSTEM_CODES.OPENING_BALANCE_EQUITY, 'Opening Balance Equity');
}

function record(db, entityType, id, number, remarks) {
  audit.record(db, { entity_type: entityType, entity_id: id, entity_number: number, action: 'create', remarks });
}

function openingInvoice(db, customer, { amount, date, notes }) {
  const number = allocateNumber(db, 'invoice', date);
  const info = db.prepare(`
    INSERT INTO invoices (number, customer_id, issue_date, due_date, status, notes, subtotal_cents, total_cents, is_opening)
    VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, 1)
  `).run(number, customer.id, date, date, notes || DESCRIPTION, amount, amount);
  const id = Number(info.lastInsertRowid);
  markCreated(db, 'invoices', id);
  db.prepare(`
    INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, amount_cents, account_id, sort_order)
    VALUES (?, ?, 1, ?, ?, ?, 0)
  `).run(id, DESCRIPTION, amount, amount, equity(db).id);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Opening balance ${number} — ${customer.name}`,
    reference: number,
    source_type: 'invoice',
    source_id: id,
    lines: [
      { account_id: systemAccount(db, SYSTEM_CODES.AR, 'Trade Receivables').id, debit_cents: amount, credit_cents: 0, description: `${DESCRIPTION} · ${customer.name}` },
      { account_id: equity(db).id, debit_cents: 0, credit_cents: amount, description: `${DESCRIPTION} · ${customer.name}` },
    ],
  });
  db.prepare('UPDATE invoices SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  record(db, 'invoice', id, number, `Opening balance: ${customer.name} owes this`);
  return { kind: 'invoice', id, number, amount_cents: amount };
}

function openingCredit(db, customer, { amount, date, notes }) {
  const number = allocateNumber(db, 'credit', date);
  const info = db.prepare(`
    INSERT INTO credit_notes (number, customer_id, credit_date, amount_cents, revenue_account_id, notes, is_opening)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(number, customer.id, date, amount, equity(db).id, notes || DESCRIPTION);
  const id = Number(info.lastInsertRowid);
  markCreated(db, 'credit_notes', id);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Opening balance ${number} — ${customer.name}`,
    reference: number,
    source_type: 'credit_note',
    source_id: id,
    lines: [
      { account_id: equity(db).id, debit_cents: amount, credit_cents: 0, description: `${DESCRIPTION} · ${customer.name}` },
      { account_id: systemAccount(db, '2450', 'Customer Credits').id, debit_cents: 0, credit_cents: amount, description: `${DESCRIPTION} · ${customer.name}` },
    ],
  });
  db.prepare('UPDATE credit_notes SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  record(db, 'credit_note', id, number, `Opening balance: owed to ${customer.name}`);
  return { kind: 'credit_note', id, number, amount_cents: amount };
}

function openingBill(db, vendor, { amount, date, notes }, portalId = null) {
  const number = allocateNumber(db, 'bill', date);
  const info = db.prepare(`
    INSERT INTO bills (number, vendor_id, bill_date, due_date, status, notes, subtotal_cents, total_cents, portal_id, is_opening)
    VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?, 1)
  `).run(number, vendor.id, date, date, notes || DESCRIPTION, amount, amount, portalId);
  const id = Number(info.lastInsertRowid);
  markCreated(db, 'bills', id);
  db.prepare(`
    INSERT INTO bill_items (bill_id, description, quantity, unit_price_cents, amount_cents, account_id, sort_order)
    VALUES (?, ?, 1, ?, ?, ?, 0)
  `).run(id, DESCRIPTION, amount, amount, equity(db).id);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Opening balance ${number} — ${vendor.name}`,
    reference: number,
    source_type: 'bill',
    source_id: id,
    lines: [
      { account_id: equity(db).id, debit_cents: amount, credit_cents: 0, description: `${DESCRIPTION} · ${vendor.name}` },
      { account_id: systemAccount(db, SYSTEM_CODES.AP, 'Trade Payables').id, debit_cents: 0, credit_cents: amount, description: `${DESCRIPTION} · ${vendor.name}` },
    ],
  });
  db.prepare('UPDATE bills SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  record(db, 'bill', id, number, `Opening balance: owed to ${vendor.name}`);
  return { kind: 'bill', id, number, amount_cents: amount };
}

function openingSupplierCredit(db, vendor, { amount, date, notes }) {
  const number = allocateNumber(db, 'supplier_credit', date);
  const info = db.prepare(`
    INSERT INTO supplier_credit_notes (number, vendor_id, credit_date, amount_cents, notes, is_opening)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(number, vendor.id, date, amount, notes || DESCRIPTION);
  const id = Number(info.lastInsertRowid);
  markCreated(db, 'supplier_credit_notes', id);
  db.prepare(`
    INSERT INTO supplier_credit_items (credit_note_id, description, amount_cents, account_id, sort_order)
    VALUES (?, ?, ?, ?, 0)
  `).run(id, DESCRIPTION, amount, equity(db).id);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Opening balance ${number} — ${vendor.name}`,
    reference: number,
    source_type: 'supplier_credit',
    source_id: id,
    lines: [
      { account_id: systemAccount(db, '1450', 'Supplier Credits').id, debit_cents: amount, credit_cents: 0, description: `${DESCRIPTION} · ${vendor.name}` },
      { account_id: equity(db).id, debit_cents: 0, credit_cents: amount, description: `${DESCRIPTION} · ${vendor.name}` },
    ],
  });
  db.prepare('UPDATE supplier_credit_notes SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  record(db, 'supplier_credit', id, number, `Opening balance: ${vendor.name} owes this`);
  return { kind: 'supplier_credit', id, number, amount_cents: amount };
}

function openingTopup(db, portal, { amount, date, notes }) {
  const number = allocateNumber(db, 'topup', date);
  const equityAccount = equity(db);
  const info = db.prepare(`
    INSERT INTO portal_topups (number, portal_id, topup_date, amount_cents, method, reference, notes, deposit_account_id)
    VALUES (?, ?, ?, ?, ?, '', ?, ?)
  `).run(number, portal.id, date, amount, DESCRIPTION, notes, equityAccount.id);
  const id = Number(info.lastInsertRowid);
  markCreated(db, 'portal_topups', id);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Opening balance ${number} — ${portal.name}`,
    reference: number,
    source_type: 'portal_topup',
    source_id: id,
    lines: [
      { account_id: systemAccount(db, SYSTEM_CODES.SUPPLIER_ADVANCES, 'Advances to Suppliers').id, debit_cents: amount, credit_cents: 0, description: `${DESCRIPTION} · ${portal.name}` },
      { account_id: equityAccount.id, debit_cents: 0, credit_cents: amount, description: `${DESCRIPTION} · ${portal.name}` },
    ],
  });
  db.prepare('UPDATE portal_topups SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
  record(db, 'portal_topup', id, number, `Opening balance held on ${portal.name}`);
  return { kind: 'portal_topup', id, number, amount_cents: amount };
}

function forCustomer(db, customer, input) {
  const opening = parseOpening(input);
  if (!opening) return null;
  return opening.direction === 'they_owe' ? openingInvoice(db, customer, opening) : openingCredit(db, customer, opening);
}

function forVendor(db, vendor, input) {
  const opening = parseOpening(input);
  if (!opening) return null;
  return opening.direction === 'we_owe' ? openingBill(db, vendor, opening) : openingSupplierCredit(db, vendor, opening);
}

function forPortal(db, portal, input) {
  const opening = parseOpening(input);
  if (!opening) return null;
  if (!portal.vendor_id) throw bad('Link the portal to a supplier to give it an opening balance');
  if (opening.direction === 'they_owe') return openingTopup(db, portal, opening);
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(portal.vendor_id);
  return openingBill(db, vendor, opening, portal.id);
}

// Changing an opening balance later (admin): the old document is undone on
// its own date and a new one posted, like Correct. Payments and credits
// already made against it move to the new one, so the new amount must cover
// them and they cannot change sides. The books' closing date is the lock: an
// opening balance dated on or before it cannot be changed.
const DOCUMENTS = {
  invoice: {
    table: 'invoices', date: 'issue_date', live: "status = 'sent'",
    used: (row) => row.amount_paid_cents + row.credit_applied_cents,
    moves: [['payments', 'invoice_id', 'payment_date', "status = 'posted'"], ['credit_applications', 'invoice_id', 'applied_date', '1 = 1'], ['refunds', 'invoice_id', 'refund_date', "status = 'paid'"]],
    settle: 'amount_paid_cents = ?, credit_applied_cents = ?', settled: (row) => [row.amount_paid_cents, row.credit_applied_cents],
    retire: "status = 'void', amount_paid_cents = 0, credit_applied_cents = 0",
  },
  credit_note: {
    table: 'credit_notes', date: 'credit_date', live: "status = 'issued'",
    used: (row) => row.applied_cents + row.refunded_cents,
    moves: [['credit_applications', 'credit_note_id', 'applied_date', '1 = 1'], ['refunds', 'credit_note_id', 'refund_date', "status = 'paid'"]],
    settle: 'applied_cents = ?, refunded_cents = ?', settled: (row) => [row.applied_cents, row.refunded_cents],
    retire: "status = 'void', applied_cents = 0, refunded_cents = 0",
  },
  bill: {
    table: 'bills', date: 'bill_date', live: "status = 'received' AND portal_id IS NULL",
    used: (row) => row.amount_paid_cents + row.credit_applied_cents,
    moves: [['bill_payments', 'bill_id', 'payment_date', "status = 'posted'"], ['supplier_credit_applications', 'bill_id', 'applied_date', '1 = 1'],
      ['supplier_credit_notes', 'bill_id', 'credit_date', "status = 'issued'"], ['refunds', 'bill_id', 'refund_date', "status = 'paid'"]],
    settle: 'amount_paid_cents = ?, credit_applied_cents = ?', settled: (row) => [row.amount_paid_cents, row.credit_applied_cents],
    retire: "status = 'void', amount_paid_cents = 0, credit_applied_cents = 0",
  },
  supplier_credit: {
    table: 'supplier_credit_notes', date: 'credit_date', live: "status = 'issued'",
    used: (row) => row.applied_cents + row.refunded_cents + row.portal_settled_cents,
    moves: [['supplier_credit_applications', 'credit_note_id', 'applied_date', '1 = 1'], ['refunds', 'supplier_credit_note_id', 'refund_date', "status = 'paid'"], ['portal_credits', 'supplier_credit_note_id', 'credit_date', "status = 'posted'"]],
    settle: 'applied_cents = ?, refunded_cents = ?, portal_settled_cents = ?', settled: (row) => [row.applied_cents, row.refunded_cents, row.portal_settled_cents],
    retire: "status = 'void', applied_cents = 0, refunded_cents = 0, portal_settled_cents = 0",
  },
};

const PARTIES = {
  customer: { table: 'customers', column: 'customer_id', docs: { they_owe: 'invoice', we_owe: 'credit_note' }, make: { invoice: openingInvoice, credit_note: openingCredit } },
  vendor: { table: 'vendors', column: 'vendor_id', docs: { we_owe: 'bill', they_owe: 'supplier_credit' }, make: { bill: openingBill, supplier_credit: openingSupplierCredit } },
};

function currentOpening(db, kind, partyId) {
  const party = PARTIES[kind];
  for (const [direction, docKind] of Object.entries(party.docs)) {
    const doc = DOCUMENTS[docKind];
    const row = db.prepare(`SELECT * FROM ${doc.table} WHERE ${party.column} = ? AND is_opening = 1 AND ${doc.live} ORDER BY id DESC LIMIT 1`).get(partyId);
    if (row) return { direction, docKind, row };
  }
  return null;
}

function closedThrough(db) {
  return db.prepare('SELECT books_closed_through FROM settings WHERE id = 1').get()?.books_closed_through || '';
}

// What the party page shows: the opening balance, if any, and whether it is locked.
function openingStatus(db, kind, partyId) {
  const closed = closedThrough(db);
  const found = currentOpening(db, kind, Number(partyId));
  if (!found) return { opening: null, closed_through: closed, locked: false };
  const doc = DOCUMENTS[found.docKind];
  const date = found.row[doc.date];
  return {
    opening: {
      kind: found.docKind, id: found.row.id, number: found.row.number, direction: found.direction,
      amount_cents: found.docKind === 'invoice' || found.docKind === 'bill' ? found.row.total_cents : found.row.amount_cents,
      as_of: date, used_cents: doc.used(found.row),
    },
    closed_through: closed,
    locked: Boolean(closed && date <= closed),
  };
}

function setOpening(db, kind, partyId, payload = {}) {
  const party = PARTIES[kind];
  if (!party) throw bad('Opening balances here are for customers and suppliers');
  return db.transaction(() => {
    const record_ = db.prepare(`SELECT * FROM ${party.table} WHERE id = ?`).get(Number(partyId));
    if (!record_) throw bad(`The ${kind === 'vendor' ? 'supplier' : 'customer'} was not found`);
    const opening = parseOpening(payload.opening);
    const old = currentOpening(db, kind, record_.id);
    if (!old && !opening) throw bad('Enter the opening balance amount');
    const reason = old ? optionalStr(payload.remarks ?? payload.reason, 'Reason', 500) : '';
    if (old && !reason) throw bad('Reason is required');

    const newKind = opening ? party.docs[opening.direction] : null;
    if (old) {
      const doc = DOCUMENTS[old.docKind];
      assertOpenDate(db, old.row[doc.date]);
      const used = doc.used(old.row);
      if (used > 0) {
        if (newKind !== old.docKind) {
          throw bad(`${old.row.number} has payments or credits on it (${(used / 100).toFixed(2)}). Void them before removing the opening balance or changing who owes it.`);
        }
        if (opening.amount < used) {
          throw bad(`The new amount (${(opening.amount / 100).toFixed(2)}) is less than what was already paid or used on ${old.row.number} (${(used / 100).toFixed(2)}). Void a payment first.`);
        }
        for (const [table, column, dateColumn, live] of doc.moves) {
          const first = db.prepare(`SELECT MIN(${dateColumn}) AS date FROM ${table} WHERE ${column} = ? AND ${live}`).get(old.row.id).date;
          if (first && opening.date > first) throw bad(`The date cannot be after ${first}, when ${old.row.number} was first paid or used`);
        }
      }
    }
    if (opening) assertOpenDate(db, opening.date);

    if (old) {
      const doc = DOCUMENTS[old.docKind];
      if (old.row.journal_entry_id) {
        const voidEntryId = reverseEntry(db, old.row.journal_entry_id, {
          entry_date: old.row[doc.date], memo: `Opening balance changed · ${reason} · ${old.row.number}`, source_type: 'void',
        });
        if (old.docKind === 'credit_note' || old.docKind === 'supplier_credit') {
          db.prepare(`UPDATE ${doc.table} SET void_entry_id = ? WHERE id = ?`).run(voidEntryId, old.row.id);
        }
      }
      db.prepare(`UPDATE ${doc.table} SET ${doc.retire} WHERE id = ?`).run(old.row.id);
    }
    const created = opening ? party.make[newKind](db, record_, opening) : null;
    if (old && created && newKind === old.docKind) {
      const doc = DOCUMENTS[old.docKind];
      for (const [table, column] of doc.moves) db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(created.id, old.row.id);
      db.prepare(`UPDATE ${doc.table} SET ${doc.settle} WHERE id = ?`).run(...doc.settled(old.row), created.id);
    }
    if (old) {
      audit.record(db, {
        entity_type: kind, entity_id: record_.id, entity_number: record_.number || record_.name,
        action: created ? 'correct' : 'void',
        remarks: `Opening balance ${old.row.number}${created ? ` → ${created.number}` : ' removed'} · ${reason}`,
        amount_cents: created ? created.amount_cents : 0,
      });
    }
    return openingStatus(db, kind, record_.id);
  })();
}

module.exports = { parseOpening, forCustomer, forVendor, forPortal, openingStatus, setOpening };
