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
  isCashAccount,
  postEntry,
  reverseEntry,
  invoiceBalanceCents,
} = require('../accounting');
const { allocateNumber } = require('./numbering');
const audit = require('./audit');

const creditSelect = `
  SELECT cn.*, c.name AS customer_name, c.email AS customer_email,
         c.phone AS customer_phone, c.address AS customer_address,
         a.code AS revenue_account_code, a.name AS revenue_account_name,
         cc.number AS cancellation_number,
         (cn.amount_cents - cn.applied_cents - cn.refunded_cents) AS remaining_cents
  FROM credit_notes cn
  JOIN customers c ON c.id = cn.customer_id
  JOIN accounts a ON a.id = cn.revenue_account_id
  LEFT JOIN cancellations cc ON cc.id = cn.cancellation_id
`;

// Unapplied credit is what is left after invoice applications and cash refunds.
function remainingCents(credit) {
  return Math.max(0, credit.amount_cents - credit.applied_cents - (credit.refunded_cents || 0));
}

function serializeCredit(row) {
  return {
    ...row,
    remaining_cents: row.status === 'void' ? 0 : remainingCents(row),
  };
}

function getCredit(db, id) {
  const credit = db.prepare(`${creditSelect} WHERE cn.id = ?`).get(Number(id));
  if (!credit) throw notFound('Credit note not found');
  credit.applications = db.prepare(`
    SELECT ca.*, i.number AS invoice_number, i.total_cents AS invoice_total_cents,
           i.amount_paid_cents AS invoice_paid_cents, i.credit_applied_cents AS invoice_credit_cents
    FROM credit_applications ca
    JOIN invoices i ON i.id = ca.invoice_id
    WHERE ca.credit_note_id = ?
    ORDER BY ca.applied_date, ca.id
  `).all(credit.id);
  credit.refunds = db.prepare(`
    SELECT r.*, a.code AS account_code, a.name AS account_name
    FROM refunds r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.credit_note_id = ?
    ORDER BY r.refund_date, r.id
  `).all(credit.id);
  return serializeCredit(credit);
}

function listCredits(db, { status, search, from, to } = {}) {
  const clauses = [];
  const params = [];
  if (status && status !== 'all') {
    if (!['issued', 'void'].includes(status)) throw bad('Credit status must be issued or void');
    clauses.push('cn.status = ?');
    params.push(status);
  }
  if (from) {
    clauses.push('cn.credit_date >= ?');
    params.push(dateISO(from, 'From date'));
  }
  if (to) {
    clauses.push('cn.credit_date <= ?');
    params.push(dateISO(to, 'To date'));
  }
  if (search) {
    clauses.push('(cn.number LIKE ? OR c.name LIKE ? OR cn.notes LIKE ?)');
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`${creditSelect} ${where} ORDER BY cn.credit_date DESC, cn.id DESC`)
    .all(...params)
    .map(serializeCredit);
}

function assertCustomer(db, customerId) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(customerId));
  if (!customer) throw bad('Choose a customer');
  if (!customer.is_active) throw bad('That customer is archived');
  return customer;
}

function assertRevenueAccount(db, accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!account) throw bad('Choose a revenue account');
  if (!account.is_active) throw bad('That revenue account is archived');
  if (account.type !== 'revenue') throw bad('Credit notes must use a revenue account');
  return account;
}

