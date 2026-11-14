'use strict';

const {
  bad,
  notFound,
  optionalStr,
  cents,
  dateISO,
  todayISO,
  notFuture,
} = require('../util');
const {
  systemAccount, isCashAccount, postEntry, reverseEntry, bankChargesCents, bankChargeLines,
} = require('../accounting');
const { markCreated } = require('../created-by');
const { allocateNumber } = require('./numbering');
const audit = require('./audit');
const workflows = require('../workflows');

const ADVANCE_ACCOUNT = '2400';
const AR_ACCOUNT = '1100';

// The stored status follows from the amounts alone, so the order of
// applications and refunds does not change it: open while money is left;
// once used up, refunded if any of it went back, otherwise applied.
function advanceStatus({ amount_cents: amount, applied_cents: applied = 0, refunded_cents: refunded = 0 }) {
  if (applied + refunded < amount) return 'open';
  return refunded > 0 ? 'refunded' : 'applied';
}

function remainingCents(advance) {
  if (!advance || advance.voided_at) return 0;
  return Math.max(0, advance.amount_cents - advance.applied_cents - advance.refunded_cents);
}

function serializeAdvance(advance) {
  return {
    ...advance,
    status_display: workflows.isVoid(advance) ? 'void' : advance.status,
    voided: workflows.isVoid(advance),
    remaining_cents: remainingCents(advance),
    allowed_actions: workflows.allowedActions('advance', advance),
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

// A receipt (receivePayment) pays its invoice shares in the same entry:
// bank in, Trade Receivables out for each share, and only what is left over
// as the customer's advance.
function createAdvance(db, payload, { receipt = false, shares = [] } = {}) {
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

    const advancesAccount = systemAccount(db, ADVANCE_ACCOUNT, 'Contract Liabilities (Customer Advances)');
    // The customer's money counts in full; what the bank keeps is our cost.
    const charges = bankChargesCents(payload, { max: amount });
    const number = allocateNumber(db, receipt ? 'receipt' : 'advance', advanceDate);

    const info = db.prepare(`
      INSERT INTO customer_advances (number, customer_id, booking_id, visa_id, advance_date, amount_cents,
        method, reference, deposit_account_id, bank_charges_cents, is_receipt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      charges,
      receipt ? 1 : 0,
    );
    const advanceId = Number(info.lastInsertRowid);
    markCreated(db, 'customer_advances', advanceId);
    const shared = shares.reduce((sum, share) => sum + share.amount, 0);
    const ar = shares.length ? systemAccount(db, AR_ACCOUNT, 'Trade Receivables') : null;
    const entryId = postEntry(db, {
      entry_date: advanceDate,
      memo: `${receipt ? 'Customer receipt' : 'Customer advance'} ${number} — ${customer.name}`,
      reference: number,
      source_type: receipt ? 'receipt' : 'advance',
      source_id: advanceId,
      lines: [
        { account_id: account.id, debit_cents: amount, credit_cents: 0, description: `${receipt ? 'Receipt' : 'Advance'} ${number}` },
        ...shares.map((share) => ({ account_id: ar.id, debit_cents: 0, credit_cents: share.amount, description: `Invoice ${share.invoice.number}` })),
        ...(amount > shared ? [{ account_id: advancesAccount.id, debit_cents: 0, credit_cents: amount - shared, description: `Advance from ${customer.name}` }] : []),
        ...bankChargeLines(db, charges, account, `${receipt ? 'receipt' : 'advance'} ${number}`),
      ],
    });
    db.prepare('UPDATE customer_advances SET journal_entry_id = ? WHERE id = ?').run(entryId, advanceId);
    for (const share of shares) {
      const paymentNumber = allocateNumber(db, 'payment', advanceDate);
      const payment = db.prepare(`
        INSERT INTO payments (number, customer_id, invoice_id, payment_date, amount_cents, method,
          reference, deposit_account_id, advance_id, journal_entry_id, from_receipt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(paymentNumber, customer.id, share.invoice.id, advanceDate, share.amount,
        optionalStr(payload.method, 'Payment method', 100) || 'Bank transfer', number, account.id, advanceId, entryId);
      markCreated(db, 'payments', Number(payment.lastInsertRowid));
      db.prepare("UPDATE invoices SET amount_paid_cents = amount_paid_cents + ?, updated_at = datetime('now') WHERE id = ?").run(share.amount, share.invoice.id);
    }
    if (shared) {
      db.prepare('UPDATE customer_advances SET applied_cents = ?, status = ? WHERE id = ?')
        .run(shared, advanceStatus({ amount_cents: amount, applied_cents: shared }), advanceId);
    }
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
    const requested = payload.amount_cents == null || payload.amount_cents === ''
      ? Infinity
      : cents(payload.amount_cents, 'Amount to use', { min: 1 });
    const amount = Math.min(remaining, invoiceBalance, requested);

    const advancesAccount = systemAccount(db, ADVANCE_ACCOUNT, 'Contract Liabilities (Customer Advances)');
    const ar = systemAccount(db, AR_ACCOUNT, 'Trade Receivables');
    const paymentDate = notFuture(dateISO(payload.payment_date || todayISO(), 'Application date'), 'Application date');
    if (paymentDate < advance.advance_date) throw bad(`The date cannot be before the advance was received (${advance.advance_date})`);
    if (paymentDate < invoice.issue_date) throw bad(`The date cannot be before the invoice date (${invoice.issue_date})`);
    const number = allocateNumber(db, 'payment', paymentDate);

    const info = db.prepare(`
      INSERT INTO payments (number, customer_id, invoice_id, payment_date, amount_cents, method,
        reference, deposit_account_id, advance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      advance.customer_id,
      invoice.id,
      paymentDate,
      amount,
      'Advance applied',
      advance.number,
      advancesAccount.id,
      advance.id,
    );
    const paymentId = Number(info.lastInsertRowid);
    markCreated(db, 'payments', paymentId);
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
    const status = advanceStatus({ ...advance, applied_cents: applied });
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

    const advancesAccount = systemAccount(db, ADVANCE_ACCOUNT, 'Contract Liabilities (Customer Advances)');
    const refundDate = dateISO(payload.refund_date || todayISO(), 'Refund date');
    if (refundDate < advance.advance_date) throw bad(`Refund date cannot be before the advance was received (${advance.advance_date})`);

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
    const status = advanceStatus({ ...advance, refunded_cents: refunded });
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
    markCreated(db, 'refunds', refundInfo.lastInsertRowid);
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
        withReceipt: true,
      });
    }

    const fresh = db.prepare('SELECT * FROM customer_advances WHERE id = ?').get(advance.id);
    if (fresh.applied_cents > 0 || fresh.refunded_cents > 0) {
      throw bad('Linked advance applications or refunds could not be fully reversed');
    }
    let voidEntryId = null;
    if (fresh.journal_entry_id) {
      // Receipt shares voided on their own earlier already moved to the advance.
      const moved = db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments
        WHERE advance_id = ? AND journal_entry_id = ? AND status = 'void' AND void_entry_id IS NOT NULL
      `).get(fresh.id, fresh.journal_entry_id).n;
      const extraLines = moved ? [
        { account_id: systemAccount(db, ADVANCE_ACCOUNT, 'Contract Liabilities (Customer Advances)').id, debit_cents: moved, credit_cents: 0, description: 'Shares voided earlier' },
        { account_id: systemAccount(db, AR_ACCOUNT, 'Trade Receivables').id, debit_cents: 0, credit_cents: moved, description: 'Shares voided earlier' },
      ] : [];
      voidEntryId = reverseEntry(db, fresh.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void ${fresh.is_receipt ? 'customer receipt' : 'customer advance'} ${fresh.number}`, remarks),
        source_type: 'void',
        extraLines,
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

// One payment from a customer for several invoices: one receipt and one
// entry for the full amount, shared out over the chosen invoices (or the
// oldest first). Anything left stays as the customer's advance. Voiding the
// receipt undoes every share.
function receivePayment(db, payload = {}) {
  return db.transaction(() => {
    const customerId = Number(payload.customer_id);
    const date = notFuture(dateISO(payload.receipt_date || todayISO(), 'Date received'), 'Date received');
    const amount = cents(payload.amount_cents, 'Amount received', { min: 1 });

    const open = db.prepare(`
      SELECT * FROM invoices
      WHERE customer_id = ? AND status = 'sent' AND issue_date <= ?
        AND total_cents > amount_paid_cents + credit_applied_cents
      ORDER BY due_date, issue_date, id
    `).all(customerId, date);
    const openById = new Map(open.map((invoice) => [invoice.id, invoice]));
    const balanceOf = (invoice) => invoice.total_cents - invoice.amount_paid_cents - invoice.credit_applied_cents;

    let shares;
    if (Array.isArray(payload.allocations)) {
      shares = [];
      for (const row of payload.allocations) {
        const share = row.amount_cents == null || row.amount_cents === '' ? 0 : cents(row.amount_cents, 'Amount for an invoice');
        if (!share) continue;
        const invoice = openById.get(Number(row.invoice_id));
        if (!invoice) throw bad('Choose open invoices of this customer dated on or before the receipt');
        if (share > balanceOf(invoice)) throw bad(`More than the ${(balanceOf(invoice) / 100).toFixed(2)} due on invoice ${invoice.number}`);
        if (shares.some((existing) => existing.invoice.id === invoice.id)) throw bad(`Invoice ${invoice.number} is listed twice`);
        shares.push({ invoice, amount: share });
      }
    } else {
      let left = amount;
      shares = [];
      for (const invoice of open) {
        if (left <= 0) break;
        const share = Math.min(left, balanceOf(invoice));
        shares.push({ invoice, amount: share });
        left -= share;
      }
    }
    const shared = shares.reduce((sum, share) => sum + share.amount, 0);
    if (shared > amount) throw bad('The invoice amounts add up to more than the amount received');

    const receipt = createAdvance(db, {
      customer_id: customerId,
      amount_cents: amount,
      advance_date: date,
      method: payload.method,
      reference: payload.reference,
      deposit_account_id: payload.deposit_account_id,
      bank_charges_cents: payload.bank_charges_cents,
    }, { receipt: true, shares });
    return getReceipt(db, receipt.id);
  })();
}

// Everything the printed receipt needs: the money in, and where it went.
function getReceipt(db, id) {
  const receipt = db.prepare(`
    SELECT a.*, c.name AS customer_name, c.address AS customer_address, c.email AS customer_email, c.phone AS customer_phone,
           acc.name AS deposit_account_name
    FROM customer_advances a
    JOIN customers c ON c.id = a.customer_id
    JOIN accounts acc ON acc.id = a.deposit_account_id
    WHERE a.id = ?
  `).get(Number(id));
  if (!receipt) throw notFound('Receipt not found');
  const invoices = db.prepare(`
    SELECT p.id AS payment_id, p.number AS payment_number, p.amount_cents, p.status,
           i.id AS invoice_id, i.number AS invoice_number, i.issue_date, i.total_cents,
           MAX(0, i.total_cents - i.amount_paid_cents - i.credit_applied_cents) AS balance_cents,
           b.number AS booking_number, v.number AS visa_number, v.applicant_name
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    LEFT JOIN bookings b ON b.id = i.booking_id
    LEFT JOIN visa_applications v ON v.id = i.visa_id
    WHERE p.advance_id = ? AND p.status = 'posted'
    ORDER BY p.id
  `).all(receipt.id);
  return { ...serializeAdvance(receipt), invoices };
}

module.exports = {
  advanceStatus,
  receivePayment,
  getReceipt,
  listAdvances,
  getAdvance,
  createAdvance,
  applyAdvance,
  refundAdvance,
  voidAdvance,
};
