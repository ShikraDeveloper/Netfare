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
const { systemAccount, isCashAccount, postEntry, reverseEntry } = require('../accounting');
const { allocateNumber } = require('./numbering');

const SUPPLIER_ADVANCES = '1400';
const AP = '2000';

const PORTAL_TYPES = ['airline', 'iata_agency', 'consolidator', 'gds', 'other'];
const SETTLEMENTS = ['prepaid', 'credit'];

const portalSelect = `
  SELECT p.*, v.name AS vendor_name
  FROM supplier_portals p
  LEFT JOIN vendors v ON v.id = p.vendor_id
`;

// ---------------------------------------------------------------------------
// Balance helpers
//
// A portal balance is derived, never stored:
//   balance = top-ups − withdrawals − value already consumed by bills
// Because bill payments tagged with a portal_id are the consumption record,
// deleting such a payment automatically restores the balance.
// ---------------------------------------------------------------------------

function aggregates(db) {
  const topups = new Map();
  const refunds = new Map();
  const consumed = new Map();
  for (const row of db.prepare(
    'SELECT portal_id, COALESCE(SUM(amount_cents), 0) AS total FROM portal_topups GROUP BY portal_id',
  ).all()) topups.set(row.portal_id, row.total);
  for (const row of db.prepare(
    'SELECT portal_id, COALESCE(SUM(amount_cents), 0) AS total FROM portal_refunds GROUP BY portal_id',
  ).all()) refunds.set(row.portal_id, row.total);
  for (const row of db.prepare(
    'SELECT portal_id, COALESCE(SUM(amount_cents), 0) AS total FROM bill_payments WHERE portal_id IS NOT NULL GROUP BY portal_id',
  ).all()) consumed.set(row.portal_id, row.total);
  return { topups, refunds, consumed };
}

function outstandingByVendor(db) {
  const map = new Map();
  const rows = db.prepare(`
    SELECT vendor_id, COALESCE(SUM(total_cents - amount_paid_cents), 0) AS outstanding
    FROM bills
    WHERE status = 'received'
    GROUP BY vendor_id
  `).all();
  for (const row of rows) map.set(row.vendor_id, Math.max(0, row.outstanding));
  return map;
}

function lockBalance(db, portalId) {
  const topup = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM portal_topups WHERE portal_id = ?').get(portalId).t;
  const refunded = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM portal_refunds WHERE portal_id = ?').get(portalId).t;
  const consumed = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM bill_payments WHERE portal_id = ?').get(portalId).t;
  return topup - refunded - consumed;
}

