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
  notFuture,
} = require('../util');
const workflows = require('../workflows');
const {
  systemAccount,
  isCashAccount,
  isPurchaseAccount,
  bankChargesCents,
  bankChargeLines,
  postEntry,
  reverseEntry,
  billBalanceCents,
  billDisplayStatus,
} = require('../accounting');
const { allocateNumber } = require('./numbering');
const { markCreated } = require('../created-by');
const { assignPartyNumber } = require('../party-numbers');
const chequeService = require('./cheques');
const audit = require('./audit');

const billSelect = `
  SELECT b.*, v.name AS vendor_name, v.email AS vendor_email, v.address AS vendor_address,
         v.phone AS vendor_phone, v.number AS vendor_number, p.name AS portal_name
  FROM bills b
  JOIN vendors v ON v.id = b.vendor_id
  LEFT JOIN supplier_portals p ON p.id = b.portal_id
`;

function serializeBill(bill, today = todayISO()) {
  return {
    ...bill,
    status_display: billDisplayStatus(bill, today),
    balance_cents: billBalanceCents(bill),
    allowed_actions: workflows.allowedActions('bill', bill),
  };
}

function getBill(db, id) {
  const bill = db.prepare(`${billSelect} WHERE b.id = ?`).get(id);
  if (!bill) throw notFound('Bill not found');
  bill.items = db.prepare(`
    SELECT bi.*, a.code AS account_code, a.name AS account_name
    FROM bill_items bi
    JOIN accounts a ON a.id = bi.account_id
    WHERE bi.bill_id = ?
    ORDER BY bi.sort_order, bi.id
  `).all(id);
  bill.payments = db.prepare(`
    SELECT p.*, a.name AS payment_account_name, sp.name AS portal_name,
           COALESCE((
             SELECT SUM(r.amount_cents) FROM refunds r
             WHERE r.bill_payment_id = p.id AND r.status = 'paid'
           ), 0) AS refunded_cents
    FROM bill_payments p
    JOIN accounts a ON a.id = p.payment_account_id
    LEFT JOIN supplier_portals sp ON sp.id = p.portal_id
    WHERE p.bill_id = ?
    ORDER BY p.payment_date, p.id
  `).all(id).map((payment) => ({
    ...payment,
    refundable_cents: payment.portal_id || payment.status === 'void'
      ? 0
      : Math.max(0, payment.amount_cents - payment.refunded_cents),
  }));
  bill.supplier_credits = db.prepare(`
    SELECT scn.*, (scn.amount_cents - scn.applied_cents - scn.refunded_cents - scn.portal_settled_cents) AS remaining_cents
    FROM supplier_credit_notes scn
    WHERE scn.bill_id = ? AND scn.status = 'issued'
    ORDER BY scn.credit_date, scn.id
  `).all(id);
  bill.credit_applications = db.prepare(`
    SELECT sca.*, scn.number AS credit_number
    FROM supplier_credit_applications sca
    JOIN supplier_credit_notes scn ON scn.id = sca.credit_note_id
    WHERE sca.bill_id = ?
    ORDER BY sca.applied_date, sca.id
  `).all(id);
  if (bill.journal_entry_id) {
    bill.journal_entry = db.prepare(`
      SELECT e.*, (
        SELECT COALESCE(SUM(l.debit_cents), 0) FROM journal_lines l WHERE l.entry_id = e.id
      ) AS total_cents
      FROM journal_entries e WHERE e.id = ?
    `).get(bill.journal_entry_id) || null;
  }
  return serializeBill(bill);
}

function listBills(db, { status, search, from, to } = {}) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('b.bill_date >= ?');
    params.push(dateISO(from, 'From date'));
  }
  if (to) {
    clauses.push('b.bill_date <= ?');
    params.push(dateISO(to, 'To date'));
  }
  if (search) {
    clauses.push('(b.number LIKE ? OR v.name LIKE ? OR b.notes LIKE ?)');
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`${billSelect} ${where} ORDER BY b.bill_date DESC, b.id DESC`).all(...params);
  const today = todayISO();
  const serialized = rows.map((row) => serializeBill(row, today));
  if (!status || status === 'all') return serialized;
  if (status === 'outstanding') {
    return serialized.filter((row) => !['draft', 'void', 'paid'].includes(row.status_display));
  }
  return serialized.filter((row) => row.status_display === status);
}

