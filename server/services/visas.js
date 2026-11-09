'use strict';

const {
  bad,
  notFound,
  optionalStr,
  num,
  dateISO,
  todayISO,
  isTruthy,
} = require('../util');
const { allocateNumber } = require('./numbering');
const { markCreated } = require('../created-by');
const cancellationService = require('./cancellations');
const jobs = require('./jobs');
const jobCosts = require('./job-costs');
const audit = require('./audit');

const VISA_TYPES = ['tourist', 'visit', 'business', 'transit', 'student', 'work', 'other'];
const OPEN_STATUSES = ['draft', 'submitted', 'approved'];

const visaSelect = `
  SELECT v.*, c.name AS customer_name, c.email AS customer_email,
         c.phone AS customer_phone, c.address AS customer_address,
         g.number AS group_number,
         (SELECT COUNT(*) FROM visa_applications x WHERE x.group_id = v.group_id) AS group_size,
         ${jobs.JOB_INVOICE_COLUMNS}
  FROM visa_applications v
  JOIN customers c ON c.id = v.customer_id
  LEFT JOIN visa_groups g ON g.id = v.group_id
  LEFT JOIN invoices pi ON pi.id = v.invoice_id
`;

function itemTotals(items) {
  return items.reduce((sum, item) => sum + item.amount_cents, 0);
}

function addMonthsISO(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Most embassies want a passport valid for six months after travel. This is a
// warning only: the application can still be saved and submitted.
function passportWarning(visa) {
  if (!visa.passport_expiry) return null;
  const reference = visa.travel_date || visa.application_date;
  if (!reference) return null;
  if (visa.passport_expiry < reference) {
    return `The passport expired on ${visa.passport_expiry}, before the ${visa.travel_date ? 'travel' : 'application'} date.`;
  }
  const required = addMonthsISO(reference, 6);
  if (visa.passport_expiry < required) {
    return `The passport expires on ${visa.passport_expiry}, less than 6 months after the ${visa.travel_date ? 'travel' : 'application'} date. Many embassies refuse such passports.`;
  }
  return null;
}

function serializeVisa(row) {
  const visa = jobs.jobPaymentStatus(row, ['cancelled']);
  return {
    ...visa,
    margin_cents: visa.sale_total_cents - visa.cost_total_cents,
    status_display: visa.status,
    is_open: OPEN_STATUSES.includes(visa.status),
    passport_warning: passportWarning(visa),
  };
}

function assertCustomer(db, customerId) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(customerId));
  if (!customer) throw bad('Choose a customer');
  if (!customer.is_active) throw bad('That customer is archived');
  return customer;
}

function normalizeApplicant(payload, customer) {
  const name = optionalStr(payload.applicant_name, 'Applicant name', 160);
  const hasFlag = payload.applicant_is_customer !== undefined && payload.applicant_is_customer !== null;

  if (hasFlag) {
    if (isTruthy(payload.applicant_is_customer)) {
      return { isCustomer: 1, name: customer.name };
    }
    if (!name) throw bad('Enter the visitor name');
    return { isCustomer: 0, name };
  }

  // Older API callers may not send the flag. Keep their previous behaviour and
  // infer the distinction from the applicant name.
  const applicantName = name || customer.name;
  return {
    isCustomer: applicantName === customer.name ? 1 : 0,
    name: applicantName,
  };
}

function normalizeVisaType(value) {
  const type = String(value || 'tourist').trim().toLowerCase();
  if (!VISA_TYPES.includes(type)) throw bad('Choose a valid visa type');
  return type;
}

function normalizeDurationDays(value, existing = 0) {
  if (value === undefined) return existing;
  if (value === null || value === '') return 0;
  const days = num(value, 'Duration', { min: 1, max: 3650 });
  if (!Number.isInteger(days)) throw bad('Duration must be a whole number of days');
  return days;
}

