'use strict';

const { bad, dateISO, cents, todayISO } = require('../util');
const { postEntry, SYSTEM_CODES } = require('../accounting');

const EQUITY_CODE = SYSTEM_CODES.OPENING_BALANCE_EQUITY;

function activeOpeningEntry(db) {
  return db.prepare(`
    SELECT e.* FROM journal_entries e
    WHERE e.source_type = 'opening_balance'
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries r
        WHERE r.source_type = 'opening_balance_reversal' AND r.source_id = e.id
      )
    ORDER BY e.id DESC LIMIT 1
  `).get();
}

function reverseOpeningEntry(db, entry, entryDate) {
  const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order, id').all(entry.id);
  if (!lines.length) return null;
  const date = entryDate > entry.entry_date ? entryDate : entry.entry_date;
  return postEntry(db, {
    entry_date: date,
    memo: `Reversal of opening balances #${entry.id}`,
    reference: entry.reference || 'OPENING',
    source_type: 'opening_balance_reversal',
    source_id: entry.id,
    lines: lines.map((line) => ({
      account_id: line.account_id,
      debit_cents: line.credit_cents,
      credit_cents: line.debit_cents,
      description: line.description,
    })),
  });
}

function getOpeningBalances(db) {
  const entry = activeOpeningEntry(db);
  const lines = entry
    ? db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order, id').all(entry.id)
    : [];
  const byAccount = new Map();
  for (const line of lines) {
    const current = byAccount.get(line.account_id) || { debit_cents: 0, credit_cents: 0 };
    current.debit_cents += line.debit_cents;
    current.credit_cents += line.credit_cents;
    byAccount.set(line.account_id, current);
  }

  const accounts = db.prepare(`
    SELECT id, code, name, type, subtype, normal_balance
    FROM accounts
    WHERE is_active = 1 AND type IN ('asset', 'liability', 'equity') AND code <> ?
    ORDER BY CASE type WHEN 'asset' THEN 1 WHEN 'liability' THEN 2 ELSE 3 END, code
  `).all(EQUITY_CODE).map((account) => ({
    ...account,
    debit_cents: byAccount.get(account.id)?.debit_cents || 0,
    credit_cents: byAccount.get(account.id)?.credit_cents || 0,
  }));

  const totalDebit = accounts.reduce((sum, account) => sum + account.debit_cents, 0);
  const totalCredit = accounts.reduce((sum, account) => sum + account.credit_cents, 0);
  return {
    entry_id: entry?.id || null,
    entry_date: entry?.entry_date || '',
    accounts,
    total_debit_cents: totalDebit,
    total_credit_cents: totalCredit,
    equity_cents: totalDebit - totalCredit,
    equity_account: db.prepare('SELECT id, code, name FROM accounts WHERE code = ?').get(EQUITY_CODE) || null,
  };
}

function saveOpeningBalances(db, payload = {}) {
  const entryDate = dateISO(payload.entry_date, 'Opening date');
  const rows = Array.isArray(payload.balances) ? payload.balances : [];
  const seen = new Set();
  const normalized = [];

  for (const [index, row] of rows.entries()) {
    const accountId = Number(row.account_id);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!account) throw bad(`Row ${index + 1}: account not found`);
    if (!account.is_active) throw bad(`Row ${index + 1}: account "${account.name}" is archived`);
    if (!['asset', 'liability', 'equity'].includes(account.type) || account.code === EQUITY_CODE) {
      throw bad(`Row ${index + 1}: opening balances can only use balance-sheet accounts`);
    }
    if (seen.has(account.id)) throw bad(`Account "${account.name}" appears more than once`);
    seen.add(account.id);

    const debit = cents(row.debit_cents ?? 0, `Row ${index + 1} debit`);
    const credit = cents(row.credit_cents ?? 0, `Row ${index + 1} credit`);
    if (debit > 0 && credit > 0) throw bad(`Account "${account.name}": enter either a debit or a credit, not both`);
    if (debit === 0 && credit === 0) continue;
    normalized.push({ account, debit, credit });
  }

  return db.transaction(() => {
    const existing = activeOpeningEntry(db);
    if (existing) reverseOpeningEntry(db, existing, entryDate);

    if (!normalized.length) return getOpeningBalances(db);

    const totalDebit = normalized.reduce((sum, row) => sum + row.debit, 0);
    const totalCredit = normalized.reduce((sum, row) => sum + row.credit, 0);
    const lines = normalized.map((row) => ({
      account_id: row.account.id,
      debit_cents: row.debit,
      credit_cents: row.credit,
      description: `Opening balance — ${row.account.code} ${row.account.name}`,
    }));

    const difference = totalDebit - totalCredit;
    if (difference !== 0) {
      const equity = db.prepare('SELECT * FROM accounts WHERE code = ?').get(EQUITY_CODE);
      if (!equity) throw bad('Opening Balance Equity account is missing. Restore account 3900 first.');
      lines.push({
        account_id: equity.id,
        debit_cents: difference < 0 ? Math.abs(difference) : 0,
        credit_cents: difference > 0 ? difference : 0,
        description: 'Opening Balance Equity — balancing amount',
      });
    }

    postEntry(db, {
      entry_date: entryDate,
      memo: 'Opening balances',
      reference: 'OPENING',
      source_type: 'opening_balance',
      lines,
    });
    return getOpeningBalances(db);
  })();
}

function clearOpeningBalances(db) {
  return db.transaction(() => {
    const existing = activeOpeningEntry(db);
    if (existing) reverseOpeningEntry(db, existing, todayISO());
    return getOpeningBalances(db);
  })();
}

module.exports = {
  getOpeningBalances,
  saveOpeningBalances,
  clearOpeningBalances,
};