function assertVendor(db, vendorId) {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(vendorId));
  if (!vendor) throw bad('Choose a vendor');
  if (!vendor.is_active) throw bad('That vendor is archived');
  return vendor;
}

function normalizeItems(db, items) {
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
    if (!isPurchaseAccount(account)) {
      throw bad(`${label}: choose an expense account or a valid non-cash asset`);
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

function insertItems(db, billId, items) {
  const insert = db.prepare(`
    INSERT INTO bill_items (bill_id, description, quantity, unit_price_cents, amount_cents, account_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  items.forEach((item, index) => {
    insert.run(billId, item.description, item.quantity, item.unit_price_cents, item.amount_cents, item.account_id, index);
  });
}

function postBill(db, bill, vendor, items) {
  const ap = systemAccount(db, '2000', 'Trade Payables');
  const grouped = new Map();
  for (const item of items) {
    grouped.set(item.account_id, (grouped.get(item.account_id) || 0) + item.amount_cents);
  }
  const lines = [];
  let expenseTotal = 0;
  for (const [accountId, amount] of grouped.entries()) {
    if (amount <= 0) continue;
    expenseTotal += amount;
    lines.push({ account_id: accountId, debit_cents: amount, credit_cents: 0, description: `Bill ${bill.number}` });
  }
  if (expenseTotal <= 0) throw bad('Bill total must be greater than zero');
  lines.push({ account_id: ap.id, debit_cents: 0, credit_cents: bill.total_cents, description: `Bill ${bill.number}` });

  return postEntry(db, {
    entry_date: bill.bill_date,
    memo: `Bill ${bill.number} — ${vendor.name}`,
    reference: bill.number,
    source_type: 'bill',
    source_id: bill.id,
    lines,
  });
}

function createBill(db, payload) {
  return db.transaction(() => {
    const vendor = assertVendor(db, payload.vendor_id);
    const billDate = dateISO(payload.bill_date, 'Bill date');
    const dueDate = dateISO(payload.due_date || billDate, 'Due date');
    if (dueDate < billDate) throw bad('Due date cannot be before the bill date');
    const status = payload.status === 'draft' ? 'draft' : 'received';
    // A posted bill counts as owed at once; its ledger entry only from its date.
    if (status === 'received') notFuture(billDate, 'Bill date');
    const defaultPaymentMethod = optionalStr(payload.default_payment_method, 'Default payment method', 100) || 'Bank transfer';
    const items = normalizeItems(db, payload.items);
    const totals = computeTotals(items);
    if (totals.total <= 0) throw bad('Bill total must be greater than zero');
    const number = allocateNumber(db, 'bill', billDate);

    const info = db.prepare(`
      INSERT INTO bills (number, vendor_id, bill_date, due_date, status, notes,
        default_payment_method, subtotal_cents, total_cents, amount_paid_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      number,
      vendor.id,
      billDate,
      dueDate,
      status,
      optionalStr(payload.notes, 'Notes', 2000),
      defaultPaymentMethod,
      totals.subtotal,
      totals.total,
    );
    const billId = Number(info.lastInsertRowid);
    markCreated(db, 'bills', billId);
    insertItems(db, billId, items);

    if (status === 'received') {
      const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
      const entryId = postBill(db, bill, vendor, items);
      db.prepare('UPDATE bills SET journal_entry_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(entryId, billId);
    }

    return getBill(db, billId);
  })();
}

function updateBill(db, id, payload) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
    if (!existing) throw notFound('Bill not found');
    workflows.assertCan('bill', 'edit', existing);
    const vendor = assertVendor(db, payload.vendor_id ?? existing.vendor_id);
    const billDate = dateISO(payload.bill_date ?? existing.bill_date, 'Bill date');
    const dueDate = dateISO(payload.due_date ?? existing.due_date, 'Due date');
    if (dueDate < billDate) throw bad('Due date cannot be before the bill date');
    const items = normalizeItems(db, payload.items);
    const totals = computeTotals(items);
    if (totals.total <= 0) throw bad('Bill total must be greater than zero');

    db.prepare(`
      UPDATE bills SET vendor_id = ?, bill_date = ?, due_date = ?, notes = ?,
        subtotal_cents = ?, total_cents = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      vendor.id,
      billDate,
      dueDate,
      optionalStr(payload.notes ?? existing.notes, 'Notes', 2000),
      totals.subtotal,
      totals.total,
      id,
    );
    db.prepare('DELETE FROM bill_items WHERE bill_id = ?').run(id);
    insertItems(db, id, items);
    return getBill(db, id);
  })();
}

function finalizeBill(db, id) {
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
    if (!bill) throw notFound('Bill not found');
    workflows.assertCan('bill', 'finalize', bill);
    const items = db.prepare('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY sort_order, id').all(id);
    if (!items.length) throw bad('Add line items before finalizing');
    notFuture(bill.bill_date, 'Bill date');
    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(bill.vendor_id);
    const entryId = postBill(db, bill, vendor, items);
    db.prepare(`
      UPDATE bills SET status = 'received', journal_entry_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(entryId, id);
    return getBill(db, id);
  })();
}