function getVisa(db, id) {
  const visa = db.prepare(`${visaSelect} WHERE v.id = ?`).get(id);
  if (!visa) throw notFound('Visa application not found');

  visa.items = db.prepare(`
    SELECT vi.*, a.code AS account_code, a.name AS account_name, vd.name AS vendor_name
    FROM visa_items vi
    JOIN accounts a ON a.id = vi.account_id
    LEFT JOIN vendors vd ON vd.id = vi.vendor_id
    WHERE vi.visa_id = ?
    ORDER BY vi.item_type, vi.sort_order, vi.id
  `).all(id);
  visa.sale_items = visa.items.filter((item) => item.item_type === 'sale');
  visa.cost_items = visa.items.filter((item) => item.item_type === 'cost');

  visa.invoice = visa.invoice_id
    ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(visa.invoice_id)
    : null;
  if (visa.invoice) {
    visa.invoice.balance_cents = visa.invoice.status === 'sent'
      ? Math.max(0, visa.invoice.total_cents - visa.invoice.amount_paid_cents - (visa.invoice.credit_applied_cents || 0))
      : 0;
  }

  visa.bills = db.prepare(`
    SELECT b.*, vd.name AS vendor_name, p.name AS portal_name, p.settlement AS portal_settlement,
      (SELECT COALESCE(SUM(scn.amount_cents), 0)
       FROM supplier_credit_notes scn
       WHERE scn.bill_id = b.id AND scn.status = 'issued') AS supplier_credit_total_cents
    FROM bills b
    JOIN vendors vd ON vd.id = b.vendor_id
    LEFT JOIN supplier_portals p ON p.id = b.portal_id
    WHERE b.visa_id = ?
    ORDER BY b.id
  `).all(id).map((bill) => ({
    ...bill,
    balance_cents: bill.status === 'received'
      ? Math.max(0, bill.total_cents - bill.amount_paid_cents - (bill.credit_applied_cents || 0))
      : 0,
    supplier_credit_available_cents: bill.status === 'received'
      ? Math.max(0, bill.total_cents - (bill.supplier_credit_total_cents || 0))
      : 0,
  }));
  visa.cancellation = cancellationService.getCancellationForSource(db, 'visa', id);
  visa.customer_refunds = db.prepare(`
    SELECT cn.id, cn.number, cn.credit_date AS date, cn.amount_cents, cn.applied_cents, cn.refunded_cents,
           (cn.amount_cents - cn.applied_cents - cn.refunded_cents) AS remaining_cents
    FROM credit_notes cn WHERE cn.visa_id = ? AND cn.status = 'issued' ORDER BY cn.credit_date, cn.id
  `).all(id);
  visa.supplier_refunds = db.prepare(`
    SELECT scn.id, scn.number, scn.credit_date AS date, scn.amount_cents, b.number AS bill_number, vd.name AS vendor_name,
           scn.applied_cents, scn.portal_settled_cents, scn.refunded_cents,
           (scn.amount_cents - scn.applied_cents - scn.portal_settled_cents - scn.refunded_cents) AS held_cents
    FROM supplier_credit_notes scn
    LEFT JOIN bills b ON b.id = scn.bill_id
    LEFT JOIN vendors vd ON vd.id = scn.vendor_id
    WHERE scn.visa_id = ? AND scn.cancellation_id IS NULL AND scn.status = 'issued'
    ORDER BY scn.credit_date, scn.id
  `).all(id);
  visa.status_history = jobs.statusHistory(db, 'visa', id);
  visa.group = visa.group_id ? groupSummary(db, visa.group_id) : null;
  visa.deposits = require('./visa-deposits').listDeposits(db, { visa_id: visa.id });

  visa.payments = visa.invoice
    ? db.prepare(`
        SELECT p.*, a.name AS deposit_account_name
        FROM payments p
        JOIN accounts a ON a.id = p.deposit_account_id
        WHERE p.invoice_id = ?
        ORDER BY p.payment_date, p.id
      `).all(visa.invoice_id)
    : [];

  const billIds = visa.bills.map((bill) => bill.id);
  visa.bill_payments = billIds.length
    ? db.prepare(`
        SELECT bp.*, a.name AS payment_account_name
        FROM bill_payments bp
        JOIN accounts a ON a.id = bp.payment_account_id
        WHERE bp.bill_id IN (${billIds.map(() => '?').join(', ')})
        ORDER BY bp.payment_date, bp.id
      `).all(...billIds)
    : [];

  visa.advances = db.prepare(`
    SELECT * FROM customer_advances
    WHERE visa_id = ?
    ORDER BY advance_date, id
  `).all(id).map((advance) => {
    const voided = Boolean(advance.voided_at);
    return {
      ...advance,
      status_display: voided ? 'void' : advance.status,
      voided,
      remaining_cents: voided
        ? 0
        : Math.max(0, advance.amount_cents - advance.applied_cents - advance.refunded_cents),
    };
  });

  visa.amount_paid_cents = visa.invoice ? visa.invoice.amount_paid_cents : 0;
  visa.balance_cents = visa.invoice
    ? visa.invoice.balance_cents
    : (visa.status === 'draft' ? visa.sale_total_cents : 0);

  return jobCosts.withActualResult(db, 'visa', [serializeVisa(visa)])[0];
}

