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
  maskPassport,
  isTruthy,
} = require('../util');
const {
  systemAccount,
  isCashAccount,
  bankChargesCents,
  bankChargeLines,
  postEntry,
  reverseEntry,
  invoiceBalanceCents,
  invoiceDisplayStatus,
} = require('../accounting');
const { allocateNumber } = require('./numbering');
const { markCreated } = require('../created-by');
const audit = require('./audit');

const invoiceSelect = `
  SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.address AS customer_address,
         c.phone AS customer_phone, c.number AS customer_number
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
`;

function serializeInvoice(invoice, today = todayISO()) {
  // The full passport is only needed while a draft can still be edited. Sent
  // and void invoices are customer documents and carry the masked form only.
  const { beneficiary_passport: passport, ...rest } = invoice;
  return {
    ...rest,
    ...(invoice.status === 'draft' ? { beneficiary_passport: passport || '' } : {}),
    beneficiary_passport_masked: maskPassport(passport),
    status_display: invoiceDisplayStatus(invoice, today),
    balance_cents: invoiceBalanceCents(invoice),
  };
}

// "This invoice is for someone else": billed to the customer, delivered to
// another person. Off means the customer is the person served.
function normalizeBeneficiary(payload, existing = {}) {
  const has = (key) => payload[key] !== undefined && payload[key] !== null;
  const forCustomer = has('beneficiary_is_customer')
    ? isTruthy(payload.beneficiary_is_customer)
    : existing.beneficiary_is_customer !== 0;
  if (forCustomer) {
    return { isCustomer: 1, name: '', nationality: '', passport: '' };
  }
  const pick = (key) => (has(key) ? payload[key] : existing[key]);
  const name = optionalStr(pick('beneficiary_name'), 'Name of the person', 160);
  if (!name) throw bad('Enter the name of the person this invoice is for');
  return {
    isCustomer: 0,
    name,
    nationality: optionalStr(pick('beneficiary_nationality'), 'Nationality', 80),
    passport: optionalStr(pick('beneficiary_passport'), 'Passport number', 60),
  };
}

// A visa invoice is billed to the customer, but the applicant may be someone
// else. Keep the applicant details on the detail response so the document can
// show a separate "Visa applicant" section without changing the ledger party.
function attachVisaDetails(db, invoice) {
  if (!invoice.visa_id) return invoice;
  const visa = db.prepare(`
    SELECT number AS visa_number,
           destination_country AS visa_destination_country,
           visa_type AS visa_type,
           duration_days AS visa_duration_days,
           applicant_name AS visa_applicant_name,
           applicant_is_customer AS visa_applicant_is_customer,
           nationality AS visa_nationality,
           passport_number AS visa_passport_number,
           passport_expiry AS visa_passport_expiry,
           reference AS visa_reference,
           (SELECT g.number FROM visa_groups g WHERE g.id = visa_applications.group_id) AS visa_group_number
    FROM visa_applications
    WHERE id = ?
  `).get(invoice.visa_id);
  if (!visa) return invoice;
  // The invoice is a customer document: show a masked passport number and no
  // date of birth. The visa application keeps the full details.
  const { visa_passport_number: passportNumber, ...details } = visa;
  return Object.assign(invoice, details, { visa_passport_masked: maskPassport(passportNumber) });
}

// Trip details for an invoice made from a booking, and the ticket number of
// each passenger line (taken from the cost line of the same passenger row).
function attachBookingDetails(db, invoice) {
  if (!invoice.booking_id) return invoice;
  const booking = db.prepare(`
    SELECT number AS booking_number, pnr AS booking_pnr, destination AS booking_destination,
           travel_date AS booking_travel_date, return_date AS booking_return_date
    FROM bookings WHERE id = ?
  `).get(invoice.booking_id);
  if (!booking) return invoice;
  const lines = db.prepare(`
    SELECT item_type, passenger_name, line_group, supplier_ref FROM booking_items
    WHERE booking_id = ? AND passenger_name <> ''
  `).all(invoice.booking_id);
  const tickets = new Map();
  for (const line of lines) {
    if (line.item_type !== 'cost' || !String(line.supplier_ref || '').trim()) continue;
    const refs = tickets.get(line.passenger_name) || [];
    refs.push(line.supplier_ref.trim());
    tickets.set(line.passenger_name, refs);
  }
  const label = String(booking.booking_destination || '').trim();
  const passengers = [...new Set(lines.map((line) => line.passenger_name))];
  invoice.booking_passenger_count = passengers.length;
  invoice.booking_ticket_lookup = (description) => {
    const name = passengers.find((passenger) => description === passenger
      || description === [label, passenger].filter(Boolean).join(' – '));
    return name ? { passenger_name: name, ticket_no: (tickets.get(name) || []).join(', ') } : null;
  };
  return Object.assign(invoice, booking);
}

