'use strict';

const {
  bad,
  notFound,
  str,
  optionalStr,
  num,
  cents,
  dateISO,
  isTruthy,
} = require('../util');
const { allocateNumber } = require('./numbering');
const { isPurchaseAccount } = require('../accounting');
const invoiceService = require('./invoices');
const billService = require('./bills');
const portalService = require('./portals');
const cancellationService = require('./cancellations');

const VISA_TYPES = ['tourist', 'visit', 'business', 'transit', 'student', 'work', 'other'];
const OPEN_STATUSES = ['draft', 'submitted', 'approved'];

const visaSelect = `
  SELECT v.*, c.name AS customer_name, c.email AS customer_email,
         c.phone AS customer_phone, c.address AS customer_address
  FROM visa_applications v
  JOIN customers c ON c.id = v.customer_id
`;

function itemTotals(items) {
  return items.reduce((sum, item) => sum + item.amount_cents, 0);
}

function serializeVisa(visa) {
  return {
    ...visa,
    margin_cents: visa.sale_total_cents - visa.cost_total_cents,
    status_display: visa.status,
    is_open: OPEN_STATUSES.includes(visa.status),
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

function normalizeItems(db, items, itemType) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const isSale = itemType === 'sale';
    const label = `${isSale ? 'Sale' : 'Cost'} line ${index + 1}`;
    const description = str(item.description, `${label} description`, { max: 300 });
    const quantity = num(item.quantity ?? 1, `${label} quantity`, { min: 0.0001, max: 1_000_000 });
    const unitPrice = cents(item.unit_price_cents, `${label} unit price`);
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
    };
  });
}

function insertItems(db, visaId, saleItems, costItems) {
  const insert = db.prepare(`
    INSERT INTO visa_items (visa_id, item_type, description, quantity, unit_price_cents,
      amount_cents, account_id, vendor_id, supplier_ref, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  saleItems.forEach((item, index) => {
    insert.run(visaId, 'sale', item.description, item.quantity, item.unit_price_cents,
      item.amount_cents, item.account_id, null, item.supplier_ref, index);
  });
  costItems.forEach((item, index) => {
    insert.run(visaId, 'cost', item.description, item.quantity, item.unit_price_cents,
      item.amount_cents, item.account_id, item.vendor_id, item.supplier_ref, index);
  });
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
  `).all(id).map((advance) => ({
    ...advance,
    remaining_cents: Math.max(0, advance.amount_cents - advance.applied_cents - advance.refunded_cents),
  }));

  visa.amount_paid_cents = visa.invoice ? visa.invoice.amount_paid_cents : 0;
  visa.balance_cents = visa.invoice
    ? visa.invoice.balance_cents
    : (visa.status === 'draft' ? visa.sale_total_cents : 0);

  return serializeVisa(visa);
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
  const serialized = rows.map(serializeVisa);
  if (!status || status === 'all') return serialized;
  return serialized.filter((row) => row.status === status);
}

