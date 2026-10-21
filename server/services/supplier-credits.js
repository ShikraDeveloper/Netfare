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
  isPurchaseAccount,
  postEntry,
  reverseEntry,
  billBalanceCents,
} = require('../accounting');
const { allocateNumber } = require('./numbering');
const portalService = require('./portals');

const creditSelect = `
  SELECT scn.*, v.name AS vendor_name, v.email AS vendor_email,
         v.phone AS vendor_phone, v.address AS vendor_address,
         b.number AS bill_number, b.total_cents AS bill_total_cents,
         bk.number AS booking_number, vi.number AS visa_number,
         cc.number AS cancellation_number,
         (scn.amount_cents - scn.applied_cents - scn.refunded_cents - scn.portal_settled_cents) AS remaining_cents
  FROM supplier_credit_notes scn
  JOIN vendors v ON v.id = scn.vendor_id
  LEFT JOIN bills b ON b.id = scn.bill_id
  LEFT JOIN bookings bk ON bk.id = scn.booking_id
  LEFT JOIN visa_applications vi ON vi.id = scn.visa_id
  LEFT JOIN cancellations cc ON cc.id = scn.cancellation_id
`;

function remainingCents(note) {
  if (!note || note.status === 'void') return 0;
  return Math.max(0, note.amount_cents - note.applied_cents - note.refunded_cents - note.portal_settled_cents);
}

function serializeCredit(row) {
  return {
    ...row,
    remaining_cents: remainingCents(row),
    status_display: row.status === 'void' ? 'void' : (remainingCents(row) > 0 ? 'open' : 'used'),
  };
}

function getSupplierCredit(db, id) {
  const credit = db.prepare(`${creditSelect} WHERE scn.id = ?`).get(Number(id));
  if (!credit) throw notFound('Supplier credit note not found');
  credit.items = db.prepare(`
    SELECT sci.*, a.code AS account_code, a.name AS account_name
    FROM supplier_credit_items sci
    JOIN accounts a ON a.id = sci.account_id
    WHERE sci.credit_note_id = ?
    ORDER BY sci.sort_order, sci.id
  `).all(credit.id);
  credit.applications = db.prepare(`
    SELECT sca.*, b.number AS bill_number, b.total_cents AS bill_total_cents
    FROM supplier_credit_applications sca
    JOIN bills b ON b.id = sca.bill_id
    WHERE sca.credit_note_id = ?
    ORDER BY sca.applied_date, sca.id
  `).all(credit.id);
  credit.refunds = db.prepare(`
    SELECT r.*, a.name AS account_name
    FROM refunds r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.supplier_credit_note_id = ?
    ORDER BY r.refund_date, r.id
  `).all(credit.id);
  credit.portal_credits = db.prepare(`
    SELECT pc.*, p.name AS portal_name
    FROM portal_credits pc
    JOIN supplier_portals p ON p.id = pc.portal_id
    WHERE pc.supplier_credit_note_id = ?
    ORDER BY pc.credit_date, pc.id
  `).all(credit.id);
  return serializeCredit(credit);
}

function listSupplierCredits(db, { status, vendor_id, bill_id, search, from, to, open } = {}) {
  const clauses = [];
  const params = [];
  if (status && status !== 'all') {
    if (!['issued', 'void'].includes(status)) throw bad('Supplier credit status must be issued or void');
    clauses.push('scn.status = ?');
    params.push(status);
  }
  if (vendor_id) {
    clauses.push('scn.vendor_id = ?');
    params.push(Number(vendor_id));
  }
  if (bill_id) {
    clauses.push('scn.bill_id = ?');
    params.push(Number(bill_id));
  }
  if (from) {
    clauses.push('scn.credit_date >= ?');
    params.push(dateISO(from, 'From date'));
  }
  if (to) {
    clauses.push('scn.credit_date <= ?');
    params.push(dateISO(to, 'To date'));
  }
  if (search) {
    clauses.push('(scn.number LIKE ? OR v.name LIKE ? OR scn.notes LIKE ? OR b.number LIKE ?)');
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term, term);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  let rows = db.prepare(`${creditSelect} ${where} ORDER BY scn.credit_date DESC, scn.id DESC`)
    .all(...params)
    .map(serializeCredit);
  if (open === true || open === '1' || open === 'true') {
    rows = rows.filter((row) => row.status === 'issued' && row.remaining_cents > 0);
  }
  return rows;
}

