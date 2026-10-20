'use strict';

const {
  bad,
  notFound,
  str,
  optionalStr,
  num,
  cents,
  dateISO,
  todayISO,
} = require('../util');
const {
  systemAccount,
  isCashAccount,
  postEntry,
  reverseEntry,
  invoiceBalanceCents,
  invoiceDisplayStatus,
} = require('../accounting');
const { allocateNumber } = require('./numbering');

const invoiceSelect = `
  SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.address AS customer_address,
         c.phone AS customer_phone
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
`;

function serializeInvoice(invoice, today = todayISO()) {
  return {
    ...invoice,
    status_display: invoiceDisplayStatus(invoice, today),
    balance_cents: invoiceBalanceCents(invoice),
  };
}

function getInvoice(db, id) {
  const invoice = db.prepare(`${invoiceSelect} WHERE i.id = ?`).get(id);
  if (!invoice) throw notFound('Invoice not found');
  invoice.items = db.prepare(`
    SELECT ii.*, a.code AS account_code, a.name AS account_name
    FROM invoice_items ii
    JOIN accounts a ON a.id = ii.account_id
    WHERE ii.invoice_id = ?
    ORDER BY ii.sort_order, ii.id
  `).all(id);
  invoice.payments = db.prepare(`
    SELECT p.*, a.name AS deposit_account_name,
           COALESCE((
             SELECT SUM(r.amount_cents) FROM refunds r
             WHERE r.payment_id = p.id AND r.status = 'paid'
           ), 0) AS refunded_cents
    FROM payments p
    JOIN accounts a ON a.id = p.deposit_account_id
    WHERE p.invoice_id = ?
    ORDER BY p.payment_date, p.id
  `).all(id).map((payment) => ({
    ...payment,
    refundable_cents: payment.advance_id
      ? 0
      : Math.max(0, payment.amount_cents - payment.refunded_cents),
  }));
  invoice.credits = db.prepare(`
    SELECT ca.id, ca.amount_cents, ca.applied_date, cn.id AS credit_note_id,
           cn.number AS credit_number, cn.status AS credit_status
    FROM credit_applications ca
    JOIN credit_notes cn ON cn.id = ca.credit_note_id
    WHERE ca.invoice_id = ?
    ORDER BY ca.applied_date, ca.id
  `).all(id);
  if (invoice.journal_entry_id) {
    invoice.journal_entry = db.prepare(`
      SELECT e.*, (
        SELECT COALESCE(SUM(l.debit_cents), 0) FROM journal_lines l WHERE l.entry_id = e.id
      ) AS total_cents
      FROM journal_entries e WHERE e.id = ?
    `).get(invoice.journal_entry_id) || null;
  }
  return serializeInvoice(invoice);
}

function listInvoices(db, { status, search, from, to } = {}) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('i.issue_date >= ?');
    params.push(dateISO(from, 'From date'));
  }
  if (to) {
    clauses.push('i.issue_date <= ?');
    params.push(dateISO(to, 'To date'));
  }
  if (search) {
    clauses.push('(i.number LIKE ? OR c.name LIKE ? OR i.notes LIKE ?)');
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`${invoiceSelect} ${where} ORDER BY i.issue_date DESC, i.id DESC`).all(...params);
  const today = todayISO();
  const serialized = rows.map((row) => serializeInvoice(row, today));
  if (!status || status === 'all') return serialized;
  if (status === 'outstanding') {
    return serialized.filter((row) => !['draft', 'void', 'paid'].includes(row.status_display));
  }
  return serialized.filter((row) => row.status_display === status);
}

function assertCustomer(db, customerId) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(customerId));
  if (!customer) throw bad('Choose a customer');
  if (!customer.is_active) throw bad('That customer is archived');
  return customer;
}

function normalizeItems(db, items, allowedTypes) {
  if (!Array.isArray(items) || items.length === 0) {
    throw bad('Add at least one line item');
  }
  return items.map((item, index) => {
    const label = `Line ${index + 1}`;
    const description = str(item.description, `${label} description`, { max: 300 });
    const quantity = num(item.quantity ?? 1, `${label} quantity`, { min: 0.0001, max: 1_000_000 });
    const unitPrice = cents(item.unit_price_cents, `${label} unit price`);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(item.account_id));
    if (!account) throw bad(`${label}: choose an account`);
    if (!account.is_active) throw bad(`${label}: account "${account.name}" is archived`);
    if (!allowedTypes.includes(account.type)) {
      throw bad(`${label}: "${account.name}" is not a valid ${allowedTypes.join('/')} account`);
    }
    return {
      description,
      quantity,
      unit_price_cents: unitPrice,
      amount_cents: Math.round(quantity * unitPrice),
      account_id: account.id,
    };
  });
}

function computeTotals(items) {
  const subtotal = items.reduce((sum, item) => sum + item.amount_cents, 0);
  return { subtotal, total: subtotal };
}

