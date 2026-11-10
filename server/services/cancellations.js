'use strict';

const {
  bad,
  notFound,
  str,
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
} = require('../accounting');
const { allocateNumber } = require('./numbering');
const { markCreated } = require('../created-by');
const invoiceService = require('./invoices');
const creditService = require('./credits');
const supplierCreditService = require('./supplier-credits');
const jobs = require('./jobs');
const audit = require('./audit');

const SOURCE_TABLES = {
  booking: { table: 'bookings', number: 'booking_number' },
  visa: { table: 'visa_applications', number: 'visa_number' },
};

const cancellationSelect = `
  SELECT cc.*, c.name AS customer_name, c.email AS customer_email,
         c.phone AS customer_phone, c.address AS customer_address,
         i.number AS invoice_number, ci.number AS cancellation_invoice_number,
         bk.number AS booking_number, bk.status AS booking_status,
         vi.number AS visa_number, vi.status AS visa_status
  FROM cancellations cc
  JOIN customers c ON c.id = cc.customer_id
  LEFT JOIN invoices i ON i.id = cc.invoice_id
  LEFT JOIN invoices ci ON ci.id = cc.cancellation_invoice_id
  LEFT JOIN bookings bk ON cc.source_type = 'booking' AND bk.id = cc.source_id
  LEFT JOIN visa_applications vi ON cc.source_type = 'visa' AND vi.id = cc.source_id
`;

function sourceRow(db, sourceType, sourceId) {
  const config = SOURCE_TABLES[sourceType];
  if (!config) throw bad('Cancellation source must be a booking or visa application');
  const row = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(Number(sourceId));
  if (!row) throw notFound(sourceType === 'booking' ? 'Booking not found' : 'Visa application not found');
  return row;
}

function refundDueRemaining(db, cancellation) {
  const refunded = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds
    WHERE cancellation_id = ? AND status = 'paid'
  `).get(cancellation.id).total;
  const credited = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total FROM credit_notes
    WHERE cancellation_id = ? AND status = 'issued'
  `).get(cancellation.id).total;
  return Math.max(0, cancellation.refund_due_cents - refunded - credited);
}

function getCancellation(db, id) {
  const cancellation = db.prepare(`${cancellationSelect} WHERE cc.id = ?`).get(Number(id));
  if (!cancellation) throw notFound('Cancellation not found');
  cancellation.refunds = db.prepare(`
    SELECT r.*, a.name AS account_name
    FROM refunds r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.cancellation_id = ?
    ORDER BY r.refund_date, r.id
  `).all(cancellation.id);
  cancellation.credits = db.prepare(`
    SELECT cn.*, a.name AS revenue_account_name
    FROM credit_notes cn
    JOIN accounts a ON a.id = cn.revenue_account_id
    WHERE cn.cancellation_id = ?
    ORDER BY cn.credit_date, cn.id
  `).all(cancellation.id);
  cancellation.supplier_credits = supplierCreditService.supplierCreditsForSource(db, {
    bookingId: cancellation.source_type === 'booking' ? cancellation.source_id : null,
    visaId: cancellation.source_type === 'visa' ? cancellation.source_id : null,
    cancellationId: cancellation.id,
  });
  cancellation.customer_refunded_cents = cancellation.refunds
    .filter((refund) => refund.status === 'paid')
    .reduce((sum, refund) => sum + refund.amount_cents, 0);
  cancellation.customer_credited_cents = cancellation.credits
    .filter((credit) => credit.status === 'issued')
    .reduce((sum, credit) => sum + credit.amount_cents, 0);
  cancellation.refund_remaining_cents = refundDueRemaining(db, cancellation);
  cancellation.source_number = cancellation.source_type === 'booking'
    ? cancellation.booking_number
    : cancellation.visa_number;
  return cancellation;
}

function getCancellationForSource(db, sourceType, sourceId) {
  const row = db.prepare(
    'SELECT id FROM cancellations WHERE source_type = ? AND source_id = ? AND voided_at IS NULL ORDER BY id DESC LIMIT 1',
  ).get(sourceType, Number(sourceId));
  return row ? getCancellation(db, row.id) : null;
}

