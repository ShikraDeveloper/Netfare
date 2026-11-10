'use strict';

// Correct (admin only; see permissions.js): fixing a posted transaction in one
// step. The original is voided (its reason starts "Corrected", reversed on its
// own date) and a new one is posted with the corrected values, in one database
// transaction: if the new one cannot be posted, nothing changes. Values not
// sent keep the original's. The audit log records both numbers and the reason.
//
// Each kind lists the fields that may change, how to void the original and
// how to post the new one. Records that hang off something else (a payment
// made from an advance or a deposit, a bill paid from a portal wallet, an
// advance already used or refunded) are voided and recorded again instead.

const { bad, notFound, str } = require('../util');
const audit = require('./audit');

const PAYMENT_FIELDS = ['amount_cents', 'payment_date', 'method', 'reference', 'cheque_number', 'cheque_date', 'bank_name', 'bank_charges_cents'];

const KINDS = {
  payment: {
    table: 'payments',
    label: 'Payment',
    fields: [...PAYMENT_FIELDS, 'deposit_account_id'],
    check(row) {
      if (row.advance_id) throw bad('This payment came from a customer advance. Void it and apply the advance again.');
      if (row.deposit_id) throw bad('This payment came from a visa security deposit. Undo it on the deposit card instead.');
    },
    void(db, row, remarks) {
      require('./invoices').deleteInvoicePayment(db, row.id, { remarks });
    },
    post(db, row, values) {
      require('./invoices').recordInvoicePayment(db, row.invoice_id, values);
      return db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id DESC LIMIT 1').get(row.invoice_id);
    },
  },
  bill_payment: {
    table: 'bill_payments',
    label: 'Bill payment',
    fields: [...PAYMENT_FIELDS, 'payment_account_id'],
    check(row) {
      if (row.portal_id) throw bad('This bill was paid from a portal wallet. Void it and settle the bill from the portal again.');
    },
    void(db, row, remarks) {
      require('./bills').deleteBillPayment(db, row.id, { remarks });
    },
    post(db, row, values) {
      require('./bills').recordBillPayment(db, row.bill_id, values);
      return db.prepare('SELECT * FROM bill_payments WHERE bill_id = ? ORDER BY id DESC LIMIT 1').get(row.bill_id);
    },
  },
  topup: {
    table: 'portal_topups',
    label: 'Top-up',
    fields: ['amount_cents', 'topup_date', 'method', 'reference', 'notes', 'deposit_account_id', 'bank_charges_cents'],
    void(db, row, remarks) {
      require('./portals').voidTopup(db, row.id, { remarks });
    },
    post(db, row, values) {
      require('./portals').topUp(db, { ...values, portal_id: row.portal_id });
      return db.prepare('SELECT * FROM portal_topups WHERE portal_id = ? ORDER BY id DESC LIMIT 1').get(row.portal_id);
    },
  },
  portal_refund: {
    table: 'portal_refunds',
    label: 'Withdrawal',
    fields: ['amount_cents', 'refund_date', 'method', 'reference', 'notes', 'payment_account_id', 'bank_charges_cents'],
    void(db, row, remarks) {
      require('./portals').voidPortalRefund(db, row.id, { remarks });
    },
    post(db, row, values) {
      require('./portals').refundPortal(db, row.portal_id, values);
      return db.prepare('SELECT * FROM portal_refunds WHERE portal_id = ? ORDER BY id DESC LIMIT 1').get(row.portal_id);
    },
  },
  advance: {
    table: 'customer_advances',
    label: 'Advance',
    fields: ['amount_cents', 'advance_date', 'method', 'reference', 'deposit_account_id', 'bank_charges_cents'],
    check(row) {
      if (row.is_receipt) throw bad('This is a customer receipt. Void it and record the receipt again.');
      if (row.applied_cents > 0 || row.refunded_cents > 0) {
        throw bad('This advance has been used or refunded. Void it and record it again.');
      }
    },
    void(db, row, remarks) {
      require('./advances').voidAdvance(db, row.id, { remarks });
    },
    post(db, row, values) {
      require('./advances').createAdvance(db, {
        ...values, customer_id: row.customer_id, booking_id: row.booking_id, visa_id: row.visa_id,
      });
      return db.prepare('SELECT * FROM customer_advances WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(row.customer_id);
    },
  },
  cash_deposit: {
    table: 'cash_deposits',
    label: 'Cash deposit',
    fields: ['amount_cents', 'deposit_date', 'from_account_id', 'to_account_id', 'reference', 'notes'],
    void(db, row, remarks) {
      require('./cash-deposits').voidDeposit(db, row.id, { remarks });
    },
    post(db, row, values) {
      require('./cash-deposits').createDeposit(db, values);
      return db.prepare('SELECT * FROM cash_deposits ORDER BY id DESC LIMIT 1').get();
    },
  },
};

// A void is normally dated today. A correction replaces the original in
// place, so its reversal takes the original's date: that day and month then
// read with the corrected amount only.
function reverseOnOriginalDate(db, entryId) {
  if (!entryId) return;
  const original = db.prepare('SELECT entry_date FROM journal_entries WHERE id = ?').get(entryId);
  if (original) db.prepare('UPDATE journal_entries SET entry_date = ? WHERE reversal_of_id = ?').run(original.entry_date, entryId);
}

function isVoid(row) {
  return row.status === 'void' || Boolean(row.voided_at);
}

function correct(db, kind, id, payload = {}) {
  const config = KINDS[kind];
  if (!config) throw bad('This record cannot be corrected here');
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(Number(id));
    if (!row) throw notFound(`${config.label} not found`);
    if (isVoid(row)) throw bad(`This ${config.label.toLowerCase()} is void`);
    const reason = str(payload.remarks ?? payload.reason, 'Reason', { max: 500 });
    config.check?.(row);

    const sent = payload.values && typeof payload.values === 'object' ? payload.values : {};
    const values = {};
    for (const field of config.fields) values[field] = sent[field] !== undefined ? sent[field] : row[field];

    config.void(db, row, `Corrected · ${reason}`);
    reverseOnOriginalDate(db, row.journal_entry_id);
    const posted = config.post(db, row, values);
    audit.record(db, {
      entity_type: kind,
      entity_id: row.id,
      entity_number: row.number || `#${row.id}`,
      action: 'correct',
      remarks: `${row.number || `#${row.id}`} → ${posted.number || `#${posted.id}`} · ${reason}`,
      amount_cents: posted.amount_cents ?? 0,
      metadata: { corrected_id: posted.id, before: Object.fromEntries(config.fields.map((field) => [field, row[field]])), after: values },
    });
    return { kind, original_id: row.id, original_number: row.number || null, id: posted.id, number: posted.number || null };
  })();
}