// What kind of document this invoice prints as.
function documentKind(invoice) {
  if (invoice.cancellation_id) return 'cancellation';
  if (invoice.booking_id) return invoice.booking_passenger_count ? 'ticket' : 'booking';
  if (invoice.visa_id) return 'visa';
  return 'service';
}

function getInvoice(db, id) {
  const invoice = db.prepare(`${invoiceSelect} WHERE i.id = ?`).get(id);
  if (!invoice) throw notFound('Invoice not found');
  attachVisaDetails(db, invoice);
  attachBookingDetails(db, invoice);
  const sourceCancellation = db.prepare(
    'SELECT id, number FROM cancellations WHERE invoice_id = ?',
  ).get(id);
  invoice.source_cancellation_id = sourceCancellation?.id || null;
  invoice.source_cancellation_number = sourceCancellation?.number || null;
  invoice.items = db.prepare(`
    SELECT ii.*, a.code AS account_code, a.name AS account_name
    FROM invoice_items ii
    JOIN accounts a ON a.id = ii.account_id
    WHERE ii.invoice_id = ?
    ORDER BY ii.sort_order, ii.id
  `).all(id);
  if (invoice.booking_ticket_lookup && !invoice.cancellation_id) {
    for (const item of invoice.items) {
      const match = invoice.booking_ticket_lookup(item.description);
      item.passenger_name = match?.passenger_name || '';
      item.ticket_no = match?.ticket_no || '';
    }
  }
  delete invoice.booking_ticket_lookup;
  invoice.document_kind = documentKind(invoice);
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
    refundable_cents: payment.advance_id || payment.deposit_id || payment.status === 'void'
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
    clauses.push('(i.number LIKE ? OR c.name LIKE ? OR i.notes LIKE ? OR i.beneficiary_name LIKE ?)');
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term);
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
  const ar = systemAccount(db, '1100', 'Trade Receivables');
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

// Ticket, package and visa sales always have a supplier cost, so they are
// invoiced from a booking or visa where that cost is recorded with the sale.
// A direct (service) invoice is for income with no supplier cost.
const JOB_REVENUE_CODES = new Set(['4000', '4100', '4320']);

function assertServiceRevenue(db, items) {
  items.forEach((item, index) => {
    const account = db.prepare('SELECT code, name FROM accounts WHERE id = ?').get(Number(item.account_id));
    if (account && JOB_REVENUE_CODES.has(account.code)) {
      throw bad(`Line ${index + 1}: ${account.code} ${account.name} is used by bookings and visas. Create a booking or visa so the supplier cost is recorded with the sale, or choose a service income account.`);
    }
  });
}

// options.jobInvoice is set only by bookings, visas and cancellations, which
// post their own revenue and costs.
function createInvoice(db, payload, options = {}) {
  return db.transaction(() => {
    const customer = assertCustomer(db, payload.customer_id);
    const issueDate = dateISO(payload.issue_date, 'Issue date');
    const dueDate = dateISO(payload.due_date || issueDate, 'Due date');
    if (dueDate < issueDate) throw bad('Due date cannot be before the issue date');
    const status = payload.status === 'draft' ? 'draft' : 'sent';
    const items = normalizeItems(db, payload.items, ['revenue']);
    if (!options.jobInvoice) assertServiceRevenue(db, items);
    const totals = computeTotals(items);
    if (totals.total <= 0) throw bad('Invoice total must be greater than zero');
    const beneficiary = normalizeBeneficiary(payload);
    const number = allocateNumber(db, 'invoice', issueDate);

    const info = db.prepare(`
      INSERT INTO invoices (number, customer_id, issue_date, due_date, status, notes, terms,
        subtotal_cents, total_cents, amount_paid_cents,
        beneficiary_is_customer, beneficiary_name, beneficiary_nationality, beneficiary_passport)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
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
      beneficiary.isCustomer,
      beneficiary.name,
      beneficiary.nationality,
      beneficiary.passport,
    );
    const invoiceId = Number(info.lastInsertRowid);
    markCreated(db, 'invoices', invoiceId);
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
    if (!existing.booking_id && !existing.visa_id && !existing.cancellation_id) assertServiceRevenue(db, items);
    const totals = computeTotals(items);
    if (totals.total <= 0) throw bad('Invoice total must be greater than zero');
    const beneficiary = normalizeBeneficiary(payload, existing);

    db.prepare(`
      UPDATE invoices SET customer_id = ?, issue_date = ?, due_date = ?, notes = ?, terms = ?,
        subtotal_cents = ?, total_cents = ?,
        beneficiary_is_customer = ?, beneficiary_name = ?, beneficiary_nationality = ?, beneficiary_passport = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      customer.id,
      issueDate,
      dueDate,
      optionalStr(payload.notes ?? existing.notes, 'Notes', 2000),
      optionalStr(payload.terms ?? existing.terms, 'Terms', 2000),
      totals.subtotal,
      totals.total,
      beneficiary.isCustomer,
      beneficiary.name,
      beneficiary.nationality,
      beneficiary.passport,
      id,
    );
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
    insertItems(db, id, items);
    return getInvoice(db, id);
  })();
}