function assertVendor(db, vendorId, { allowArchived = false } = {}) {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(vendorId));
  if (!vendor) throw bad('Choose a vendor');
  if (!vendor.is_active && !allowArchived) throw bad('That vendor is archived');
  return vendor;
}

function assertCostAccount(db, accountId, label = 'account') {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!account) throw bad(`Choose a ${label}`);
  if (!account.is_active) throw bad(`Account "${account.name}" is archived`);
  if (!isPurchaseAccount(account)) {
    throw bad(`"${account.name}" is not a valid cost or asset account for a supplier credit`);
  }
  return account;
}

function normalizeManualItems(db, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw bad('Add at least one credit line');
  }
  return items.map((item, index) => {
    const label = `Line ${index + 1}`;
    const account = assertCostAccount(db, item.account_id, `${label} cost account`);
    let amount;
    if (item.amount_cents != null && item.amount_cents !== '') {
      amount = cents(item.amount_cents, `${label} amount`, { min: 1 });
    } else {
      const quantity = Number(item.quantity ?? 1);
      const unitPrice = cents(item.unit_price_cents, `${label} unit price`, { min: 1 });
      if (!Number.isFinite(quantity) || quantity <= 0) throw bad(`${label} quantity must be greater than zero`);
      amount = Math.round(quantity * unitPrice);
    }
    return {
      description: str(item.description, `${label} description`, { max: 300 }),
      amount_cents: amount,
      account_id: account.id,
    };
  });
}

// Split a credit across the original bill lines so each cost account is
// reduced in proportion to the bill. The last line absorbs rounding.
function itemsFromBill(db, billId, amount) {
  const items = db.prepare(`
    SELECT bi.*, a.name AS account_name
    FROM bill_items bi
    JOIN accounts a ON a.id = bi.account_id
    WHERE bi.bill_id = ?
    ORDER BY bi.sort_order, bi.id
  `).all(billId);
  if (!items.length) throw bad('This bill has no lines to credit');
  const total = items.reduce((sum, item) => sum + item.amount_cents, 0);
  if (total <= 0) throw bad('This bill has no value to credit');
  if (amount > total) throw bad('A supplier credit cannot exceed the bill total');
  let allocated = 0;
  return items.map((item, index) => {
    const share = index === items.length - 1
      ? amount - allocated
      : Math.floor((amount * item.amount_cents) / total);
    allocated += share;
    return {
      description: item.description,
      amount_cents: share,
      account_id: item.account_id,
    };
  }).filter((item) => item.amount_cents > 0);
}

function issueEntry(db, { creditId, number, vendorName, creditDate, items }) {
  const supplierCredits = systemAccount(db, '1450', 'Supplier Credits');
  const grouped = new Map();
  for (const item of items) {
    grouped.set(item.account_id, (grouped.get(item.account_id) || 0) + item.amount_cents);
  }
  const lines = [{
    account_id: supplierCredits.id,
    debit_cents: items.reduce((sum, item) => sum + item.amount_cents, 0),
    credit_cents: 0,
    description: `Supplier credit ${number}`,
  }];
  for (const [accountId, amount] of grouped.entries()) {
    lines.push({
      account_id: accountId,
      debit_cents: 0,
      credit_cents: amount,
      description: `Supplier credit ${number}`,
    });
  }
  return postEntry(db, {
    entry_date: creditDate,
    memo: `Supplier credit ${number} — ${vendorName}`,
    reference: number,
    source_type: 'supplier_credit',
    source_id: creditId,
    lines,
  });
}

