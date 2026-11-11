'use strict';

// Voiding a booking or visa that was entered by mistake (admin only; see
// permissions.js). It is not a cancellation: no cancellation note, no
// charges. Everything the job posted is reversed: its refund credit notes,
// its invoice with the payments and credits on it, its supplier credits and
// its supplier bills with their payments. The job keeps its number with the
// status "cancelled" and voided_at set, which the app shows as Void and the
// reports leave out, like a job whose documents were all reversed.
//
// A job that was cancelled (or rejected under the old note) has a
// cancellation note: void that note first (cancellations.voidCancellation),
// which puts the job back to where it was.

const { bad, notFound, str, todayISO } = require('../util');
const audit = require('./audit');
const jobs = require('./jobs');
const workflows = require('../workflows');

const JOBS = {
  booking: { table: 'bookings', column: 'booking_id', label: 'booking' },
  visa: { table: 'visa_applications', column: 'visa_id', label: 'visa application' },
};

function voidJob(db, sourceType, jobId, payload = {}) {
  const config = JOBS[sourceType];
  if (!config) throw bad('Only bookings and visas can be voided here');
  const invoices = require('./invoices');
  const bills = require('./bills');
  const credits = require('./credits');
  const supplierCredits = require('./supplier-credits');
  return db.transaction(() => {
    const job = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(Number(jobId));
    if (!job) throw notFound(`The ${config.label} was not found`);
    if (job.voided_at) throw bad(`This ${config.label} is already void`);
    if (job.status === 'draft') throw bad(`A draft ${config.label} has posted nothing: delete it instead`);
    const note = db.prepare(`
      SELECT number FROM cancellations WHERE source_type = ? AND source_id = ? AND voided_at IS NULL
    `).get(sourceType, job.id);
    if (note) throw bad(`Void cancellation note ${note.number} first; that puts the ${config.label} back as it was`);
    workflows.assertCan(sourceType, 'void', job);
    if (sourceType === 'visa') {
      const deposit = db.prepare('SELECT number FROM visa_deposits WHERE visa_id = ? AND voided_at IS NULL').get(job.id);
      if (deposit) throw bad(`Security deposit ${deposit.number} belongs to this visa. Settle or void it first.`);
    }
    const remarks = str(payload.remarks ?? payload.reason, 'Reason', { max: 500 });
    const why = `${remarks} · void ${job.number}`;

    const creditNotes = db.prepare(`SELECT id FROM credit_notes WHERE ${config.column} = ? AND status = 'issued' ORDER BY id`).all(job.id);
    for (const credit of creditNotes) credits.voidCredit(db, credit.id, { remarks: why });

    const invoice = job.invoice_id ? db.prepare('SELECT id, status FROM invoices WHERE id = ?').get(job.invoice_id) : null;
    if (invoice && invoice.status === 'sent') invoices.voidInvoice(db, invoice.id, { remarks: why }, { fromWorkflow: true });

    // Supplier credits of the job (named on it, or raised on one of its bills).
    const supplierCreditNotes = db.prepare(`
      SELECT scn.id FROM supplier_credit_notes scn LEFT JOIN bills b ON b.id = scn.bill_id
      WHERE scn.status = 'issued' AND COALESCE(scn.${config.column}, b.${config.column}) = ?
      ORDER BY scn.id
    `).all(job.id);
    for (const credit of supplierCreditNotes) supplierCredits.voidSupplierCredit(db, credit.id, { remarks: why });

    const jobBills = db.prepare(`SELECT id FROM bills WHERE ${config.column} = ? AND status = 'received' ORDER BY id`).all(job.id);
    for (const bill of jobBills) bills.voidBill(db, bill.id, { remarks: why }, { fromWorkflow: true });

    db.prepare(`
      UPDATE ${config.table} SET status = 'cancelled', voided_at = datetime('now'), void_remarks = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(remarks, job.id);
    jobs.recordStatus(db, sourceType, job.id, { from: job.status, to: 'void', eventDate: todayISO(), remarks });
    audit.record(db, {
      entity_type: sourceType,
      entity_id: job.id,
      entity_number: job.number,
      action: 'void',
      remarks,
      amount_cents: job.sale_total_cents || 0,
      metadata: {
        invoice_voided: Boolean(invoice && invoice.status === 'sent'),
        bills_voided: jobBills.length,
        credit_notes_voided: creditNotes.length,
        supplier_credits_voided: supplierCreditNotes.length,
      },
    });
    return job.id;
  })();
}

module.exports = { voidJob };