// A link from the card gateway (Network International, Telr, Stripe…) for
// paying this invoice online. Not accounting data; it goes out with the
// invoice and its share message.
function setPaymentLink(db, id, payload = {}) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) throw notFound('Invoice not found');
  if (invoice.status === 'void') throw bad('This invoice is void');
  const link = optionalStr(payload.payment_link, 'Payment link', 500);
  if (link && !/^https:\/\/[^\s]+$/i.test(link)) throw bad('The payment link must start with https:// and have no spaces');
  db.prepare("UPDATE invoices SET payment_link = ?, updated_at = datetime('now') WHERE id = ?").run(link, id);
  return getInvoice(db, id);
}

function finalizeInvoice(db, id) {
  return db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'draft') throw bad('Only draft invoices can be finalized');
    const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id);
    if (!items.length) throw bad('Add line items before finalizing');
    // Drafts saved before this rule may still use a ticket or visa account.
    if (!invoice.booking_id && !invoice.visa_id && !invoice.cancellation_id) assertServiceRevenue(db, items);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(invoice.customer_id);
    const entryId = postInvoice(db, invoice, customer, items);
    db.prepare(`
      UPDATE invoices SET status = 'sent', journal_entry_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(entryId, id);
    return getInvoice(db, id);
  })();
}

function voidInvoice(db, id, payload = {}) {
  return db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status === 'void') throw bad('Invoice is already void');
    // Job and cancellation invoices are owned by their workflow. A direct void
    // would reverse receipts without a refund and leave the job and its
    // supplier bills untouched.
    // Cancellation-charges invoices also carry the job id, so check them first.
    if (invoice.cancellation_id) {
      throw bad('This invoice holds cancellation charges. Issue a customer credit note to waive the charges instead of voiding it.');
    }
    if (invoice.booking_id || invoice.visa_id) {
      throw bad(`This invoice belongs to a ${invoice.booking_id ? 'booking' : 'visa application'}. Cancel the ${invoice.booking_id ? 'booking' : 'visa application'} instead so charges, refunds and supplier credits are handled.`);
    }
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);

    // A void must leave no live payment, refund or credit application behind.
    // Reverse the dependants first, then the invoice itself.
    const refundService = require('./refunds');
    const creditService = require('./credits');
    // Reverse credit applications before refunds. A customer refund checks
    // against the remaining paid balance, so leaving an applied credit in place
    // can make a fully reversible invoice look overpaid.
    const applications = db.prepare('SELECT id FROM credit_applications WHERE invoice_id = ? ORDER BY id').all(invoice.id);
    for (const application of applications) {
      creditService.deleteCreditApplication(db, application.id, {
        remarks: remarks || `Voided with invoice ${invoice.number}`,
      });
    }

    const refunds = db.prepare(`
      SELECT id FROM refunds
      WHERE status = 'paid' AND (
        invoice_id = ? OR payment_id IN (SELECT id FROM payments WHERE invoice_id = ?)
      )
      ORDER BY id
    `).all(invoice.id, invoice.id);
    for (const refund of refunds) {
      refundService.voidRefund(db, refund.id, {
        remarks: remarks || `Voided with invoice ${invoice.number}`,
      });
    }

    const payments = db.prepare("SELECT id FROM payments WHERE invoice_id = ? AND status = 'posted' ORDER BY id").all(invoice.id);
    for (const payment of payments) {
      deleteInvoicePayment(db, payment.id, {
        remarks: remarks || `Voided with invoice ${invoice.number}`,
      });
    }

    const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
    if (fresh.amount_paid_cents > 0 || fresh.credit_applied_cents > 0) {
      throw bad('Linked payments or credits could not be fully reversed');
    }
    if (fresh.status === 'sent' && fresh.journal_entry_id) {
      reverseEntry(db, fresh.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void invoice ${fresh.number}`, remarks),
        source_type: 'void',
      });
    }
    db.prepare(`UPDATE invoices SET status = 'void', updated_at = datetime('now') WHERE id = ?`).run(id);
    audit.record(db, {
      entity_type: 'invoice',
      entity_id: invoice.id,
      entity_number: invoice.number,
      action: 'void',
      remarks: remarks || `Voided invoice ${invoice.number}`,
      amount_cents: invoice.total_cents,
      metadata: {
        refunds_voided: refunds.length,
        credit_applications_reversed: applications.length,
        payments_voided: payments.length,
      },
    });
    return getInvoice(db, id);
  })();
}

