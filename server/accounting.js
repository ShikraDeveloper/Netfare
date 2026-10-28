'use strict';

const { bad, dateISO, cents, todayISO } = require('./util');

const SYSTEM_CODES = {
  AR: '1100',
  SUPPLIER_ADVANCES: '1400',
  SUPPLIER_CREDITS: '1450',
  AP: '2000',
  CUSTOMER_ADVANCES: '2400',
  CUSTOMER_CREDITS: '2450',
  REFUND_PAYABLE: '2500',
  RETAINED_EARNINGS: '3100',
  OPENING_BALANCE_EQUITY: '3900',
  SERVICE_CHARGE: '4300',
  CANCELLATION_INCOME: '4330',
  DEPOSITS_WITH_SUPPLIERS: '1460',
  VISA_DEPOSITS: '2600',
  FORFEITED_DEPOSITS: '4340',
};

// Accounts that are maintained by a subledger. Manual journals may not post
// to them because doing so breaks aging, statements and reconciliation.
const CONTROL_ACCOUNT_CODES = new Set([
  SYSTEM_CODES.AR,
  SYSTEM_CODES.SUPPLIER_ADVANCES,
  SYSTEM_CODES.SUPPLIER_CREDITS,
  SYSTEM_CODES.AP,
  SYSTEM_CODES.CUSTOMER_ADVANCES,
  SYSTEM_CODES.CUSTOMER_CREDITS,
  SYSTEM_CODES.REFUND_PAYABLE,
  SYSTEM_CODES.DEPOSITS_WITH_SUPPLIERS,
  SYSTEM_CODES.VISA_DEPOSITS,
]);

function getSettings(db) {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get();
}

function accountByCode(db, code) {
  return db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
}

function isCashAccount(account) {
  return Boolean(account && account.is_active && account.type === 'asset' && account.is_cash);
}

function isPurchaseAccount(account) {
  if (!account || !account.is_active) return false;
  if (account.type === 'expense') return true;
  return account.type === 'asset' && !account.is_system && !account.is_cash;
}

function systemAccount(db, code, label) {
  const account = accountByCode(db, code);
  if (!account) {
    throw bad(`Required system account ${code}${label ? ` (${label})` : ''} is missing. Restore it under Chart of Accounts.`);
  }
  if (!account.is_active) {
    throw bad(`System account ${code} is archived. Reactivate it to continue.`);
  }
  return account;
}

