'use strict';

// Correcting a posted booking or visa (admin only; see permissions.js): wrong
// fares, fees, costs, lines or suppliers. The job keeps its number and status.
// Its invoice and supplier bills are reversed on their own dates and voided;
// the corrected lines are written and new documents posted on the job's date.
// Payments, applied credits, refunds and deposit steps on the old invoice move
// to the new one, and each old bill's payments and credits move to the new
// bill of the same supplier, all unchanged, so receipt and payment numbers
// stay the same. A prepaid portal then settles only what is still due.
// Everything happens in one database transaction: if any check fails,
// nothing changes.

const { bad, notFound, str } = require('../util');
const { reverseEntry } = require('../accounting');
const { reverseOnOriginalDate } = require('./corrections');
const audit = require('./audit');
const { moveLinks } = require('./document-moves');
const jobs = require('./jobs');
const workflows = require('../workflows');

const JOBS = {
  booking: {
    table: 'bookings',
    column: 'booking_id',
    label: 'booking',
    date: 'booking_date',
    write: (db, job, values) => require('./bookings').writeBooking(db, job, values),
    post: (db, job) => require('./bookings').postBookingDocuments(db, job, { autoSettle: false }),
    get: (db, id) => require('./bookings').getBooking(db, id),
  },
  visa: {
    table: 'visa_applications',
    column: 'visa_id',
    label: 'visa application',
    date: 'application_date',
    write: (db, job, values) => require('./visas').writeVisa(db, job, values),
    post: (db, job) => require('./visas').postVisaDocuments(db, job, { autoSettle: false }),
    get: (db, id) => require('./visas').getVisa(db, id),
  },
};

// Reverses a posted invoice or bill on its own date and voids it.
function retire(db, table, row, dateField, reason) {
  if (row.journal_entry_id) {
    reverseEntry(db, row.journal_entry_id, { entry_date: row[dateField], memo: `Corrected · ${reason} · ${row.number}`, source_type: 'void' });
    reverseOnOriginalDate(db, row.journal_entry_id);
  }
  db.prepare(`UPDATE ${table} SET status = 'void', amount_paid_cents = 0, credit_applied_cents = 0, updated_at = datetime('now') WHERE id = ?`).run(row.id);
}

const money = (cents) => (cents / 100).toFixed(2);

function correctJob(db, sourceType, jobId, payload = {}) {
  const config = JOBS[sourceType];
  if (!config) throw bad('Only bookings and visas are corrected here');
  const portals = require('./portals');
  return db.transaction(() => {
    const job = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(Number(jobId));
    if (!job) throw notFound(`The ${config.label} was not found`);
    if (job.voided_at) throw bad(`This ${config.label} is void`);
    if (job.status === 'draft') throw bad(`A draft ${config.label} is edited, not corrected`);
    const note = db.prepare(`
      SELECT number FROM cancellations WHERE source_type = ? AND source_id = ? AND voided_at IS NULL
    `).get(sourceType, job.id);
    if (note) throw bad(`This ${config.label} has cancellation note ${note.number}. Void the note first.`);
    workflows.assertCan(sourceType, 'correct', job);
    const reason = str(payload.remarks ?? payload.reason, 'Reason', { max: 500 });
    const values = payload.values && typeof payload.values === 'object' ? payload.values : {};

    const invoice = job.invoice_id ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(job.invoice_id) : null;
    if (!invoice || invoice.status !== 'sent') throw bad(`The invoice of this ${config.label} is not open`);
    const invoiceSettled = invoice.amount_paid_cents + invoice.credit_applied_cents;
    const customerId = values.customer_id === undefined ? job.customer_id : Number(values.customer_id);
    if (invoiceSettled > 0 && customerId !== invoice.customer_id) {
      throw bad(`Payments and credits on ${invoice.number} belong to its customer. Void them before changing the customer.`);
    }
    const oldBills = db.prepare(`SELECT * FROM bills WHERE ${config.column} = ? AND status = 'received' ORDER BY id`).all(job.id);

    retire(db, 'invoices', invoice, 'issue_date', reason);
    for (const bill of oldBills) retire(db, 'bills', bill, 'bill_date', reason);

    config.write(db, job, values);
    const updated = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(job.id);
    const { invoice: created } = config.post(db, updated);
    db.prepare(`UPDATE ${config.table} SET invoice_id = ?, updated_at = datetime('now') WHERE id = ?`).run(created.id, job.id);

    if (created.total_cents < invoiceSettled) {
      throw bad(`The new total (${money(created.total_cents)}) is less than what was paid or credited on ${invoice.number} (${money(invoiceSettled)}). Refund or void a payment first.`);
    }
    moveLinks(db, 'invoice', invoice.id, created.id);
    db.prepare('UPDATE invoices SET amount_paid_cents = ?, credit_applied_cents = ? WHERE id = ?')
      .run(invoice.amount_paid_cents, invoice.credit_applied_cents, created.id);

    const oldIds = new Set(oldBills.map((bill) => bill.id));
    const newBills = db.prepare(`SELECT * FROM bills WHERE ${config.column} = ? AND status = 'received' ORDER BY id`).all(job.id)
      .filter((bill) => !oldIds.has(bill.id));
    for (const old of oldBills) {
      const settled = old.amount_paid_cents + old.credit_applied_cents;
      const linked = settled > 0 || db.prepare("SELECT 1 FROM supplier_credit_notes WHERE bill_id = ? AND status = 'issued'").get(old.id);
      const target = newBills.find((bill) => bill.vendor_id === old.vendor_id);
      if (!target) {
        if (linked) {
          const vendor = db.prepare('SELECT name FROM vendors WHERE id = ?').get(old.vendor_id)?.name || 'that supplier';
          throw bad(`Bill ${old.number} for ${vendor} has payments or credits. Keep a cost line for ${vendor}, or void them first.`);
        }
        continue;
      }
      if (target.total_cents < settled) {
        throw bad(`The new cost for bill ${old.number} (${money(target.total_cents)}) is less than what was paid or credited (${money(settled)}). Void a payment first.`);
      }
      moveLinks(db, 'bill', old.id, target.id);
      db.prepare('UPDATE bills SET amount_paid_cents = amount_paid_cents + ?, credit_applied_cents = credit_applied_cents + ? WHERE id = ?')
        .run(old.amount_paid_cents, old.credit_applied_cents, target.id);
    }
    // A prepaid portal settles what is still due on the new bills.
    for (const bill of newBills) {
      try {
        portals.autoSettleBill(db, bill.id, updated[config.date]);
      } catch {
        // Not enough in the wallet: the rest stays payable, as when posting.
      }
    }

    jobs.recordStatus(db, sourceType, job.id, { from: job.status, to: job.status, remarks: `Corrected · ${reason}` });
    audit.record(db, {
      entity_type: sourceType,
      entity_id: job.id,
      entity_number: job.number,
      action: 'correct',
      remarks: `${job.number} · invoice ${invoice.number} → ${created.number} · ${reason}`,
      amount_cents: created.total_cents,
      metadata: {
        invoice_before: invoice.number,
        invoice_after: created.number,
        total_before: invoice.total_cents,
        total_after: created.total_cents,
        bills_before: oldBills.map((bill) => bill.number),
        bills_after: newBills.map((bill) => bill.number),
      },
    });
    return config.get(db, job.id);
  })();
}

module.exports = { correctJob };
