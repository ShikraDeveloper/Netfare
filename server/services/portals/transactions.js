'use strict';

const { bad, notFound, optionalStr, cents, dateISO, todayISO } = require('../../util');
const { systemAccount, postEntry, reverseEntry, billBalanceCents } = require('../../accounting');
const { allocateNumber } = require('../numbering');
const audit = require('../audit');
const {
  SUPPLIER_ADVANCES,
  AP,
  assertAccount,
  balanceAsOf,
  lockBalance,
  canRemoveTopup,
  canRemoveCredit,
} = require('./common');
const { getPortal, portalForVendor } = require('./lifecycle');

function topUp(db, payload) {
  return db.transaction(() => {
    const portal = db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(Number(payload.portal_id));
    if (!portal) throw bad('Choose a portal');
    if (!portal.is_active) throw bad('That portal is archived');
    if (!portal.vendor_id) throw bad('Link this portal to a supplier before using its wallet');
    if (portal.settlement !== 'prepaid') throw bad('Only prepaid portals accept top-ups. Use the supplier ledger for credit accounts.');

    const amount = cents(payload.amount_cents, 'Top-up amount', { min: 1 });
    const date = dateISO(payload.topup_date || todayISO(), 'Top-up date');
    const account = assertAccount(db, payload.deposit_account_id, 'source account');
    const supplierAdvances = systemAccount(db, SUPPLIER_ADVANCES, 'Advances to Suppliers');
    const number = allocateNumber(db, 'topup', date);

    const info = db.prepare(`
      INSERT INTO portal_topups (number, portal_id, topup_date, amount_cents, method, reference, notes, deposit_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      portal.id,
      date,
      amount,
      optionalStr(payload.method, 'Method', 100) || 'Bank transfer',
      optionalStr(payload.reference, 'Reference', 200),
      optionalStr(payload.notes, 'Notes', 2000),
      account.id,
    );
    const topupId = Number(info.lastInsertRowid);

    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Portal top-up ${number} — ${portal.name}`,
      reference: number,
      source_type: 'portal_topup',
      source_id: topupId,
      lines: [
        { account_id: supplierAdvances.id, debit_cents: amount, credit_cents: 0, description: `Top-up ${number} · ${portal.name}` },
        { account_id: account.id, debit_cents: 0, credit_cents: amount, description: `Top-up ${number}` },
      ],
    });
    db.prepare('UPDATE portal_topups SET journal_entry_id = ? WHERE id = ?').run(entryId, topupId);
    return getPortal(db, portal.id);
  })();
}

function voidTopup(db, id, payload = {}) {
  return db.transaction(() => {
    const topup = db.prepare('SELECT * FROM portal_topups WHERE id = ?').get(id);
    if (!topup) throw notFound('Top-up not found');
    if (topup.status === 'void') throw bad('This top-up is already void');
    const balance = lockBalance(db, topup.portal_id);
    if (balance < topup.amount_cents) {
      throw bad('Part of this top-up has already been used. Withdraw the remaining balance instead.');
    }
    if (!canRemoveTopup(db, topup)) {
      throw bad('Voiding this top-up would make the wallet negative on a past date. Withdraw the remaining balance instead.');
    }
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    let voidEntryId = null;
    if (topup.journal_entry_id) {
      voidEntryId = reverseEntry(db, topup.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void portal top-up ${topup.number}`, remarks),
        source_type: 'void',
      });
    }
    db.prepare(`
      UPDATE portal_topups SET status = 'void', void_entry_id = ?, voided_at = datetime('now') WHERE id = ?
    `).run(voidEntryId, topup.id);
    audit.record(db, {
      entity_type: 'portal_topup',
      entity_id: topup.id,
      entity_number: topup.number,
      action: 'void',
      remarks: remarks || `Voided portal top-up ${topup.number}`,
      amount_cents: topup.amount_cents,
      metadata: { portal_id: topup.portal_id },
    });
    return getPortal(db, topup.portal_id);
  })();
}

// Kept as an alias for older clients. A top-up is voided, never deleted, so
// the audit trail and the original document number survive.
function voidPortalRefund(db, id, payload = {}) {
  return db.transaction(() => {
    const refund = db.prepare('SELECT * FROM portal_refunds WHERE id = ?').get(id);
    if (!refund) throw notFound('Portal withdrawal not found');
    if (refund.status === 'void') throw bad('This portal withdrawal is already void');
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    let voidEntryId = null;
    if (refund.journal_entry_id) {
      voidEntryId = reverseEntry(db, refund.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void portal withdrawal #${refund.id}`, remarks),
        source_type: 'void',
      });
    }
    db.prepare(`
      UPDATE portal_refunds SET status = 'void', void_entry_id = ?, voided_at = datetime('now') WHERE id = ?
    `).run(voidEntryId, refund.id);
    audit.record(db, {
      entity_type: 'portal_refund',
      entity_id: refund.id,
      entity_number: `#${refund.id}`,
      action: 'void',
      remarks: remarks || `Voided portal withdrawal #${refund.id}`,
      amount_cents: refund.amount_cents,
      metadata: { portal_id: refund.portal_id },
    });
    return getPortal(db, refund.portal_id);
  })();
}