function serializePortal(portal, agg, outstanding) {
  const topup = agg.topups.get(portal.id) || 0;
  const refunded = agg.refunds.get(portal.id) || 0;
  const consumed = agg.consumed.get(portal.id) || 0;
  const balance = topup - refunded - consumed;
  const outstandingAp = portal.vendor_id ? (outstanding.get(portal.vendor_id) || 0) : 0;
  return {
    ...portal,
    topup_total_cents: topup,
    refunded_total_cents: refunded,
    consumed_total_cents: consumed,
    balance_cents: balance,
    outstanding_ap_cents: outstandingAp,
    credit_available_cents: portal.settlement === 'credit' && portal.credit_limit_cents > 0
      ? Math.max(0, portal.credit_limit_cents - outstandingAp)
      : 0,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function listPortals(db, { search, settlement, type, status } = {}) {
  const agg = aggregates(db);
  const outstanding = outstandingByVendor(db);
  let rows = db.prepare(`${portalSelect} ORDER BY p.is_active DESC, p.name COLLATE NOCASE`)
    .all()
    .map((portal) => serializePortal(portal, agg, outstanding));

  if (search) {
    const term = String(search).trim().toLowerCase();
    rows = rows.filter((portal) => (
      portal.name.toLowerCase().includes(term)
      || (portal.vendor_name || '').toLowerCase().includes(term)
      || (portal.login_ref || '').toLowerCase().includes(term)
    ));
  }
  if (settlement && settlement !== 'all') rows = rows.filter((portal) => portal.settlement === settlement);
  if (type && type !== 'all') rows = rows.filter((portal) => portal.portal_type === type);
  if (status === 'active') rows = rows.filter((portal) => portal.is_active);
  if (status === 'archived') rows = rows.filter((portal) => !portal.is_active);
  return rows;
}

function getPortal(db, id) {
  const portal = db.prepare(`${portalSelect} WHERE p.id = ?`).get(id);
  if (!portal) throw notFound('Portal not found');
  const result = serializePortal(portal, aggregates(db), outstandingByVendor(db));

  result.topups = db.prepare(`
    SELECT t.*, a.name AS deposit_account_name
    FROM portal_topups t
    JOIN accounts a ON a.id = t.deposit_account_id
    WHERE t.portal_id = ?
    ORDER BY t.topup_date DESC, t.id DESC
  `).all(id);

  result.refunds = db.prepare(`
    SELECT r.*, a.name AS payment_account_name
    FROM portal_refunds r
    JOIN accounts a ON a.id = r.payment_account_id
    WHERE r.portal_id = ?
    ORDER BY r.refund_date DESC, r.id DESC
  `).all(id);

  result.settlements = db.prepare(`
    SELECT bp.id, bp.number, bp.payment_date, bp.amount_cents, bp.reference, bp.journal_entry_id,
           b.id AS bill_id, b.number AS bill_number, b.total_cents AS bill_total_cents,
           b.status AS bill_status, b.booking_id AS booking_id, b.visa_id AS visa_id,
           v.name AS vendor_name
    FROM bill_payments bp
    JOIN bills b ON b.id = bp.bill_id
    JOIN vendors v ON v.id = bp.vendor_id
    WHERE bp.portal_id = ?
    ORDER BY bp.payment_date DESC, bp.id DESC
  `).all(id);

  result.open_bills = portal.vendor_id ? db.prepare(`
    SELECT b.id, b.number, b.bill_date, b.total_cents, b.amount_paid_cents,
           (b.total_cents - b.amount_paid_cents) AS balance_cents, b.booking_id, b.visa_id
    FROM bills b
    WHERE b.vendor_id = ? AND b.status = 'received' AND b.total_cents > b.amount_paid_cents
    ORDER BY b.bill_date, b.id
  `).all(portal.vendor_id) : [];

  return result;
}

function portalForVendor(db, vendorId) {
  if (!vendorId) return null;
  return db.prepare(
    'SELECT * FROM supplier_portals WHERE vendor_id = ? AND is_active = 1 ORDER BY id LIMIT 1',
  ).get(vendorId) || null;
}

function portalReport(db) {
  const agg = aggregates(db);
  const outstanding = outstandingByVendor(db);
  const rows = db.prepare(`${portalSelect} ORDER BY p.name COLLATE NOCASE`)
    .all()
    .map((portal) => serializePortal(portal, agg, outstanding));
  const totals = rows.reduce((acc, row) => {
    acc.topup_total_cents += row.topup_total_cents;
    acc.refunded_total_cents += row.refunded_total_cents;
    acc.consumed_total_cents += row.consumed_total_cents;
    acc.balance_cents += row.balance_cents;
    acc.outstanding_ap_cents += row.outstanding_ap_cents;
    return acc;
  }, {
    topup_total_cents: 0,
    refunded_total_cents: 0,
    consumed_total_cents: 0,
    balance_cents: 0,
    outstanding_ap_cents: 0,
  });
  return { rows, totals };
}

function portalStats(db) {
  const report = portalReport(db);
  return {
    count: report.rows.length,
    active_count: report.rows.filter((row) => row.is_active).length,
    prepaid_balance_cents: report.rows
      .filter((row) => row.settlement === 'prepaid')
      .reduce((sum, row) => sum + row.balance_cents, 0),
    balance_cents: report.totals.balance_cents,
    outstanding_ap_cents: report.totals.outstanding_ap_cents,
  };
}

// ---------------------------------------------------------------------------
// Portal master data
// ---------------------------------------------------------------------------

function normalizePortal(db, payload, existing = null) {
  const name = payload.name != null
    ? str(payload.name, 'Portal name', { max: 160 })
    : existing.name;

  const portalType = payload.portal_type != null
    ? String(payload.portal_type)
    : (existing ? existing.portal_type : 'other');
  if (!PORTAL_TYPES.includes(portalType)) throw bad('Choose a valid portal type');

  const settlement = payload.settlement != null
    ? String(payload.settlement)
    : (existing ? existing.settlement : 'prepaid');
  if (!SETTLEMENTS.includes(settlement)) throw bad('Choose prepaid or credit');

  let vendorId = existing ? existing.vendor_id : null;
  if (payload.vendor_id !== undefined) {
    if (payload.vendor_id === null || payload.vendor_id === '') {
      vendorId = null;
    } else {
      const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(payload.vendor_id));
      if (!vendor) throw bad('Choose a valid supplier');
      vendorId = vendor.id;
    }
  }

  const creditLimit = payload.credit_limit_cents != null
    ? cents(payload.credit_limit_cents, 'Credit limit')
    : (existing ? existing.credit_limit_cents : 0);

  const isActive = payload.is_active != null
    ? (payload.is_active ? 1 : 0)
    : (existing ? existing.is_active : 1);

  return {
    name,
    portal_type: portalType,
    settlement,
    vendor_id: vendorId,
    login_ref: optionalStr(payload.login_ref ?? (existing ? existing.login_ref : ''), 'Login / URL reference', 240),
    notes: optionalStr(payload.notes ?? (existing ? existing.notes : ''), 'Notes', 2000),
    credit_limit_cents: creditLimit,
    is_active: isActive,
  };
}

function createPortal(db, payload) {
  return db.transaction(() => {
    const data = normalizePortal(db, payload);
    const info = db.prepare(`
      INSERT INTO supplier_portals (name, portal_type, settlement, vendor_id, login_ref, notes, credit_limit_cents, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name,
      data.portal_type,
      data.settlement,
      data.vendor_id,
      data.login_ref,
      data.notes,
      data.credit_limit_cents,
      data.is_active,
    );
    return getPortal(db, Number(info.lastInsertRowid));
  })();
}

function updatePortal(db, id, payload) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(id);
    if (!existing) throw notFound('Portal not found');
    const data = normalizePortal(db, payload, existing);
    db.prepare(`
      UPDATE supplier_portals SET name = ?, portal_type = ?, settlement = ?, vendor_id = ?,
        login_ref = ?, notes = ?, credit_limit_cents = ?, is_active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      data.name,
      data.portal_type,
      data.settlement,
      data.vendor_id,
      data.login_ref,
      data.notes,
      data.credit_limit_cents,
      data.is_active,
      id,
    );
    return getPortal(db, id);
  })();
}

function deletePortal(db, id) {
  return db.transaction(() => {
    const portal = db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(id);
    if (!portal) throw notFound('Portal not found');
    const topups = db.prepare('SELECT COUNT(*) AS c FROM portal_topups WHERE portal_id = ?').get(id).c;
    const refunds = db.prepare('SELECT COUNT(*) AS c FROM portal_refunds WHERE portal_id = ?').get(id).c;
    const settlements = db.prepare('SELECT COUNT(*) AS c FROM bill_payments WHERE portal_id = ?').get(id).c;
    if (topups || refunds || settlements) {
      throw bad('This portal has activity. Archive it instead of deleting.');
    }
    db.prepare('DELETE FROM supplier_portals WHERE id = ?').run(id);
    return { deleted: true };
  })();
}

// ---------------------------------------------------------------------------
// Money movements
// ---------------------------------------------------------------------------

function assertAccount(db, accountId, label) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!account) throw bad(`Choose ${label}`);
  if (!account.is_active) throw bad(`That ${label} is archived`);
  if (!isCashAccount(account)) throw bad(`${label} must be an active bank or cash account`);
  return account;
}

