'use strict';

// Shared rules for travel jobs (bookings and visa applications): line
// validation, posting the customer invoice and supplier bills, default due
// dates and the status history. Keeping one copy stops the two job types from
// drifting apart.

const {
  bad,
  str,
  optionalStr,
  num,
  cents,
  addDays,
  todayISO,
} = require('../util');
const { isPurchaseAccount, getSettings, invoiceDisplayStatus, invoiceBalanceCents } = require('../accounting');
const invoiceService = require('./invoices');
const billService = require('./bills');
const portalService = require('./portals');

const JOBS = {
  booking: { itemsTable: 'booking_items', fkColumn: 'booking_id', label: 'booking' },
  visa: { itemsTable: 'visa_items', fkColumn: 'visa_id', label: 'visa application' },
};

function jobConfig(sourceType) {
  const config = JOBS[sourceType];
  if (!config) throw new Error(`Unknown job type: ${sourceType}`);
  return config;
}

function normalizeJobItems(db, items, itemType) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const isSale = itemType === 'sale';
    const label = `${isSale ? 'Sale' : 'Cost'} line ${index + 1}`;
    const description = str(item.description, `${label} description`, { max: 300 });
    const quantity = num(item.quantity ?? 1, `${label} quantity`, { min: 0.0001, max: 1_000_000 });
    const unitPrice = cents(item.unit_price_cents, `${label} unit price`);
    // A supplier bill cannot be posted for nothing, so a zero cost line would
    // only fail later at confirmation with a vague message.
    if (!isSale && unitPrice <= 0) {
      throw bad(`${label}: enter a cost greater than zero, or remove the line`);
    }
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(item.account_id));
    if (!account) throw bad(`${label}: choose an account`);
    if (!account.is_active) throw bad(`${label}: account "${account.name}" is archived`);
    if (isSale && account.type !== 'revenue') throw bad(`${label}: choose a revenue account`);
    if (!isSale && !isPurchaseAccount(account)) {
      throw bad(`${label}: choose an expense account or a valid non-cash asset`);
    }

    let vendorId = null;
    if (!isSale) {
      const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(item.vendor_id));
      if (!vendor) throw bad(`${label}: choose a supplier`);
      if (!vendor.is_active) throw bad(`${label}: supplier "${vendor.name}" is archived`);
      vendorId = vendor.id;
    }

    return {
      item_type: itemType,
      description,
      quantity,
      unit_price_cents: unitPrice,
      amount_cents: Math.round(quantity * unitPrice),
      account_id: account.id,
      vendor_id: vendorId,
      supplier_ref: optionalStr(item.supplier_ref, `${label} supplier reference`, 120),
      passenger_name: optionalStr(item.passenger_name, `${label} passenger name`, 160),
      line_group: Number.isInteger(Number(item.line_group)) && Number(item.line_group) > 0 ? Number(item.line_group) : null,
    };
  });
}

function insertJobItems(db, sourceType, jobId, saleItems, costItems) {
  const { itemsTable, fkColumn } = jobConfig(sourceType);
  const insert = db.prepare(`
    INSERT INTO ${itemsTable} (${fkColumn}, item_type, description, quantity, unit_price_cents,
      amount_cents, account_id, vendor_id, supplier_ref, passenger_name, line_group, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  saleItems.forEach((item, index) => {
    insert.run(jobId, 'sale', item.description, item.quantity, item.unit_price_cents,
      item.amount_cents, item.account_id, null, item.supplier_ref, item.passenger_name || '', item.line_group ?? null, index);
  });
  costItems.forEach((item, index) => {
    insert.run(jobId, 'cost', item.description, item.quantity, item.unit_price_cents,
      item.amount_cents, item.account_id, item.vendor_id, item.supplier_ref, item.passenger_name || '', item.line_group ?? null, index);
  });
}

// The due date defaults to the company payment terms, like a direct invoice.
function defaultDueDate(db, issueDate) {
  const days = Number(getSettings(db)?.payment_terms_days ?? 0);
  return addDays(issueDate, Number.isFinite(days) && days > 0 ? days : 0);
}

// Confirming a booking or submitting a visa posts the customer invoice and one
// bill per supplier, then settles prepaid-portal bills from the wallet.
function postJobDocuments(db, {
  sourceType,
  jobId,
  customerId,
  issueDate,
  dueDate,
  invoiceNotes,
  invoiceTerms,
  billNotes,
  items,
  lineLabel = '',
  autoSettle = true,
}) {
  const { fkColumn, label } = jobConfig(sourceType);
  // Passenger rows print as "Dubai–London return · Emirates – Ali Khan".
  const describe = (item) => (item.passenger_name
    ? [String(lineLabel || '').trim(), item.passenger_name].filter(Boolean).join(' – ')
    : item.description);
  const saleItems = items.filter((item) => item.item_type === 'sale');
  const costItems = items.filter((item) => item.item_type === 'cost');
  if (!saleItems.length) throw bad(`Add sale items before posting this ${label}`);
  costItems.forEach((item, index) => {
    if (item.unit_price_cents <= 0 || item.amount_cents <= 0) {
      throw bad(`Cost line ${index + 1} ("${item.description}") has no cost. Edit the ${label} and enter the supplier cost, or remove the line.`);
    }
  });

  const invoice = invoiceService.createInvoice(db, {
    customer_id: customerId,
    issue_date: issueDate,
    due_date: dueDate || issueDate,
    notes: invoiceNotes || '',
    terms: invoiceTerms || '',
    status: 'sent',
    items: saleItems.map((item) => ({
      description: describe(item),
      quantity: item.quantity,
      unit_price_cents: item.unit_price_cents,
      account_id: item.account_id,
    })),
  }, { jobInvoice: true });
  db.prepare(`UPDATE invoices SET ${fkColumn} = ? WHERE id = ?`).run(jobId, invoice.id);

  const groups = new Map();
  for (const item of costItems) {
    if (!item.vendor_id) continue;
    if (!groups.has(item.vendor_id)) groups.set(item.vendor_id, []);
    groups.get(item.vendor_id).push(item);
  }
  for (const [vendorId, vendorItems] of groups.entries()) {
    const bill = billService.createBill(db, {
      vendor_id: vendorId,
      bill_date: issueDate,
      due_date: dueDate || issueDate,
      notes: billNotes,
      status: 'received',
      items: vendorItems.map((item) => ({
        description: describe(item),
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        account_id: item.account_id,
      })),
    });
    db.prepare(`UPDATE bills SET ${fkColumn} = ? WHERE id = ?`).run(jobId, bill.id);
    const portal = portalService.portalForVendor(db, vendorId);
    if (portal) {
      db.prepare('UPDATE bills SET portal_id = ? WHERE id = ?').run(portal.id, bill.id);
    }
  }

  // Prepaid portals settle their supplier's bill straight away from the balance.
  // A correction settles only what is left after the old payments move across.
  const warnings = [];
  if (!autoSettle) return { invoice, warnings };
  const jobBills = db.prepare(`SELECT id, number FROM bills WHERE ${fkColumn} = ? AND status = 'received'`).all(jobId);
  for (const bill of jobBills) {
    let settled;
    try {
      settled = portalService.autoSettleBill(db, bill.id, issueDate);
    } catch (error) {
      warnings.push(`Bill ${bill.number}: ${error.message}`);
      continue;
    }
    if (settled && settled.shortfall_cents > 0) {
      const short = (settled.shortfall_cents / 100).toFixed(2);
      warnings.push(settled.settled_cents > 0
        ? `Portal "${settled.portal_name}" had only part of the amount for bill ${bill.number}. ${short} is still payable.`
        : `Portal "${settled.portal_name}" has no balance for bill ${bill.number}. ${short} is still payable.`);
    }
  }
  return { invoice, warnings };
}

// Status history: when a job moved between statuses, and why.
function recordStatus(db, sourceType, jobId, { from = null, to, eventDate = todayISO(), remarks = '' } = {}) {
  jobConfig(sourceType);
  db.prepare(`
    INSERT INTO job_status_history (source_type, source_id, from_status, to_status, event_date, remarks)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sourceType, Number(jobId), from, to, eventDate, String(remarks || '').slice(0, 500));
}