function voidPortalCredit(db, id, payload = {}) {
  return db.transaction(() => {
    const credit = db.prepare('SELECT * FROM portal_credits WHERE id = ?').get(id);
    if (!credit) throw notFound('Portal credit not found');
    if (credit.status === 'void') throw bad('This portal credit is already void');
    const balance = lockBalance(db, credit.portal_id);
    if (balance < credit.amount_cents) {
      throw bad('This portal credit has already been used. Void the bill settlements from this wallet first.');
    }
    if (!canRemoveCredit(db, credit)) {
      throw bad('Voiding this portal credit would make the wallet negative on a past date. Void the bill settlements from this wallet first.');
    }
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    let voidEntryId = null;
    if (credit.journal_entry_id) {
      voidEntryId = reverseEntry(db, credit.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void portal credit ${credit.number}`, remarks),
        source_type: 'void',
      });
    }
    db.prepare(`
      UPDATE portal_credits SET status = 'void', void_entry_id = ?, voided_at = datetime('now') WHERE id = ?
    `).run(voidEntryId, credit.id);
    if (credit.supplier_credit_note_id) {
      db.prepare(`
        UPDATE supplier_credit_notes SET portal_settled_cents = MAX(0, portal_settled_cents - ?)
        WHERE id = ?
      `).run(credit.amount_cents, credit.supplier_credit_note_id);
    }
    audit.record(db, {
      entity_type: 'portal_credit',
      entity_id: credit.id,
      entity_number: credit.number,
      action: 'void',
      remarks: remarks || `Voided portal credit ${credit.number}`,
      amount_cents: credit.amount_cents,
      metadata: {
        portal_id: credit.portal_id,
        supplier_credit_note_id: credit.supplier_credit_note_id || null,
      },
    });
    return getPortal(db, credit.portal_id);
  })();
}

function refundPortal(db, id, payload = {}) {
  return db.transaction(() => {
    const portal = db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(id);
    if (!portal) throw notFound('Portal not found');

    if (!portal.vendor_id) throw bad('Link this portal to a supplier before using its wallet');
    if (portal.settlement !== 'prepaid') throw bad('Only prepaid portal wallets can be withdrawn');

    const date = dateISO(payload.refund_date || todayISO(), 'Refund date');
    const balance = Math.min(lockBalance(db, id), balanceAsOf(db, id, date));
    if (balance <= 0) throw bad('This portal has no available balance to withdraw on that date');
    const amount = payload.amount_cents == null
      ? balance
      : cents(payload.amount_cents, 'Withdrawal amount', { min: 1 });
    if (amount > balance) throw bad('Withdrawal is more than the available portal balance on that date');

    const account = assertAccount(db, payload.payment_account_id, 'refund account');
    const supplierAdvances = systemAccount(db, SUPPLIER_ADVANCES, 'Advances to Suppliers');

    const info = db.prepare(`
      INSERT INTO portal_refunds (portal_id, refund_date, amount_cents, method, reference, notes, payment_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      portal.id,
      date,
      amount,
      optionalStr(payload.method, 'Method', 100) || 'Bank transfer',
      optionalStr(payload.reference, 'Reference', 200),
      optionalStr(payload.notes, 'Notes', 2000),
      account.id,
    );
    const refundId = Number(info.lastInsertRowid);

    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Portal withdrawal — ${portal.name}`,
      reference: portal.name,
      source_type: 'portal_refund',
      source_id: refundId,
      lines: [
        { account_id: account.id, debit_cents: amount, credit_cents: 0, description: `Withdrawal from ${portal.name}` },
        { account_id: supplierAdvances.id, debit_cents: 0, credit_cents: amount, description: `Withdrawal from ${portal.name}` },
      ],
    });
    db.prepare('UPDATE portal_refunds SET journal_entry_id = ? WHERE id = ?').run(entryId, refundId);
    return getPortal(db, portal.id);
  })();
}

function settleBillFromPortal(db, payload) {
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(payload.bill_id));
    if (!bill) throw bad('Choose a bill');
    if (bill.status !== 'received') throw bad('Only received bills can be settled from a portal');

    const billBalance = billBalanceCents(bill);
    if (billBalance <= 0) throw bad('That bill is already fully paid');

    const portal = payload.portal_id
      ? db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(Number(payload.portal_id))
      : portalForVendor(db, bill.vendor_id);
    if (!portal) throw bad('No portal is linked to this supplier');
    if (!portal.is_active) throw bad('That portal is archived');
    if (!portal.vendor_id || portal.vendor_id !== bill.vendor_id) {
      throw bad(`Portal "${portal.name}" is not linked to this bill's supplier`);
    }
    if (portal.settlement !== 'prepaid') {
      throw bad('Only a prepaid portal wallet can settle a bill. Pay credit-account bills through Trade Payables.');
    }

    const date = dateISO(payload.settle_date || todayISO(), 'Settlement date');
    if (date < bill.bill_date) throw bad('Settlement date cannot be before the bill date');

    const available = Math.min(lockBalance(db, portal.id), balanceAsOf(db, portal.id, date));
    if (available <= 0) throw bad(`Portal "${portal.name}" has no available balance on that date`);

    const requested = payload.amount_cents == null
      ? billBalance
      : cents(payload.amount_cents, 'Settlement amount', { min: 1 });
    const amount = Math.min(requested, billBalance, available);
    if (amount <= 0) throw bad('Nothing to settle from this portal');

    const supplierAdvances = systemAccount(db, SUPPLIER_ADVANCES, 'Advances to Suppliers');
    const ap = systemAccount(db, AP, 'Trade Payables');
    const number = allocateNumber(db, 'bill_payment', date);

    const info = db.prepare(`
      INSERT INTO bill_payments (number, bill_id, vendor_id, payment_date, amount_cents, method, reference, payment_account_id, portal_id)
      VALUES (?, ?, ?, ?, ?, 'Portal wallet', ?, ?, ?)
    `).run(
      number,
      bill.id,
      bill.vendor_id,
      date,
      amount,
      portal.name,
      supplierAdvances.id,
      portal.id,
    );
    const paymentId = Number(info.lastInsertRowid);

    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Bill ${bill.number} settled from portal ${portal.name}`,
      reference: bill.number,
      source_type: 'portal_settle',
      source_id: paymentId,
      lines: [
        { account_id: ap.id, debit_cents: amount, credit_cents: 0, description: `Bill ${bill.number}` },
        { account_id: supplierAdvances.id, debit_cents: 0, credit_cents: amount, description: `Portal ${portal.name}` },
      ],
    });
    db.prepare('UPDATE bill_payments SET journal_entry_id = ? WHERE id = ?').run(entryId, paymentId);
    db.prepare(`
      UPDATE bills SET amount_paid_cents = amount_paid_cents + ?, portal_id = COALESCE(portal_id, ?),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(amount, portal.id, bill.id);

    return { settled_cents: amount, bill_id: bill.id, portal_id: portal.id, portal_name: portal.name };
  })();
}

// Used when a booking is confirmed: prepaid portals settle their vendor's bill
// automatically, up to whatever balance is available.
function autoSettleBill(db, billId, settleDate) {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill || bill.status !== 'received') return null;
  const portal = portalForVendor(db, bill.vendor_id);
  if (!portal || portal.settlement !== 'prepaid') return null;

  const billBalance = billBalanceCents(bill);
  if (billBalance <= 0) return null;
  const available = Math.min(lockBalance(db, portal.id), balanceAsOf(db, portal.id, settleDate || bill.bill_date));
  if (available <= 0) {
    return { settled_cents: 0, portal_id: portal.id, portal_name: portal.name, shortfall_cents: billBalance };
  }

  const amount = Math.min(billBalance, available);
  const result = settleBillFromPortal(db, {
    bill_id: bill.id,
    portal_id: portal.id,
    amount_cents: amount,
    settle_date: settleDate || bill.bill_date,
  });
  return { ...result, shortfall_cents: Math.max(0, billBalance - amount) };
}