function insertSupplierCredit(db, payload, { applyToBill = false } = {}) {
  const vendor = assertVendor(db, payload.vendor_id, { allowArchived: Boolean(payload.cancellation_id) });
  const creditDate = dateISO(payload.credit_date || todayISO(), 'Credit date');
  let bill = null;
  if (payload.bill_id) {
    bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(payload.bill_id));
    if (!bill) throw bad('Choose a valid bill');
    if (bill.vendor_id !== vendor.id) throw bad('Choose a bill from the same vendor');
    if (!['received', 'void'].includes(bill.status)) throw bad('Supplier credits can only be linked to a received bill');
    if (bill.status === 'void') throw bad('Cannot credit a void bill');
  }
  if (payload.booking_id) {
    const booking = db.prepare('SELECT id, customer_id FROM bookings WHERE id = ?').get(Number(payload.booking_id));
    if (!booking) throw bad('Choose a valid booking');
  }
  if (payload.visa_id) {
    const visa = db.prepare('SELECT id FROM visa_applications WHERE id = ?').get(Number(payload.visa_id));
    if (!visa) throw bad('Choose a valid visa');
  }
  if (payload.cancellation_id) {
    const cancellation = db.prepare('SELECT * FROM cancellations WHERE id = ?').get(Number(payload.cancellation_id));
    if (!cancellation) throw bad('Choose a valid cancellation');
  }

  let items;
  if (Array.isArray(payload.items) && payload.items.length) {
    items = normalizeManualItems(db, payload.items);
  } else if (bill) {
    const amount = cents(payload.amount_cents, 'Credit amount', { min: 1 });
    items = itemsFromBill(db, bill.id, amount);
  } else {
    throw bad('Add at least one credit line');
  }
  const amount = items.reduce((sum, item) => sum + item.amount_cents, 0);
  if (amount <= 0) throw bad('Supplier credit must be greater than zero');
  if (payload.amount_cents != null && payload.amount_cents !== '' && Array.isArray(payload.items) && payload.items.length) {
    const requested = cents(payload.amount_cents, 'Credit amount', { min: 1 });
    if (requested !== amount) throw bad('Credit amount must equal the sum of its lines');
  }
  if (bill) {
    const existing = db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total
      FROM supplier_credit_notes
      WHERE bill_id = ? AND status = 'issued'
    `).get(bill.id).total;
    if (existing + amount > bill.total_cents) {
      throw bad(`Supplier credits would exceed the bill total of ${(bill.total_cents / 100).toFixed(2)}`);
    }
  }

  const number = allocateNumber(db, 'supplier_credit', creditDate);
  const info = db.prepare(`
    INSERT INTO supplier_credit_notes (
      number, vendor_id, bill_id, booking_id, visa_id, cancellation_id,
      credit_date, amount_cents, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    number,
    vendor.id,
    bill ? bill.id : null,
    payload.booking_id ? Number(payload.booking_id) : null,
    payload.visa_id ? Number(payload.visa_id) : null,
    payload.cancellation_id ? Number(payload.cancellation_id) : null,
    creditDate,
    amount,
    optionalStr(payload.notes, 'Notes', 2000),
  );
  const creditId = Number(info.lastInsertRowid);
  const insertItem = db.prepare(`
    INSERT INTO supplier_credit_items (credit_note_id, description, amount_cents, account_id, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  items.forEach((item, index) => {
    insertItem.run(creditId, item.description, item.amount_cents, item.account_id, index);
  });
  const entryId = issueEntry(db, {
    creditId,
    number,
    vendorName: vendor.name,
    creditDate,
    items,
  });
  db.prepare('UPDATE supplier_credit_notes SET journal_entry_id = ? WHERE id = ?').run(entryId, creditId);

  if (applyToBill && bill) {
    const note = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(creditId);
    const balance = billBalanceCents(db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id));
    const applyAmount = Math.min(remainingCents(note), balance);
    if (applyAmount > 0) applySupplierCreditRow(db, creditId, bill.id, applyAmount, creditDate);
    const refreshed = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(creditId);
    const left = remainingCents(refreshed);
    if (left > 0 && bill.portal_id) {
      const portal = db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(bill.portal_id);
      if (portal && portal.settlement === 'prepaid') {
        portalService.recordPortalCredit(db, {
          portal_id: portal.id,
          bill_id: bill.id,
          supplier_credit_note_id: creditId,
          credit_date: creditDate,
          amount_cents: left,
          notes: `Supplier credit ${number} moved to portal wallet`,
        });
      }
    }
  }
  return creditId;
}

function createSupplierCredit(db, payload = {}) {
  return db.transaction(() => {
    const id = insertSupplierCredit(db, payload, { applyToBill: false });
    return getSupplierCredit(db, id);
  })();
}

// Called inside a cancellation transaction after the cancellation row exists.
function createSupplierCreditForCancellation(db, payload) {
  return insertSupplierCredit(db, payload, { applyToBill: true });
}

function applySupplierCreditRow(db, creditId, billId, amount, appliedDate) {
  const ap = systemAccount(db, '2000', 'Accounts Payable');
  const supplierCredits = systemAccount(db, '1450', 'Supplier Credits');
  const info = db.prepare(`
    INSERT INTO supplier_credit_applications (credit_note_id, bill_id, applied_date, amount_cents)
    VALUES (?, ?, ?, ?)
  `).run(creditId, billId, appliedDate, amount);
  const applicationId = Number(info.lastInsertRowid);
  const number = db.prepare('SELECT number FROM supplier_credit_notes WHERE id = ?').get(creditId).number;
  const billNumber = db.prepare('SELECT number FROM bills WHERE id = ?').get(billId).number;
  const entryId = postEntry(db, {
    entry_date: appliedDate,
    memo: `Supplier credit ${number} applied to bill ${billNumber}`,
    reference: billNumber,
    source_type: 'supplier_credit_applied',
    source_id: applicationId,
    lines: [
      { account_id: ap.id, debit_cents: amount, credit_cents: 0, description: `Bill ${billNumber}` },
      { account_id: supplierCredits.id, debit_cents: 0, credit_cents: amount, description: `Supplier credit ${number}` },
    ],
  });
  db.prepare('UPDATE supplier_credit_applications SET journal_entry_id = ? WHERE id = ?').run(entryId, applicationId);
  db.prepare('UPDATE supplier_credit_notes SET applied_cents = applied_cents + ? WHERE id = ?').run(amount, creditId);
  db.prepare(`
    UPDATE bills SET credit_applied_cents = credit_applied_cents + ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(amount, billId);
  return applicationId;
}

function applySupplierCredit(db, creditId, payload = {}) {
  return db.transaction(() => {
    const credit = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(Number(creditId));
    if (!credit) throw notFound('Supplier credit note not found');
    if (credit.status !== 'issued') throw bad('Only issued supplier credits can be applied');
    const remaining = remainingCents(credit);
    if (remaining <= 0) throw bad('This supplier credit has no remaining balance');
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(payload.bill_id));
    if (!bill) throw bad('Choose a bill');
    if (bill.vendor_id !== credit.vendor_id) throw bad('Choose an open bill for the same vendor');
    if (bill.status !== 'received') throw bad('Supplier credits can only be applied to received bills');
    const amount = cents(payload.amount_cents, 'Credit amount', { min: 1 });
    if (amount > remaining) throw bad(`Credit amount exceeds the remaining balance of ${(remaining / 100).toFixed(2)}`);
    const balance = billBalanceCents(bill);
    if (amount > balance) throw bad(`Credit amount exceeds the bill balance of ${(balance / 100).toFixed(2)}`);
    const appliedDate = dateISO(payload.applied_date || todayISO(), 'Applied date');
    if (appliedDate < credit.credit_date) {
      throw bad('Application date cannot be before the supplier credit date');
    }
    applySupplierCreditRow(db, credit.id, bill.id, amount, appliedDate);
    return getSupplierCredit(db, credit.id);
  })();
}

