'use strict';

const {
  bad,
  notFound,
  optionalStr,
  cents,
  dateISO,
  todayISO,
} = require('../util');
const {
  systemAccount,
  postEntry,
  reverseEntry,
  getEntryWithLines,
} = require('../accounting');
const { allocateNumber } = require('./numbering');

const refundSelect = `
  SELECT r.*,
         CASE WHEN r.refund_type = 'customer' THEN c.name ELSE v.name END AS party_name,
         CASE WHEN r.refund_type = 'customer' THEN c.email ELSE v.email END AS party_email,
         CASE WHEN r.refund_type = 'customer' THEN c.phone ELSE v.phone END AS party_phone,
         CASE WHEN r.refund_type = 'customer' THEN c.address ELSE v.address END AS party_address,
         c.id AS customer_id, v.id AS vendor_id,
         i.number AS invoice_number, b.number AS bill_number,
         p.number AS payment_number, bp.number AS bill_payment_number,
         a.code AS account_code, a.name AS account_name
  FROM refunds r
  LEFT JOIN customers c ON r.refund_type = 'customer' AND c.id = r.party_id
  LEFT JOIN vendors v ON r.refund_type = 'supplier' AND v.id = r.party_id
  LEFT JOIN invoices i ON i.id = r.invoice_id
  LEFT JOIN bills b ON b.id = r.bill_id
  LEFT JOIN payments p ON p.id = r.payment_id
  LEFT JOIN bill_payments bp ON bp.id = r.bill_payment_id
  LEFT JOIN accounts a ON a.id = r.account_id
`;

function serializeRefund(row) {
  const customer = row.refund_type === 'customer';
  return {
    ...row,
    party_name: row.party_name || '—',
    source_type: customer ? 'invoice' : 'bill',
    document_id: customer ? row.invoice_id : row.bill_id,
    document_number: customer ? row.invoice_number : row.bill_number,
    payment_number: customer ? row.payment_number : row.bill_payment_number,
  };
}

function listRefunds(db, { type, status, search, from, to } = {}) {
  if (type && !['all', 'customer', 'supplier'].includes(type)) {
    throw bad('Refund type must be customer or supplier');
  }
  if (status && !['all', 'paid', 'void'].includes(status)) {
    throw bad('Refund status must be paid or void');
  }

  const clauses = [];
  const params = [];
  if (type && type !== 'all') {
    clauses.push('r.refund_type = ?');
    params.push(type);
  }
  if (status && status !== 'all') {
    clauses.push('r.status = ?');
    params.push(status);
  }
  if (from) {
    clauses.push('r.refund_date >= ?');
    params.push(dateISO(from, 'From date'));
  }
  if (to) {
    clauses.push('r.refund_date <= ?');
    params.push(dateISO(to, 'To date'));
  }
  if (search) {
    clauses.push(`(
      r.number LIKE ? OR c.name LIKE ? OR v.name LIKE ? OR
      i.number LIKE ? OR b.number LIKE ? OR r.reference LIKE ?
    )`);
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`${refundSelect} ${where} ORDER BY r.refund_date DESC, r.id DESC`)
    .all(...params)
    .map(serializeRefund);
}