function listCancellations(db, { from, to, search, source_type } = {}) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('cc.cancellation_date >= ?');
    params.push(dateISO(from, 'From date'));
  }
  if (to) {
    clauses.push('cc.cancellation_date <= ?');
    params.push(dateISO(to, 'To date'));
  }
  if (source_type) {
    if (!SOURCE_TABLES[source_type]) throw bad('Cancellation source must be a booking or visa application');
    clauses.push('cc.source_type = ?');
    params.push(source_type);
  }
  if (search) {
    clauses.push('(cc.number LIKE ? OR c.name LIKE ? OR bk.number LIKE ? OR vi.number LIKE ? OR cc.reason LIKE ?)');
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`${cancellationSelect} ${where} ORDER BY cc.cancellation_date DESC, cc.id DESC`)
    .all(...params)
    .map((row) => ({
      ...row,
      refund_remaining_cents: refundDueRemaining(db, row),
      source_number: row.source_type === 'booking' ? row.booking_number : row.visa_number,
    }));
}

function reverseInvoiceCredits(db, invoice, entryDate, cancellationNumber) {
  const applications = db.prepare(`
    SELECT ca.*, cn.number AS credit_number
    FROM credit_applications ca
    JOIN credit_notes cn ON cn.id = ca.credit_note_id
    WHERE ca.invoice_id = ?
    ORDER BY ca.id
  `).all(invoice.id);
  for (const application of applications) {
    if (application.journal_entry_id) {
      reverseEntry(db, application.journal_entry_id, {
        entry_date: entryDate,
        memo: `Cancellation ${cancellationNumber} reversed credit ${application.credit_number}`,
        source_type: 'void',
      });
    }
    db.prepare('DELETE FROM credit_applications WHERE id = ?').run(application.id);
    db.prepare(
      'UPDATE credit_notes SET applied_cents = MAX(0, applied_cents - ?) WHERE id = ?',
    ).run(application.amount_cents, application.credit_note_id);
    db.prepare(
      'UPDATE invoices SET credit_applied_cents = MAX(0, credit_applied_cents - ?) WHERE id = ?',
    ).run(application.amount_cents, invoice.id);
  }
}