function topUp(db, payload) {
  return db.transaction(() => {
    const portal = db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(Number(payload.portal_id));
    if (!portal) throw bad('Choose a portal');
    if (!portal.is_active) throw bad('That portal is archived');

    const amount = cents(payload.amount_cents, 'Top-up amount', { min: 1 });
    const date = dateISO(payload.topup_date || todayISO(), 'Top-up date');
    const account = assertAccount(db, payload.deposit_account_id, 'source account');
    const supplierAdvances = systemAccount(db, SUPPLIER_ADVANCES, 'Supplier Advances');
    const number = allocateNumber(db, 'topup', date);

    const info = db.prepare(`
      INSERT INTO portal_topups (number, portal_id, topup_date, amount_cents, method, reference, notes, deposit_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number,
      portal.id,
      date,
      amount,
      optionalStr(payload.method, 'Method', 100) || 'Bank transfer',
      optionalStr(payload.reference, 'Reference', 200),
      optionalStr(payload.notes, 'Notes', 2000),
      account.id,
    );
    const topupId = Number(info.lastInsertRowid);

    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Portal top-up ${number} — ${portal.name}`,
      reference: number,
      source_type: 'portal_topup',
      source_id: topupId,
      lines: [
        { account_id: supplierAdvances.id, debit_cents: amount, credit_cents: 0, description: `Top-up ${number} · ${portal.name}` },
        { account_id: account.id, debit_cents: 0, credit_cents: amount, description: `Top-up ${number}` },
      ],
    });
    db.prepare('UPDATE portal_topups SET journal_entry_id = ? WHERE id = ?').run(entryId, topupId);
    return getPortal(db, portal.id);
  })();
}