function createCredit(db, payload = {}) {
  return db.transaction(() => {
    const customer = assertCustomer(db, payload.customer_id);
    const revenueAccount = assertRevenueAccount(db, payload.revenue_account_id);
    const creditDate = dateISO(payload.credit_date || todayISO(), 'Credit date');
    const amount = cents(payload.amount_cents, 'Credit amount', { min: 1 });
    const notes = optionalStr(payload.notes, 'Notes', 2000);
    const number = allocateNumber(db, 'credit', creditDate);

    const info = db.prepare(`
      INSERT INTO credit_notes (number, customer_id, credit_date, amount_cents, revenue_account_id, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(number, customer.id, creditDate, amount, revenueAccount.id, notes);
    const creditId = Number(info.lastInsertRowid);
    const credits = systemAccount(db, '2450', 'Customer Credits');
    const entryId = postEntry(db, {
      entry_date: creditDate,
      memo: `Credit note ${number} — ${customer.name}`,
      reference: number,
      source_type: 'credit_note',
      source_id: creditId,
      lines: [
        { account_id: revenueAccount.id, debit_cents: amount, credit_cents: 0, description: `Credit note ${number}` },
        { account_id: credits.id, debit_cents: 0, credit_cents: amount, description: `Credit note ${number}` },
      ],
    });
    db.prepare('UPDATE credit_notes SET journal_entry_id = ? WHERE id = ?').run(entryId, creditId);
    return getCredit(db, creditId);
  })();
}

// A cancellation refund converted into store credit does not touch revenue a
// second time. It moves the liability from Refund Liabilities to Customer Credits.
function createCreditFromCancellation(db, payload = {}) {
  return db.transaction(() => {
    const cancellation = db.prepare('SELECT * FROM cancellations WHERE id = ?').get(Number(payload.cancellation_id));
    if (!cancellation) throw notFound('Cancellation not found');
    const customer = assertCustomer(db, cancellation.customer_id);
    const creditDate = dateISO(payload.credit_date || todayISO(), 'Credit date');
    if (creditDate < cancellation.cancellation_date) {
      throw bad('Credit date cannot be before the cancellation date');
    }
    const amount = cents(payload.amount_cents, 'Credit amount', { min: 1 });
    const refundDue = cancellation.refund_due_cents
      - db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds
        WHERE cancellation_id = ? AND status = 'paid'
      `).get(cancellation.id).total
      - db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total FROM credit_notes
        WHERE cancellation_id = ? AND status = 'issued'
      `).get(cancellation.id).total;
    if (amount > refundDue) {
      throw bad(`Credit amount exceeds the unrefunded cancellation balance of ${(Math.max(0, refundDue) / 100).toFixed(2)}`);
    }
    const revenueAccount = systemAccount(db, '4330', 'Cancellation Fee Income');
    const number = allocateNumber(db, 'credit', creditDate);
    const info = db.prepare(`
      INSERT INTO credit_notes (
        number, customer_id, credit_date, amount_cents, revenue_account_id,
        cancellation_id, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      customer.id,
      creditDate,
      amount,
      revenueAccount.id,
      cancellation.id,
      optionalStr(payload.notes, 'Notes', 2000) || `Refund converted to credit for ${cancellation.number}`,
    );
    const creditId = Number(info.lastInsertRowid);
    const credits = systemAccount(db, '2450', 'Customer Credits');
    const refundPayable = systemAccount(db, '2500', 'Refund Liabilities');
    const entryId = postEntry(db, {
      entry_date: creditDate,
      memo: `Cancellation ${cancellation.number} refund converted to customer credit ${number}`,
      reference: cancellation.number,
      source_type: 'credit_note',
      source_id: creditId,
      lines: [
        { account_id: refundPayable.id, debit_cents: amount, credit_cents: 0, description: `Cancellation ${cancellation.number}` },
        { account_id: credits.id, debit_cents: 0, credit_cents: amount, description: `Credit note ${number}` },
      ],
    });
    db.prepare('UPDATE credit_notes SET journal_entry_id = ? WHERE id = ?').run(entryId, creditId);
    return getCredit(db, creditId);
  })();
}

