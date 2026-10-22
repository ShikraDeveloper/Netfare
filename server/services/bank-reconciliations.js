'use strict';

const { bad, notFound, dateISO, todayISO, cents, optionalStr } = require('../util');
const { isCashAccount } = require('../accounting');
const audit = require('./audit');

function getAccount(db, accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!account) throw notFound('Bank account not found');
  if (!isCashAccount(account)) throw bad('Choose an active cash or bank account');
  return account;
}

function getStatementDate(value) {
  return dateISO(value || todayISO(), 'Statement date');
}

function latestForAccount(db, accountId) {
  return db.prepare(`
    SELECT * FROM bank_reconciliations
    WHERE account_id = ?
    ORDER BY statement_date DESC, id DESC
    LIMIT 1
  `).get(accountId);
}

function clearedBefore(db, accountId, beforeDate) {
  return db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS amount
    FROM bank_reconciliation_lines rl
    JOIN bank_reconciliations r ON r.id = rl.reconciliation_id
    JOIN journal_lines l ON l.id = rl.journal_line_id
    WHERE r.account_id = ? AND r.statement_date < ?
  `).get(accountId, beforeDate).amount;
}

function ledgerBalance(db, accountId, throughDate) {
  return db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS amount
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.account_id = ? AND e.entry_date <= ?
  `).get(accountId, throughDate).amount;
}

function getWorkspace(db, { account_id: accountId, statement_date: statementDate } = {}) {
  const account = getAccount(db, accountId);
  const date = getStatementDate(statementDate);
  const latest = latestForAccount(db, account.id);
  if (latest && date <= latest.statement_date) {
    throw bad(`Statement date must be after the last reconciliation (${latest.statement_date})`);
  }
  const lines = db.prepare(`
    SELECT l.id, l.entry_id, l.description, l.debit_cents, l.credit_cents,
           e.entry_date, e.memo, e.reference, e.source_type
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.account_id = ? AND e.entry_date <= ?
      AND NOT EXISTS (
        SELECT 1 FROM bank_reconciliation_lines rl WHERE rl.journal_line_id = l.id
      )
    ORDER BY e.entry_date, e.id, l.sort_order, l.id
  `).all(account.id, date);
  return {
    account,
    statement_date: date,
    last_reconciliation: latest || null,
    cleared_before_cents: clearedBefore(db, account.id, date),
    ledger_balance_cents: ledgerBalance(db, account.id, date),
    lines: lines.map((line) => ({
      ...line,
      amount_cents: line.debit_cents - line.credit_cents,
    })),
  };
}

function listReconciliations(db, { account_id: accountId } = {}) {
  const params = [];
  let where = '';
  if (accountId) {
    where = 'WHERE r.account_id = ?';
    params.push(Number(accountId));
  }
  return db.prepare(`
    SELECT r.*, a.code AS account_code, a.name AS account_name,
      (SELECT COUNT(*) FROM bank_reconciliation_lines rl WHERE rl.reconciliation_id = r.id) AS line_count
    FROM bank_reconciliations r
    JOIN accounts a ON a.id = r.account_id
    ${where}
    ORDER BY r.statement_date DESC, r.id DESC
  `).all(...params);
}