function getRefund(db, id) {
  const row = db.prepare(`${refundSelect} WHERE r.id = ?`).get(id);
  if (!row) throw notFound('Refund not found');
  const refund = serializeRefund(row);

  refund.journal_entry = refund.journal_entry_id
    ? getEntryWithLines(db, refund.journal_entry_id)
    : null;
  refund.void_entry = refund.void_entry_id
    ? getEntryWithLines(db, refund.void_entry_id)
    : null;

  const sourceId = refund.refund_type === 'customer' ? refund.payment_id : refund.bill_payment_id;
  refund.source_amount_cents = 0;
  if (sourceId) {
    const table = refund.refund_type === 'customer' ? 'payments' : 'bill_payments';
    const source = db.prepare(`SELECT amount_cents FROM ${table} WHERE id = ?`).get(sourceId);
    refund.source_amount_cents = source ? source.amount_cents : 0;
  }
  const sourceColumn = refund.refund_type === 'customer' ? 'payment_id' : 'bill_payment_id';
  const totalRefunded = sourceId
    ? db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total
        FROM refunds WHERE ${sourceColumn} = ? AND status = 'paid'
      `).get(sourceId).total
    : 0;
  refund.total_refunded_cents = totalRefunded;
  refund.remaining_refundable_cents = Math.max(0, refund.source_amount_cents - totalRefunded);
  refund.refunded_before_cents = sourceId
    ? db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total
        FROM refunds
        WHERE ${sourceColumn} = ? AND status = 'paid'
          AND (refund_date < ? OR (refund_date = ? AND id < ?))
      `).get(sourceId, refund.refund_date, refund.refund_date, refund.id).total
    : 0;
  return refund;
}

function getRefundSources(db, type) {
  if (!['customer', 'supplier'].includes(type)) {
    throw bad('Choose customer or supplier refunds');
  }

  const rows = type === 'customer'
    ? db.prepare(`
        SELECT p.id AS payment_id, p.number AS payment_number, p.payment_date,
               p.amount_cents, p.method,
               p.deposit_account_id AS account_id, a.name AS account_name,
               i.id AS document_id, i.number AS document_number,
               c.id AS party_id, c.name AS party_name,
               COALESCE((
                 SELECT SUM(r.amount_cents) FROM refunds r
                 WHERE r.payment_id = p.id AND r.status = 'paid'
               ), 0) AS refunded_cents
        FROM payments p
        JOIN invoices i ON i.id = p.invoice_id
        JOIN customers c ON c.id = p.customer_id
        JOIN accounts a ON a.id = p.deposit_account_id
        WHERE i.status = 'sent' AND p.advance_id IS NULL
        ORDER BY p.payment_date DESC, p.id DESC
      `).all()
    : db.prepare(`
        SELECT bp.id AS bill_payment_id, bp.number AS payment_number, bp.payment_date,
               bp.amount_cents, bp.method,
               bp.payment_account_id AS account_id, a.name AS account_name,
               b.id AS document_id, b.number AS document_number,
               v.id AS party_id, v.name AS party_name,
               COALESCE((
                 SELECT SUM(r.amount_cents) FROM refunds r
                 WHERE r.bill_payment_id = bp.id AND r.status = 'paid'
               ), 0) AS refunded_cents
        FROM bill_payments bp
        JOIN bills b ON b.id = bp.bill_id
        JOIN vendors v ON v.id = bp.vendor_id
        JOIN accounts a ON a.id = bp.payment_account_id
        WHERE b.status = 'received' AND bp.portal_id IS NULL
        ORDER BY bp.payment_date DESC, bp.id DESC
      `).all();

  return rows
    .map((row) => ({
      ...row,
      refund_type: type,
      refundable_cents: Math.max(0, row.amount_cents - row.refunded_cents),
    }))
    .filter((row) => row.refundable_cents > 0);
}

function refundAccount(db, accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!account) throw bad('Choose a refund account');
  if (!account.is_active) throw bad('That refund account is archived');
  if (account.type !== 'asset' || !account.is_cash) {
    throw bad('Refund account must be a bank or cash account');
  }
  return account;
}

