'use strict';

const { getSettings } = require('../accounting');

function allocateNumber(db, kind, dateStr) {
  const settings = getSettings(db);
  const year = String(dateStr || '').slice(0, 4) || String(new Date().getFullYear());
  const configs = {
    invoice: {
      table: 'invoices',
      prefix: settings.invoice_prefix || 'INV',
      next: settings.next_invoice_number,
      column: 'next_invoice_number',
    },
    bill: {
      table: 'bills',
      prefix: settings.bill_prefix || 'BILL',
      next: settings.next_bill_number,
      column: 'next_bill_number',
    },
    payment: {
      table: 'payments',
      prefix: 'PMT',
      next: settings.next_payment_number,
      column: 'next_payment_number',
    },
    bill_payment: {
      table: 'bill_payments',
      prefix: 'BPMT',
      next: settings.next_payment_number,
      column: 'next_payment_number',
    },
    booking: {
      table: 'bookings',
      prefix: settings.booking_prefix || 'BK',
      next: settings.next_booking_number,
      column: 'next_booking_number',
    },
    visa: {
      table: 'visa_applications',
      prefix: settings.visa_prefix || 'VIS',
      next: settings.next_visa_number,
      column: 'next_visa_number',
    },
    advance: {
      table: 'customer_advances',
      prefix: 'ADV',
      next: settings.next_advance_number,
      column: 'next_advance_number',
    },
    topup: {
      table: 'portal_topups',
      prefix: settings.topup_prefix || 'TOP',
      next: settings.next_topup_number,
      column: 'next_topup_number',
    },
    refund: {
      table: 'refunds',
      prefix: 'REF',
      next: settings.next_refund_number,
      column: 'next_refund_number',
    },
    deposit: {
      table: 'cash_deposits',
      prefix: 'DEP',
      next: settings.next_deposit_number,
      column: 'next_deposit_number',
    },
    credit: {
      table: 'credit_notes',
      prefix: 'CR',
      next: settings.next_credit_number,
      column: 'next_credit_number',
    },
    supplier_credit: {
      table: 'supplier_credit_notes',
      prefix: settings.supplier_credit_prefix || 'SCN',
      next: settings.next_supplier_credit_number,
      column: 'next_supplier_credit_number',
    },
    cancellation: {
      table: 'cancellations',
      prefix: settings.cancellation_prefix || 'CNC',
      next: settings.next_cancellation_number,
      column: 'next_cancellation_number',
    },
    portal_credit: {
      table: 'portal_credits',
      prefix: settings.portal_credit_prefix || 'PCR',
      next: settings.next_portal_credit_number,
      column: 'next_portal_credit_number',
    },
  };
  const config = configs[kind];
  if (!config) throw new Error(`Unknown document kind: ${kind}`);

  let next = config.next;
  let number;
  do {
    number = `${config.prefix}-${year}-${String(next).padStart(4, '0')}`;
    next += 1;
  } while (db.prepare(`SELECT 1 FROM ${config.table} WHERE number = ?`).get(number));

  db.prepare(`UPDATE settings SET ${config.column} = ? WHERE id = 1`).run(next);
  return number;
}

module.exports = { allocateNumber };
