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
  systemAccount,
  bankChargesCents,
  bankChargeLines,
  postEntry,
  reverseEntry,
  getEntryWithLines,
} = require('../accounting');
const { allocateNumber } = require('./numbering');
const { markCreated } = require('../created-by');
const supplierCreditService = require('./supplier-credits');
const audit = require('./audit');

const refundSelect = `
  SELECT r.*,
         CASE WHEN r.refund_type = 'customer' THEN c.name ELSE v.name END AS party_name,
         CASE WHEN r.refund_type = 'customer' THEN c.email ELSE v.email END AS party_email,
         CASE WHEN r.refund_type = 'customer' THEN c.phone ELSE v.phone END AS party_phone,
         CASE WHEN r.refund_type = 'customer' THEN c.address ELSE v.address END AS party_address,
         c.id AS customer_id, v.id AS vendor_id,
         i.number AS invoice_number, b.number AS bill_number,
         p.number AS payment_number, bp.number AS bill_payment_number,
         cc.number AS cancellation_number, scn.number AS supplier_credit_number,
         adv.number AS advance_number, ccn.number AS credit_note_number,
         dep.number AS deposit_number, dep.visa_id AS deposit_visa_id,
         a.code AS account_code, a.name AS account_name
  FROM refunds r
  LEFT JOIN customers c ON r.refund_type = 'customer' AND c.id = r.party_id
  LEFT JOIN vendors v ON r.refund_type = 'supplier' AND v.id = r.party_id
  LEFT JOIN invoices i ON i.id = r.invoice_id
  LEFT JOIN bills b ON b.id = r.bill_id
  LEFT JOIN payments p ON p.id = r.payment_id
  LEFT JOIN bill_payments bp ON bp.id = r.bill_payment_id
  LEFT JOIN cancellations cc ON cc.id = r.cancellation_id
  LEFT JOIN supplier_credit_notes scn ON scn.id = r.supplier_credit_note_id
  LEFT JOIN customer_advances adv ON adv.id = r.advance_id
  LEFT JOIN credit_notes ccn ON ccn.id = r.credit_note_id
  LEFT JOIN visa_deposits dep ON dep.id = r.deposit_id
  LEFT JOIN accounts a ON a.id = r.account_id
`;