function normalizeDates(payload, existing = {}) {
  const pick = (key) => (payload[key] !== undefined ? payload[key] : existing[key]);
  const applicationDate = dateISO(pick('application_date'), 'Application date');
  const dueRaw = pick('due_date');
  const dueDate = dueRaw ? dateISO(dueRaw, 'Payment due date') : applicationDate;
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

function createVisa(db, payload) {
  return db.transaction(() => {
    const customer = assertCustomer(db, payload.customer_id);
    const applicant = normalizeApplicant(payload, customer);
    const dates = normalizeDates(payload);
    const saleItems = normalizeItems(db, payload.sale_items || [], 'sale');
    const costItems = normalizeItems(db, payload.cost_items || [], 'cost');
    if (!saleItems.length) throw bad('Add at least one sale item');
    const saleTotal = itemTotals(saleItems);
    if (saleTotal <= 0) throw bad('Visa sale total must be greater than zero');

    const number = allocateNumber(db, 'visa', dates.applicationDate);
    const info = db.prepare(`
      INSERT INTO visa_applications (number, customer_id, application_date, due_date, travel_date,
        status, destination_country, visa_type, applicant_name, applicant_is_customer,
        nationality, passport_number, passport_expiry, date_of_birth, reference, notes,
        sale_total_cents, cost_total_cents)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      customer.id,
      dates.applicationDate,
      dates.dueDate,
      dates.travelDate,
      optionalStr(payload.destination_country, 'Destination country', 120),
      normalizeVisaType(payload.visa_type),
      applicant.name,
      applicant.isCustomer,
      optionalStr(payload.nationality, 'Nationality', 80),
      optionalStr(payload.passport_number, 'Passport number', 60),
      dates.passportExpiry,
      dates.dateOfBirth,
      optionalStr(payload.reference, 'Application reference', 120),
      optionalStr(payload.notes, 'Notes', 2000),
      saleTotal,
      itemTotals(costItems),
    );
    const visaId = Number(info.lastInsertRowid);
    insertItems(db, visaId, saleItems, costItems);
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
    const dates = normalizeDates(payload, existing);
    const saleItems = normalizeItems(db, payload.sale_items || [], 'sale');
    const costItems = normalizeItems(db, payload.cost_items || [], 'cost');
    if (!saleItems.length) throw bad('Add at least one sale item');
    const saleTotal = itemTotals(saleItems);
    if (saleTotal <= 0) throw bad('Visa sale total must be greater than zero');

    db.prepare(`
      UPDATE visa_applications SET customer_id = ?, application_date = ?, due_date = ?, travel_date = ?,
        destination_country = ?, visa_type = ?, applicant_name = ?, applicant_is_customer = ?,
        nationality = ?, passport_number = ?, passport_expiry = ?, date_of_birth = ?,
        reference = ?, notes = ?, sale_total_cents = ?, cost_total_cents = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      customer.id,
      dates.applicationDate,
      dates.dueDate,
      dates.travelDate,
      optionalStr(payload.destination_country, 'Destination country', 120),
      normalizeVisaType(payload.visa_type ?? existing.visa_type),
      applicant.name,
      applicant.isCustomer,
      optionalStr(payload.nationality, 'Nationality', 80),
      optionalStr(payload.passport_number, 'Passport number', 60),
      dates.passportExpiry,
      dates.dateOfBirth,
      optionalStr(payload.reference, 'Application reference', 120),
      optionalStr(payload.notes, 'Notes', 2000),
      saleTotal,
      itemTotals(costItems),
      id,
    );
    db.prepare('DELETE FROM visa_items WHERE visa_id = ?').run(id);
    insertItems(db, id, saleItems, costItems);
    return getVisa(db, id);
  })();
}

function deleteVisa(db, id) {
  return db.transaction(() => {
    const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(id);
    if (!visa) throw notFound('Visa application not found');
    if (visa.status !== 'draft') throw bad('Only draft visa applications can be deleted. Cancel it instead.');
    db.prepare("DELETE FROM attachments WHERE entity_type = 'visa' AND entity_id = ?").run(id);
    db.prepare('DELETE FROM visa_applications WHERE id = ?').run(id);
    return { deleted: true };
  })();
}

function submitVisa(db, id) {
  return db.transaction(() => {
    const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(id);
    if (!visa) throw notFound('Visa application not found');
    if (visa.status !== 'draft') throw bad('Only draft visa applications can be submitted');
    const items = db.prepare('SELECT * FROM visa_items WHERE visa_id = ? ORDER BY item_type, sort_order, id').all(id);
    const saleItems = items.filter((item) => item.item_type === 'sale');
    const costItems = items.filter((item) => item.item_type === 'cost');
    if (!saleItems.length) throw bad('Add sale items before submitting this application');

    const invoice = invoiceService.createInvoice(db, {
      customer_id: visa.customer_id,
      issue_date: visa.application_date,
      due_date: visa.due_date || visa.application_date,
      notes: visa.notes,
      terms: visa.destination_country
        ? `${visa.destination_country} ${visa.visa_type} visa${visa.applicant_name ? ` for ${visa.applicant_name}` : ''}`
        : '',
      status: 'sent',
      items: saleItems.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        account_id: item.account_id,
      })),
    });
    db.prepare('UPDATE invoices SET visa_id = ? WHERE id = ?').run(id, invoice.id);

    const groups = new Map();
    for (const item of costItems) {
      if (!item.vendor_id) continue;
      if (!groups.has(item.vendor_id)) groups.set(item.vendor_id, []);
      groups.get(item.vendor_id).push(item);
    }
    for (const [vendorId, vendorItems] of groups.entries()) {
      const bill = billService.createBill(db, {
        vendor_id: vendorId,
        bill_date: visa.application_date,
        due_date: visa.due_date || visa.application_date,
        notes: `Visa ${visa.number} · ${visa.destination_country || 'Application'}${visa.reference ? ` · Ref ${visa.reference}` : ''}`,
        status: 'received',
        items: vendorItems.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unit_price_cents: item.unit_price_cents,
          account_id: item.account_id,
        })),
      });
      db.prepare('UPDATE bills SET visa_id = ? WHERE id = ?').run(id, bill.id);
      const portal = portalService.portalForVendor(db, vendorId);
      if (portal) {
        db.prepare('UPDATE bills SET portal_id = ? WHERE id = ?').run(portal.id, bill.id);
      }
    }

    // Prepaid portals settle their supplier's bill straight away from the balance.
    const warnings = [];
    const visaBills = db.prepare('SELECT id, number FROM bills WHERE visa_id = ?').all(id);
    for (const bill of visaBills) {
      let settled;
      try {
        settled = portalService.autoSettleBill(db, bill.id, visa.application_date);
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

    db.prepare("UPDATE visa_applications SET status = 'submitted', invoice_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(invoice.id, id);
    const result = getVisa(db, id);
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
    return getVisa(db, id);
  })();
}

