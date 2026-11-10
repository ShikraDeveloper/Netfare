'use strict';

// Correct (admin only; see permissions.js): fixing a posted transaction in one
// step. The original is voided (its reason starts "Corrected") and a new one is
// posted with the corrected values, in one database transaction: if the new
// one cannot be posted, nothing changes. Values not sent keep the original's.
// The audit log records both numbers and the reason.
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

module.exports = { correct, KINDS };