function deleteTopup(db, id) {
  return db.transaction(() => {
    const topup = db.prepare('SELECT * FROM portal_topups WHERE id = ?').get(id);
    if (!topup) throw notFound('Top-up not found');
    const balance = lockBalance(db, topup.portal_id);
    if (balance < topup.amount_cents) {
      throw bad('Part of this top-up has already been used. Withdraw the remaining balance instead of deleting.');
    }
    if (topup.journal_entry_id) {
      reverseEntry(db, topup.journal_entry_id, {
        entry_date: todayISO(),
        memo: `Reverse portal top-up ${topup.number}`,
        source_type: 'void',
      });
    }
    db.prepare('DELETE FROM portal_topups WHERE id = ?').run(id);
    return getPortal(db, topup.portal_id);
  })();
}

function refundPortal(db, id, payload = {}) {
  return db.transaction(() => {
    const portal = db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(id);
    if (!portal) throw notFound('Portal not found');

    const balance = lockBalance(db, id);
    if (balance <= 0) throw bad('This portal has no available balance to withdraw');
    const amount = payload.amount_cents == null
      ? balance
      : cents(payload.amount_cents, 'Withdrawal amount', { min: 1 });
    if (amount > balance) throw bad('Withdrawal is more than the available portal balance');

    const account = assertAccount(db, payload.payment_account_id, 'refund account');
    const supplierAdvances = systemAccount(db, SUPPLIER_ADVANCES, 'Supplier Advances');
    const date = dateISO(payload.refund_date || todayISO(), 'Refund date');

    const info = db.prepare(`
      INSERT INTO portal_refunds (portal_id, refund_date, amount_cents, method, reference, notes, payment_account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      portal.id,
      date,
      amount,
      optionalStr(payload.method, 'Method', 100) || 'Bank transfer',
      optionalStr(payload.reference, 'Reference', 200),
      optionalStr(payload.notes, 'Notes', 2000),
      account.id,
    );
    const refundId = Number(info.lastInsertRowid);

    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Portal withdrawal — ${portal.name}`,
      reference: portal.name,
      source_type: 'portal_refund',
      source_id: refundId,
      lines: [
        { account_id: account.id, debit_cents: amount, credit_cents: 0, description: `Withdrawal from ${portal.name}` },
        { account_id: supplierAdvances.id, debit_cents: 0, credit_cents: amount, description: `Withdrawal from ${portal.name}` },
      ],
    });
    db.prepare('UPDATE portal_refunds SET journal_entry_id = ? WHERE id = ?').run(entryId, refundId);
    return getPortal(db, portal.id);
  })();
}