function insertItems(db, invoiceId, items) {
  const insert = db.prepare(`
    INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_cents, amount_cents, account_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  items.forEach((item, index) => {
    insert.run(invoiceId, item.description, item.quantity, item.unit_price_cents, item.amount_cents, item.account_id, index);
  });
}

function postInvoice(db, invoice, customer, items) {
  const ar = systemAccount(db, '1100', 'Accounts Receivable');
  const grouped = new Map();
  for (const item of items) {
    grouped.set(item.account_id, (grouped.get(item.account_id) || 0) + item.amount_cents);
  }
  const lines = [
    { account_id: ar.id, debit_cents: invoice.total_cents, credit_cents: 0, description: `Invoice ${invoice.number}` },
  ];
  let revenueTotal = 0;
  for (const [accountId, amount] of grouped.entries()) {
    if (amount <= 0) continue;
    revenueTotal += amount;
    lines.push({ account_id: accountId, debit_cents: 0, credit_cents: amount, description: `Invoice ${invoice.number}` });
  }
  if (revenueTotal <= 0) throw bad('Invoice total must be greater than zero');

  return postEntry(db, {
    entry_date: invoice.issue_date,
    memo: `Invoice ${invoice.number} — ${customer.name}`,
    reference: invoice.number,
    source_type: 'invoice',
    source_id: invoice.id,
    lines,
  });
}

function createInvoice(db, payload) {
  return db.transaction(() => {
    const customer = assertCustomer(db, payload.customer_id);
    const issueDate = dateISO(payload.issue_date, 'Issue date');
    const dueDate = dateISO(payload.due_date || issueDate, 'Due date');
    if (dueDate < issueDate) throw bad('Due date cannot be before the issue date');
    const status = payload.status === 'draft' ? 'draft' : 'sent';
    const items = normalizeItems(db, payload.items, ['revenue']);
    const totals = computeTotals(items);
    if (totals.total <= 0) throw bad('Invoice total must be greater than zero');
    const number = allocateNumber(db, 'invoice', issueDate);

    const info = db.prepare(`
      INSERT INTO invoices (number, customer_id, issue_date, due_date, status, notes, terms,
        subtotal_cents, total_cents, amount_paid_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      number,
      customer.id,
      issueDate,
      dueDate,
      status,
      optionalStr(payload.notes, 'Notes', 2000),
      optionalStr(payload.terms, 'Terms', 2000),
      totals.subtotal,
      totals.total,
    );
    const invoiceId = Number(info.lastInsertRowid);
    insertItems(db, invoiceId, items);

    if (status === 'sent') {
      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
      const entryId = postInvoice(db, invoice, customer, items);
      db.prepare('UPDATE invoices SET journal_entry_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(entryId, invoiceId);
    }

    return getInvoice(db, invoiceId);
  })();
}

function updateInvoice(db, id, payload) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!existing) throw notFound('Invoice not found');
    if (existing.status !== 'draft') throw bad('Only draft invoices can be edited');
    const customer = assertCustomer(db, payload.customer_id ?? existing.customer_id);
    const issueDate = dateISO(payload.issue_date ?? existing.issue_date, 'Issue date');
    const dueDate = dateISO(payload.due_date ?? existing.due_date, 'Due date');
    if (dueDate < issueDate) throw bad('Due date cannot be before the issue date');
    const items = normalizeItems(db, payload.items, ['revenue']);
    const totals = computeTotals(items);
    if (totals.total <= 0) throw bad('Invoice total must be greater than zero');

    db.prepare(`
      UPDATE invoices SET customer_id = ?, issue_date = ?, due_date = ?, notes = ?, terms = ?,
        subtotal_cents = ?, total_cents = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      customer.id,
      issueDate,
      dueDate,
      optionalStr(payload.notes ?? existing.notes, 'Notes', 2000),
      optionalStr(payload.terms ?? existing.terms, 'Terms', 2000),
      totals.subtotal,
      totals.total,
      id,
    );
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
    insertItems(db, id, items);
    return getInvoice(db, id);
  })();
}

function finalizeInvoice(db, id) {
  return db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'draft') throw bad('Only draft invoices can be finalized');
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id);
    if (!items.length) throw bad('Add line items before finalizing');
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(invoice.customer_id);
    const entryId = postInvoice(db, invoice, customer, items);
    db.prepare(`
      UPDATE invoices SET status = 'sent', journal_entry_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(entryId, id);
    return getInvoice(db, id);
  })();
}

function voidInvoice(db, id) {
  return db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status === 'void') throw bad('Invoice is already void');
    const refundCount = db.prepare(`
      SELECT COUNT(*) AS c FROM refunds WHERE invoice_id = ? AND status = 'paid'
    `).get(id).c;
    if (refundCount > 0) {
      throw bad('Void the refunds on this invoice before voiding it.');
    }
    if (invoice.amount_paid_cents > 0) throw bad('Remove payments from this invoice before voiding it');
    if (invoice.credit_applied_cents > 0) throw bad('Remove credit applications from this invoice before voiding it');
    if (invoice.status === 'sent' && invoice.journal_entry_id) {
      reverseEntry(db, invoice.journal_entry_id, {
        entry_date: todayISO(),
        memo: `Void invoice ${invoice.number}`,
        source_type: 'void',
      });
    }
    db.prepare(`UPDATE invoices SET status = 'void', updated_at = datetime('now') WHERE id = ?`).run(id);
    return getInvoice(db, id);
  })();
}