// A supplier credit on a prepaid portal becomes wallet value without any cash
// moving. Internally the supplier credit is settled into Advances to Suppliers.
function recordPortalCredit(db, payload = {}) {
  const portal = db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(Number(payload.portal_id));
  if (!portal) throw bad('Choose a portal');
  if (!portal.is_active) throw bad('That portal is archived');
  if (!portal.vendor_id) throw bad('Link this portal to a supplier before recording a credit');
  if (portal.settlement !== 'prepaid') throw bad('Only prepaid portals accept wallet credits');
  const amount = cents(payload.amount_cents, 'Portal credit amount', { min: 1 });
  const date = dateISO(payload.credit_date || todayISO(), 'Credit date');

  let note = null;
  if (payload.supplier_credit_note_id) {
    note = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(Number(payload.supplier_credit_note_id));
    if (!note) throw bad('Choose a valid supplier credit note');
    if (note.status !== 'issued') throw bad('That supplier credit is void');
    if (note.vendor_id !== portal.vendor_id) throw bad('The supplier credit belongs to a different supplier');
    if (date < note.credit_date) throw bad('Portal credit date cannot be before the supplier credit date');
    const remaining = note.amount_cents - note.applied_cents - note.refunded_cents - note.portal_settled_cents;
    if (amount > remaining) throw bad('Portal credit exceeds the remaining supplier credit');
  }
  if (payload.bill_id) {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(payload.bill_id));
    if (!bill) throw bad('Choose a valid bill');
    if (bill.vendor_id !== portal.vendor_id) throw bad('The bill belongs to a different supplier');
  }

  const supplierAdvances = systemAccount(db, SUPPLIER_ADVANCES, 'Advances to Suppliers');
  const supplierCredits = systemAccount(db, '1450', 'Supplier Credits');
  const number = allocateNumber(db, 'portal_credit', date);
  const info = db.prepare(`
    INSERT INTO portal_credits (
      number, portal_id, credit_date, amount_cents, bill_id, supplier_credit_note_id, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    number,
    portal.id,
    date,
    amount,
    payload.bill_id ? Number(payload.bill_id) : null,
    note ? note.id : null,
    optionalStr(payload.notes, 'Notes', 2000),
  );
  const creditId = Number(info.lastInsertRowid);
  const entryId = postEntry(db, {
    entry_date: date,
    memo: `Portal credit ${number} — ${portal.name}`,
    reference: number,
    source_type: 'portal_credit',
    source_id: creditId,
    lines: [
      { account_id: supplierAdvances.id, debit_cents: amount, credit_cents: 0, description: `Portal credit ${number} · ${portal.name}` },
      { account_id: supplierCredits.id, debit_cents: 0, credit_cents: amount, description: `Portal credit ${number}` },
    ],
  });
  db.prepare('UPDATE portal_credits SET journal_entry_id = ? WHERE id = ?').run(entryId, creditId);
  if (note) {
    db.prepare('UPDATE supplier_credit_notes SET portal_settled_cents = portal_settled_cents + ? WHERE id = ?')
      .run(amount, note.id);
  }
  return db.prepare('SELECT * FROM portal_credits WHERE id = ?').get(creditId);
}

module.exports = {
  topUp,
  voidTopup,
  voidPortalRefund,
  voidPortalCredit,
  refundPortal,
  settleBillFromPortal,
  autoSettleBill,
  recordPortalCredit,
};
