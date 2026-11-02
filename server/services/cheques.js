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
} = require('../util');
const audit = require('./audit');
const { markCreated } = require('../created-by');

const STATUSES = ['planned', 'issued', 'cleared', 'bounced', 'cancelled'];
const BATCH_FREQUENCIES = ['monthly', 'quarterly', 'yearly'];

const chequeSelect = `
  SELECT pdc.*, v.name AS vendor_name,
         ci.name AS item_name, ci.frequency AS item_frequency,
         b.number AS bill_number, bp.number AS payment_number
  FROM post_dated_cheques pdc
  JOIN vendors v ON v.id = pdc.vendor_id
  LEFT JOIN compliance_items ci ON ci.id = pdc.compliance_item_id
  LEFT JOIN bills b ON b.id = pdc.bill_id
  LEFT JOIN bill_payments bp ON bp.id = pdc.bill_payment_id
`;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const currentLastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = d === currentLastDay ? lastDay : Math.min(d, lastDay);
  return `${target.getUTCFullYear()}-${pad2(target.getUTCMonth() + 1)}-${pad2(day)}`;
}

function dateDiffDays(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

function serialize(row, today = todayISO()) {
  const days = dateDiffDays(today, row.cheque_date);
  let timing = 'later';
  if (row.status === 'cleared') timing = 'cleared';
  else if (row.status === 'bounced') timing = 'bounced';
  else if (row.status === 'cancelled') timing = 'cancelled';
  else if (days < 0) timing = 'overdue';
  else if (days === 0) timing = 'today';
  else if (days <= 30) timing = 'soon';
  return {
    ...row,
    days_until: days,
    timing,
    timing_label: timing === 'overdue'
      ? `${Math.abs(days)}d overdue`
      : timing === 'today'
        ? 'Today'
        : timing === 'soon'
          ? `In ${days}d`
          : timing === 'cleared'
            ? 'Cleared'
            : timing === 'bounced'
              ? 'Bounced'
              : timing === 'cancelled'
                ? 'Cancelled'
                : `In ${days}d`,
  };
}

function summarize(cheques, today = todayISO()) {
  const scheduled = cheques.filter((row) => ['planned', 'issued'].includes(row.status));
  const upcoming = scheduled.filter((row) => {
    const days = dateDiffDays(today, row.cheque_date);
    return days >= 0 && days <= 30;
  });
  const cleared = cheques.filter((row) => row.status === 'cleared');
  const bounced = cheques.filter((row) => row.status === 'bounced');
  return {
    total_count: cheques.length,
    planned_count: cheques.filter((row) => row.status === 'planned').length,
    issued_count: cheques.filter((row) => row.status === 'issued').length,
    scheduled_count: scheduled.length,
    scheduled_cents: scheduled.reduce((sum, row) => sum + row.amount_cents, 0),
    upcoming_count: upcoming.length,
    upcoming_cents: upcoming.reduce((sum, row) => sum + row.amount_cents, 0),
    cleared_count: cleared.length,
    cleared_cents: cleared.reduce((sum, row) => sum + row.amount_cents, 0),
    bounced_count: bounced.length,
  };
}

function listCheques(db, { status, search, from, to, compliance_item_id } = {}) {
  const today = todayISO();
  const clauses = [];
  const params = [];
  if (status && status !== 'all') {
    if (!STATUSES.includes(status)) throw bad('Invalid cheque status');
    clauses.push('pdc.status = ?');
    params.push(status);
  }
  if (from) {
    clauses.push('pdc.cheque_date >= ?');
    params.push(dateISO(from, 'From date'));
  }
  if (to) {
    clauses.push('pdc.cheque_date <= ?');
    params.push(dateISO(to, 'To date'));
  }
  if (compliance_item_id) {
    clauses.push('pdc.compliance_item_id = ?');
    params.push(Number(compliance_item_id));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  let cheques = db.prepare(`${chequeSelect} ${where}
    ORDER BY CASE pdc.status WHEN 'planned' THEN 0 WHEN 'issued' THEN 1 WHEN 'cleared' THEN 2 WHEN 'bounced' THEN 3 ELSE 4 END,
             pdc.cheque_date, pdc.id
  `).all(...params).map((row) => serialize(row, today));

  if (search) {
    const term = String(search).trim().toLowerCase();
    cheques = cheques.filter((row) => [
      row.cheque_number,
      row.vendor_name,
      row.item_name,
      row.bank_name,
      row.reference,
      row.notes,
      row.bill_number,
      row.payment_number,
    ].some((value) => String(value || '').toLowerCase().includes(term)));
  }

  return {
    cheques,
    summary: summarize(db.prepare(`${chequeSelect}`).all().map((row) => serialize(row, today)), today),
  };
}

function getCheque(db, id) {
  const row = db.prepare(`${chequeSelect} WHERE pdc.id = ?`).get(id);
  if (!row) throw notFound('Cheque not found');
  return serialize(row);
}

function incrementChequeNumber(first, offset) {
  const match = String(first).match(/^(.*?)(\d+)(\D*)$/);
  if (!match) return offset === 0 ? String(first) : `${first}-${offset + 1}`;
  const [, prefix, digits, suffix] = match;
  const next = String(Number(digits) + offset).padStart(digits.length, '0');
  return `${prefix}${next}${suffix}`;
}

function createBatch(db, payload = {}) {
  return db.transaction(() => {
    const itemId = Number(payload.compliance_item_id);
    const item = db.prepare(`
      SELECT ci.*, v.name AS vendor_name
      FROM compliance_items ci
      JOIN vendors v ON v.id = ci.vendor_id
      WHERE ci.id = ?
    `).get(itemId);
    if (!item) throw bad('Choose a compliance item with a vendor');
    if (item.kind !== 'recurring_bill') throw bad('Post-dated cheques can only be created for recurring bills');
    if (!item.vendor_id) throw bad('This compliance item has no vendor');

    const count = Math.round(num(payload.count ?? 12, 'Number of cheques', { min: 1, max: 60 }));
    const firstNumber = str(payload.first_cheque_number, 'First cheque number', { max: 80 });
    const startDate = dateISO(payload.start_date || item.next_due_date, 'First cheque date');
    const frequency = String(payload.frequency || 'monthly');
    if (!BATCH_FREQUENCIES.includes(frequency)) throw bad('Cheque frequency must be monthly, quarterly or yearly');
    const amount = cents(payload.amount_cents ?? item.amount_cents, 'Cheque amount', { min: 1 });
    const bankName = optionalStr(payload.bank_name, 'Bank name', 120);
    const status = String(payload.initial_status || 'planned');
    if (!['planned', 'issued'].includes(status)) throw bad('Initial cheque status must be planned or issued');
    const reference = optionalStr(payload.reference, 'Reference', 200);
    const notes = optionalStr(payload.notes, 'Notes', 2000);

    const insert = db.prepare(`
      INSERT INTO post_dated_cheques (
        compliance_item_id, vendor_id, cheque_number, cheque_date, amount_cents,
        bank_name, status, reference, notes, anchor_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const duplicate = db.prepare(`
      SELECT id FROM post_dated_cheques
      WHERE cheque_number = ? AND (bank_name = ? OR ? = '')
      LIMIT 1
    `);

    const created = [];
    const step = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12;
    for (let i = 0; i < count; i += 1) {
      const chequeNumber = incrementChequeNumber(firstNumber, i);
      if (duplicate.get(chequeNumber, bankName, bankName)) {
        throw bad(`Cheque ${chequeNumber} already exists${bankName ? ` for ${bankName}` : ''}`);
      }
      const date = addMonths(startDate, step * i);
      const info = insert.run(
        item.id, item.vendor_id, chequeNumber, date, amount,
        bankName, status, reference, notes, startDate,
      );
      markCreated(db, 'post_dated_cheques', info.lastInsertRowid);
      created.push(getCheque(db, Number(info.lastInsertRowid)));
    }
    return { cheques: created, count: created.length };
  })();
}

function updateCheque(db, id, payload = {}) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM post_dated_cheques WHERE id = ?').get(id);
    if (!existing) throw notFound('Cheque not found');
    const status = String(payload.status ?? existing.status);
    if (!STATUSES.includes(status)) throw bad('Choose a valid cheque status');
    if (existing.status === 'cancelled') {
      throw bad('This cheque is void and cannot be edited.');
    }
    if (status === 'cancelled') {
      throw bad('Use the void action to cancel this cheque with remarks and an audit entry.');
    }
    if (existing.bill_payment_id && status !== 'cleared') {
      throw bad('This cheque is linked to a payment. Remove the payment before changing its status.');
    }
    const chequeNumber = str(payload.cheque_number ?? existing.cheque_number, 'Cheque number', { max: 80 });
    const chequeDate = dateISO(payload.cheque_date ?? existing.cheque_date, 'Cheque date');
    const amount = cents(payload.amount_cents ?? existing.amount_cents, 'Cheque amount', { min: 1 });
    const bankName = optionalStr(payload.bank_name ?? existing.bank_name, 'Bank name', 120);
    if (existing.bill_payment_id) {
      const coreChanged = chequeNumber !== existing.cheque_number
        || chequeDate !== existing.cheque_date
        || amount !== existing.amount_cents
        || bankName !== existing.bank_name;
      if (coreChanged) {
        throw bad('This cheque is linked to a payment. Remove the payment before changing its number, date, amount or bank.');
      }
    }
    const reference = optionalStr(payload.reference ?? existing.reference, 'Reference', 200);
    const notes = optionalStr(payload.notes ?? existing.notes, 'Notes', 2000);
    const clearedAt = status === 'cleared'
      ? (existing.cleared_at || todayISO())
      : null;
    db.prepare(`
      UPDATE post_dated_cheques SET
        cheque_number = ?, cheque_date = ?, amount_cents = ?, bank_name = ?,
        status = ?, reference = ?, notes = ?, cleared_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(chequeNumber, chequeDate, amount, bankName, status, reference, notes, clearedAt, id);
    return getCheque(db, id);
  })();
}

function voidCheque(db, id, payload = {}) {
  return db.transaction(() => {
    const cheque = db.prepare('SELECT * FROM post_dated_cheques WHERE id = ?').get(id);
    if (!cheque) throw notFound('Cheque not found');
    if (cheque.status === 'cancelled') throw bad('This cheque is already void');
    if (cheque.bill_payment_id || cheque.bill_id) {
      throw bad('This cheque is linked to a payment. Void the bill payment before voiding the cheque.');
    }
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    db.prepare(`
      UPDATE post_dated_cheques SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?
    `).run(cheque.id);
    audit.record(db, {
      entity_type: 'cheque',
      entity_id: cheque.id,
      entity_number: cheque.cheque_number,
      action: 'void',
      remarks: remarks || `Voided cheque ${cheque.cheque_number}`,
      amount_cents: cheque.amount_cents,
      metadata: { vendor_id: cheque.vendor_id, cheque_date: cheque.cheque_date },
    });
    return getCheque(db, id);
  })();
}

function deleteCheque(db, id, payload = {}) {
  return db.transaction(() => {
    const cheque = db.prepare('SELECT * FROM post_dated_cheques WHERE id = ?').get(id);
    if (!cheque) throw notFound('Cheque not found');
    if (cheque.status === 'cancelled') {
      throw bad('This cheque is void and cannot be deleted.');
    }
    if (cheque.bill_payment_id || cheque.bill_id) {
      throw bad('This cheque is linked to a payment. Void the payment before deleting the cheque.');
    }
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    audit.record(db, {
      entity_type: 'cheque',
      entity_id: cheque.id,
      entity_number: cheque.cheque_number,
      action: 'delete',
      remarks: remarks || `Deleted cheque ${cheque.cheque_number}`,
      amount_cents: cheque.amount_cents,
      metadata: { vendor_id: cheque.vendor_id, cheque_date: cheque.cheque_date },
    });
    db.prepare('DELETE FROM post_dated_cheques WHERE id = ?').run(id);
    return { deleted: true };
  })();
}

function matchChequePayment(db, { vendorId, chequeNumber, amountCents, paymentDate, billId, paymentId }) {
  if (!vendorId || !chequeNumber || !amountCents || !paymentId) return null;
  const candidates = db.prepare(`
    SELECT * FROM post_dated_cheques
    WHERE vendor_id = ? AND cheque_number = ? AND amount_cents = ?
      AND status IN ('planned', 'issued')
    ORDER BY ABS(julianday(cheque_date) - julianday(?)), id
    LIMIT 1
  `).get(vendorId, chequeNumber, amountCents, paymentDate);
  if (!candidates) return null;
  db.prepare(`
    UPDATE post_dated_cheques SET
      status = 'cleared', bill_id = ?, bill_payment_id = ?, cleared_at = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(billId, paymentId, paymentDate, candidates.id);
  return getCheque(db, candidates.id);
}

function unlinkPayment(db, paymentId) {
  db.prepare(`
    UPDATE post_dated_cheques SET
      status = 'issued', bill_id = NULL, bill_payment_id = NULL, cleared_at = NULL,
      updated_at = datetime('now')
    WHERE bill_payment_id = ?
  `).run(paymentId);
}

module.exports = {
  STATUSES,
  listCheques,
  getCheque,
  createBatch,
  updateCheque,
  voidCheque,
  deleteCheque,
  matchChequePayment,
  unlinkPayment,
};