// Invoices and bills (not those of a booking or visa, which are corrected
// from the job). The old document is reversed on its own date and voided; the
// corrected one is posted; payments, applied credits and refunds move across
// to it unchanged, so receipt and payment numbers stay the same. The new
// total must cover what was already paid and credited.
const DOCUMENTS = {
  invoice: {
    table: 'invoices',
    label: 'invoice',
    party: 'customer_id',
    date: 'issue_date',
    fields: ['customer_id', 'issue_date', 'due_date', 'notes', 'terms', 'beneficiary_is_customer', 'beneficiary_name', 'beneficiary_nationality', 'beneficiary_passport'],
    items: 'invoice_items',
    moves: [['payments', 'invoice_id', "status = 'posted'"], ['credit_applications', 'invoice_id', '1 = 1'], ['refunds', 'invoice_id', '1 = 1']],
    post: (db, values) => require('./invoices').createInvoice(db, { ...values, status: 'sent' }),
    get: (db, id) => require('./invoices').getInvoice(db, id),
  },
  bill: {
    table: 'bills',
    label: 'bill',
    party: 'vendor_id',
    date: 'bill_date',
    fields: ['vendor_id', 'bill_date', 'due_date', 'notes'],
    items: 'bill_items',
    moves: [
      ['bill_payments', 'bill_id', "status = 'posted'"], ['supplier_credit_applications', 'bill_id', '1 = 1'],
      ['supplier_credit_notes', 'bill_id', '1 = 1'], ['refunds', 'bill_id', '1 = 1'],
    ],
    post: (db, values) => require('./bills').createBill(db, { ...values, status: 'received' }),
    get: (db, id) => require('./bills').getBill(db, id),
  },
};