function settleBillFromPortal(db, payload) {
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(payload.bill_id));
    if (!bill) throw bad('Choose a bill');
    if (bill.status !== 'received') throw bad('Only received bills can be settled from a portal');

    const billBalance = Math.max(0, bill.total_cents - bill.amount_paid_cents);
    if (billBalance <= 0) throw bad('That bill is already fully paid');

    const portal = payload.portal_id
      ? db.prepare('SELECT * FROM supplier_portals WHERE id = ?').get(Number(payload.portal_id))
      : portalForVendor(db, bill.vendor_id);
    if (!portal) throw bad('No portal is linked to this supplier');
    if (!portal.is_active) throw bad('That portal is archived');
    if (portal.vendor_id && portal.vendor_id !== bill.vendor_id) {
      throw bad(`Portal "${portal.name}" belongs to a different supplier`);
    }

    const available = lockBalance(db, portal.id);
    if (available <= 0) throw bad(`Portal "${portal.name}" has no available balance`);

    const requested = payload.amount_cents == null
      ? billBalance
      : cents(payload.amount_cents, 'Settlement amount', { min: 1 });
    const amount = Math.min(requested, billBalance, available);
    if (amount <= 0) throw bad('Nothing to settle from this portal');

    const date = dateISO(payload.settle_date || todayISO(), 'Settlement date');
    const supplierAdvances = systemAccount(db, SUPPLIER_ADVANCES, 'Supplier Advances');
    const ap = systemAccount(db, AP, 'Accounts Payable');
    const number = allocateNumber(db, 'bill_payment', date);

    const info = db.prepare(`
      INSERT INTO bill_payments (number, bill_id, vendor_id, payment_date, amount_cents, method, reference, payment_account_id, portal_id)
      VALUES (?, ?, ?, ?, ?, 'Portal wallet', ?, ?, ?)
    `).run(
      number,
      bill.id,
      bill.vendor_id,
      date,
      amount,
      portal.name,
      supplierAdvances.id,
      portal.id,
    );
    const paymentId = Number(info.lastInsertRowid);

    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Bill ${bill.number} settled from portal ${portal.name}`,
      reference: bill.number,
      source_type: 'portal_settle',
      source_id: paymentId,
      lines: [
        { account_id: ap.id, debit_cents: amount, credit_cents: 0, description: `Bill ${bill.number}` },
        { account_id: supplierAdvances.id, debit_cents: 0, credit_cents: amount, description: `Portal ${portal.name}` },
      ],
    });
    db.prepare('UPDATE bill_payments SET journal_entry_id = ? WHERE id = ?').run(entryId, paymentId);
    db.prepare(`
      UPDATE bills SET amount_paid_cents = amount_paid_cents + ?, portal_id = COALESCE(portal_id, ?),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(amount, portal.id, bill.id);

    return { settled_cents: amount, bill_id: bill.id, portal_id: portal.id, portal_name: portal.name };
  })();
}

// Used when a booking is confirmed: prepaid portals settle their vendor's bill
// automatically, up to whatever balance is available.
function autoSettleBill(db, billId, settleDate) {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!bill || bill.status !== 'received') return null;
  const portal = portalForVendor(db, bill.vendor_id);
  if (!portal || portal.settlement !== 'prepaid') return null;

  const billBalance = Math.max(0, bill.total_cents - bill.amount_paid_cents);
  if (billBalance <= 0) return null;
  const available = lockBalance(db, portal.id);
  if (available <= 0) {
    return { settled_cents: 0, portal_id: portal.id, portal_name: portal.name, shortfall_cents: billBalance };
  }

  const amount = Math.min(billBalance, available);
  const result = settleBillFromPortal(db, {
    bill_id: bill.id,
    portal_id: portal.id,
    amount_cents: amount,
    settle_date: settleDate || bill.bill_date,
  });
  return { ...result, shortfall_cents: Math.max(0, billBalance - amount) };
}

// ---------------------------------------------------------------------------
// Per-portal supplier ledger
//
// Prepaid portals: the balance is an asset (Supplier Advances, 1400). Top-ups
// debit it; withdrawals and bill settlements credit it. This view returns every
// movement with the journal lines that produced it, a running balance, and a
// reconciliation against the 1400 account in the general ledger.
//
// Credit portals: there is no deposit wallet. The supplier account is the
// ordinary A/P subledger for the linked vendor: bills and supplier refunds
// increase what we owe, and payments reduce it. The same row shape is returned
// so the UI can reuse the running-balance and journal-line rendering.
// ---------------------------------------------------------------------------