function postEntry(db, { entry_date, memo = '', reference = '', source_type = 'manual', source_id = null, reversal_of_id = null, lines }) {
  const date = dateISO(entry_date, 'Entry date');
  if (!Array.isArray(lines) || lines.length < 2) {
    throw bad('A journal entry needs at least two lines');
  }

  const normalized = lines.map((line, index) => {
    const accountId = Number(line.account_id);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!account) throw bad(`Line ${index + 1}: account not found`);
    if (!account.is_active) throw bad(`Line ${index + 1}: account "${account.name}" is archived`);

    const debit = cents(line.debit_cents ?? 0, `Line ${index + 1} debit`);
    const credit = cents(line.credit_cents ?? 0, `Line ${index + 1} credit`);
    if (debit > 0 && credit > 0) throw bad(`Line ${index + 1}: enter either a debit or a credit, not both`);
    if (debit === 0 && credit === 0) throw bad(`Line ${index + 1}: enter a debit or credit amount`);

    return {
      account_id: accountId,
      debit_cents: debit,
      credit_cents: credit,
      description: String(line.description || '').trim(),
      sort_order: index,
    };
  });

  const totalDebit = normalized.reduce((sum, line) => sum + line.debit_cents, 0);
  const totalCredit = normalized.reduce((sum, line) => sum + line.credit_cents, 0);
  if (totalDebit !== totalCredit) {
    throw bad(`Entry is not balanced: debits ${(totalDebit / 100).toFixed(2)} vs credits ${(totalCredit / 100).toFixed(2)}`);
  }
  if (totalDebit === 0) throw bad('Entry total must be greater than zero');

  const insertEntry = db.prepare(`
    INSERT INTO journal_entries (entry_date, memo, reference, source_type, source_id, reversal_of_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertLine = db.prepare(`
    INSERT INTO journal_lines (entry_id, account_id, debit_cents, credit_cents, description, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const info = insertEntry.run(
    date,
    String(memo).trim(),
    String(reference).trim(),
    source_type,
    source_id,
    reversal_of_id,
  );
  for (const line of normalized) {
    insertLine.run(info.lastInsertRowid, line.account_id, line.debit_cents, line.credit_cents, line.description, line.sort_order);
  }
  return Number(info.lastInsertRowid);
}

function reverseEntry(db, entryId, { entry_date, memo, source_type = 'void' } = {}) {
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
  if (!entry) return null;
  const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order, id').all(entryId);
  if (!lines.length) return null;
  return postEntry(db, {
    entry_date: entry_date || todayISO(),
    memo: memo || `Reversal of entry #${entryId}`,
    reference: entry.reference,
    source_type,
    source_id: entry.source_id,
    reversal_of_id: entryId,
    lines: lines.map((line) => ({
      account_id: line.account_id,
      debit_cents: line.credit_cents,
      credit_cents: line.debit_cents,
      description: line.description,
    })),
  });
}

function getEntryWithLines(db, entryId) {
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
  if (!entry) return null;
  entry.lines = db.prepare(`
    SELECT l.*, a.code AS account_code, a.name AS account_name, a.type AS account_type
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.entry_id = ?
    ORDER BY l.sort_order, l.id
  `).all(entryId);
  entry.total_cents = entry.lines.reduce((sum, line) => sum + line.debit_cents, 0);
  return entry;
}

function invoiceBalanceCents(invoice) {
  return Math.max(0, invoice.total_cents - invoice.amount_paid_cents - (invoice.credit_applied_cents || 0));
}

function billBalanceCents(bill) {
  return Math.max(0, bill.total_cents - bill.amount_paid_cents - (bill.credit_applied_cents || 0));
}

function assertManualEntryAccounts(db, lines) {
  if (!Array.isArray(lines)) return;
  for (const line of lines) {
    const accountId = Number(line?.account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) continue;
    const account = db.prepare('SELECT code, name FROM accounts WHERE id = ?').get(accountId);
    if (account && CONTROL_ACCOUNT_CODES.has(account.code)) {
      throw bad(`Manual entries cannot post to control account ${account.code} ${account.name}. Use the related invoice, bill, refund or credit screen.`);
    }
  }
}

function invoiceDisplayStatus(invoice, today = todayISO()) {
  if (invoice.status === 'draft') return 'draft';
  if (invoice.status === 'void') return 'void';
  const settled = invoice.amount_paid_cents + (invoice.credit_applied_cents || 0);
  if (invoice.total_cents <= settled) return 'paid';
  if (settled > 0) return invoice.due_date < today ? 'overdue' : 'partial';
  return invoice.due_date < today ? 'overdue' : 'sent';
}

function billDisplayStatus(bill, today = todayISO()) {
  if (bill.status === 'draft') return 'draft';
  if (bill.status === 'void') return 'void';
  const settled = bill.amount_paid_cents + (bill.credit_applied_cents || 0);
  if (bill.total_cents <= settled) return 'paid';
  if (settled > 0) return bill.due_date < today ? 'overdue' : 'partial';
  return bill.due_date < today ? 'overdue' : 'received';
}

module.exports = {
  SYSTEM_CODES,
  CONTROL_ACCOUNT_CODES,
  getSettings,
  accountByCode,
  isCashAccount,
  isPurchaseAccount,
  systemAccount,
  postEntry,
  reverseEntry,
  getEntryWithLines,
  invoiceBalanceCents,
  billBalanceCents,
  invoiceDisplayStatus,
  billDisplayStatus,
  assertManualEntryAccounts,
};