// fromWorkflow: the booking or visa that owns the bill is itself being
// voided (job-void.js), so the owner check below does not apply.
function voidBill(db, id, payload = {}, { fromWorkflow = false } = {}) {
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
    if (!bill) throw notFound('Bill not found');
    if (bill.status === 'void') throw bad('Bill is already void');
    // A booking or visa bill is part of the job's margin. Supplier changes go
    // through a supplier credit, or the job is cancelled.
    if ((bill.booking_id || bill.visa_id) && !fromWorkflow) {
      throw bad(`This bill belongs to a ${bill.booking_id ? 'booking' : 'visa application'}. Record a supplier credit for the amount the supplier returns, or cancel the ${bill.booking_id ? 'booking' : 'visa application'}.`);
    }
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);

    // Reverse dependants first so the bill and its supplier balance both end at zero.
    const refundService = require('./refunds');
    const supplierCreditService = require('./supplier-credits');
    const refunds = db.prepare(`
      SELECT id FROM refunds
      WHERE status = 'paid' AND (
        bill_id = ? OR bill_payment_id IN (SELECT id FROM bill_payments WHERE bill_id = ?)
      )
      ORDER BY id
    `).all(bill.id, bill.id);
    for (const refund of refunds) {
      refundService.voidRefund(db, refund.id, {
        remarks: remarks || `Voided with bill ${bill.number}`,
      });
    }

    const applications = db.prepare(
      'SELECT id FROM supplier_credit_applications WHERE bill_id = ? ORDER BY id',
    ).all(bill.id);
    for (const application of applications) {
      supplierCreditService.deleteSupplierCreditApplication(db, application.id, {
        remarks: remarks || `Voided with bill ${bill.number}`,
      });
    }

    const payments = db.prepare("SELECT id FROM bill_payments WHERE bill_id = ? AND status = 'posted' ORDER BY id").all(bill.id);
    for (const payment of payments) {
      deleteBillPayment(db, payment.id, {
        remarks: remarks || `Voided with bill ${bill.number}`,
      });
    }

    const fresh = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id);
    if (fresh.amount_paid_cents > 0 || fresh.credit_applied_cents > 0) {
      throw bad('Linked payments or supplier credits could not be fully reversed');
    }
    if (fresh.status === 'received' && fresh.journal_entry_id) {
      reverseEntry(db, fresh.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void bill ${fresh.number}`, remarks),
        source_type: 'void',
      });
    }
    db.prepare(`UPDATE bills SET status = 'void', updated_at = datetime('now') WHERE id = ?`).run(id);
    audit.record(db, {
      entity_type: 'bill',
      entity_id: bill.id,
      entity_number: bill.number,
      action: 'void',
      remarks: remarks || `Voided bill ${bill.number}`,
      amount_cents: bill.total_cents,
      metadata: {
        refunds_voided: refunds.length,
        supplier_credit_applications_reversed: applications.length,
        payments_voided: payments.length,
      },
    });
    return getBill(db, id);
  })();
}

function deleteBill(db, id) {
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
    if (!bill) throw notFound('Bill not found');
    workflows.assertCan('bill', 'delete', bill);
    db.prepare("DELETE FROM attachments WHERE entity_type = 'bill' AND entity_id = ?").run(id);
    db.prepare('DELETE FROM bills WHERE id = ?').run(id);
    return { deleted: true };
  })();
}

function recordBillPayment(db, billId, payload) {
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
    if (!bill) throw notFound('Bill not found');
    workflows.assertCan('bill', 'record_payment', bill);
    const amount = cents(payload.amount_cents, 'Payment amount', { min: 1 });
    const balance = billBalanceCents(bill);
    if (amount > balance) throw bad(`Payment exceeds the outstanding balance of ${(balance / 100).toFixed(2)}`);
    const paymentDate = notFuture(dateISO(payload.payment_date || todayISO(), 'Payment date'), 'Payment date');
    if (paymentDate < bill.bill_date) {
      throw bad(`Payment date cannot be before the bill date (${bill.bill_date}). Record money paid earlier as a supplier portal top-up.`);
    }
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payload.payment_account_id));
    if (!account) throw bad('Choose a payment account');
    if (!account.is_active) throw bad('That payment account is archived');
    if (!isCashAccount(account)) throw bad('Payment account must be an active cash or bank account');
    const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(bill.vendor_id);
    const ap = systemAccount(db, '2000', 'Trade Payables');
    const number = allocateNumber(db, 'bill_payment', paymentDate);
    const method = optionalStr(payload.method, 'Payment method', 100) || 'Bank transfer';
    const isCheque = ['Cheque', 'Check'].includes(method);
    const chequeNumber = optionalStr(payload.cheque_number, 'Cheque number', 100);
    if (isCheque && !chequeNumber) throw bad('Enter the cheque number');
    const chequeDate = payload.cheque_date
      ? dateISO(payload.cheque_date, 'Cheque date')
      : (isCheque ? paymentDate : null);
    const bankName = optionalStr(payload.bank_name, 'Bank name', 100);
    // Transfer charges the bank adds on top of what the supplier receives.
    const charges = bankChargesCents(payload);

    const info = db.prepare(`
      INSERT INTO bill_payments (
        number, bill_id, vendor_id, payment_date, amount_cents, method, reference,
        cheque_number, cheque_date, bank_name, payment_account_id, bank_charges_cents
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      bill.id,
      bill.vendor_id,
      paymentDate,
      amount,
      method,
      optionalStr(payload.reference, 'Reference', 200),
      chequeNumber,
      chequeDate,
      bankName,
      account.id,
      charges,
    );
    const paymentId = Number(info.lastInsertRowid);
    markCreated(db, 'bill_payments', paymentId);
    const entryId = postEntry(db, {
      entry_date: paymentDate,
      memo: `Bill payment ${number} — ${vendor.name} (bill ${bill.number})${chequeNumber ? ` · cheque ${chequeNumber}` : ''}`,
      reference: bill.number,
      source_type: 'bill_payment',
      source_id: paymentId,
      lines: [
        { account_id: ap.id, debit_cents: amount, credit_cents: 0, description: `Bill ${bill.number}` },
        { account_id: account.id, debit_cents: 0, credit_cents: amount, description: `Payment ${number}${chequeNumber ? ` · Cheque ${chequeNumber}` : ''}` },
        ...bankChargeLines(db, charges, account, `payment ${number}`),
      ],
    });
    db.prepare('UPDATE bill_payments SET journal_entry_id = ? WHERE id = ?').run(entryId, paymentId);
    if (isCheque && chequeNumber) {
      chequeService.matchChequePayment(db, {
        vendorId: bill.vendor_id,
        chequeNumber,
        amountCents: amount,
        paymentDate,
        billId: bill.id,
        paymentId,
      });
    }
    db.prepare(`
      UPDATE bills SET amount_paid_cents = amount_paid_cents + ?, updated_at = datetime('now') WHERE id = ?
    `).run(amount, bill.id);
    return getBill(db, billId);
  })();
}