function correctDocument(db, kind, id, payload = {}) {
  const config = DOCUMENTS[kind];
  if (!config) throw bad('This record cannot be corrected here');
  const { reverseEntry } = require('../accounting');
  return db.transaction(() => {
    const old = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(Number(id));
    if (!old) throw notFound(`The ${config.label} was not found`);
    const posted = kind === 'invoice' ? 'sent' : 'received';
    if (old.status !== posted) throw bad(`Only a posted ${config.label} can be corrected; a draft is edited`);
    if (old.booking_id || old.visa_id) throw bad(`This ${config.label} belongs to a ${old.booking_id ? 'booking' : 'visa'}: correct it there`);
    if (old.cancellation_id) throw bad('This invoice holds cancellation charges. Issue a credit note to change them.');
    if (old.is_opening) throw bad('Opening balances are corrected in Opening balances');
    const reason = str(payload.remarks ?? payload.reason, 'Reason', { max: 500 });

    const sent = payload.values && typeof payload.values === 'object' ? payload.values : {};
    const values = {};
    for (const field of config.fields) values[field] = sent[field] !== undefined ? sent[field] : old[field];
    values.items = Array.isArray(sent.items) ? sent.items : db.prepare(`
      SELECT description, quantity, unit_price_cents, account_id FROM ${config.items} WHERE ${config.table.slice(0, -1)}_id = ? ORDER BY sort_order, id
    `).all(old.id);
    const settled = old.amount_paid_cents + old.credit_applied_cents;
    if (settled > 0 && Number(values[config.party]) !== old[config.party]) {
      throw bad(`Payments and credits on ${old.number} belong to its ${kind === 'invoice' ? 'customer' : 'supplier'}. Void them before changing the ${kind === 'invoice' ? 'customer' : 'supplier'}.`);
    }

    if (old.journal_entry_id) {
      reverseEntry(db, old.journal_entry_id, { entry_date: old[config.date], memo: `Corrected · ${reason} · ${config.label} ${old.number}`, source_type: 'void' });
      reverseOnOriginalDate(db, old.journal_entry_id);
    }
    db.prepare(`UPDATE ${config.table} SET status = 'void', amount_paid_cents = 0, credit_applied_cents = 0, updated_at = datetime('now') WHERE id = ?`).run(old.id);
    const created = config.post(db, values);
    if (created.total_cents < settled) {
      throw bad(`The new total (${(created.total_cents / 100).toFixed(2)}) is less than what was paid or credited on ${old.number} (${(settled / 100).toFixed(2)}). Refund or void a payment first.`);
    }
    for (const [table, column, which] of config.moves) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ? AND ${which}`).run(created.id, old.id);
    }
    db.prepare(`UPDATE ${config.table} SET amount_paid_cents = ?, credit_applied_cents = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(old.amount_paid_cents, old.credit_applied_cents, created.id);
    audit.record(db, {
      entity_type: kind,
      entity_id: old.id,
      entity_number: old.number,
      action: 'correct',
      remarks: `${old.number} → ${created.number} · ${reason}`,
      amount_cents: created.total_cents,
      metadata: { corrected_id: created.id, total_before: old.total_cents, total_after: created.total_cents, moved_settled_cents: settled },
    });
    return config.get(db, created.id);
  })();
}

module.exports = { correct, correctDocument, reverseOnOriginalDate, KINDS };