function issueVisa(db, id) {
  return db.transaction(() => {
    const visa = db.prepare('SELECT * FROM visa_applications WHERE id = ?').get(id);
    if (!visa) throw notFound('Visa application not found');
    if (visa.status !== 'approved') throw bad('Only approved applications can be marked as issued');
    db.prepare("UPDATE visa_applications SET status = 'issued', updated_at = datetime('now') WHERE id = ?").run(id);
    return getVisa(db, id);
  })();
}

function rejectVisa(db, id, payload = {}) {
  const visa = db.prepare('SELECT status FROM visa_applications WHERE id = ?').get(Number(id));
  if (!visa) throw notFound('Visa application not found');
  if (!['submitted', 'approved'].includes(visa.status)) {
    throw bad('Only submitted or approved applications can be rejected');
  }
  cancellationService.cancelSource(db, {
    sourceType: 'visa',
    sourceId: id,
    payload,
    finalStatus: 'rejected',
  });
  return getVisa(db, id);
}

function cancelVisa(db, id, payload = {}) {
  cancellationService.cancelSource(db, {
    sourceType: 'visa',
    sourceId: id,
    payload,
    finalStatus: 'cancelled',
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
  const serialised = rows.map((row) => {
    const base = serializeVisa(row);
    const adjustment = cancellationService.cancellationAdjustment(
      db, 'visa', row.id, row.sale_total_cents, row.cost_total_cents,
    );
    if (adjustment) {
      return {
        ...base,
        ...adjustment,
        margin_cents: adjustment.sale_total_cents - adjustment.cost_total_cents,
      };
    }
    // Jobs cancelled or rejected before cancellations were tracked keep their
    // historical treatment (excluded from margin reporting).
    if (row.status === 'rejected' || row.status === 'cancelled') return null;
    return base;
  }).filter(Boolean);
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
  let sale = 0;
  let cost = 0;
  for (const row of inRange) {
    const adjustment = cancellationService.cancellationAdjustment(
      db, 'visa', row.id, row.sale_total_cents, row.cost_total_cents,
    );
    if (adjustment) {
      sale += adjustment.sale_total_cents;
      cost += adjustment.cost_total_cents;
    } else if (row.status !== 'cancelled' && row.status !== 'rejected') {
      sale += row.sale_total_cents;
      cost += row.cost_total_cents;
    }
  }
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
    visa_count: inRange.length,
    active_count: (counts.submitted || 0) + (counts.approved || 0),
    sale_cents: sale,
    cost_cents: cost,
    margin_cents: sale - cost,
  };
}

module.exports = {
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