function deleteBillPayment(db, paymentId, payload = {}) {
  return db.transaction(() => {
    const payment = db.prepare('SELECT * FROM bill_payments WHERE id = ?').get(paymentId);
    if (!payment) throw notFound('Payment not found');
    if (payment.status === 'void') throw bad('That payment is already void');
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(payment.bill_id);
    if (!bill) throw notFound('Bill not found');
    if (bill.status === 'void') {
      throw bad('Payments cannot be voided on a void bill. The void already reversed them.');
    }
    const refundCount = db.prepare(`
      SELECT COUNT(*) AS c FROM refunds WHERE bill_payment_id = ? AND status = 'paid'
    `).get(paymentId).c;
    if (refundCount > 0) {
      throw bad('This payment has refunds. Void the refunds before voiding the payment.');
    }
    chequeService.unlinkPayment(db, paymentId);
    let voidEntryId = null;
    if (payment.journal_entry_id) {
      voidEntryId = reverseEntry(db, payment.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void bill payment ${payment.number}`, remarks),
        source_type: 'void',
      });
    }
    db.prepare(`
      UPDATE bill_payments SET status = 'void', void_entry_id = ?, voided_at = datetime('now') WHERE id = ?
    `).run(voidEntryId, paymentId);
    if (payment.portal_id) {
      const remaining = db.prepare(
        "SELECT COUNT(*) AS c FROM bill_payments WHERE bill_id = ? AND portal_id IS NOT NULL AND status = 'posted'",
      ).get(payment.bill_id).c;
      if (!remaining) {
        db.prepare("UPDATE bills SET portal_id = NULL, updated_at = datetime('now') WHERE id = ?").run(payment.bill_id);
      }
    }
    db.prepare(`
      UPDATE bills SET amount_paid_cents = MAX(0, amount_paid_cents - ?), updated_at = datetime('now') WHERE id = ?
    `).run(payment.amount_cents, payment.bill_id);
    audit.record(db, {
      entity_type: 'bill_payment',
      entity_id: payment.id,
      entity_number: payment.number,
      action: 'void',
      remarks: remarks || `Voided bill payment ${payment.number}`,
      amount_cents: payment.amount_cents,
      metadata: { bill_id: bill.id, bill_number: bill.number },
    });
    return getBill(db, bill.id);
  })();
}

// Quick expense (paid now): a small expense already paid, such as a taxi or
// office supplies. It is a bill and its payment on the same date, so it voids,
// reports and appears on statements exactly like any bill; Trade Payables nets
// to zero. Without a supplier it is booked to a "Sundry (cash expenses)" one.
const SUNDRY_VENDOR = 'Sundry (cash expenses)';

function sundryVendor(db) {
  const existing = db.prepare('SELECT * FROM vendors WHERE name = ? ORDER BY id LIMIT 1').get(SUNDRY_VENDOR);
  if (existing) {
    if (!existing.is_active) db.prepare('UPDATE vendors SET is_active = 1 WHERE id = ?').run(existing.id);
    return existing;
  }
  const id = Number(db.prepare('INSERT INTO vendors (name, notes) VALUES (?, ?)')
    .run(SUNDRY_VENDOR, 'Used for quick expenses paid without a named supplier.').lastInsertRowid);
  assignPartyNumber(db, 'vendors', id);
  return db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
}

// Charges the bank debits itself are kept under the bank's own supplier
// record, created on first use.
function bankDebitVendor(db, account) {
  const name = `${account.name} (bank debits)`;
  const existing = db.prepare('SELECT * FROM vendors WHERE name = ? ORDER BY id LIMIT 1').get(name);
  if (existing) {
    if (!existing.is_active) db.prepare('UPDATE vendors SET is_active = 1 WHERE id = ?').run(existing.id);
    return existing;
  }
  const id = Number(db.prepare('INSERT INTO vendors (name, notes) VALUES (?, ?)')
    .run(name, `Charges the bank debits from ${account.code} ${account.name} itself.`).lastInsertRowid);
  assignPartyNumber(db, 'vendors', id);
  return db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
}

function createQuickExpense(db, payload = {}) {
  return db.transaction(() => {
    const vendorId = payload.vendor_id ? assertVendor(db, payload.vendor_id).id : sundryVendor(db).id;
    const date = dateISO(payload.expense_date || todayISO(), 'Date');
    const amount = cents(payload.amount_cents, 'Amount', { min: 1 });
    const method = optionalStr(payload.method, 'Payment method', 100) || 'Cash';
    const description = str(payload.description, 'What it was for', { max: 300 });
    const bill = createBill(db, {
      vendor_id: vendorId,
      bill_date: date,
      due_date: date,
      status: 'received',
      default_payment_method: method,
      notes: ['Quick expense · paid now', optionalStr(payload.notes, 'Notes', 1000)].filter(Boolean).join(' · '),
      items: [{ description, quantity: 1, unit_price_cents: amount, account_id: payload.account_id }],
    });
    recordBillPayment(db, bill.id, {
      amount_cents: amount,
      payment_date: date,
      payment_account_id: payload.payment_account_id,
      method,
      reference: payload.reference,
      cheque_number: payload.cheque_number,
    });
    return getBill(db, bill.id);
  })();
}

module.exports = {
  createQuickExpense,
  bankDebitVendor,
  SUNDRY_VENDOR,
  listBills,
  getBill,
  createBill,
  updateBill,
  finalizeBill,
  voidBill,
  deleteBill,
  recordBillPayment,
  deleteBillPayment,
};