function creditPortalLedger(db, portal, options = {}) {
  const today = todayISO();
  const vendorId = portal.vendor_id;

  const bills = vendorId
    ? db.prepare(`
        SELECT b.*
        FROM bills b
        WHERE b.vendor_id = ? AND b.status = 'received'
        ORDER BY b.bill_date, b.id
      `).all(vendorId)
    : [];

  const payments = vendorId
    ? db.prepare(`
        SELECT p.*, b.number AS bill_number, b.bill_date,
               a.name AS payment_account_name
        FROM bill_payments p
        JOIN bills b ON b.id = p.bill_id
        JOIN accounts a ON a.id = p.payment_account_id
        WHERE p.vendor_id = ? AND b.status = 'received'
        ORDER BY p.payment_date, p.id
      `).all(vendorId)
    : [];

  const supplierRefunds = vendorId
    ? db.prepare(`
        SELECT r.*, b.number AS bill_number, a.name AS account_name
        FROM refunds r
        JOIN bills b ON b.id = r.bill_id
        JOIN accounts a ON a.id = r.account_id
        WHERE r.party_id = ? AND r.refund_type = 'supplier' AND r.status = 'paid'
        ORDER BY r.refund_date, r.id
      `).all(vendorId)
    : [];

  const entryIds = [
    ...bills.map((bill) => bill.journal_entry_id),
    ...payments.map((payment) => payment.journal_entry_id),
    ...supplierRefunds.map((refund) => refund.journal_entry_id),
  ].filter(Boolean);

  const linesByEntry = new Map();
  if (entryIds.length) {
    const placeholders = entryIds.map(() => '?').join(',');
    const lines = db.prepare(`
      SELECT l.entry_id, l.debit_cents, l.credit_cents, l.description,
             a.code AS account_code, a.name AS account_name, a.type AS account_type
      FROM journal_lines l
      JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id IN (${placeholders})
      ORDER BY l.sort_order, l.id
    `).all(...entryIds);
    for (const line of lines) {
      if (!linesByEntry.has(line.entry_id)) linesByEntry.set(line.entry_id, []);
      linesByEntry.get(line.entry_id).push({
        account_code: line.account_code,
        account_name: line.account_name,
        account_type: line.account_type,
        description: line.description,
        debit_cents: line.debit_cents,
        credit_cents: line.credit_cents,
      });
    }
  }

  const movements = [
    ...bills.map((bill) => ({
      key: `bill-${bill.id}`,
      kind: 'bill',
      date: bill.bill_date,
      order: 0,
      reference: bill.number,
      description: bill.notes || 'Supplier bill',
      detail: 'Bill received',
      debit_cents: 0,
      credit_cents: bill.total_cents,
      entry_id: bill.journal_entry_id || null,
      bill_id: bill.id,
      source_id: bill.id,
      lines: linesByEntry.get(bill.journal_entry_id) || [],
    })),
    ...payments.map((payment) => ({
      key: `billpay-${payment.id}`,
      kind: 'bill_payment',
      date: payment.payment_date,
      order: 1,
      reference: payment.number,
      description: `Payment · ${payment.method}`,
      detail: [payment.payment_account_name, payment.reference].filter(Boolean).join(' · '),
      debit_cents: payment.amount_cents,
      credit_cents: 0,
      entry_id: payment.journal_entry_id || null,
      bill_id: payment.bill_id,
      source_id: payment.id,
      lines: linesByEntry.get(payment.journal_entry_id) || [],
    })),
    ...supplierRefunds.map((refund) => ({
      key: `supplier-refund-${refund.id}`,
      kind: 'supplier_refund',
      date: refund.refund_date,
      order: 2,
      reference: refund.number,
      description: `Supplier refund · ${refund.method}`,
      detail: [refund.account_name, refund.reference, refund.bill_number ? `Bill ${refund.bill_number}` : ''].filter(Boolean).join(' · '),
      debit_cents: 0,
      credit_cents: refund.amount_cents,
      entry_id: refund.journal_entry_id || null,
      bill_id: refund.bill_id,
      source_id: refund.id,
      lines: linesByEntry.get(refund.journal_entry_id) || [],
    })),
  ].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.source_id - b.source_id;
  });

  let running = 0;
  const ledger = movements.map((movement) => {
    running += movement.credit_cents - movement.debit_cents;
    return { ...movement, balance_cents: running };
  });

  const activityDates = movements.map((movement) => movement.date).filter(Boolean).sort();
  const defaultFrom = activityDates[0] || today;
  const lastActivity = activityDates[activityDates.length - 1] || today;
  const defaultTo = lastActivity > today ? lastActivity : today;

  let from = options.from ? dateISO(options.from, 'From date') : defaultFrom;
  let to = options.to ? dateISO(options.to, 'To date') : defaultTo;
  if (from > to) [from, to] = [to, from];

  const openingCents = ledger
    .filter((row) => row.date < from)
    .reduce((sum, row) => sum + row.credit_cents - row.debit_cents, 0);
  const rows = ledger.filter((row) => row.date >= from && row.date <= to);
  const totalCreditCents = rows.reduce((sum, row) => sum + row.credit_cents, 0);
  const totalDebitCents = rows.reduce((sum, row) => sum + row.debit_cents, 0);
  const closingCents = openingCents + totalCreditCents - totalDebitCents;
  const periodBills = rows.filter((row) => row.kind === 'bill').length;
  const periodPayments = rows.filter((row) => row.kind === 'bill_payment').length;
  const periodRefunds = rows.filter((row) => row.kind === 'supplier_refund').length;

  return {
    mode: 'credit',
    portal: {
      id: portal.id,
      name: portal.name,
      portal_type: portal.portal_type,
      settlement: portal.settlement,
      vendor_id: portal.vendor_id,
      vendor_name: portal.vendor_name || null,
      login_ref: portal.login_ref,
      is_active: portal.is_active,
      balance_cents: portal.balance_cents,
      topup_total_cents: portal.topup_total_cents,
      refunded_total_cents: portal.refunded_total_cents,
      consumed_total_cents: portal.consumed_total_cents,
      outstanding_ap_cents: portal.outstanding_ap_cents,
      credit_limit_cents: portal.credit_limit_cents,
      credit_available_cents: portal.credit_available_cents,
    },
    from,
    to,
    default_from: defaultFrom,
    default_to: defaultTo,
    opening_cents: openingCents,
    total_debit_cents: totalDebitCents,
    total_credit_cents: totalCreditCents,
    closing_cents: closingCents,
    current_balance_cents: portal.outstanding_ap_cents,
    account_code: AP,
    account_name: 'Accounts Payable',
    rows,
    counts: {
      bills: bills.length,
      payments: payments.length,
      refunds: supplierRefunds.length,
      period_bills: periodBills,
      period_payments: periodPayments,
      period_refunds: periodRefunds,
      topups: 0,
      settlements: 0,
    },
    reconciliation: null,
  };
}