function applyCredit(db, creditId, payload = {}) {
  return db.transaction(() => {
    const credit = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(Number(creditId));
    if (!credit) throw notFound('Credit note not found');
    if (credit.status !== 'issued') throw bad('Only issued credit notes can be applied');
    const remaining = remainingCents(credit);
    if (remaining <= 0) throw bad('This credit note has no remaining balance');
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(payload.invoice_id));
    if (!invoice) throw bad('Choose an invoice');
    if (invoice.customer_id !== credit.customer_id) throw bad('Choose an invoice for the same customer');
    if (invoice.status !== 'sent') throw bad('Credits can only be applied to sent invoices');
    const amount = cents(payload.amount_cents, 'Credit amount', { min: 1 });
    if (amount > remaining) throw bad(`Credit amount exceeds the remaining balance of ${(remaining / 100).toFixed(2)}`);
    const balance = invoiceBalanceCents(invoice);
    if (amount > balance) throw bad(`Credit amount exceeds the invoice balance of ${(balance / 100).toFixed(2)}`);
    const appliedDate = dateISO(payload.applied_date || todayISO(), 'Applied date');
    const credits = systemAccount(db, '2450', 'Customer Credits');
    const ar = systemAccount(db, '1100', 'Trade Receivables');

    const info = db.prepare(`
      INSERT INTO credit_applications (credit_note_id, invoice_id, applied_date, amount_cents)
      VALUES (?, ?, ?, ?)
    `).run(credit.id, invoice.id, appliedDate, amount);
    const applicationId = Number(info.lastInsertRowid);
    const entryId = postEntry(db, {
      entry_date: appliedDate,
      memo: `Credit ${credit.number} applied to invoice ${invoice.number}`,
      reference: invoice.number,
      source_type: 'credit_applied',
      source_id: applicationId,
      lines: [
        { account_id: credits.id, debit_cents: amount, credit_cents: 0, description: `Credit ${credit.number}` },
        { account_id: ar.id, debit_cents: 0, credit_cents: amount, description: `Invoice ${invoice.number}` },
      ],
    });
    db.prepare('UPDATE credit_applications SET journal_entry_id = ? WHERE id = ?').run(entryId, applicationId);
    db.prepare('UPDATE credit_notes SET applied_cents = applied_cents + ? WHERE id = ?').run(amount, credit.id);
    db.prepare(`
      UPDATE invoices SET credit_applied_cents = credit_applied_cents + ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(amount, invoice.id);
    return getCredit(db, credit.id);
  })();
}

function deleteCreditApplication(db, applicationId, payload = {}) {
  return db.transaction(() => {
    const application = db.prepare('SELECT * FROM credit_applications WHERE id = ?').get(Number(applicationId));
    if (!application) throw notFound('Credit application not found');
    const credit = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(application.credit_note_id);
    if (!credit) throw notFound('Credit note not found');
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    if (application.journal_entry_id) {
      reverseEntry(db, application.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Reverse credit application ${credit.number}`, remarks),
        source_type: 'void',
      });
    }
    db.prepare('DELETE FROM credit_applications WHERE id = ?').run(application.id);
    db.prepare(`
      UPDATE credit_notes SET applied_cents = MAX(0, applied_cents - ?) WHERE id = ?
    `).run(application.amount_cents, credit.id);
    db.prepare(`
      UPDATE invoices SET credit_applied_cents = MAX(0, credit_applied_cents - ?), updated_at = datetime('now')
      WHERE id = ?
    `).run(application.amount_cents, application.invoice_id);
    audit.record(db, {
      entity_type: 'credit_application',
      entity_id: application.id,
      entity_number: credit.number,
      action: 'void',
      remarks: remarks || `Reversed credit application ${credit.number}`,
      amount_cents: application.amount_cents,
      metadata: { credit_note_id: credit.id, invoice_id: application.invoice_id },
    });
    return getCredit(db, credit.id);
  })();
}