function serializeRefund(row) {
  const customer = row.refund_type === 'customer';
  let sourceType = customer ? 'invoice' : 'bill';
  let documentId = customer ? row.invoice_id : row.bill_id;
  let documentNumber = customer ? row.invoice_number : row.bill_number;
  if (customer && row.deposit_id) {
    // A visa deposit refund links to the visa, where the deposit card lives.
    sourceType = 'deposit';
    documentId = row.deposit_visa_id;
    documentNumber = row.deposit_number;
  } else if (customer && row.advance_id) {
    sourceType = 'advance';
    documentId = row.advance_id;
    documentNumber = row.advance_number;
  } else if (customer && row.credit_note_id) {
    sourceType = 'credit';
    documentId = row.credit_note_id;
    documentNumber = row.credit_note_number;
  } else if (customer && row.cancellation_id) {
    sourceType = 'cancellation';
    documentId = row.cancellation_id;
    documentNumber = row.cancellation_number;
  } else if (!customer && row.supplier_credit_note_id) {
    sourceType = 'supplier_credit';
    documentId = row.supplier_credit_note_id;
    documentNumber = row.supplier_credit_number;
  }
  return {
    ...row,
    party_name: row.party_name || '—',
    source_type: sourceType,
    document_id: documentId,
    document_number: documentNumber,
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
      i.number LIKE ? OR b.number LIKE ? OR r.reference LIKE ? OR
      cc.number LIKE ? OR scn.number LIKE ? OR adv.number LIKE ? OR ccn.number LIKE ?
    )`);
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term, term, term, term, term, term, term);
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
  let sourceAmount = 0;
  let sourceColumn = null;
  let sourceApplied = 0;
  if (refund.cancellation_id) {
    const cancellation = db.prepare('SELECT refund_due_cents FROM cancellations WHERE id = ?')
      .get(refund.cancellation_id);
    sourceAmount = cancellation?.refund_due_cents || 0;
    sourceColumn = 'cancellation_id';
    sourceApplied = db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total FROM credit_notes
      WHERE cancellation_id = ? AND status = 'issued'
    `).get(refund.cancellation_id).total;
  } else if (refund.supplier_credit_note_id) {
    const note = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?')
      .get(refund.supplier_credit_note_id);
    sourceAmount = note?.amount_cents || 0;
    sourceColumn = 'supplier_credit_note_id';
    sourceApplied = note ? note.applied_cents + note.portal_settled_cents : 0;
  } else if (refund.credit_note_id) {
    const note = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(refund.credit_note_id);
    sourceAmount = note?.amount_cents || 0;
    sourceColumn = 'credit_note_id';
    sourceApplied = note?.applied_cents || 0;
  } else if (refund.deposit_id) {
    // Money used for invoices, forfeited or deducted is not refundable.
    const deposit = require('./visa-deposits').getDeposit(db, refund.deposit_id);
    sourceAmount = deposit.collected_cents;
    sourceColumn = 'deposit_id';
    sourceApplied = deposit.applied_cents + deposit.forfeited_cents;
  } else if (refund.advance_id) {
    const advance = db.prepare('SELECT * FROM customer_advances WHERE id = ?')
      .get(refund.advance_id);
    sourceAmount = advance?.amount_cents || 0;
    sourceColumn = 'advance_id';
    sourceApplied = advance?.applied_cents || 0;
  } else if (sourceId) {
    const table = refund.refund_type === 'customer' ? 'payments' : 'bill_payments';
    const source = db.prepare(`SELECT amount_cents FROM ${table} WHERE id = ?`).get(sourceId);
    sourceAmount = source ? source.amount_cents : 0;
    sourceColumn = refund.refund_type === 'customer' ? 'payment_id' : 'bill_payment_id';
  }
  refund.source_amount_cents = sourceAmount;
  const totalRefunded = sourceColumn
    ? db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total
        FROM refunds WHERE ${sourceColumn} = ? AND status = 'paid'
      `).get(refund.cancellation_id || refund.supplier_credit_note_id || refund.credit_note_id || refund.deposit_id || refund.advance_id || sourceId).total
    : 0;
  refund.total_refunded_cents = totalRefunded;
  refund.remaining_refundable_cents = Math.max(0, sourceAmount - totalRefunded - sourceApplied);
  refund.refunded_before_cents = sourceColumn
    ? db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total
        FROM refunds
        WHERE ${sourceColumn} = ? AND status = 'paid'
          AND (refund_date < ? OR (refund_date = ? AND id < ?))
      `).get(
        refund.cancellation_id || refund.supplier_credit_note_id || refund.credit_note_id || refund.deposit_id || refund.advance_id || sourceId,
        refund.refund_date, refund.refund_date, refund.id,
      ).total
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
        WHERE i.status = 'sent' AND p.advance_id IS NULL AND p.status = 'posted'
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
        WHERE b.status = 'received' AND bp.portal_id IS NULL AND bp.status = 'posted'
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
    const refundDate = notFuture(dateISO(payload.refund_date || todayISO(), 'Refund date'), 'Refund date');
    const method = optionalStr(payload.method, 'Refund method', 100) || 'Bank transfer';
    const reference = optionalStr(payload.reference, 'Reference', 200);
    const notes = optionalStr(payload.notes, 'Notes', 1000);
    const account = refundAccount(db, payload.account_id);
    const number = allocateNumber(db, 'refund', refundDate);
    // Paying a customer, the bank's charge is extra; receiving from a
    // supplier, it comes out of the money received.
    const charges = bankChargesCents(payload, type === 'supplier' ? { max: amount } : {});

    if (type === 'customer') {
      const paymentId = Number(payload.payment_id);
      const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
      if (!payment) throw notFound('Payment not found');
      if (payment.status === 'void') throw bad('That payment is void and cannot be refunded');
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
      const ar = systemAccount(db, '1100', 'Trade Receivables');
      const info = db.prepare(`
        INSERT INTO refunds (
          number, refund_type, status, party_id, invoice_id, payment_id,
          bill_id, bill_payment_id, refund_date, amount_cents, method,
          reference, notes, account_id, bank_charges_cents
        ) VALUES (?, ?, 'paid', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        number, 'customer', payment.customer_id, payment.invoice_id, payment.id,
        refundDate, amount, method, reference, notes, account.id, charges,
      );
      const refundId = Number(info.lastInsertRowid);
      markCreated(db, 'refunds', refundId);
      const entryId = postEntry(db, {
        entry_date: refundDate,
        memo: `Customer refund ${number} — ${customer?.name || 'Customer'} (invoice ${invoice.number})`,
        reference: invoice.number,
        source_type: 'customer_refund',
        source_id: refundId,
        lines: [
          { account_id: ar.id, debit_cents: amount, credit_cents: 0, description: `Refund ${number}` },
          { account_id: account.id, debit_cents: 0, credit_cents: amount, description: `Refund to ${customer?.name || 'customer'}` },
          ...bankChargeLines(db, charges, account, `refund ${number}`),
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
    if (billPayment.status === 'void') throw bad('That bill payment is void and cannot be refunded');
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
    const supplierCredits = systemAccount(db, '1450', 'Supplier Credits');
    // A supplier refund is a credit note settled in cash. The bill keeps its
    // payment history and is not reopened.
    const creditNote = supplierCreditService.createSupplierCredit(db, {
      vendor_id: billPayment.vendor_id,
      bill_id: bill.id,
      booking_id: bill.booking_id,
      visa_id: bill.visa_id,
      credit_date: refundDate,
      amount_cents: amount,
      notes: `Supplier refund ${number} for bill ${bill.number}`,
    });
    const info = db.prepare(`
      INSERT INTO refunds (
        number, refund_type, status, party_id, invoice_id, payment_id,
        bill_id, bill_payment_id, supplier_credit_note_id, refund_date,
        amount_cents, method, reference, notes, account_id, bank_charges_cents
      ) VALUES (?, 'supplier', 'paid', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number, billPayment.vendor_id, bill.id, billPayment.id, creditNote.id,
      refundDate, amount, method, reference, notes, account.id, charges,
    );
    const refundId = Number(info.lastInsertRowid);
    markCreated(db, 'refunds', refundId);
    const entryId = postEntry(db, {
      entry_date: refundDate,
      memo: `Supplier credit refund ${number} — ${vendor?.name || 'Vendor'} (bill ${bill.number})`,
      reference: bill.number,
      source_type: 'supplier_refund',
      source_id: refundId,
      lines: [
        { account_id: account.id, debit_cents: amount, credit_cents: 0, description: `Refund received from ${vendor?.name || 'vendor'}` },
        { account_id: supplierCredits.id, debit_cents: 0, credit_cents: amount, description: `Supplier credit ${creditNote.number}` },
        ...bankChargeLines(db, charges, account, `refund ${number}`),
      ],
    });
    db.prepare('UPDATE refunds SET journal_entry_id = ? WHERE id = ?').run(entryId, refundId);
    db.prepare('UPDATE supplier_credit_notes SET refunded_cents = refunded_cents + ? WHERE id = ?')
      .run(amount, creditNote.id);
    return getRefund(db, refundId);
  })();
}