function createReconciliation(db, payload = {}) {
  const account = getAccount(db, payload.account_id);
  const date = getStatementDate(payload.statement_date);
  const statementBalance = cents(payload.statement_balance_cents, 'Statement closing balance', {
    min: -1_000_000_000_00,
  });
  const notes = String(payload.notes || '').trim();
  if (notes.length > 2000) throw bad('Notes must be 2000 characters or fewer');
  const lineIds = [...new Set((Array.isArray(payload.line_ids) ? payload.line_ids : []).map(Number).filter(Boolean))];

  return db.transaction(() => {
    const latest = latestForAccount(db, account.id);
    if (latest && date <= latest.statement_date) {
      throw bad(`Statement date must be after the last reconciliation (${latest.statement_date})`);
    }
    let lines = [];
    if (lineIds.length) {
      const placeholders = lineIds.map(() => '?').join(',');
      lines = db.prepare(`
        SELECT l.*, e.entry_date
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = ? AND l.id IN (${placeholders})
      `).all(account.id, ...lineIds);
      if (lines.length !== lineIds.length) throw bad('One or more selected transactions do not belong to this account');
      if (lines.some((line) => line.entry_date > date)) throw bad('A selected transaction is after the statement date');
      const already = db.prepare(`
        SELECT COUNT(*) AS count FROM bank_reconciliation_lines WHERE journal_line_id IN (${placeholders})
      `).get(...lineIds).count;
      if (already) throw bad('One or more selected transactions are already reconciled');
    }

    const selected = lines.reduce((sum, line) => sum + line.debit_cents - line.credit_cents, 0);
    const cleared = clearedBefore(db, account.id, date) + selected;
    const difference = statementBalance - cleared;
    const info = db.prepare(`
      INSERT INTO bank_reconciliations (
        account_id, statement_date, statement_balance_cents, cleared_balance_cents,
        difference_cents, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      account.id,
      date,
      statementBalance,
      cleared,
      difference,
      difference === 0 ? 'reconciled' : 'difference',
      notes,
    );
    const recId = Number(info.lastInsertRowid);
    const insertLine = db.prepare(`
      INSERT INTO bank_reconciliation_lines (reconciliation_id, journal_line_id) VALUES (?, ?)
    `);
    for (const line of lines) insertLine.run(recId, line.id);
    return getReconciliation(db, recId);
  })();
}

function getReconciliation(db, id) {
  const rec = db.prepare(`
    SELECT r.*, a.code AS account_code, a.name AS account_name
    FROM bank_reconciliations r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.id = ?
  `).get(Number(id));
  if (!rec) throw notFound('Reconciliation not found');
  rec.lines = db.prepare(`
    SELECT l.*, e.entry_date, e.memo, e.reference, e.source_type
    FROM bank_reconciliation_lines rl
    JOIN journal_lines l ON l.id = rl.journal_line_id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE rl.reconciliation_id = ?
    ORDER BY e.entry_date, e.id, l.sort_order, l.id
  `).all(rec.id);
  return rec;
}

function voidReconciliation(db, id, payload = {}) {
  return db.transaction(() => {
    const rec = db.prepare('SELECT * FROM bank_reconciliations WHERE id = ?').get(Number(id));
    if (!rec) throw notFound('Reconciliation not found');
    const later = db.prepare(`
      SELECT id, statement_date FROM bank_reconciliations
      WHERE account_id = ? AND (statement_date > ? OR (statement_date = ? AND id > ?))
      ORDER BY statement_date DESC, id DESC LIMIT 1
    `).get(rec.account_id, rec.statement_date, rec.statement_date, rec.id);
    if (later) throw bad(`Reopen the later reconciliation from ${later.statement_date} first`);
    const remarks = optionalStr(payload.remarks ?? payload.reason ?? '', 'Void remarks', 2000);
    db.prepare('DELETE FROM bank_reconciliations WHERE id = ?').run(rec.id);
    audit.record(db, {
      entity_type: 'bank_reconciliation',
      entity_id: rec.id,
      entity_number: `#${rec.id}`,
      action: 'void',
      remarks: remarks || `Reopened reconciliation #${rec.id}`,
      amount_cents: rec.cleared_balance_cents,
      metadata: { account_id: rec.account_id, statement_date: rec.statement_date },
    });
    return { deleted: true, voided: true };
  })();
}

function deleteReconciliation(db, id, payload = {}) {
  return voidReconciliation(db, id, payload);
}

module.exports = {
  getWorkspace,
  listReconciliations,
  createReconciliation,
  getReconciliation,
  voidReconciliation,
  deleteReconciliation,
};
