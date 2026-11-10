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
  // A refund is posted again from where it came: the payment, the
  // cancellation note, the credit note, the advance or the supplier credit.
  refund: {
    table: 'refunds',
    label: 'Refund',
    fields: ['amount_cents', 'refund_date', 'method', 'reference', 'notes', 'account_id', 'bank_charges_cents'],
    check(row, values) {
      if (row.deposit_id) throw bad('This refund is part of a visa security deposit. Undo it on the deposit card instead.');
      // These two refunds have no bank charges line, so asking for one would be dropped silently.
      if ((row.advance_id || row.cancellation_id) && Number(values.bank_charges_cents) > 0) {
        throw bad('Bank charges are not recorded on advance or cancellation refunds. Record them as a quick expense.');
      }
    },
    void(db, row, remarks) {
      require('./refunds').voidRefund(db, row.id, { remarks });
    },
    post(db, row, values) {
      if (row.cancellation_id) require('./cancellations').refundCancellation(db, row.cancellation_id, values);
      else if (row.credit_note_id) require('./credits').refundCredit(db, row.credit_note_id, values);
      else if (row.advance_id) require('./advances').refundAdvance(db, row.advance_id, { ...values, payment_account_id: values.account_id });
      else if (row.bill_payment_id) require('./refunds').createRefund(db, { ...values, refund_type: 'supplier', bill_payment_id: row.bill_payment_id });
      else if (row.supplier_credit_note_id) require('./supplier-credits').refundSupplierCredit(db, row.supplier_credit_note_id, values);
      else if (row.payment_id) require('./refunds').createRefund(db, { ...values, refund_type: 'customer', payment_id: row.payment_id });
      else throw bad('This refund cannot be corrected here. Void it and record it again.');
      return db.prepare('SELECT * FROM refunds ORDER BY id DESC LIMIT 1').get();
    },
  },
  // A manual journal entry; entries posted by documents are corrected there.
  journal: {
    table: 'journal_entries',
    label: 'Journal entry',
    fields: ['entry_date', 'memo', 'reference', 'lines'],
    entry: (row) => row.id,
    check(row) {
      if (row.source_type !== 'manual') throw bad('This entry was posted by a document. Correct the document instead.');
    },
    defaults(db, row) {
      return {
        lines: db.prepare('SELECT account_id, debit_cents, credit_cents, description FROM journal_lines WHERE entry_id = ? ORDER BY sort_order, id').all(row.id),
      };
    },
    void(db, row, remarks) {
      require('./journal').voidManualEntry(db, row.id, { remarks });
    },
    post(db, row, values) {
      const id = require('./journal').createManualEntry(db, values);
      return db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(id);
    },
  },
  // The same card or payment-link items, with the amount that reached the bank corrected.
  card_settlement: {
    table: 'card_settlements',
    label: 'Card settlement',
    fields: ['net_cents', 'settlement_date', 'bank_account_id', 'reference', 'notes', 'line_ids'],
    defaults(db, row) {
      return { line_ids: db.prepare('SELECT journal_line_id FROM card_settlement_lines WHERE settlement_id = ?').all(row.id).map((line) => line.journal_line_id) };
    },
    void(db, row, remarks) {
      require('./card-settlements').voidSettlement(db, row.id, { remarks });
    },
    post(db, row, values) {
      return require('./card-settlements').createSettlement(db, values);
    },
  },
  // Only the latest count: every later count was measured against this one's result.
  petty_cash_count: {
    table: 'petty_cash_counts',
    label: 'Petty cash count',
    fields: ['count_date', 'counted_cents', 'notes'],
    check(row, values, db) {
      const later = db.prepare("SELECT 1 FROM petty_cash_counts WHERE status = 'posted' AND id <> ? AND (count_date > ? OR (count_date = ? AND id > ?))")
        .get(row.id, row.count_date, row.count_date, row.id);
      if (later) throw bad('A later count was made after this one. Void the later counts first, or correct the latest count.');
    },
    void(db, row, remarks) {
      require('./petty-cash').voidCount(db, row.id, { remarks });
    },
    post(db, row, values) {
      return require('./petty-cash').recordCount(db, values);
    },
  },
  // A credit already spent from the wallet may still be corrected, as long as
  // the wallet does not end up lower than zero on any date.
  portal_credit: {
    table: 'portal_credits',
    label: 'Portal credit',
    fields: ['amount_cents', 'credit_date', 'notes'],
    void(db, row, remarks) {
      row.walletBefore = require('./portals/common').walletLow(db, row.portal_id);
      require('./portals/transactions').voidPortalCredit(db, row.id, { remarks, correcting: true });
    },
    post(db, row, values) {
      const credit = require('./portals/transactions').recordPortalCredit(db, {
        ...values, portal_id: row.portal_id, bill_id: row.bill_id, supplier_credit_note_id: row.supplier_credit_note_id,
      });
      require('./portals/common').assertWalletNotLower(db, row.portal_id, row.walletBefore);
      return credit;
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
  if (original) require('../accounting').assertOpenDate(db, original.entry_date);
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

    const sent = payload.values && typeof payload.values === 'object' ? payload.values : {};
    const base = { ...row, ...config.defaults?.(db, row) };
    const values = {};
    for (const field of config.fields) values[field] = sent[field] !== undefined ? sent[field] : base[field];
    config.check?.(row, values, db);

    config.void(db, row, `Corrected · ${reason}`);
    reverseOnOriginalDate(db, config.entry ? config.entry(row) : row.journal_entry_id);
    const posted = config.post(db, row, values);
    audit.record(db, {
      entity_type: kind,
      entity_id: row.id,
      entity_number: row.number || `#${row.id}`,
      action: 'correct',
      remarks: `${row.number || `#${row.id}`} → ${posted.number || `#${posted.id}`} · ${reason}`,
      amount_cents: posted.amount_cents ?? 0,
      metadata: { corrected_id: posted.id, before: Object.fromEntries(config.fields.map((field) => [field, base[field]])), after: values },
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
    moves: [
      ['payments', 'invoice_id', "status = 'posted'"], ['credit_applications', 'invoice_id', '1 = 1'],
      ['refunds', 'invoice_id', '1 = 1'], ['visa_deposit_events', 'invoice_id', '1 = 1'],
    ],
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
    if (old.is_opening) throw bad("Change an opening balance from the customer's or supplier's Edit form.");
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

// Credit notes and supplier credits. The old one is reversed on its own date
// and voided; the new one is posted for the same customer or supplier, with
// the same booking, visa and bill links. Where it was used (applied to
// invoices or bills, refunded, or moved to a portal wallet) those steps move
// to the new one unchanged, so the new amount must cover them and its date
// cannot be after the first of them. Credits from a cancellation note and
// opening balances are changed where they were made.
const CREDITS = {
  credit_note: {
    table: 'credit_notes',
    label: 'credit note',
    entity: 'credit_note',
    fields: ['credit_date', 'amount_cents', 'notes', 'revenue_account_id'],
    used: (row) => row.applied_cents + row.refunded_cents,
    moves: [['credit_applications', 'credit_note_id', 'applied_date'], ['refunds', 'credit_note_id', 'refund_date', "status = 'paid'"]],
    check(db, row, values) {
      for (const column of ['booking_id', 'visa_id']) {
        if (!row[column]) continue;
        const table = column === 'booking_id' ? 'bookings' : 'visa_applications';
        const invoice = db.prepare(`SELECT i.* FROM ${table} j JOIN invoices i ON i.id = j.invoice_id WHERE j.id = ?`).get(row[column]);
        if (!invoice) continue;
        const others = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM credit_notes WHERE ${column} = ? AND status = 'issued' AND id <> ?`)
          .get(row[column], row.id).total;
        const limit = invoice.total_cents - others;
        if (Number(values.amount_cents) > limit) throw bad(`The refund cannot be more than ${money(limit)} (the invoice less other refunds)`);
        if (values.credit_date < invoice.issue_date) throw bad('The date cannot be before the invoice date');
      }
    },
    post(db, row, values) {
      const credit = require('./credits').createCredit(db, { ...values, customer_id: row.customer_id });
      db.prepare('UPDATE credit_notes SET booking_id = ?, visa_id = ? WHERE id = ?').run(row.booking_id, row.visa_id, credit.id);
      return db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(credit.id);
    },
    settle(db, row, id) {
      db.prepare('UPDATE credit_notes SET applied_cents = ?, refunded_cents = ? WHERE id = ?').run(row.applied_cents, row.refunded_cents, id);
    },
    get: (db, id) => require('./credits').getCredit(db, id),
  },
  supplier_credit: {
    table: 'supplier_credit_notes',
    label: 'supplier credit',
    entity: 'supplier_credit',
    fields: ['credit_date', 'amount_cents', 'notes'],
    used: (row) => row.applied_cents + row.refunded_cents + row.portal_settled_cents,
    moves: [
      ['supplier_credit_applications', 'credit_note_id', 'applied_date'],
      ['refunds', 'supplier_credit_note_id', 'refund_date', "status = 'paid'"],
      ['portal_credits', 'supplier_credit_note_id', 'credit_date', "status = 'posted'"],
    ],
    post(db, row, values) {
      const amount = Number(values.amount_cents);
      const old = db.prepare('SELECT description, amount_cents, account_id FROM supplier_credit_items WHERE credit_note_id = ? ORDER BY sort_order, id').all(row.id);
      let items;
      if (amount === row.amount_cents) items = old;
      else if (row.bill_id) items = require('./supplier-credits').itemsFromBill(db, row.bill_id, amount);
      else if (old.length === 1) items = [{ ...old[0], amount_cents: amount }];
      else throw bad('This supplier credit has several lines. Void it and record it again.');
      const credit = require('./supplier-credits').createSupplierCredit(db, {
        vendor_id: row.vendor_id, bill_id: row.bill_id, booking_id: row.booking_id, visa_id: row.visa_id,
        credit_date: values.credit_date, notes: values.notes, items,
      });
      return db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(credit.id);
    },
    settle(db, row, id) {
      db.prepare('UPDATE supplier_credit_notes SET applied_cents = ?, refunded_cents = ?, portal_settled_cents = ? WHERE id = ?')
        .run(row.applied_cents, row.refunded_cents, row.portal_settled_cents, id);
    },
    get: (db, id) => require('./supplier-credits').getSupplierCredit(db, id),
  },
};

const money = (value) => (value / 100).toFixed(2);

function correctCredit(db, kind, id, payload = {}) {
  const config = CREDITS[kind];
  if (!config) throw bad('This record cannot be corrected here');
  const { reverseEntry } = require('../accounting');
  const { cents, dateISO } = require('../util');
  return db.transaction(() => {
    const old = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(Number(id));
    if (!old) throw notFound(`The ${config.label} was not found`);
    if (old.status !== 'issued') throw bad(`This ${config.label} is void`);
    if (old.is_opening) throw bad("Change an opening balance from the customer's or supplier's Edit form.");
    if (old.cancellation_id) throw bad(`This ${config.label} came from a cancellation note. Void the note and cancel again.`);
    const reason = str(payload.remarks ?? payload.reason, 'Reason', { max: 500 });

    const sent = payload.values && typeof payload.values === 'object' ? payload.values : {};
    const values = {};
    for (const field of config.fields) values[field] = sent[field] !== undefined ? sent[field] : old[field];
    values.amount_cents = cents(values.amount_cents, 'Amount', { min: 1 });
    values.credit_date = dateISO(values.credit_date, 'Date');
    const used = config.used(old);
    if (values.amount_cents < used) {
      throw bad(`The new amount (${money(values.amount_cents)}) is less than what was already used from ${old.number} (${money(used)}). Void that first.`);
    }
    // Only uses still in force count; a voided refund no longer uses the credit.
    for (const [table, column, dateColumn, live = '1 = 1'] of config.moves) {
      const first = db.prepare(`SELECT MIN(${dateColumn}) AS date FROM ${table} WHERE ${column} = ? AND ${live}`).get(old.id).date;
      if (first && values.credit_date > first) throw bad(`The date cannot be after ${first}, when ${old.number} was first used`);
    }
    config.check?.(db, old, values);

    let voidEntryId = null;
    if (old.journal_entry_id) {
      voidEntryId = reverseEntry(db, old.journal_entry_id, { entry_date: old.credit_date, memo: `Corrected · ${reason} · ${config.label} ${old.number}`, source_type: 'void' });
    }
    db.prepare(`UPDATE ${config.table} SET status = 'void', void_entry_id = ?, applied_cents = 0, refunded_cents = 0${kind === 'supplier_credit' ? ', portal_settled_cents = 0' : ''} WHERE id = ?`)
      .run(voidEntryId, old.id);
    const created = config.post(db, old, values);
    for (const [table, column] of config.moves) db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(created.id, old.id);
    config.settle(db, old, created.id);

    audit.record(db, {
      entity_type: config.entity,
      entity_id: old.id,
      entity_number: old.number,
      action: 'correct',
      remarks: `${old.number} → ${created.number} · ${reason}`,
      amount_cents: created.amount_cents,
      metadata: { corrected_id: created.id, amount_before: old.amount_cents, amount_after: created.amount_cents, date_before: old.credit_date, date_after: created.credit_date, moved_used_cents: used },
    });
    return config.get(db, created.id);
  })();
}

module.exports = { correct, correctDocument, correctCredit, reverseOnOriginalDate, KINDS };