function deleteSupplierCreditApplication(db, applicationId) {
  return db.transaction(() => {
    const application = db.prepare('SELECT * FROM supplier_credit_applications WHERE id = ?').get(Number(applicationId));
    if (!application) throw notFound('Supplier credit application not found');
    const credit = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(application.credit_note_id);
    if (!credit) throw notFound('Supplier credit note not found');
    if (credit.status === 'void') throw bad('This supplier credit is void');
    if (application.journal_entry_id) {
      reverseEntry(db, application.journal_entry_id, {
        entry_date: todayISO(),
        memo: `Reverse supplier credit application ${credit.number}`,
        source_type: 'void',
      });
    }
    db.prepare('DELETE FROM supplier_credit_applications WHERE id = ?').run(application.id);
    db.prepare(`
      UPDATE supplier_credit_notes SET applied_cents = MAX(0, applied_cents - ?) WHERE id = ?
    `).run(application.amount_cents, credit.id);
    db.prepare(`
      UPDATE bills SET credit_applied_cents = MAX(0, credit_applied_cents - ?), updated_at = datetime('now')
      WHERE id = ?
    `).run(application.amount_cents, application.bill_id);
    return getSupplierCredit(db, credit.id);
  })();
}

function refundSupplierCredit(db, creditId, payload = {}) {
  return db.transaction(() => {
    const credit = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(Number(creditId));
    if (!credit) throw notFound('Supplier credit note not found');
    if (credit.status !== 'issued') throw bad('Only issued supplier credits can be refunded');
    const remaining = remainingCents(credit);
    if (remaining <= 0) throw bad('This supplier credit has no remaining balance');
    const amount = cents(payload.amount_cents, 'Refund amount', { min: 1 });
    if (amount > remaining) throw bad(`Refund exceeds the remaining credit of ${(remaining / 100).toFixed(2)}`);
    const refundDate = dateISO(payload.refund_date || todayISO(), 'Refund date');
    if (refundDate < credit.credit_date) {
      throw bad('Refund date cannot be before the supplier credit date');
    }
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payload.account_id));
    if (!account) throw bad('Choose a bank or cash account');
    if (!account.is_active) throw bad('That account is archived');
    if (!isCashAccount(account)) throw bad('Refunds must be paid from a bank or cash account');
    const method = optionalStr(payload.method, 'Refund method', 100) || 'Bank transfer';
    const supplierCredits = systemAccount(db, '1450', 'Supplier Credits');
    const number = allocateNumber(db, 'refund', refundDate);
    const info = db.prepare(`
      INSERT INTO refunds (
        number, refund_type, party_id, bill_id, supplier_credit_note_id,
        refund_date, amount_cents, method, reference, notes, account_id
      ) VALUES (?, 'supplier', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      credit.vendor_id,
      credit.bill_id,
      credit.id,
      refundDate,
      amount,
      method,
      optionalStr(payload.reference, 'Reference', 200),
      optionalStr(payload.notes, 'Notes', 2000) || `Cash refund of supplier credit ${credit.number}`,
      account.id,
    );
    const refundId = Number(info.lastInsertRowid);
    const entryId = postEntry(db, {
      entry_date: refundDate,
      memo: `Supplier credit refund ${number} — ${credit.number}`,
      reference: credit.number,
      source_type: 'refund',
      source_id: refundId,
      lines: [
        { account_id: account.id, debit_cents: amount, credit_cents: 0, description: `Supplier credit refund ${number}` },
        { account_id: supplierCredits.id, debit_cents: 0, credit_cents: amount, description: `Supplier credit ${credit.number}` },
      ],
    });
    db.prepare('UPDATE refunds SET journal_entry_id = ? WHERE id = ?').run(entryId, refundId);
    db.prepare('UPDATE supplier_credit_notes SET refunded_cents = refunded_cents + ? WHERE id = ?').run(amount, credit.id);
    return getSupplierCredit(db, credit.id);
  })();
}

function voidSupplierCredit(db, creditId) {
  return db.transaction(() => {
    const credit = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(Number(creditId));
    if (!credit) throw notFound('Supplier credit note not found');
    if (credit.status === 'void') throw bad('This supplier credit is already void');
    const activity = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM supplier_credit_applications WHERE credit_note_id = ?) AS applications,
        (SELECT COUNT(*) FROM refunds WHERE supplier_credit_note_id = ? AND status = 'paid') AS refunds,
        (SELECT COUNT(*) FROM portal_credits WHERE supplier_credit_note_id = ?) AS portal_credits
    `).get(credit.id, credit.id, credit.id);
    if (activity.applications || activity.refunds || activity.portal_credits
      || credit.applied_cents || credit.refunded_cents || credit.portal_settled_cents) {
      throw bad('Only an unused supplier credit can be voided. Reverse its applications, refunds or portal movement first.');
    }
    let voidEntryId = null;
    if (credit.journal_entry_id) {
      voidEntryId = reverseEntry(db, credit.journal_entry_id, {
        entry_date: todayISO(),
        memo: `Void supplier credit ${credit.number}`,
        source_type: 'void',
      });
    }
    db.prepare(`
      UPDATE supplier_credit_notes SET status = 'void', void_entry_id = ?, applied_cents = 0,
        refunded_cents = 0, portal_settled_cents = 0 WHERE id = ?
    `).run(voidEntryId, credit.id);
    return getSupplierCredit(db, credit.id);
  })();
}