function portalLedger(db, portalId, options = {}) {
  const id = Number(portalId);
  const portal = getPortal(db, id);
  if (portal.settlement === 'credit') return creditPortalLedger(db, portal, options);
  const today = todayISO();

  const activityDates = [
    ...portal.topups.map((topup) => topup.topup_date),
    ...portal.refunds.map((refund) => refund.refund_date),
    ...portal.settlements.map((settlement) => settlement.payment_date),
  ].filter(Boolean).sort();
  const defaultFrom = activityDates[0] || today;
  const lastActivity = activityDates[activityDates.length - 1] || today;
  const defaultTo = lastActivity > today ? lastActivity : today;

  let from = options.from ? dateISO(options.from, 'From date') : defaultFrom;
  let to = options.to ? dateISO(options.to, 'To date') : defaultTo;
  if (from > to) [from, to] = [to, from];

  const entryIds = [
    ...portal.topups.map((topup) => topup.journal_entry_id),
    ...portal.refunds.map((refund) => refund.journal_entry_id),
    ...portal.settlements.map((settlement) => settlement.journal_entry_id),
  ].filter(Boolean);

  const linesByEntry = new Map();
  if (entryIds.length) {
    const placeholders = entryIds.map(() => '?').join(',');
    const lines = db.prepare(`
      SELECT l.entry_id, l.debit_cents, l.credit_cents, l.description,
             a.code AS account_code, a.name AS account_name, a.type AS account_type
      FROM journal_lines l
      JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id IN (${placeholders})
      ORDER BY l.sort_order, l.id
    `).all(...entryIds);
    for (const line of lines) {
      if (!linesByEntry.has(line.entry_id)) linesByEntry.set(line.entry_id, []);
      linesByEntry.get(line.entry_id).push({
        account_code: line.account_code,
        account_name: line.account_name,
        account_type: line.account_type,
        description: line.description,
        debit_cents: line.debit_cents,
        credit_cents: line.credit_cents,
      });
    }
  }

  const movements = [
    ...portal.topups.map((topup) => ({
      key: `topup-${topup.id}`,
      kind: 'topup',
      date: topup.topup_date,
      order: 0,
      reference: topup.number,
      description: `Top-up · ${topup.method}`,
      detail: `${topup.deposit_account_name}${topup.reference ? ` · ${topup.reference}` : ''}`,
      debit_cents: topup.amount_cents,
      credit_cents: 0,
      entry_id: topup.journal_entry_id || null,
      source_id: topup.id,
    })),
    ...portal.refunds.map((refund) => ({
      key: `refund-${refund.id}`,
      kind: 'refund',
      date: refund.refund_date,
      order: 1,
      reference: refund.reference || '—',
      description: `Withdrawal · ${refund.method}`,
      detail: refund.payment_account_name,
      debit_cents: 0,
      credit_cents: refund.amount_cents,
      entry_id: refund.journal_entry_id || null,
      source_id: refund.id,
    })),
    ...portal.settlements.map((settlement) => ({
      key: `settle-${settlement.id}`,
      kind: 'settlement',
      date: settlement.payment_date,
      order: 2,
      reference: settlement.number,
      description: `Bill ${settlement.bill_number} settled`,
      detail: `${settlement.vendor_name}${settlement.booking_id ? ' · from a booking' : settlement.visa_id ? ' · from a visa application' : ''}`,
      debit_cents: 0,
      credit_cents: settlement.amount_cents,
      entry_id: settlement.journal_entry_id || null,
      source_id: settlement.id,
      bill_id: settlement.bill_id,
      booking_id: settlement.booking_id || null,
      visa_id: settlement.visa_id || null,
    })),
  ].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.source_id - b.source_id;
  });

  let running = 0;
  const ledger = movements.map((movement) => {
    running += movement.debit_cents - movement.credit_cents;
    return {
      ...movement,
      balance_cents: running,
      lines: linesByEntry.get(movement.entry_id) || [],
    };
  });

  const openingCents = ledger
    .filter((row) => row.date < from)
    .reduce((sum, row) => sum + row.debit_cents - row.credit_cents, 0);
  const rows = ledger.filter((row) => row.date >= from && row.date <= to);
  const totalDebitCents = rows.reduce((sum, row) => sum + row.debit_cents, 0);
  const totalCreditCents = rows.reduce((sum, row) => sum + row.credit_cents, 0);
  const closingCents = openingCents + totalDebitCents - totalCreditCents;

  const gl = db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS balance
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ?
  `).get(SUPPLIER_ADVANCES);
  const allPortalBalanceCents = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(amount_cents), 0) FROM portal_topups)
      - (SELECT COALESCE(SUM(amount_cents), 0) FROM portal_refunds)
      - (SELECT COALESCE(SUM(amount_cents), 0) FROM bill_payments WHERE portal_id IS NOT NULL)
      AS balance
  `).get().balance;

  return {
    mode: 'wallet',
    portal: {
      id: portal.id,
      name: portal.name,
      portal_type: portal.portal_type,
      settlement: portal.settlement,
      vendor_id: portal.vendor_id,
      vendor_name: portal.vendor_name || null,
      login_ref: portal.login_ref,
      is_active: portal.is_active,
      balance_cents: portal.balance_cents,
      topup_total_cents: portal.topup_total_cents,
      refunded_total_cents: portal.refunded_total_cents,
      consumed_total_cents: portal.consumed_total_cents,
      outstanding_ap_cents: portal.outstanding_ap_cents,
      credit_limit_cents: portal.credit_limit_cents,
      credit_available_cents: portal.credit_available_cents,
    },
    from,
    to,
    default_from: defaultFrom,
    default_to: defaultTo,
    opening_cents: openingCents,
    total_debit_cents: totalDebitCents,
    total_credit_cents: totalCreditCents,
    closing_cents: closingCents,
    current_balance_cents: portal.balance_cents,
    account_code: SUPPLIER_ADVANCES,
    account_name: 'Supplier Advances',
    rows,
    counts: {
      topups: portal.topups.length,
      refunds: portal.refunds.length,
      settlements: portal.settlements.length,
    },
    reconciliation: {
      account_code: SUPPLIER_ADVANCES,
      account_name: 'Supplier Advances',
      gl_balance_cents: gl.balance,
      portal_total_cents: allPortalBalanceCents,
      difference_cents: gl.balance - allPortalBalanceCents,
    },
  };
}

module.exports = {
  listPortals,
  getPortal,
  createPortal,
  updatePortal,
  deletePortal,
  topUp,
  deleteTopup,
  refundPortal,
  settleBillFromPortal,
  autoSettleBill,
  portalForVendor,
  portalReport,
  portalStats,
  portalLedger,
  lockBalance,
};