function listVisas(db, { status, search, from, to } = {}) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('v.application_date >= ?');
    params.push(dateISO(from, 'From date'));
  }
  if (to) {
    clauses.push('v.application_date <= ?');
    params.push(dateISO(to, 'To date'));
  }
  if (search) {
    clauses.push(`(v.number LIKE ? OR c.name LIKE ? OR v.destination_country LIKE ?
      OR v.applicant_name LIKE ? OR v.passport_number LIKE ? OR v.reference LIKE ?)`);
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`${visaSelect} ${where} ORDER BY v.application_date DESC, v.id DESC`).all(...params);
  const serialized = jobCosts.withActualResult(db, 'visa', rows.map(serializeVisa));
  if (!status || status === 'all') return serialized;
  return serialized.filter((row) => row.status === status);
}

function normalizeDates(db, payload, existing = {}) {
  const pick = (key) => (payload[key] !== undefined ? payload[key] : existing[key]);
  const applicationDate = dateISO(pick('application_date'), 'Application date');
  const dueRaw = pick('due_date');
  const dueDate = dueRaw ? dateISO(dueRaw, 'Payment due date') : jobs.defaultDueDate(db, applicationDate);
  if (dueDate < applicationDate) throw bad('Due date cannot be before the application date');
  const travelRaw = pick('travel_date');
  const passportRaw = pick('passport_expiry');
  const birthRaw = pick('date_of_birth');
  return {
    applicationDate,
    dueDate,
    travelDate: travelRaw ? dateISO(travelRaw, 'Travel date') : null,
    passportExpiry: passportRaw ? dateISO(passportRaw, 'Passport expiry') : null,
    dateOfBirth: birthRaw ? dateISO(birthRaw, 'Date of birth') : null,
  };
}