// Pays unapplied customer credit back in cash. The credit note stays issued;
// only its remaining balance falls. Revenue is not touched a second time.
function refundCredit(db, creditId, payload = {}) {
  return db.transaction(() => {
    const credit = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(Number(creditId));
    if (!credit) throw notFound('Credit note not found');
    if (credit.status !== 'issued') throw bad('Only issued credit notes can be refunded');
    const remaining = remainingCents(credit);
    if (remaining <= 0) throw bad('This credit note has no remaining balance');
    const amount = cents(payload.amount_cents == null ? remaining : payload.amount_cents, 'Refund amount', { min: 1 });
    if (amount > remaining) throw bad(`Refund exceeds the remaining credit of ${(remaining / 100).toFixed(2)}`);
    const refundDate = dateISO(payload.refund_date || todayISO(), 'Refund date');
    if (refundDate < credit.credit_date) {
      throw bad('Refund date cannot be before the credit date');
    }
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payload.account_id));
    if (!account) throw bad('Choose a bank or cash account');
    if (!account.is_active) throw bad('That account is archived');
    if (!isCashAccount(account)) throw bad('Refunds must be paid from a bank or cash account');
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(credit.customer_id);
    const method = optionalStr(payload.method, 'Refund method', 100) || 'Bank transfer';
    const credits = systemAccount(db, '2450', 'Customer Credits');
    const number = allocateNumber(db, 'refund', refundDate);
    const info = db.prepare(`
      INSERT INTO refunds (
        number, refund_type, party_id, credit_note_id,
        refund_date, amount_cents, method, reference, notes, account_id
      ) VALUES (?, 'customer', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      credit.customer_id,
      credit.id,
      refundDate,
      amount,
      method,
      optionalStr(payload.reference, 'Reference', 200),
      optionalStr(payload.notes, 'Notes', 2000) || `Cash refund of customer credit ${credit.number}`,
      account.id,
    );
    const refundId = Number(info.lastInsertRowid);
    const entryId = postEntry(db, {
      entry_date: refundDate,
      memo: `Customer credit refund ${number} — ${customer?.name || 'Customer'} (${credit.number})`,
      reference: credit.number,
      source_type: 'customer_credit_refund',
      source_id: refundId,
      lines: [
        { account_id: credits.id, debit_cents: amount, credit_cents: 0, description: `Credit ${credit.number}` },
        { account_id: account.id, debit_cents: 0, credit_cents: amount, description: `Refund ${number}` },
      ],
    });
    db.prepare('UPDATE refunds SET journal_entry_id = ? WHERE id = ?').run(entryId, refundId);
    db.prepare('UPDATE credit_notes SET refunded_cents = refunded_cents + ? WHERE id = ?').run(amount, credit.id);
    return getCredit(db, credit.id);
  })();
}

function voidCredit(db, creditId, payload = {}) {
  return db.transaction(() => {
    const credit = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(Number(creditId));
    if (!credit) throw notFound('Credit note not found');
    if (credit.status === 'void') throw bad('This credit note is already void');
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);

    // Cash refunds are part of the credit. Reverse them first so 2450 returns
    // to zero once the credit note itself is reversed.
    const refundService = require('./refunds');
    const refunds = db.prepare(
      "SELECT id FROM refunds WHERE credit_note_id = ? AND status = 'paid' ORDER BY id",
    ).all(credit.id);
    for (const refund of refunds) {
      refundService.voidRefund(db, refund.id, {
        remarks: remarks || `Voided with credit note ${credit.number}`,
      });
    }

    const applications = db.prepare(
      'SELECT id FROM credit_applications WHERE credit_note_id = ? ORDER BY id',
    ).all(credit.id);
    for (const application of applications) {
      deleteCreditApplication(db, application.id, {
        remarks: remarks || `Voided with credit note ${credit.number}`,
      });
    }

    const fresh = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(credit.id);
    let voidEntryId = null;
    if (fresh.journal_entry_id) {
      voidEntryId = reverseEntry(db, fresh.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void credit note ${fresh.number}`, remarks),
        source_type: 'void',
      });
    }
    db.prepare(`
      UPDATE credit_notes SET status = 'void', void_entry_id = ?, applied_cents = 0, refunded_cents = 0 WHERE id = ?
    `).run(voidEntryId, credit.id);
    audit.record(db, {
      entity_type: 'credit_note',
      entity_id: credit.id,
      entity_number: credit.number,
      action: 'void',
      remarks: remarks || `Voided credit note ${credit.number}`,
      amount_cents: credit.amount_cents,
      metadata: { applications_reversed: applications.length, refunds_reversed: refunds.length },
    });
    return getCredit(db, credit.id);
  })();
}

module.exports = {
  listCredits,
  getCredit,
  createCredit,
  createCreditFromCancellation,
  applyCredit,
  deleteCreditApplication,
  refundCredit,
  voidCredit,
};
