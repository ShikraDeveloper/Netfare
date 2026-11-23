// @ts-check
'use strict';

// One payment to a supplier for several bills (Pay supplier): one entry for
// the whole transfer, so the bank shows it once, shared over the chosen bills
// (or the oldest first). Each bill's share is a bill payment linked to it.
// Bank charges sit on the payment. Voiding it undoes every share left.

const { bad, notFound, optionalStr, cents, dateISO, todayISO, notFuture } = require('../util');
const workflows = require('../workflows');
const {
  systemAccount, isCashAccount, bankChargesCents, bankChargeLines, postEntry, billBalanceCents,
} = require('../accounting');
const { allocateNumber } = require('./numbering');
const { markCreated } = require('../created-by');
const audit = require('./audit');

/**
 * @param {any} db
 * @param {Record<string, any>} [payload]
 */
function paySupplier(db, payload = {}) {
  return db.transaction(() => {
    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(payload.vendor_id));
    if (!vendor) throw bad('Choose a supplier');
    if (!vendor.is_active) throw bad('That supplier is archived');
    const date = notFuture(dateISO(payload.payment_date || todayISO(), 'Payment date'), 'Payment date');
    const amount = cents(payload.amount_cents, 'Amount paid', { min: 1 });
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payload.payment_account_id));
    if (!account || !account.is_active || !isCashAccount(account)) throw bad('Choose the cash or bank account it was paid from');
    const method = optionalStr(payload.method, 'Payment method', 100) || 'Bank transfer';
    if (['Cheque', 'Check'].includes(method)) throw bad('Record a cheque on each bill, so the cheque can be matched');
    const reference = optionalStr(payload.reference, 'Reference', 200);
    // Charges the bank adds on top of what the supplier receives.
    const charges = bankChargesCents(payload);

    const open = db.prepare(`
      SELECT * FROM bills
      WHERE vendor_id = ? AND status = 'received' AND bill_date <= ?
        AND total_cents > amount_paid_cents + credit_applied_cents
      ORDER BY COALESCE(due_date, bill_date), bill_date, id
    `).all(vendor.id, date);
    const openById = new Map(open.map((bill) => [bill.id, bill]));

    let shares = [];
    if (Array.isArray(payload.allocations)) {
      for (const row of payload.allocations) {
        const share = row.amount_cents == null || row.amount_cents === '' ? 0 : cents(row.amount_cents, 'Amount for a bill');
        if (!share) continue;
        const bill = openById.get(Number(row.bill_id));
        if (!bill) throw bad('Choose open bills of this supplier dated on or before the payment');
        if (share > billBalanceCents(bill)) throw bad(`More than the ${(billBalanceCents(bill) / 100).toFixed(2)} due on bill ${bill.number}`);
        if (shares.some((existing) => existing.bill.id === bill.id)) throw bad(`Bill ${bill.number} is listed twice`);
        shares.push({ bill, amount: share });
      }
    } else {
      let left = amount;
      for (const bill of open) {
        if (left <= 0) break;
        const share = Math.min(left, billBalanceCents(bill));
        shares.push({ bill, amount: share });
        left -= share;
      }
    }
    const shared = shares.reduce((sum, share) => sum + share.amount, 0);
    if (shared > amount) throw bad('The bill amounts add up to more than the amount paid');
    if (shared < amount) throw bad(`${((amount - shared) / 100).toFixed(2)} is not on any bill. Put it on a bill, or pay less`);
    for (const share of shares) workflows.assertCan('bill', 'record_payment', share.bill);

    const number = allocateNumber(db, 'supplier_payment', date);
    const info = db.prepare(`
      INSERT INTO supplier_payments (number, vendor_id, payment_date, amount_cents, method, reference, payment_account_id, bank_charges_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(number, vendor.id, date, amount, method, reference, account.id, charges);
    const id = Number(info.lastInsertRowid);
    markCreated(db, 'supplier_payments', id);

    const ap = systemAccount(db, '2000', 'Trade Payables');
    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Supplier payment ${number} — ${vendor.name} (${shares.map((share) => share.bill.number).join(', ')})`,
      reference: reference || number,
      source_type: 'supplier_payment',
      source_id: id,
      lines: [
        ...shares.map((share) => ({ account_id: ap.id, debit_cents: share.amount, credit_cents: 0, description: `Bill ${share.bill.number}` })),
        { account_id: account.id, debit_cents: 0, credit_cents: amount, description: `Payment ${number}` },
        ...bankChargeLines(db, charges, account, `payment ${number}`),
      ],
    });
    db.prepare('UPDATE supplier_payments SET journal_entry_id = ? WHERE id = ?').run(entryId, id);

    // Each bill's share, in the same entry.
    const insertShare = db.prepare(`
      INSERT INTO bill_payments (number, bill_id, vendor_id, payment_date, amount_cents, method, reference,
        payment_account_id, journal_entry_id, supplier_payment_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const share of shares) {
      const shareInfo = insertShare.run(allocateNumber(db, 'bill_payment', date), share.bill.id, vendor.id, date, share.amount,
        method, reference || number, account.id, entryId, id);
      markCreated(db, 'bill_payments', shareInfo.lastInsertRowid);
      db.prepare("UPDATE bills SET amount_paid_cents = amount_paid_cents + ?, updated_at = datetime('now') WHERE id = ?").run(share.amount, share.bill.id);
    }
    return getSupplierPayment(db, id);
  })();
}

/**
 * @param {any} db
 * @param {number} id
 */
function getSupplierPayment(db, id) {
  const payment = db.prepare(`
    SELECT sp.*, v.name AS vendor_name, a.code AS account_code, a.name AS account_name
    FROM supplier_payments sp JOIN vendors v ON v.id = sp.vendor_id JOIN accounts a ON a.id = sp.payment_account_id
    WHERE sp.id = ?
  `).get(Number(id));
  if (!payment) throw notFound('Supplier payment not found');
  const bills = db.prepare(`
    SELECT bp.id AS payment_id, bp.number AS payment_number, bp.amount_cents, bp.status,
           b.id AS bill_id, b.number AS bill_number, b.total_cents
    FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id
    WHERE bp.supplier_payment_id = ?
    ORDER BY bp.id
  `).all(payment.id);
  return { ...payment, bills };
}

// One bill's share undone on its own (a bill voided, or the share voided on
// the bill): the bank gets that share back; the rest of the payment stands.
/**
 * @param {any} db
 * @param {any} share A bill_payments row with supplier_payment_id.
 * @param {string} memo
 */
function reverseShare(db, share, memo) {
  const ap = systemAccount(db, '2000', 'Trade Payables');
  return postEntry(db, {
    entry_date: todayISO(),
    memo,
    reference: share.number,
    source_type: 'void',
    lines: [
      { account_id: share.payment_account_id, debit_cents: share.amount_cents, credit_cents: 0, description: `Void ${share.number}` },
      { account_id: ap.id, debit_cents: 0, credit_cents: share.amount_cents, description: `Void ${share.number}` },
    ],
  });
}

/**
 * @param {any} db
 * @param {number} id
 * @param {Record<string, any>} [payload]
 */
function voidSupplierPayment(db, id, payload = {}) {
  return db.transaction(() => {
    const payment = db.prepare('SELECT * FROM supplier_payments WHERE id = ?').get(Number(id));
    if (!payment) throw notFound('Supplier payment not found');
    if (payment.status === 'void') throw bad('That payment is already void');
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    const shares = db.prepare("SELECT * FROM bill_payments WHERE supplier_payment_id = ? AND status = 'posted' ORDER BY id").all(payment.id);
    const refunded = shares.length && db.prepare(`
      SELECT COUNT(*) AS c FROM refunds WHERE status = 'paid' AND bill_payment_id IN (${shares.map(() => '?').join(',')})
    `).get(...shares.map((share) => share.id)).c;
    if (refunded) throw bad('A bill in this payment has a refund. Void the refund first.');

    // The bank gets back what is still on bills, and the charges.
    const ap = systemAccount(db, '2000', 'Trade Payables');
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(payment.payment_account_id);
    const back = shares.reduce((sum, share) => sum + share.amount_cents, 0);
    const lines = [
      ...shares.map((share) => ({ account_id: ap.id, debit_cents: 0, credit_cents: share.amount_cents, description: `Void ${share.number}` })),
      ...(back ? [{ account_id: account.id, debit_cents: back, credit_cents: 0, description: `Void ${payment.number}` }] : []),
      ...bankChargeLines(db, payment.bank_charges_cents, account, `void ${payment.number}`)
        .map((line) => ({ ...line, debit_cents: line.credit_cents, credit_cents: line.debit_cents })),
    ];
    const voidEntryId = lines.length ? postEntry(db, {
      entry_date: todayISO(),
      memo: audit.withRemarks(`Void supplier payment ${payment.number}`, remarks),
      reference: payment.number,
      source_type: 'void',
      lines,
    }) : null;
    for (const share of shares) {
      db.prepare("UPDATE bill_payments SET status = 'void', void_entry_id = ?, voided_at = datetime('now') WHERE id = ?").run(voidEntryId, share.id);
      db.prepare("UPDATE bills SET amount_paid_cents = MAX(0, amount_paid_cents - ?), updated_at = datetime('now') WHERE id = ?").run(share.amount_cents, share.bill_id);
    }
    db.prepare("UPDATE supplier_payments SET status = 'void', void_entry_id = ?, voided_at = datetime('now') WHERE id = ?").run(voidEntryId, payment.id);
    audit.record(db, {
      entity_type: 'supplier_payment',
      entity_id: payment.id,
      entity_number: payment.number,
      action: 'void',
      remarks: remarks || `Voided supplier payment ${payment.number}`,
      amount_cents: payment.amount_cents,
      metadata: { bills: shares.length },
    });
    return getSupplierPayment(db, payment.id);
  })();
}

module.exports = { paySupplier, getSupplierPayment, voidSupplierPayment, reverseShare };
