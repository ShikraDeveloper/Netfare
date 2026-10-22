'use strict';

const {
  bad,
  notFound,
  optionalStr,
  num,
  cents,
  dateISO,
  todayISO,
} = require('../util');
const { systemAccount, isCashAccount, postEntry, reverseEntry } = require('../accounting');
const { allocateNumber } = require('./numbering');
const audit = require('./audit');

const ADVANCE_ACCOUNT = '2400';
const AR_ACCOUNT = '1100';

function remainingCents(advance) {
  if (!advance || advance.voided_at) return 0;
  return Math.max(0, advance.amount_cents - advance.applied_cents - advance.refunded_cents);
}

function serializeAdvance(advance) {
  return {
    ...advance,
    status_display: advance.voided_at ? 'void' : advance.status,
    voided: Boolean(advance.voided_at),
    remaining_cents: remainingCents(advance),
  };
}

function getAdvance(db, id) {
  const advance = db.prepare(`
    SELECT a.*, c.name AS customer_name, b.number AS booking_number, v.number AS visa_number
    FROM customer_advances a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN bookings b ON b.id = a.booking_id
    LEFT JOIN visa_applications v ON v.id = a.visa_id
    WHERE a.id = ?
  `).get(id);
  if (!advance) throw notFound('Advance not found');
  advance.refunds = db.prepare(`
    SELECT r.*, a.name AS account_name
    FROM refunds r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.advance_id = ?
    ORDER BY r.refund_date, r.id
  `).all(advance.id);
  return serializeAdvance(advance);
}

function listAdvances(db, { customer_id, booking_id, visa_id, status } = {}) {
  const clauses = [];
  const params = [];
  if (customer_id) {
    clauses.push('a.customer_id = ?');
    params.push(Number(customer_id));
  }
  if (booking_id) {
    clauses.push('a.booking_id = ?');
    params.push(Number(booking_id));
  }
  if (visa_id) {
    clauses.push('a.visa_id = ?');
    params.push(Number(visa_id));
  }
  if (status) {
    clauses.push('a.status = ?');
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT a.*, c.name AS customer_name, b.number AS booking_number, v.number AS visa_number
    FROM customer_advances a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN bookings b ON b.id = a.booking_id
    LEFT JOIN visa_applications v ON v.id = a.visa_id
    ${where}
    ORDER BY a.advance_date DESC, a.id DESC
  `).all(...params).map(serializeAdvance);
}

function createAdvance(db, payload) {
  return db.transaction(() => {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(payload.customer_id));
    if (!customer) throw bad('Choose a customer');
    if (!customer.is_active) throw bad('That customer is archived');

    let bookingId = null;
    if (payload.booking_id) {
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(payload.booking_id));
      if (!booking) throw bad('Booking not found');
      if (booking.customer_id !== customer.id) throw bad('That booking belongs to a different customer');
      bookingId = booking.id;
    }

    let visaId = null;
    if (payload.visa_id) {
      const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(Number(payload.visa_id));
      if (!visa) throw bad('Visa application not found');
      if (visa.customer_id !== customer.id) throw bad('That visa application belongs to a different customer');
      visaId = visa.id;
    }

    const amount = cents(payload.amount_cents, 'Advance amount', { min: 1 });
    const advanceDate = dateISO(payload.advance_date || todayISO(), 'Advance date');
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payload.deposit_account_id));
    if (!account) throw bad('Choose a deposit account');
    if (!account.is_active) throw bad('That deposit account is archived');
    if (!isCashAccount(account)) throw bad('Deposit account must be an active cash or bank account');

    const advancesAccount = systemAccount(db, ADVANCE_ACCOUNT, 'Customer Advances');
    const number = allocateNumber(db, 'advance', advanceDate);

    const info = db.prepare(`
      INSERT INTO customer_advances (number, customer_id, booking_id, visa_id, advance_date, amount_cents,
        method, reference, deposit_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      customer.id,
      bookingId,
      visaId,
      advanceDate,
      amount,
      optionalStr(payload.method, 'Payment method', 100) || 'Bank transfer',
      optionalStr(payload.reference, 'Reference', 200),
      account.id,
    );
    const advanceId = Number(info.lastInsertRowid);
    const entryId = postEntry(db, {
      entry_date: advanceDate,
      memo: `Customer advance ${number} — ${customer.name}`,
      reference: number,
      source_type: 'advance',
      source_id: advanceId,
      lines: [
        { account_id: account.id, debit_cents: amount, credit_cents: 0, description: `Advance ${number}` },
        { account_id: advancesAccount.id, debit_cents: 0, credit_cents: amount, description: `Advance from ${customer.name}` },
      ],
    });
    db.prepare('UPDATE customer_advances SET journal_entry_id = ? WHERE id = ?').run(entryId, advanceId);
    return getAdvance(db, advanceId);
  })();
}