// options.groupId links the application to a family or group created together.
function createVisa(db, payload, options = {}) {
  return db.transaction(() => {
    const customer = assertCustomer(db, payload.customer_id);
    const applicant = normalizeApplicant(payload, customer);
    const dates = normalizeDates(db, payload);
    const durationDays = normalizeDurationDays(payload.duration_days);
    const saleItems = jobs.normalizeJobItems(db, payload.sale_items || [], 'sale');
    const costItems = jobs.normalizeJobItems(db, payload.cost_items || [], 'cost');
    if (!saleItems.length) throw bad('Add at least one sale item');
    const saleTotal = itemTotals(saleItems);
    if (saleTotal <= 0) throw bad('Visa sale total must be greater than zero');

    const number = allocateNumber(db, 'visa', dates.applicationDate);
    const info = db.prepare(`
      INSERT INTO visa_applications (number, customer_id, application_date, due_date, travel_date,
        status, destination_country, visa_type, duration_days, applicant_name, applicant_is_customer,
        nationality, passport_number, passport_expiry, date_of_birth, reference, notes, invoice_notes,
        sale_total_cents, cost_total_cents, group_id)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      customer.id,
      dates.applicationDate,
      dates.dueDate,
      dates.travelDate,
      optionalStr(payload.destination_country, 'Destination country', 120),
      normalizeVisaType(payload.visa_type),
      durationDays,
      applicant.name,
      applicant.isCustomer,
      optionalStr(payload.nationality, 'Nationality', 80),
      optionalStr(payload.passport_number, 'Passport number', 60),
      dates.passportExpiry,
      dates.dateOfBirth,
      optionalStr(payload.reference, 'Application reference', 120),
      optionalStr(payload.notes, 'Notes', 2000),
      optionalStr(payload.invoice_notes, 'Invoice note', 2000),
      saleTotal,
      itemTotals(costItems),
      options.groupId || null,
    );
    const visaId = Number(info.lastInsertRowid);
    markCreated(db, 'visa_applications', visaId);
    jobs.insertJobItems(db, 'visa', visaId, saleItems, costItems);
    jobs.recordStatus(db, 'visa', visaId, { to: 'draft', remarks: 'Application created' });
    return getVisa(db, visaId);
  })();
}

function updateVisa(db, id, payload) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(id);
    if (!existing) throw notFound('Visa application not found');
    if (existing.status !== 'draft') throw bad('Only draft visa applications can be edited');
    const customer = assertCustomer(db, payload.customer_id ?? existing.customer_id);
    const applicant = normalizeApplicant(payload, customer);
    const dates = normalizeDates(db, payload, existing);
    const durationDays = normalizeDurationDays(payload.duration_days, existing.duration_days || 0);
    const saleItems = jobs.normalizeJobItems(db, payload.sale_items || [], 'sale');
    const costItems = jobs.normalizeJobItems(db, payload.cost_items || [], 'cost');
    if (!saleItems.length) throw bad('Add at least one sale item');
    const saleTotal = itemTotals(saleItems);
    if (saleTotal <= 0) throw bad('Visa sale total must be greater than zero');

    db.prepare(`
      UPDATE visa_applications SET customer_id = ?, application_date = ?, due_date = ?, travel_date = ?,
        destination_country = ?, visa_type = ?, duration_days = ?, applicant_name = ?, applicant_is_customer = ?,
        nationality = ?, passport_number = ?, passport_expiry = ?, date_of_birth = ?,
        reference = ?, notes = ?, invoice_notes = ?, sale_total_cents = ?, cost_total_cents = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      customer.id,
      dates.applicationDate,
      dates.dueDate,
      dates.travelDate,
      optionalStr(payload.destination_country, 'Destination country', 120),
      normalizeVisaType(payload.visa_type ?? existing.visa_type),
      durationDays,
      applicant.name,
      applicant.isCustomer,
      optionalStr(payload.nationality, 'Nationality', 80),
      optionalStr(payload.passport_number, 'Passport number', 60),
      dates.passportExpiry,
      dates.dateOfBirth,
      optionalStr(payload.reference, 'Application reference', 120),
      optionalStr(payload.notes, 'Notes', 2000),
      optionalStr(payload.invoice_notes ?? existing.invoice_notes, 'Invoice note', 2000),
      saleTotal,
      itemTotals(costItems),
      id,
    );
    db.prepare('DELETE FROM visa_items WHERE visa_id = ?').run(id);
    jobs.insertJobItems(db, 'visa', id, saleItems, costItems);
    return getVisa(db, id);
  })();
}