function voidRefund(db, id, payload = {}) {
  return db.transaction(() => {
    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(id);
    if (!refund) throw notFound('Refund not found');
    if (refund.status === 'void') throw bad('Refund is already void');
    if (refund.deposit_id) {
      const deposit = db.prepare('SELECT number FROM visa_deposits WHERE id = ?').get(refund.deposit_id);
      throw bad(`This refund belongs to visa deposit ${deposit?.number || ''}. Void it from the Security deposit card on the visa page so the deposit is restored.`.replace('  ', ' '));
    }
    const voidDate = dateISO(payload.void_date || todayISO(), 'Void date');
    if (voidDate < refund.refund_date) {
      throw bad('Void date cannot be before the refund date');
    }
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);

    const voidEntryId = refund.journal_entry_id
      ? reverseEntry(db, refund.journal_entry_id, {
          entry_date: voidDate,
          memo: audit.withRemarks(`Void refund ${refund.number}`, remarks),
          source_type: 'void',
        })
      : null;

    if (refund.supplier_credit_note_id) {
      const note = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(refund.supplier_credit_note_id);
      if (!note) throw notFound('Supplier credit note not found');
      db.prepare(`
        UPDATE supplier_credit_notes SET refunded_cents = MAX(0, refunded_cents - ?) WHERE id = ?
      `).run(refund.amount_cents, note.id);
    } else if (refund.credit_note_id) {
      const note = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(refund.credit_note_id);
      if (!note) throw notFound('Credit note not found');
      db.prepare(`
        UPDATE credit_notes SET refunded_cents = MAX(0, refunded_cents - ?) WHERE id = ?
      `).run(refund.amount_cents, note.id);
    } else if (refund.cancellation_id) {
      const cancellation = db.prepare('SELECT * FROM cancellations WHERE id = ?').get(refund.cancellation_id);
      if (!cancellation) throw notFound('Cancellation not found');
    } else if (refund.advance_id) {
      const advance = db.prepare('SELECT * FROM customer_advances WHERE id = ?').get(refund.advance_id);
      if (!advance) throw notFound('Advance not found');
      const refunded = Math.max(0, advance.refunded_cents - refund.amount_cents);
      const status = require('./advances').advanceStatus({ ...advance, refunded_cents: refunded });
      db.prepare('UPDATE customer_advances SET refunded_cents = ?, status = ? WHERE id = ?')
        .run(refunded, status, advance.id);
    } else if (refund.refund_type === 'customer') {
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

    db.prepare(`
      UPDATE refunds SET status = 'void', void_entry_id = ? WHERE id = ?
    `).run(voidEntryId, id);
    // A refund on a bill payment made its own credit note (createRefund).
    // Without the refund that credit was never given, so it goes too. Done
    // after the refund is marked void, so the credit note does not void it again.
    if (refund.bill_payment_id && refund.supplier_credit_note_id && !payload.fromSupplierCredit) {
      const note = db.prepare('SELECT status FROM supplier_credit_notes WHERE id = ?').get(refund.supplier_credit_note_id);
      if (note?.status === 'issued') {
        supplierCreditService.voidSupplierCredit(db, refund.supplier_credit_note_id, {
          remarks: remarks || `Voided with refund ${refund.number}`,
        });
      }
    }
    audit.record(db, {
      entity_type: 'refund',
      entity_id: refund.id,
      entity_number: refund.number,
      action: 'void',
      remarks: remarks || `Voided refund ${refund.number}`,
      amount_cents: refund.amount_cents,
      metadata: {
        refund_type: refund.refund_type,
        invoice_id: refund.invoice_id || null,
        bill_id: refund.bill_id || null,
        advance_id: refund.advance_id || null,
        cancellation_id: refund.cancellation_id || null,
        supplier_credit_note_id: refund.supplier_credit_note_id || null,
        credit_note_id: refund.credit_note_id || null,
      },
    });
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
