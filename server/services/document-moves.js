'use strict';

// What hangs on a posted document and follows it when the document is
// replaced: Correct on an invoice, bill, booking, visa or credit, and a
// changed opening balance. One list per kind, so every replacement moves the
// same things and receipt and payment numbers stay the same.
//   live: what still counts as a use (for "the date cannot be after the
//         first use"); only: what moves (a void payment stays behind).
// test/document-moves.test.js fails when a new table points at one of these
// documents and is neither listed here nor left out on purpose.

const MOVES = {
  invoice: [
    { table: 'payments', column: 'invoice_id', date: 'payment_date', live: "status = 'posted'", only: "status = 'posted'" },
    { table: 'credit_applications', column: 'invoice_id', date: 'applied_date', live: '1 = 1' },
    { table: 'refunds', column: 'invoice_id', date: 'refund_date', live: "status = 'paid'" },
    { table: 'visa_deposit_events', column: 'invoice_id', date: 'event_date', live: 'voided_at IS NULL' },
  ],
  bill: [
    { table: 'bill_payments', column: 'bill_id', date: 'payment_date', live: "status = 'posted'", only: "status = 'posted'" },
    { table: 'supplier_credit_applications', column: 'bill_id', date: 'applied_date', live: '1 = 1' },
    { table: 'supplier_credit_notes', column: 'bill_id', date: 'credit_date', live: "status = 'issued'" },
    { table: 'refunds', column: 'bill_id', date: 'refund_date', live: "status = 'paid'" },
    // Links only: they follow the bill but do not count as a use of it.
    { table: 'portal_credits', column: 'bill_id', date: 'credit_date', live: '1 = 0' },
    { table: 'post_dated_cheques', column: 'bill_id', date: 'cheque_date', live: '1 = 0' },
  ],
  credit_note: [
    { table: 'credit_applications', column: 'credit_note_id', date: 'applied_date', live: '1 = 1' },
    { table: 'refunds', column: 'credit_note_id', date: 'refund_date', live: "status = 'paid'" },
  ],
  supplier_credit: [
    { table: 'supplier_credit_applications', column: 'credit_note_id', date: 'applied_date', live: '1 = 1' },
    { table: 'refunds', column: 'supplier_credit_note_id', date: 'refund_date', live: "status = 'paid'" },
    { table: 'portal_credits', column: 'supplier_credit_note_id', date: 'credit_date', live: "status = 'posted'" },
  ],
};

function moveLinks(db, kind, fromId, toId) {
  for (const move of MOVES[kind] || []) {
    db.prepare(`UPDATE ${move.table} SET ${move.column} = ? WHERE ${move.column} = ? AND ${move.only || '1 = 1'}`).run(toId, fromId);
  }
}

// The earliest date anything still in force used the document, or null.
function firstUse(db, kind, id) {
  let first = null;
  for (const move of MOVES[kind] || []) {
    const date = db.prepare(`SELECT MIN(${move.date}) AS date FROM ${move.table} WHERE ${move.column} = ? AND ${move.live}`).get(id).date;
    if (date && (!first || date < first)) first = date;
  }
  return first;
}

module.exports = { MOVES, moveLinks, firstUse };