function supplierCreditReconciliation(db) {
  const account = db.prepare("SELECT * FROM accounts WHERE code = '1450'").get();
  const balance = db.prepare(`
    SELECT COALESCE(SUM(debit_cents - credit_cents), 0) AS total
    FROM journal_lines WHERE account_id = ?
  `).get(account.id).total;
  const open = db.prepare(`
    SELECT COALESCE(SUM(amount_cents - applied_cents - refunded_cents - portal_settled_cents), 0) AS total
    FROM supplier_credit_notes WHERE status = 'issued'
  `).get().total;
  return {
    account_id: account.id,
    account_code: account.code,
    account_name: account.name,
    account_balance_cents: balance,
    open_credit_cents: open,
    difference_cents: balance - open,
    matched: balance === open,
  };
}

function supplierCreditsForSource(db, { bookingId, visaId, cancellationId } = {}) {
  const clauses = [];
  const params = [];
  if (bookingId) {
    clauses.push('scn.booking_id = ?');
    params.push(Number(bookingId));
  }
  if (visaId) {
    clauses.push('scn.visa_id = ?');
    params.push(Number(visaId));
  }
  if (cancellationId) {
    clauses.push('scn.cancellation_id = ?');
    params.push(Number(cancellationId));
  }
  if (!clauses.length) return [];
  return db.prepare(`${creditSelect} WHERE ${clauses.join(' OR ')} ORDER BY scn.credit_date, scn.id`)
    .all(...params)
    .map(serializeCredit);
}

module.exports = {
  listSupplierCredits,
  getSupplierCredit,
  createSupplierCredit,
  createSupplierCreditForCancellation,
  applySupplierCredit,
  deleteSupplierCreditApplication,
  refundSupplierCredit,
  voidSupplierCredit,
  supplierCreditReconciliation,
  supplierCreditsForSource,
  itemsFromBill,
};