// Cancellation voids the invoice but deliberately keeps every receipt and
// refund in place. The caller must first reverse applied credit notes.
function voidInvoiceForCancellation(db, id, { entryDate, memo } = {}) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) throw notFound('Invoice not found');
  if (invoice.status === 'void') return getInvoice(db, id);
  if (invoice.status === 'draft') throw bad('Only a sent invoice can be cancelled');
  if (invoice.credit_applied_cents > 0) {
    throw bad('Reverse applied customer credits before cancelling this invoice');
  }
  if (invoice.journal_entry_id) {
    reverseEntry(db, invoice.journal_entry_id, {
      entry_date: entryDate || todayISO(),
      memo: memo || `Cancel invoice ${invoice.number}`,
      source_type: 'void',
    });
  }
  db.prepare(`UPDATE invoices SET status = 'void', updated_at = datetime('now') WHERE id = ?`).run(id);
  return getInvoice(db, id);
}

function deleteInvoice(db, id) {
  return db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'draft') throw bad('Only draft invoices can be deleted. Void it instead.');
    db.prepare("DELETE FROM attachments WHERE entity_type = 'invoice' AND entity_id = ?").run(id);
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
    if (paymentDate < invoice.issue_date) {
      throw bad(`Payment date cannot be before the invoice date (${invoice.issue_date}). Record money received earlier as a customer advance.`);
    }
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payload.deposit_account_id));
    if (!account) throw bad('Choose a deposit account');
    if (!account.is_active) throw bad('That deposit account is archived');
    if (!isCashAccount(account)) throw bad('Deposit account must be an active cash or bank account');
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(invoice.customer_id);
    const ar = systemAccount(db, '1100', 'Trade Receivables');
    const number = allocateNumber(db, 'payment', paymentDate);
    const method = optionalStr(payload.method, 'Payment method', 100) || 'Bank transfer';
    const isCheque = ['Cheque', 'Check'].includes(method);
    const chequeNumber = optionalStr(payload.cheque_number, 'Cheque number', 100);
    if (isCheque && !chequeNumber) throw bad('Enter the cheque number');
    const chequeDate = payload.cheque_date
      ? dateISO(payload.cheque_date, 'Cheque date')
      : (isCheque ? paymentDate : null);
    const bankName = optionalStr(payload.bank_name, 'Bank name', 100);
    // The customer settles the full amount; what the bank keeps is our cost.
    const charges = bankChargesCents(payload, { max: amount });

    const info = db.prepare(`
      INSERT INTO payments (
        number, customer_id, invoice_id, payment_date, amount_cents, method, reference,
        cheque_number, cheque_date, bank_name, deposit_account_id, bank_charges_cents
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      charges,
    );
    const paymentId = Number(info.lastInsertRowid);
    markCreated(db, 'payments', paymentId);
    const entryId = postEntry(db, {
      entry_date: paymentDate,
      memo: `Payment ${number} — ${customer.name} (invoice ${invoice.number})${chequeNumber ? ` · cheque ${chequeNumber}` : ''}`,
      reference: invoice.number,
      source_type: 'payment',
      source_id: paymentId,
      lines: [
        { account_id: account.id, debit_cents: amount, credit_cents: 0, description: `Payment ${number}${chequeNumber ? ` · Cheque ${chequeNumber}` : ''}` },
        { account_id: ar.id, debit_cents: 0, credit_cents: amount, description: `Invoice ${invoice.number}` },
        ...bankChargeLines(db, charges, account, `payment ${number}`),
      ],
    });
    db.prepare('UPDATE payments SET journal_entry_id = ? WHERE id = ?').run(entryId, paymentId);
    db.prepare(`
      UPDATE invoices SET amount_paid_cents = amount_paid_cents + ?, updated_at = datetime('now') WHERE id = ?
    `).run(amount, invoice.id);
    return getInvoice(db, invoiceId);
  })();
}

function deleteInvoicePayment(db, paymentId, payload = {}) {
  return db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) throw notFound('Payment not found');
    if (payment.status === 'void') throw bad('That payment is already void');
    // A payment made from a visa security deposit is undone from the deposit
    // card, which also restores the deposit held (2600 stays matched).
    if (payment.deposit_id && !payload.fromDeposit) {
      const deposit = db.prepare('SELECT number FROM visa_deposits WHERE id = ?').get(payment.deposit_id);
      throw bad(`Payment ${payment.number} was made from visa deposit ${deposit?.number || ''}. Void the "Applied to invoice" step on the visa's Security deposit card first.`);
    }
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(payment.invoice_id);
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status === 'void') {
      throw bad('Payments cannot be voided on a void invoice. The cancellation already accounts for the money received.');
    }
    const refundCount = db.prepare(`
      SELECT COUNT(*) AS c FROM refunds WHERE payment_id = ? AND status = 'paid'
    `).get(paymentId).c;
    if (refundCount > 0) {
      throw bad('This payment has refunds. Void the refunds before voiding the payment.');
    }
    let voidEntryId = null;
    if (payment.journal_entry_id) {
      voidEntryId = reverseEntry(db, payment.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void payment ${payment.number}`, remarks),
        source_type: 'void',
      });
    }
    db.prepare(`
      UPDATE payments SET status = 'void', void_entry_id = ?, voided_at = datetime('now') WHERE id = ?
    `).run(voidEntryId, paymentId);
    db.prepare(`
      UPDATE invoices SET amount_paid_cents = MAX(0, amount_paid_cents - ?), updated_at = datetime('now') WHERE id = ?
    `).run(payment.amount_cents, payment.invoice_id);
    if (payment.advance_id) {
      const advance = db.prepare('SELECT * FROM customer_advances WHERE id = ?').get(payment.advance_id);
      if (advance) {
        const applied = Math.max(0, advance.applied_cents - payment.amount_cents);
        let status = 'open';
        if (advance.refunded_cents > 0 && applied + advance.refunded_cents >= advance.amount_cents) status = 'refunded';
        else if (applied + advance.refunded_cents >= advance.amount_cents) status = 'applied';
        db.prepare('UPDATE customer_advances SET applied_cents = ?, status = ? WHERE id = ?').run(applied, status, advance.id);
      }
    }
    audit.record(db, {
      entity_type: 'payment',
      entity_id: payment.id,
      entity_number: payment.number,
      action: 'void',
      remarks: remarks || `Voided payment ${payment.number}`,
      amount_cents: payment.amount_cents,
      metadata: { invoice_id: invoice.id, invoice_number: invoice.number },
    });
    return getInvoice(db, invoice.id);
  })();
}

// Everything a printed receipt voucher needs for one customer payment.
function getPaymentReceipt(db, paymentId) {
  const payment = db.prepare(`
    SELECT p.*, a.name AS deposit_account_name,
           i.number AS invoice_number, i.issue_date AS invoice_issue_date, i.status AS invoice_status,
           i.total_cents AS invoice_total_cents, i.amount_paid_cents AS invoice_paid_cents,
           i.credit_applied_cents AS invoice_credit_cents, i.booking_id, i.visa_id,
           c.name AS customer_name, c.address AS customer_address, c.email AS customer_email, c.phone AS customer_phone,
           (SELECT number FROM bookings WHERE id = i.booking_id) AS booking_number,
           (SELECT number FROM visa_applications WHERE id = i.visa_id) AS visa_number,
           (SELECT is_receipt FROM customer_advances WHERE id = p.advance_id) AS advance_is_receipt,
           COALESCE((SELECT SUM(r.amount_cents) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'paid'), 0) AS refunded_cents
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    JOIN customers c ON c.id = p.customer_id
    JOIN accounts a ON a.id = p.deposit_account_id
    WHERE p.id = ?
  `).get(Number(paymentId));
  if (!payment) throw notFound('Payment not found');
  const { invoice_paid_cents: paid, invoice_credit_cents: credit, ...rest } = payment;
  return {
    ...rest,
    invoice_balance_cents: payment.invoice_status === 'void'
      ? 0
      : Math.max(0, payment.invoice_total_cents - paid - (credit || 0)),
  };
}

module.exports = {
  getPaymentReceipt,
  JOB_REVENUE_CODES,
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  finalizeInvoice,
  setPaymentLink,
  voidInvoice,
  voidInvoiceForCancellation,
  deleteInvoice,
  recordInvoicePayment,
  deleteInvoicePayment,
};