function deleteInvoice(db, id) {
  return db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'draft') throw bad('Only draft invoices can be deleted. Void it instead.');
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    return { deleted: true };
  })();
}

function recordInvoicePayment(db, invoiceId, payload) {
  return db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'sent') throw bad('Payments can only be recorded against sent invoices');
    const amount = cents(payload.amount_cents, 'Payment amount', { min: 1 });
    const balance = invoiceBalanceCents(invoice);
    if (amount > balance) throw bad(`Payment exceeds the outstanding balance of ${(balance / 100).toFixed(2)}`);
    const paymentDate = dateISO(payload.payment_date || todayISO(), 'Payment date');
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payload.deposit_account_id));
    if (!account) throw bad('Choose a deposit account');
    if (!account.is_active) throw bad('That deposit account is archived');
    if (!isCashAccount(account)) throw bad('Deposit account must be an active cash or bank account');
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(invoice.customer_id);
    const ar = systemAccount(db, '1100', 'Accounts Receivable');
    const number = allocateNumber(db, 'payment', paymentDate);
    const method = optionalStr(payload.method, 'Payment method', 100) || 'Bank transfer';
    const isCheque = ['Cheque', 'Check'].includes(method);
    const chequeNumber = optionalStr(payload.cheque_number, 'Cheque number', 100);
    if (isCheque && !chequeNumber) throw bad('Enter the cheque number');
    const chequeDate = payload.cheque_date
      ? dateISO(payload.cheque_date, 'Cheque date')
      : (isCheque ? paymentDate : null);
    const bankName = optionalStr(payload.bank_name, 'Bank name', 100);

    const info = db.prepare(`
      INSERT INTO payments (
        number, customer_id, invoice_id, payment_date, amount_cents, method, reference,
        cheque_number, cheque_date, bank_name, deposit_account_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      invoice.customer_id,
      invoice.id,
      paymentDate,
      amount,
      method,
      optionalStr(payload.reference, 'Reference', 200),
      chequeNumber,
      chequeDate,
      bankName,
      account.id,
    );
    const paymentId = Number(info.lastInsertRowid);
    const entryId = postEntry(db, {
      entry_date: paymentDate,
      memo: `Payment ${number} — ${customer.name} (invoice ${invoice.number})${chequeNumber ? ` · cheque ${chequeNumber}` : ''}`,
      reference: invoice.number,
      source_type: 'payment',
      source_id: paymentId,
      lines: [
        { account_id: account.id, debit_cents: amount, credit_cents: 0, description: `Payment ${number}${chequeNumber ? ` · Cheque ${chequeNumber}` : ''}` },
        { account_id: ar.id, debit_cents: 0, credit_cents: amount, description: `Invoice ${invoice.number}` },
      ],
    });
    db.prepare('UPDATE payments SET journal_entry_id = ? WHERE id = ?').run(entryId, paymentId);
    db.prepare(`
      UPDATE invoices SET amount_paid_cents = amount_paid_cents + ?, updated_at = datetime('now') WHERE id = ?
    `).run(amount, invoice.id);
    return getInvoice(db, invoiceId);
  })();
}

function deleteInvoicePayment(db, paymentId) {
  return db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) throw notFound('Payment not found');
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(payment.invoice_id);
    if (!invoice) throw notFound('Invoice not found');
    const refundCount = db.prepare(`
      SELECT COUNT(*) AS c FROM refunds WHERE payment_id = ? AND status = 'paid'
    `).get(paymentId).c;
    if (refundCount > 0) {
      throw bad('This payment has refunds. Void the refunds before removing the payment or cancelling the invoice.');
    }
    if (payment.journal_entry_id) {
      reverseEntry(db, payment.journal_entry_id, {
        entry_date: todayISO(),
        memo: `Reverse payment ${payment.number}`,
        source_type: 'void',
      });
    }
    db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId);
    db.prepare(`
      UPDATE invoices SET amount_paid_cents = MAX(0, amount_paid_cents - ?), updated_at = datetime('now') WHERE id = ?
    `).run(payment.amount_cents, payment.invoice_id);
    if (payment.advance_id) {
      const advance = db.prepare('SELECT * FROM customer_advances WHERE id = ?').get(payment.advance_id);
      if (advance) {
        const applied = Math.max(0, advance.applied_cents - payment.amount_cents);
        const status = applied + advance.refunded_cents >= advance.amount_cents ? 'applied' : 'open';
        db.prepare('UPDATE customer_advances SET applied_cents = ?, status = ? WHERE id = ?').run(applied, status, advance.id);
      }
    }
    return getInvoice(db, invoice.id);
  })();
}

module.exports = {
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  finalizeInvoice,
  voidInvoice,
  deleteInvoice,
  recordInvoicePayment,
  deleteInvoicePayment,
};