function createRefund(db, payload = {}) {
  return db.transaction(() => {
    const type = String(payload.refund_type || payload.type || '').toLowerCase();
    if (!['customer', 'supplier'].includes(type)) {
      throw bad('Choose a customer or supplier refund');
    }
    const amount = cents(payload.amount_cents, 'Refund amount', { min: 1 });
    const refundDate = dateISO(payload.refund_date || todayISO(), 'Refund date');
    const method = optionalStr(payload.method, 'Refund method', 100) || 'Bank transfer';
    const reference = optionalStr(payload.reference, 'Reference', 200);
    const notes = optionalStr(payload.notes, 'Notes', 1000);
    const account = refundAccount(db, payload.account_id);
    const number = allocateNumber(db, 'refund', refundDate);

    if (type === 'customer') {
      const paymentId = Number(payload.payment_id);
      const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
      if (!payment) throw notFound('Payment not found');
      if (payment.advance_id) {
        throw bad('This payment was funded by a customer advance. Refund the advance instead.');
      }
      if (payload.invoice_id != null && Number(payload.invoice_id) !== payment.invoice_id) {
        throw bad('That payment belongs to a different invoice');
      }
      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(payment.invoice_id);
      if (!invoice) throw notFound('Invoice not found');
      if (invoice.status !== 'sent') {
        throw bad('Payments can only be refunded on posted invoices');
      }
      if (refundDate < payment.payment_date) {
        throw bad('Refund date cannot be before the payment date');
      }
      const refunded = db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds
        WHERE payment_id = ? AND status = 'paid'
      `).get(payment.id).total;
      const refundable = payment.amount_cents - refunded;
      if (amount > refundable) {
        throw bad(`Refund exceeds the remaining refundable amount of ${(refundable / 100).toFixed(2)}`);
      }
      if (amount > invoice.amount_paid_cents) {
        throw bad(`Refund exceeds the amount paid on this invoice (${(invoice.amount_paid_cents / 100).toFixed(2)})`);
      }

      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(payment.customer_id);
      const ar = systemAccount(db, '1100', 'Accounts Receivable');
      const info = db.prepare(`
        INSERT INTO refunds (
          number, refund_type, status, party_id, invoice_id, payment_id,
          bill_id, bill_payment_id, refund_date, amount_cents, method,
          reference, notes, account_id
        ) VALUES (?, ?, 'paid', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        number, 'customer', payment.customer_id, payment.invoice_id, payment.id,
        refundDate, amount, method, reference, notes, account.id,
      );
      const refundId = Number(info.lastInsertRowid);
      const entryId = postEntry(db, {
        entry_date: refundDate,
        memo: `Customer refund ${number} — ${customer?.name || 'Customer'} (invoice ${invoice.number})`,
        reference: invoice.number,
        source_type: 'customer_refund',
        source_id: refundId,
        lines: [
          { account_id: ar.id, debit_cents: amount, credit_cents: 0, description: `Refund ${number}` },
          { account_id: account.id, debit_cents: 0, credit_cents: amount, description: `Refund to ${customer?.name || 'customer'}` },
        ],
      });
      db.prepare('UPDATE refunds SET journal_entry_id = ? WHERE id = ?').run(entryId, refundId);
      db.prepare(`
        UPDATE invoices SET amount_paid_cents = MAX(0, amount_paid_cents - ?), updated_at = datetime('now')
        WHERE id = ?
      `).run(amount, invoice.id);
      return getRefund(db, refundId);
    }

    const billPaymentId = Number(payload.bill_payment_id);
    const billPayment = db.prepare('SELECT * FROM bill_payments WHERE id = ?').get(billPaymentId);
    if (!billPayment) throw notFound('Bill payment not found');
    if (billPayment.portal_id) {
      throw bad('This bill payment was made from a supplier wallet. Restore it from the portal instead.');
    }
    if (payload.bill_id != null && Number(payload.bill_id) !== billPayment.bill_id) {
      throw bad('That payment belongs to a different bill');
    }
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billPayment.bill_id);
    if (!bill) throw notFound('Bill not found');
    if (bill.status !== 'received') {
      throw bad('Bill payments can only be refunded on received bills');
    }
    if (refundDate < billPayment.payment_date) {
      throw bad('Refund date cannot be before the payment date');
    }
    const refunded = db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds
      WHERE bill_payment_id = ? AND status = 'paid'
    `).get(billPayment.id).total;
    const refundable = billPayment.amount_cents - refunded;
    if (amount > refundable) {
      throw bad(`Refund exceeds the remaining refundable amount of ${(refundable / 100).toFixed(2)}`);
    }
    if (amount > bill.amount_paid_cents) {
      throw bad(`Refund exceeds the amount paid on this bill (${(bill.amount_paid_cents / 100).toFixed(2)})`);
    }

    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(billPayment.vendor_id);
    const ap = systemAccount(db, '2000', 'Accounts Payable');
    const info = db.prepare(`
      INSERT INTO refunds (
        number, refund_type, status, party_id, invoice_id, payment_id,
        bill_id, bill_payment_id, refund_date, amount_cents, method,
        reference, notes, account_id
      ) VALUES (?, 'supplier', 'paid', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number, billPayment.vendor_id, bill.id, billPayment.id,
      refundDate, amount, method, reference, notes, account.id,
    );
    const refundId = Number(info.lastInsertRowid);
    const entryId = postEntry(db, {
      entry_date: refundDate,
      memo: `Supplier refund ${number} — ${vendor?.name || 'Vendor'} (bill ${bill.number})`,
      reference: bill.number,
      source_type: 'supplier_refund',
      source_id: refundId,
      lines: [
        { account_id: account.id, debit_cents: amount, credit_cents: 0, description: `Refund received from ${vendor?.name || 'vendor'}` },
        { account_id: ap.id, debit_cents: 0, credit_cents: amount, description: `Bill ${bill.number}` },
      ],
    });
    db.prepare('UPDATE refunds SET journal_entry_id = ? WHERE id = ?').run(entryId, refundId);
    db.prepare(`
      UPDATE bills SET amount_paid_cents = MAX(0, amount_paid_cents - ?), updated_at = datetime('now')
      WHERE id = ?
    `).run(amount, bill.id);
    return getRefund(db, refundId);
  })();
}