function deleteVisa(db, id) {
  return db.transaction(() => {
    const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(id);
    if (!visa) throw notFound('Visa application not found');
    if (visa.status !== 'draft') throw bad('Only draft visa applications can be deleted. Cancel it instead.');
    db.prepare("DELETE FROM attachments WHERE entity_type = 'visa' AND entity_id = ?").run(id);
    jobs.deleteStatusHistory(db, 'visa', id);
    db.prepare('DELETE FROM visa_applications WHERE id = ?').run(id);
    return { deleted: true };
  })();
}

function submitVisa(db, id, options = {}) {
  return db.transaction(() => {
    const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(id);
    if (!visa) throw notFound('Visa application not found');
    if (visa.status !== 'draft') throw bad('Only draft visa applications can be submitted');
    const items = db.prepare('SELECT * FROM visa_items WHERE visa_id = ? ORDER BY item_type, sort_order, id').all(id);
    const visaTypeName = visa.visa_type
      ? `${visa.visa_type.charAt(0).toUpperCase()}${visa.visa_type.slice(1)}`
      : '';
    const visaDetails = [
      visa.destination_country,
      visaTypeName ? `${visaTypeName} visa` : '',
      visa.duration_days ? `${visa.duration_days} days` : '',
    ].filter(Boolean).join(' · ');
    const { invoice, warnings } = jobs.postJobDocuments(db, {
      sourceType: 'visa',
      jobId: id,
      customerId: visa.customer_id,
      issueDate: visa.application_date,
      dueDate: visa.due_date || visa.application_date,
      // Only the customer-facing note is copied; application notes stay internal.
      invoiceNotes: visa.invoice_notes,
      invoiceTerms: visaDetails
        ? `${visaDetails}${visa.applicant_name ? ` for ${visa.applicant_name}` : ''}`
        : '',
      billNotes: `Visa ${visa.number} · ${visa.destination_country || 'Application'}${visa.reference ? ` · Ref ${visa.reference}` : ''}`,
      items,
    });
    db.prepare("UPDATE visa_applications SET status = 'submitted', invoice_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(invoice.id, id);
    jobs.recordStatus(db, 'visa', id, { from: 'draft', to: 'submitted', remarks: `Invoice ${invoice.number} posted` });
    const appliedAdvances = options.apply_advances ? jobs.applyOpenAdvances(db, 'visa', id, invoice) : [];
    const result = getVisa(db, id);
    if (appliedAdvances.length) result.applied_advances = appliedAdvances;
    if (result.passport_warning) warnings.push(result.passport_warning);
    if (warnings.length) result.warnings = warnings;
    return result;
  })();
}

function approveVisa(db, id) {
  return db.transaction(() => {
    const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(id);
    if (!visa) throw notFound('Visa application not found');
    if (visa.status !== 'submitted') throw bad('Only submitted applications can be approved');
    db.prepare("UPDATE visa_applications SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(id);
    jobs.recordStatus(db, 'visa', id, { from: 'submitted', to: 'approved' });
    return getVisa(db, id);
  })();
}

function issueVisa(db, id) {
  return db.transaction(() => {
    const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(id);
    if (!visa) throw notFound('Visa application not found');
    if (visa.status !== 'approved') throw bad('Only approved applications can be marked as issued');
    db.prepare("UPDATE visa_applications SET status = 'issued', updated_at = datetime('now') WHERE id = ?").run(id);
    jobs.recordStatus(db, 'visa', id, { from: 'approved', to: 'issued' });
    return getVisa(db, id);
  })();
}

// Rejected by immigration: the work was done, so the invoice, the sale and
// what the customer owes stay. Only the status changes, with the date and
// reason. Money given back or received is recorded separately
// (visa-refunds.js: refundCustomer, supplierRefund).
function rejectVisa(db, id, payload = {}) {
  return db.transaction(() => {
    const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(Number(id));
    if (!visa) throw notFound('Visa application not found');
    if (!['submitted', 'approved'].includes(visa.status)) {
      throw bad('Only submitted or approved applications can be rejected');
    }
    const date = dateISO(payload.rejection_date || todayISO(), 'Rejection date');
    const reason = optionalStr(payload.reason, 'Reason', 500) || 'Rejected by immigration';
    db.prepare("UPDATE visa_applications SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(visa.id);
    jobs.recordStatus(db, 'visa', visa.id, { from: visa.status, to: 'rejected', eventDate: date, remarks: reason });
    audit.record(db, {
      entity_type: 'visa', entity_id: visa.id, entity_number: visa.number, action: 'reject', remarks: reason, amount_cents: 0,
    });
    return getVisa(db, id);
  })();
}

function cancelVisa(db, id, payload = {}) {
  cancellationService.cancelSource(db, {
    sourceType: 'visa',
    sourceId: id,
    payload,
  });
  return getVisa(db, id);
}

function visaMarginReport(db, from, to) {
  const start = dateISO(from, 'From date');
  const end = dateISO(to, 'To date');
  const rows = db.prepare(`
    ${visaSelect}
    WHERE v.application_date >= ? AND v.application_date <= ?
    ORDER BY v.application_date DESC, v.id DESC
  `).all(start, end);
  const serialised = jobCosts.valueJobs(db, 'visa', rows.map(serializeVisa));
  const totals = serialised.reduce((acc, row) => {
    acc.sale_cents += row.sale_total_cents;
    acc.cost_cents += row.cost_total_cents;
    acc.margin_cents += row.margin_cents;
    return acc;
  }, { sale_cents: 0, cost_cents: 0, margin_cents: 0 });
  totals.margin_percent = totals.sale_cents ? (totals.margin_cents / totals.sale_cents) * 100 : 0;
  return { from: start, to: end, rows: serialised, totals };
}

function visaStats(db, from, to) {
  const rows = db.prepare('SELECT * FROM visa_applications').all();
  const inRange = rows.filter((row) => (!from || row.application_date >= from) && (!to || row.application_date <= to));
  const valued = jobCosts.valueJobs(db, 'visa', inRange);
  const sale = valued.reduce((sum, row) => sum + row.sale_total_cents, 0);
  const cost = valued.reduce((sum, row) => sum + row.cost_total_cents, 0);
  const counts = {
    total: rows.length,
    draft: 0,
    submitted: 0,
    approved: 0,
    issued: 0,
    rejected: 0,
    cancelled: 0,
  };
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  return {
    counts,
    visa_count: valued.length,
    draft_count: inRange.filter((row) => row.status === 'draft').length,
    active_count: (counts.submitted || 0) + (counts.approved || 0),
    sale_cents: sale,
    cost_cents: cost,
    margin_cents: sale - cost,
  };
}

const SHARED_GROUP_FIELDS = [
  'customer_id', 'application_date', 'due_date', 'travel_date', 'destination_country',
  'visa_type', 'duration_days', 'reference', 'notes', 'invoice_notes',
];
const APPLICANT_FIELDS = [
  'applicant_is_customer', 'applicant_name', 'nationality', 'passport_number',
  'passport_expiry', 'date_of_birth', 'sale_items', 'cost_items',
];
const MAX_GROUP_SIZE = 30;

function groupSummary(db, groupId) {
  const group = db.prepare('SELECT * FROM visa_groups WHERE id = ?').get(Number(groupId));
  if (!group) return null;
  const applications = db.prepare(`
    SELECT id, number, applicant_name, status, sale_total_cents, cost_total_cents, invoice_id
    FROM visa_applications WHERE group_id = ? ORDER BY id
  `).all(group.id);
  return {
    ...group,
    applications,
    size: applications.length,
    draft_count: applications.filter((row) => row.status === 'draft').length,
  };
}

// One form for several people: each applicant becomes a separate application
// (own invoice, status, rejection or cancellation), linked by a visa group.
// A single applicant creates a plain application with no group.
function createVisaGroup(db, payload = {}) {
  return db.transaction(() => {
    const applicants = Array.isArray(payload.applicants) ? payload.applicants : [];
    if (!applicants.length) throw bad('Add at least one applicant');
    if (applicants.length > MAX_GROUP_SIZE) throw bad(`A group can have at most ${MAX_GROUP_SIZE} applicants`);
    const shared = {};
    for (const key of SHARED_GROUP_FIELDS) if (payload[key] !== undefined) shared[key] = payload[key];
    const build = (applicant, index) => {
      const fields = {};
      for (const key of APPLICANT_FIELDS) if (applicant[key] !== undefined) fields[key] = applicant[key];
      if (!String(fields.applicant_name || '').trim() && fields.applicant_is_customer === false) {
        // The group create adds "Applicant N:" to every applicant error.
        throw bad('Enter the applicant name');
      }
      return { ...shared, ...fields };
    };

    // A security deposit taken with the application is recorded straight away.
    const takeDeposits = (applications) => {
      applicants.forEach((applicant, index) => {
        if (!Number(applicant.deposit_cents)) return;
        try {
          require('./visa-deposits').collectDeposit(db, {
            visa_id: applications[index].id,
            amount_cents: applicant.deposit_cents,
            deposit_date: payload.deposit?.deposit_date || payload.application_date,
            account_id: payload.deposit?.account_id,
            method: payload.deposit?.method,
          });
        } catch (error) {
          if (error.status === 400) error.message = `Applicant ${index + 1} deposit: ${error.message}`;
          throw error;
        }
      });
    };

    if (applicants.length === 1) {
      const visa = createVisa(db, build(applicants[0], 0));
      takeDeposits([visa]);
      return { group: null, applications: [getVisa(db, visa.id)] };
    }
    const customer = assertCustomer(db, payload.customer_id);
    const applicationDate = dateISO(payload.application_date, 'Application date');
    const number = allocateNumber(db, 'visa_group', applicationDate);
    const groupId = Number(db.prepare('INSERT INTO visa_groups (number, customer_id) VALUES (?, ?)')
      .run(number, customer.id).lastInsertRowid);
    markCreated(db, 'visa_groups', groupId);
    const created = applicants.map((applicant, index) => {
      try {
        return createVisa(db, build(applicant, index), { groupId });
      } catch (error) {
        if (error.status === 400) error.message = `Applicant ${index + 1}: ${error.message}`;
        throw error;
      }
    });
    takeDeposits(created);
    // Read them back once the group is complete so each shows the full group size.
    const applications = created.map((visa) => getVisa(db, visa.id));
    return { group: groupSummary(db, groupId), applications };
  })();
}

// Submit every draft application in the group at once, or none of them.
function submitVisaGroup(db, groupId, options = {}) {
  return db.transaction(() => {
    const group = groupSummary(db, groupId);
    if (!group) throw notFound('Visa group not found');
    const drafts = group.applications.filter((row) => row.status === 'draft');
    if (!drafts.length) throw bad('This group has no draft applications to submit');
    const warnings = [];
    const submitted = drafts.map((row) => {
      const result = submitVisa(db, row.id, options);
      for (const warning of result.warnings || []) warnings.push(`${result.number}: ${warning}`);
      return result;
    });
    return { group: groupSummary(db, groupId), submitted: submitted.map((row) => row.id), warnings };
  })();
}

module.exports = {
  createVisaGroup,
  submitVisaGroup,
  VISA_TYPES,
  listVisas,
  getVisa,
  createVisa,
  updateVisa,
  deleteVisa,
  submitVisa,
  approveVisa,
  issueVisa,
  rejectVisa,
  cancelVisa,
  visaMarginReport,
  visaStats,
};
