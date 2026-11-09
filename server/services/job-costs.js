'use strict';

// Reports value a booking or visa from what was actually posted, not from the
// lines typed on the draft:
//   sale  = the job's invoice total (the sale lines, locked at confirmation)
//   cost  = received supplier bills − supplier credits recorded against them
// Drafts have posted nothing and stay out of margin reporting. Jobs cancelled
// before cancellation notes existed had every document reversed, so they are
// excluded too. Cancelled jobs with a note show their charges and retained cost.
// Refunds to the customer on a visa (credit notes) lower its sale.

const COLUMNS = { booking: 'booking_id', visa: 'visa_id' };

function columnFor(sourceType) {
  const column = COLUMNS[sourceType];
  if (!column) throw new Error(`Unknown job type: ${sourceType}`);
  return column;
}

// A supplier credit belongs to the job it names, or else to the job of the
// bill it was raised against.
function creditJobSql(column) {
  return `COALESCE(scn.${column}, b.${column})`;
}

function jobCostMap(db, sourceType) {
  const column = columnFor(sourceType);
  const costs = new Map();
  for (const row of db.prepare(`
    SELECT ${column} AS job_id, COALESCE(SUM(total_cents), 0) AS total
    FROM bills
    WHERE ${column} IS NOT NULL AND status = 'received'
    GROUP BY ${column}
  `).all()) {
    costs.set(row.job_id, row.total);
  }
  for (const row of db.prepare(`
    SELECT ${creditJobSql(column)} AS job_id, COALESCE(SUM(scn.amount_cents), 0) AS total
    FROM supplier_credit_notes scn
    LEFT JOIN bills b ON b.id = scn.bill_id
    WHERE scn.status = 'issued' AND ${creditJobSql(column)} IS NOT NULL
    GROUP BY job_id
  `).all()) {
    costs.set(row.job_id, (costs.get(row.job_id) || 0) - row.total);
  }
  for (const [jobId, total] of costs) costs.set(jobId, Math.max(0, total));
  return costs;
}

function jobCostCents(db, sourceType, jobId) {
  const column = columnFor(sourceType);
  const id = Number(jobId);
  if (!id) return 0;
  const bills = db.prepare(`
    SELECT COALESCE(SUM(total_cents), 0) AS total FROM bills
    WHERE ${column} = ? AND status = 'received'
  `).get(id).total;
  const credits = db.prepare(`
    SELECT COALESCE(SUM(scn.amount_cents), 0) AS total
    FROM supplier_credit_notes scn
    LEFT JOIN bills b ON b.id = scn.bill_id
    WHERE scn.status = 'issued' AND ${creditJobSql(column)} = ?
  `).get(id).total;
  return Math.max(0, bills - credits);
}

function cancellationMap(db, sourceType) {
  const map = new Map();
  for (const row of db.prepare(`
    SELECT * FROM cancellations WHERE source_type = ? ORDER BY id
  `).all(sourceType)) {
    map.set(row.source_id, row);
  }
  return map;
}

// Refunds given to the customer on each visa (credit notes linked to it).
// Bookings have none.
function customerRefundMap(db, sourceType) {
  const map = new Map();
  if (sourceType !== 'visa') return map;
  for (const row of db.prepare(`
    SELECT visa_id, SUM(amount_cents) AS total FROM credit_notes
    WHERE visa_id IS NOT NULL AND status = 'issued' GROUP BY visa_id
  `).all()) map.set(row.visa_id, row.total);
  return map;
}

function supplierCreditMap(db, sourceType) {
  const column = columnFor(sourceType);
  const map = new Map();
  for (const row of db.prepare(`
    SELECT ${creditJobSql(column)} AS job_id, SUM(scn.amount_cents) AS total
    FROM supplier_credit_notes scn LEFT JOIN bills b ON b.id = scn.bill_id
    WHERE scn.status = 'issued' AND ${creditJobSql(column)} IS NOT NULL GROUP BY job_id
  `).all()) map.set(row.job_id, row.total);
  return map;
}

// What a job really made once money went back: after a cancellation, what
// was kept; otherwise the sale less refunds to the customer. Cost is the bills
// less refunds from the supplier. Added as `result` (with `margin_cents` set
// to the real profit) only where it differs from the typed lines.
function withActualResult(db, sourceType, jobs) {
  const notes = cancellationMap(db, sourceType);
  const refunds = customerRefundMap(db, sourceType);
  const credits = supplierCreditMap(db, sourceType);
  if (!jobs.some((job) => notes.has(job.id) || refunds.has(job.id) || credits.has(job.id))) return jobs;
  const costs = jobCostMap(db, sourceType);
  return jobs.map((job) => {
    const note = notes.get(job.id);
    if (!note && !refunds.has(job.id) && !credits.has(job.id)) return job;
    const sale = note ? note.customer_charges_cents : job.sale_total_cents - (refunds.get(job.id) || 0);
    const cost = costs.get(job.id) || 0;
    return { ...job, result: { sale_cents: sale, cost_cents: cost, margin_cents: sale - cost }, margin_cents: sale - cost };
  });
}

// Returns the jobs that belong in margin reporting, each with sale, cost and
// margin taken from the ledger documents. Jobs left out are dropped.
function valueJobs(db, sourceType, jobs) {
  const costs = jobCostMap(db, sourceType);
  const cancellations = cancellationMap(db, sourceType);
  const refunds = customerRefundMap(db, sourceType);
  // A visa rejected without a note keeps its invoice and its sale.
  const keptRejections = sourceType === 'visa'
    ? new Set(db.prepare(`
      SELECT v.id FROM visa_applications v JOIN invoices i ON i.id = v.invoice_id
      WHERE v.status = 'rejected' AND i.status = 'sent'
    `).all().map((row) => row.id))
    : new Set();
  const result = [];
  for (const job of jobs) {
    if (job.status === 'draft') continue;
    const cost = costs.get(job.id) || 0;
    const cancellation = cancellations.get(job.id);
    if (cancellation) {
      const charges = cancellation.customer_charges_cents;
      result.push({
        ...job,
        cancellation_id: cancellation.id,
        cancellation_number: cancellation.number,
        cancellation_date: cancellation.cancellation_date,
        original_sale_total_cents: job.sale_total_cents,
        original_cost_total_cents: job.cost_total_cents,
        sale_total_cents: charges,
        cost_total_cents: cost,
        customer_charges_cents: charges,
        retained_cost_cents: cost,
        refund_due_cents: cancellation.refund_due_cents,
        is_cancelled: true,
        margin_cents: charges - cost,
      });
      continue;
    }
    if (job.status === 'cancelled' || (job.status === 'rejected' && !keptRejections.has(job.id))) continue;
    const refunded = refunds.get(job.id) || 0;
    const sale = job.sale_total_cents - refunded;
    result.push({
      ...job,
      planned_cost_total_cents: job.cost_total_cents,
      ...(refunded ? { original_sale_total_cents: job.sale_total_cents, refunded_cents: refunded } : {}),
      sale_total_cents: sale,
      cost_total_cents: cost,
      margin_cents: sale - cost,
    });
  }
  return result;
}

module.exports = {
  withActualResult,
  jobCostMap,
  jobCostCents,
  valueJobs,
};