function statusHistory(db, sourceType, jobId) {
  return db.prepare(`
    SELECT id, from_status, to_status, event_date, remarks, created_at
    FROM job_status_history
    WHERE source_type = ? AND source_id = ?
    ORDER BY created_at, id
  `).all(sourceType, Number(jobId));
}

function deleteStatusHistory(db, sourceType, jobId) {
  db.prepare('DELETE FROM job_status_history WHERE source_type = ? AND source_id = ?')
    .run(sourceType, Number(jobId));
}

// Columns a booking or visa list query selects from its invoice (alias pi).
const JOB_INVOICE_COLUMNS = `
  pi.status AS pay_invoice_status, pi.total_cents AS pay_total_cents,
  pi.amount_paid_cents AS pay_paid_cents, pi.credit_applied_cents AS pay_credit_cents,
  pi.due_date AS pay_due_date`;

// Paid / partial / unpaid / overdue for a booking or visa, from its invoice.
// Drafts are not invoiced yet; cancelled and rejected jobs have none to collect.
function jobPaymentStatus(job, closedStatuses = []) {
  const { pay_invoice_status: status, pay_total_cents: total, pay_paid_cents: paid,
    pay_credit_cents: credit, pay_due_date: due, ...rest } = job;
  let paymentStatus = null;
  let balance = 0;
  if (!closedStatuses.includes(job.status)) {
    if (!job.invoice_id || !status) {
      paymentStatus = 'not_invoiced';
    } else if (status !== 'void') {
      const invoice = { status, total_cents: total, amount_paid_cents: paid, credit_applied_cents: credit, due_date: due };
      const display = invoiceDisplayStatus(invoice);
      paymentStatus = display === 'sent' ? 'unpaid' : display;
      balance = invoiceBalanceCents(invoice);
    }
  }
  return { ...rest, payment_status: paymentStatus, payment_balance_cents: balance };
}

// Open advances recorded on the job pay its new invoice straight away, in the
// order they were received, up to the invoice total. Each is dated the later
// of the invoice date and the advance date.
function applyOpenAdvances(db, sourceType, jobId, invoice) {
  const column = sourceType === 'booking' ? 'booking_id' : 'visa_id';
  const advances = db.prepare(`
    SELECT * FROM customer_advances
    WHERE ${column} = ? AND voided_at IS NULL AND amount_cents - applied_cents - refunded_cents > 0
    ORDER BY advance_date, id
  `).all(Number(jobId));
  const advanceService = require('./advances');
  const applied = [];
  for (const advance of advances) {
    const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
    if (invoiceBalanceCents(fresh) <= 0) break;
    const paymentDate = advance.advance_date > fresh.issue_date ? advance.advance_date : fresh.issue_date;
    const result = advanceService.applyAdvance(db, advance.id, { invoice_id: invoice.id, payment_date: paymentDate });
    applied.push({ number: advance.number, amount_cents: result.applied_cents });
  }
  return applied;
}

module.exports = {
  applyOpenAdvances,
  JOB_INVOICE_COLUMNS,
  jobPaymentStatus,
  normalizeJobItems,
  insertJobItems,
  defaultDueDate,
  postJobDocuments,
  recordStatus,
  statusHistory,
  deleteStatusHistory,
};