function voidRefund(db, id, payload = {}) {
  return db.transaction(() => {
    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(id);
    if (!refund) throw notFound('Refund not found');
    if (refund.status === 'void') throw bad('Refund is already void');
    const voidDate = dateISO(payload.void_date || todayISO(), 'Void date');
    if (voidDate < refund.refund_date) {
      throw bad('Void date cannot be before the refund date');
    }

    if (refund.refund_type === 'customer') {
      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(refund.invoice_id);
      if (!invoice) throw notFound('Invoice not found');
      if (invoice.status === 'void') {
        throw bad('Cannot void a refund on a void invoice');
      }
      if (invoice.amount_paid_cents + refund.amount_cents + (invoice.credit_applied_cents || 0) > invoice.total_cents) {
        throw bad('Voiding this refund would make the invoice overpaid. Remove newer payments first.');
      }
      db.prepare(`
        UPDATE invoices SET amount_paid_cents = amount_paid_cents + ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(refund.amount_cents, invoice.id);
    } else {
      const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(refund.bill_id);
      if (!bill) throw notFound('Bill not found');
      if (bill.status === 'void') {
        throw bad('Cannot void a refund on a void bill');
      }
      if (bill.amount_paid_cents + refund.amount_cents > bill.total_cents) {
        throw bad('Voiding this refund would make the bill overpaid. Remove newer payments first.');
      }
      db.prepare(`
        UPDATE bills SET amount_paid_cents = amount_paid_cents + ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(refund.amount_cents, bill.id);
    }

    const voidEntryId = refund.journal_entry_id
      ? reverseEntry(db, refund.journal_entry_id, {
          entry_date: voidDate,
          memo: `Void refund ${refund.number}`,
          source_type: 'void',
        })
      : null;
    db.prepare(`
      UPDATE refunds SET status = 'void', void_entry_id = ? WHERE id = ?
    `).run(voidEntryId, id);
    return getRefund(db, id);
  })();
}

module.exports = {
  listRefunds,
  getRefund,
  getRefundSources,
  createRefund,
  voidRefund,
};