function normalizeSupplierCredits(db, sourceType, sourceId, values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw bad('Supplier credits must be a list');
  const result = [];
  for (const value of values) {
    const billId = Number(value.bill_id);
    if (!Number.isInteger(billId) || billId <= 0) throw bad('Each supplier credit must choose a bill');
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
    if (!bill) throw bad('Choose a valid supplier bill');
    const linked = sourceType === 'booking' ? bill.booking_id === Number(sourceId) : bill.visa_id === Number(sourceId);
    if (!linked) throw bad(`Bill ${bill.number} does not belong to this ${sourceType}`);
    if (bill.status !== 'received') throw bad(`Only received bills can be credited (${bill.number})`);
    const amount = cents(value.amount_cents ?? 0, `Supplier credit for ${bill.number}`, { min: 0 });
    const existing = db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total
      FROM supplier_credit_notes WHERE bill_id = ? AND status = 'issued'
    `).get(bill.id).total;
    const available = Math.max(0, bill.total_cents - existing);
    if (amount > available) {
      throw bad(`Supplier credit for ${bill.number} cannot exceed the available bill amount of ${(available / 100).toFixed(2)}`);
    }
    if (amount > 0) result.push({ bill, amount_cents: amount });
  }
  return result;
}

function cancelSource(db, { sourceType, sourceId, payload = {} } = {}) {
  if (!['booking', 'visa'].includes(sourceType)) throw bad('Cancellation source must be a booking or visa application');
  return db.transaction(() => {
    const source = sourceRow(db, sourceType, sourceId);
    const expected = 'cancelled';
    if (source.status === 'cancelled' || (sourceType === 'visa' && source.status === 'rejected')) {
      throw bad(sourceType === 'booking' ? 'Booking is already cancelled' : 'Visa application is already cancelled or rejected');
    }
    const existing = db.prepare(
      'SELECT id FROM cancellations WHERE source_type = ? AND source_id = ? AND voided_at IS NULL',
    ).get(sourceType, Number(sourceId));
    if (existing) throw bad('This job already has a cancellation record');

    const cancellationDate = dateISO(payload.cancellation_date || todayISO(), 'Cancellation date');
    const customerCharges = cents(payload.customer_charges_cents ?? 0, 'Cancellation charges', { min: 0 });
    const supplierCredits = normalizeSupplierCredits(db, sourceType, sourceId, payload.supplier_credits);
    const invoiceId = source.invoice_id || null;
    let invoice = invoiceId ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) : null;

    // Drafts have never touched the ledger. There is nothing to reverse.
    if (source.status === 'draft' && !invoice) {
      db.prepare(`UPDATE ${SOURCE_TABLES[sourceType].table} SET status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(expected, Number(sourceId));
      jobs.recordStatus(db, sourceType, sourceId, {
        from: source.status,
        to: expected,
        eventDate: cancellationDate,
        remarks: optionalStr(payload.reason, 'Reason', 500) || 'Draft cancelled before posting',
      });
      audit.record(db, {
        entity_type: sourceType,
        entity_id: Number(sourceId),
        entity_number: source.number || `#${sourceId}`,
        action: 'cancel',
        remarks: optionalStr(payload.reason, 'Reason', 500) || optionalStr(payload.notes, 'Notes', 2000),
        amount_cents: 0,
        metadata: { draft: true },
      });
      return null;
    }

    const number = allocateNumber(db, 'cancellation', cancellationDate);
    const info = db.prepare(`
      INSERT INTO cancellations (
        number, source_type, source_id, cancellation_date, customer_id,
        invoice_id, customer_charges_cents, received_cents, refund_due_cents,
        reason, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(
      number,
      sourceType,
      Number(sourceId),
      cancellationDate,
      source.customer_id,
      invoiceId,
      customerCharges,
      optionalStr(payload.reason, 'Reason', 500),
      optionalStr(payload.notes, 'Notes', 2000),
    );
    const cancellationId = Number(info.lastInsertRowid);
    markCreated(db, 'cancellations', cancellationId);

    let received = 0;
    if (invoice) {
      // Applied customer credits return to their notes so they can be used again.
      reverseInvoiceCredits(db, invoice, cancellationDate, number);
      invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
      received = Math.max(0, invoice.amount_paid_cents);
      if (invoice.status === 'sent') {
        invoiceService.voidInvoiceForCancellation(db, invoice.id, {
          entryDate: cancellationDate,
          memo: `Cancellation ${number} — invoice ${invoice.number}`,
        });
      } else if (invoice.status !== 'void') {
        throw bad('Only sent or void invoices can be part of a cancellation');
      }
    }

    const ar = systemAccount(db, '1100', 'Trade Receivables');
    const refundPayable = systemAccount(db, '2500', 'Refund Liabilities');
    const cancellationIncome = systemAccount(db, '4330', 'Cancellation Fee Income');

    if (received > 0) {
      postEntry(db, {
        entry_date: cancellationDate,
        memo: `Cancellation ${number} — amounts received held as refund payable`,
        reference: number,
        source_type: 'cancellation_received',
        source_id: cancellationId,
        lines: [
          { account_id: ar.id, debit_cents: received, credit_cents: 0, description: `Cancellation ${number}` },
          { account_id: refundPayable.id, debit_cents: 0, credit_cents: received, description: `Cancellation ${number}` },
        ],
      });
    }

    const chargeFromHeld = Math.min(received, customerCharges);
    if (chargeFromHeld > 0) {
      postEntry(db, {
        entry_date: cancellationDate,
        memo: `Cancellation ${number} — cancellation charges`,
        reference: number,
        source_type: 'cancellation_charge',
        source_id: cancellationId,
        lines: [
          { account_id: refundPayable.id, debit_cents: chargeFromHeld, credit_cents: 0, description: `Cancellation ${number}` },
          { account_id: cancellationIncome.id, debit_cents: 0, credit_cents: chargeFromHeld, description: `Cancellation ${number}` },
        ],
      });
    }

    const shortfall = Math.max(0, customerCharges - received);
    let cancellationInvoiceId = null;
    if (shortfall > 0) {
      const cancellationInvoice = invoiceService.createInvoice(db, {
        customer_id: source.customer_id,
        issue_date: cancellationDate,
        due_date: cancellationDate,
        status: 'sent',
        notes: `Cancellation charges for ${number}`,
        items: [{
          description: `Cancellation charges — ${sourceType === 'booking' ? 'booking' : 'visa application'} ${source.number || sourceId}`,
          quantity: 1,
          unit_price_cents: shortfall,
          account_id: cancellationIncome.id,
        }],
      }, { jobInvoice: true });
      cancellationInvoiceId = cancellationInvoice.id;
      db.prepare(`
        UPDATE invoices SET cancellation_id = ?, booking_id = ?, visa_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        cancellationId,
        sourceType === 'booking' ? Number(sourceId) : null,
        sourceType === 'visa' ? Number(sourceId) : null,
        cancellationInvoice.id,
      );
    }

    let supplierCreditTotal = 0;
    for (const credit of supplierCredits) {
      supplierCreditService.createSupplierCreditForCancellation(db, {
        vendor_id: credit.bill.vendor_id,
        bill_id: credit.bill.id,
        booking_id: sourceType === 'booking' ? Number(sourceId) : null,
        visa_id: sourceType === 'visa' ? Number(sourceId) : null,
        cancellation_id: cancellationId,
        credit_date: cancellationDate,
        amount_cents: credit.amount_cents,
        notes: `Cancellation ${number} — credit from bill ${credit.bill.number}`,
      });
      supplierCreditTotal += credit.amount_cents;
    }

    const refundDue = Math.max(0, received - customerCharges);
    db.prepare(`
      UPDATE cancellations SET received_cents = ?, supplier_credit_total_cents = ?,
        refund_due_cents = ?, cancellation_invoice_id = ? WHERE id = ?
    `).run(received, supplierCreditTotal, refundDue, cancellationInvoiceId, cancellationId);

    db.prepare(`UPDATE ${SOURCE_TABLES[sourceType].table} SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(expected, Number(sourceId));
    jobs.recordStatus(db, sourceType, sourceId, {
      from: source.status,
      to: expected,
      eventDate: cancellationDate,
      remarks: [`Cancellation ${number}`, optionalStr(payload.reason, 'Reason', 500)].filter(Boolean).join(' · '),
    });
    audit.record(db, {
      entity_type: 'cancellation',
      entity_id: cancellationId,
      entity_number: number,
      action: 'cancel',
      remarks: optionalStr(payload.reason, 'Reason', 500)
        || optionalStr(payload.notes, 'Notes', 2000)
        || `Cancelled ${sourceType} ${source.number || sourceId}`,
      amount_cents: customerCharges,
      metadata: {
        source_type: sourceType,
        source_id: Number(sourceId),
        received_cents: received,
        refund_due_cents: refundDue,
        supplier_credit_total_cents: supplierCreditTotal,
      },
    });
    return getCancellation(db, cancellationId);
  })();
}

function refundCancellation(db, id, payload = {}) {
  return db.transaction(() => {
    const cancellation = getCancellation(db, id);
    const remaining = cancellation.refund_remaining_cents;
    if (remaining <= 0) throw bad('This cancellation has no refund left to pay');
    const amount = cents(payload.amount_cents == null ? remaining : payload.amount_cents, 'Refund amount', { min: 1 });
    if (amount > remaining) {
      throw bad(`Refund exceeds the remaining cancellation refund of ${(remaining / 100).toFixed(2)}`);
    }
    const refundDate = dateISO(payload.refund_date || todayISO(), 'Refund date');
    if (refundDate < cancellation.cancellation_date) {
      throw bad('Refund date cannot be before the cancellation date');
    }
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payload.account_id));
    if (!account) throw bad('Choose a bank or cash account');
    if (!account.is_active) throw bad('That account is archived');
    if (!isCashAccount(account)) throw bad('Refunds must be paid from a bank or cash account');
    const method = optionalStr(payload.method, 'Refund method', 100) || 'Bank transfer';
    const refundPayable = systemAccount(db, '2500', 'Refund Liabilities');
    const number = allocateNumber(db, 'refund', refundDate);
    const info = db.prepare(`
      INSERT INTO refunds (
        number, refund_type, status, party_id, invoice_id, cancellation_id,
        refund_date, amount_cents, method, reference, notes, account_id
      ) VALUES (?, 'customer', 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      cancellation.customer_id,
      cancellation.invoice_id,
      cancellation.id,
      refundDate,
      amount,
      method,
      optionalStr(payload.reference, 'Reference', 200),
      optionalStr(payload.notes, 'Notes', 1000) || `Cancellation refund ${cancellation.number}`,
      account.id,
    );
    const refundId = Number(info.lastInsertRowid);
    markCreated(db, 'refunds', refundId);
    const entryId = postEntry(db, {
      entry_date: refundDate,
      memo: `Cancellation refund ${number} — ${cancellation.customer_name}`,
      reference: cancellation.number,
      source_type: 'cancellation_refund',
      source_id: refundId,
      lines: [
        { account_id: refundPayable.id, debit_cents: amount, credit_cents: 0, description: `Cancellation ${cancellation.number}` },
        { account_id: account.id, debit_cents: 0, credit_cents: amount, description: `Refund ${number}` },
      ],
    });
    db.prepare('UPDATE refunds SET journal_entry_id = ? WHERE id = ?').run(entryId, refundId);
    return getCancellation(db, cancellation.id);
  })();
}