function applyAdvance(db, id, payload = {}) {
  return db.transaction(() => {
    const advance = db.prepare('SELECT * FROM customer_advances WHERE id = ?').get(id);
    if (!advance) throw notFound('Advance not found');
    if (advance.voided_at) throw bad('This advance is void');
    const remaining = remainingCents(advance);
    if (remaining <= 0) throw bad('This advance has already been applied or refunded');

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(payload.invoice_id));
    if (!invoice) throw bad('Choose an invoice');
    if (invoice.status !== 'sent') throw bad('Only sent invoices can receive an advance');
    if (invoice.customer_id !== advance.customer_id) throw bad('That invoice belongs to a different customer');

    const invoiceBalance = Math.max(0, invoice.total_cents - invoice.amount_paid_cents - (invoice.credit_applied_cents || 0));
    if (invoiceBalance <= 0) throw bad('That invoice is already fully paid');
    const amount = Math.min(remaining, invoiceBalance);

    const advancesAccount = systemAccount(db, ADVANCE_ACCOUNT, 'Customer Advances');
    const ar = systemAccount(db, AR_ACCOUNT, 'Accounts Receivable');
    const paymentDate = dateISO(payload.payment_date || todayISO(), 'Application date');
    const number = allocateNumber(db, 'payment', paymentDate);

    const info = db.prepare(`
      INSERT INTO payments (number, customer_id, invoice_id, payment_date, amount_cents, method,
        reference, deposit_account_id, advance_id)
      VALUES (?, ?, ?, ?, ?, 'Advance applied', ?, ?, ?)
    `).run(
      number,
      advance.customer_id,
      invoice.id,
      paymentDate,
      amount,
      advance.number,
      advancesAccount.id,
      advance.id,
    );
    const paymentId = Number(info.lastInsertRowid);
    const entryId = postEntry(db, {
      entry_date: paymentDate,
      memo: `Advance ${advance.number} applied to invoice ${invoice.number}`,
      reference: invoice.number,
      source_type: 'advance_apply',
      source_id: paymentId,
      lines: [
        { account_id: advancesAccount.id, debit_cents: amount, credit_cents: 0, description: `Advance ${advance.number}` },
        { account_id: ar.id, debit_cents: 0, credit_cents: amount, description: `Invoice ${invoice.number}` },
      ],
    });
    db.prepare('UPDATE payments SET journal_entry_id = ? WHERE id = ?').run(entryId, paymentId);

    const applied = advance.applied_cents + amount;
    const status = applied + advance.refunded_cents >= advance.amount_cents ? 'applied' : 'open';
    db.prepare('UPDATE customer_advances SET applied_cents = ?, status = ? WHERE id = ?').run(applied, status, id);
    db.prepare("UPDATE invoices SET amount_paid_cents = amount_paid_cents + ?, updated_at = datetime('now') WHERE id = ?").run(amount, invoice.id);

    return {
      advance: getAdvance(db, id),
      applied_cents: amount,
      invoice_id: invoice.id,
    };
  })();
}