function convertCancellationToCredit(db, id, payload = {}) {
  return db.transaction(() => {
    const cancellation = getCancellation(db, id);
    creditService.createCreditFromCancellation(db, {
      cancellation_id: cancellation.id,
      amount_cents: payload.amount_cents == null
        ? cancellation.refund_remaining_cents
        : payload.amount_cents,
      credit_date: payload.credit_date || cancellation.cancellation_date,
      notes: payload.notes,
    });
    return getCancellation(db, cancellation.id);
  })();
}

// Undoing a cancellation (or a rejection under the old note) entered by
// mistake: admin only (see permissions.js). Everything the note did is
// reversed: refunds paid and credit notes made from it, its charges invoice,
// the supplier credits it raised and its own entries. The original invoice
// comes back with its payments, and the booking or visa returns to the status
// it had before. Credits that were applied to the original invoice were
// released at cancellation; they stay free to apply again. The note is kept,
// marked void with its amounts cleared (the audit log keeps them).
function voidCancellation(db, id, payload = {}) {
  const refundService = require('./refunds');
  return db.transaction(() => {
    const note = db.prepare('SELECT * FROM cancellations WHERE id = ?').get(Number(id));
    if (!note) throw notFound('Cancellation not found');
    if (note.voided_at) throw bad('This cancellation note is already void');
    const remarks = str(payload.remarks ?? payload.reason, 'Reason', { max: 500 });
    const why = `${remarks} · void ${note.number}`;
    const job = sourceRow(db, note.source_type, note.source_id);
    if (job.voided_at) throw bad('The booking or visa of this note is void');

    const refunds = db.prepare("SELECT id FROM refunds WHERE cancellation_id = ? AND status = 'paid' ORDER BY id").all(note.id);
    for (const refund of refunds) refundService.voidRefund(db, refund.id, { remarks: why });
    const credits = db.prepare("SELECT id FROM credit_notes WHERE cancellation_id = ? AND status = 'issued' ORDER BY id").all(note.id);
    for (const credit of credits) creditService.voidCredit(db, credit.id, { remarks: why });

    const charges = note.cancellation_invoice_id
      ? db.prepare('SELECT id, status FROM invoices WHERE id = ?').get(note.cancellation_invoice_id)
      : null;
    if (charges && charges.status === 'sent') invoiceService.voidInvoice(db, charges.id, { remarks: why }, { fromWorkflow: true });

    const supplierCredits = db.prepare("SELECT id FROM supplier_credit_notes WHERE cancellation_id = ? AND status = 'issued' ORDER BY id").all(note.id);
    for (const credit of supplierCredits) supplierCreditService.voidSupplierCredit(db, credit.id, { remarks: why });

    // The note's own entries: money held as refund payable, and the charges.
    const entries = db.prepare(`
      SELECT id FROM journal_entries
      WHERE source_type IN ('cancellation_received', 'cancellation_charge') AND source_id = ?
        AND id NOT IN (SELECT reversal_of_id FROM journal_entries WHERE reversal_of_id IS NOT NULL)
      ORDER BY id
    `).all(note.id);
    for (const entry of entries) reverseEntry(db, entry.id, { memo: `Void ${note.number}`, source_type: 'void' });

    // The original invoice, if this note voided it.
    let restored = null;
    const invoice = note.invoice_id ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(note.invoice_id) : null;
    if (invoice && invoice.status === 'void' && invoice.journal_entry_id) {
      const reversal = db.prepare(`
        SELECT id FROM journal_entries WHERE reversal_of_id = ? AND memo LIKE ? ORDER BY id DESC LIMIT 1
      `).get(invoice.journal_entry_id, `Cancellation ${note.number}%`);
      if (reversal) {
        reverseEntry(db, reversal.id, { memo: `Restore invoice ${invoice.number} · void ${note.number}`, source_type: 'void' });
        db.prepare(`UPDATE invoices SET status = 'sent', updated_at = datetime('now') WHERE id = ?`).run(invoice.id);
        restored = invoice.number;
      }
    }

    // Back to the status the job had before it was cancelled.
    const before = db.prepare(`
      SELECT from_status FROM job_status_history
      WHERE source_type = ? AND source_id = ? AND to_status = ? ORDER BY id DESC LIMIT 1
    `).get(note.source_type, job.id, job.status);
    const previous = before?.from_status && before.from_status !== 'draft'
      ? before.from_status
      : (note.source_type === 'booking' ? 'confirmed' : 'submitted');
    db.prepare(`UPDATE ${SOURCE_TABLES[note.source_type].table} SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(previous, job.id);
    jobs.recordStatus(db, note.source_type, job.id, { from: job.status, to: previous, eventDate: todayISO(), remarks: `Void ${note.number} · ${remarks}` });

    db.prepare(`
      UPDATE cancellations SET voided_at = datetime('now'), void_remarks = ?, customer_charges_cents = 0,
        received_cents = 0, refund_due_cents = 0, supplier_credit_total_cents = 0
      WHERE id = ?
    `).run(remarks, note.id);
    audit.record(db, {
      entity_type: 'cancellation',
      entity_id: note.id,
      entity_number: note.number,
      action: 'void',
      remarks,
      amount_cents: note.customer_charges_cents,
      metadata: {
        source_type: note.source_type,
        source_id: job.id,
        status_restored: previous,
        invoice_restored: restored,
        customer_charges_cents: note.customer_charges_cents,
        received_cents: note.received_cents,
        refund_due_cents: note.refund_due_cents,
        refunds_voided: refunds.length,
        credit_notes_voided: credits.length,
        supplier_credits_voided: supplierCredits.length,
        charges_invoice_voided: Boolean(charges && charges.status === 'sent'),
      },
    });
    return getCancellation(db, note.id);
  })();
}

module.exports = {
  voidCancellation,
  cancelSource,
  getCancellation,
  getCancellationForSource,
  listCancellations,
  refundCancellation,
  convertCancellationToCredit,
};