function refundAdvance(db, id, payload = {}) {
  return db.transaction(() => {
    const advance = db.prepare('SELECT * FROM customer_advances WHERE id = ?').get(id);
    if (!advance) throw notFound('Advance not found');
    if (advance.voided_at) throw bad('This advance is void');
    const remaining = remainingCents(advance);
    if (remaining <= 0) throw bad('This advance has already been applied or refunded');

    const amount = payload.amount_cents == null
      ? remaining
      : cents(payload.amount_cents, 'Refund amount', { min: 1 });
    if (amount > remaining) throw bad('Refund is more than the unapplied advance balance');

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payload.payment_account_id));
    if (!account) throw bad('Choose the account to refund from');
    if (!account.is_active) throw bad('That account is archived');
    if (!isCashAccount(account)) throw bad('Refund account must be an active cash or bank account');

    const advancesAccount = systemAccount(db, ADVANCE_ACCOUNT, 'Customer Advances');
    const refundDate = dateISO(payload.refund_date || todayISO(), 'Refund date');

    const entryId = postEntry(db, {
      entry_date: refundDate,
      memo: `Refund of customer advance ${advance.number}`,
      reference: advance.number,
      source_type: 'advance_refund',
      source_id: advance.id,
      lines: [
        { account_id: advancesAccount.id, debit_cents: amount, credit_cents: 0, description: `Advance ${advance.number}` },
        { account_id: account.id, debit_cents: 0, credit_cents: amount, description: `Refund to customer` },
      ],
    });

    const refunded = advance.refunded_cents + amount;
    const status = advance.applied_cents + refunded >= advance.amount_cents ? 'refunded' : 'open';
    db.prepare('UPDATE customer_advances SET refunded_cents = ?, status = ? WHERE id = ?').run(refunded, status, id);
    const number = allocateNumber(db, 'refund', refundDate);
    const refundInfo = db.prepare(`
      INSERT INTO refunds (
        number, refund_type, status, party_id, advance_id, refund_date,
        amount_cents, method, reference, notes, account_id, journal_entry_id
      ) VALUES (?, 'customer', 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      advance.customer_id,
      advance.id,
      refundDate,
      amount,
      optionalStr(payload.method, 'Refund method', 100) || 'Bank transfer',
      advance.number,
      optionalStr(payload.notes, 'Notes', 2000) || `Refund of advance ${advance.number}`,
      account.id,
      entryId,
    );
    return {
      advance: getAdvance(db, id),
      refund_id: Number(refundInfo.lastInsertRowid),
      journal_entry_id: entryId,
    };
  })();
}

function voidAdvance(db, id, payload = {}) {
  return db.transaction(() => {
    const advance = db.prepare('SELECT * FROM customer_advances WHERE id = ?').get(id);
    if (!advance) throw notFound('Advance not found');
    if (advance.voided_at) throw bad('This advance is already void');
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);

    // Refunds and applications are part of the advance. Reverse them first so
    // the customer advance control account returns to zero.
    const refundService = require('./refunds');
    const invoiceService = require('./invoices');
    const refunds = db.prepare(
      "SELECT id FROM refunds WHERE advance_id = ? AND status = 'paid' ORDER BY id",
    ).all(advance.id);
    for (const refund of refunds) {
      refundService.voidRefund(db, refund.id, {
        remarks: remarks || `Voided with advance ${advance.number}`,
      });
    }

    const payments = db.prepare(
      "SELECT id FROM payments WHERE advance_id = ? AND status = 'posted' ORDER BY id",
    ).all(advance.id);
    for (const payment of payments) {
      invoiceService.deleteInvoicePayment(db, payment.id, {
        remarks: remarks || `Voided with advance ${advance.number}`,
      });
    }

    const fresh = db.prepare('SELECT * FROM customer_advances WHERE id = ?').get(advance.id);
    if (fresh.applied_cents > 0 || fresh.refunded_cents > 0) {
      throw bad('Linked advance applications or refunds could not be fully reversed');
    }
    let voidEntryId = null;
    if (fresh.journal_entry_id) {
      voidEntryId = reverseEntry(db, fresh.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void customer advance ${fresh.number}`, remarks),
        source_type: 'void',
      });
    }
    db.prepare(`
      UPDATE customer_advances SET void_entry_id = ?, voided_at = datetime('now'),
        applied_cents = 0, refunded_cents = 0 WHERE id = ?
    `).run(voidEntryId, advance.id);
    audit.record(db, {
      entity_type: 'customer_advance',
      entity_id: advance.id,
      entity_number: advance.number,
      action: 'void',
      remarks: remarks || `Voided customer advance ${advance.number}`,
      amount_cents: advance.amount_cents,
      metadata: {
        refunds_voided: refunds.length,
        invoice_payments_voided: payments.length,
      },
    });
    return getAdvance(db, id);
  })();
}

function deleteAdvance(db, id, payload = {}) {
  return db.transaction(() => {
    const advance = db.prepare('SELECT * FROM customer_advances WHERE id = ?').get(id);
    if (!advance) throw notFound('Advance not found');
    if (advance.voided_at) throw bad('This advance is already void');
    if (advance.applied_cents > 0 || advance.refunded_cents > 0) {
      throw bad('This advance has already been applied or refunded. Refund it instead of deleting.');
    }
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    if (advance.journal_entry_id) {
      reverseEntry(db, advance.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Reverse advance ${advance.number}`, remarks),
        source_type: 'void',
      });
    }
    audit.record(db, {
      entity_type: 'customer_advance',
      entity_id: advance.id,
      entity_number: advance.number,
      action: 'delete',
      remarks: remarks || `Deleted advance ${advance.number}`,
      amount_cents: advance.amount_cents,
    });
    db.prepare('DELETE FROM customer_advances WHERE id = ?').run(id);
    return { deleted: true };
  })();
}

module.exports = {
  listAdvances,
  getAdvance,
  createAdvance,
  applyAdvance,
  refundAdvance,
  voidAdvance,
  deleteAdvance,
};
