'use strict';

const {
  bad,
  notFound,
  optionalStr,
  cents,
  dateISO,
  todayISO,
} = require('../util');
const {
  postEntry,
  reverseEntry,
  getEntryWithLines,
} = require('../accounting');
const { allocateNumber } = require('./numbering');

function accountBalanceAsOf(db, accountId, asOf) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS balance
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE l.account_id = ? AND a.type = 'asset' AND e.entry_date <= ?
  `).get(accountId, asOf);
  return row.balance;
}

function accountBalance(db, accountId) {
  return accountBalanceAsOf(db, accountId, '9999-12-31');
}

function cashBalances(db) {
  const cash = db.prepare("SELECT * FROM accounts WHERE code = '1000'").get();
  const rows = db.prepare(`
    SELECT a.id, a.code, a.name, a.is_cash,
           COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS balance_cents
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
    WHERE a.type = 'asset' AND a.is_cash = 1
    GROUP BY a.id
    ORDER BY a.code
  `).all();
  const cashRow = rows.find((row) => row.id === cash?.id) || null;
  const bankRows = rows.filter((row) => row.id !== cash?.id);
  return {
    cash_account: cashRow,
    cash_balance_cents: cashRow ? cashRow.balance_cents : 0,
    bank_balance_cents: bankRows.reduce((sum, row) => sum + row.balance_cents, 0),
    bank_accounts: bankRows,
    accounts: rows,
  };
}

const depositSelect = `
  SELECT d.*, f.code AS from_code, f.name AS from_name,
         t.code AS to_code, t.name AS to_name
  FROM cash_deposits d
  JOIN accounts f ON f.id = d.from_account_id
  JOIN accounts t ON t.id = d.to_account_id
`;

function listDeposits(db, { from, to, status } = {}) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('d.deposit_date >= ?');
    params.push(dateISO(from, 'From date'));
  }
  if (to) {
    clauses.push('d.deposit_date <= ?');
    params.push(dateISO(to, 'To date'));
  }
  if (status && status !== 'all') {
    if (!['posted', 'void'].includes(status)) throw bad('Invalid deposit status');
    clauses.push('d.status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const deposits = db.prepare(`${depositSelect} ${where}
    ORDER BY d.deposit_date DESC, d.id DESC
  `).all(...params);
  const balances = cashBalances(db);
  const start = `${todayISO().slice(0, 7)}-01`;
  const month = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS count
    FROM cash_deposits
    WHERE status = 'posted' AND deposit_date >= ?
  `).get(start);
  return {
    deposits,
    balances: {
      cash_balance_cents: balances.cash_balance_cents,
      bank_balance_cents: balances.bank_balance_cents,
      cash_accounts: balances.accounts.filter((row) => row.id === balances.cash_account?.id),
      bank_accounts: balances.bank_accounts,
    },
    summary: {
      month_total_cents: month.total,
      month_count: month.count,
      last_deposit: deposits.find((row) => row.status === 'posted') || null,
    },
  };
}

function getDeposit(db, id) {
  const row = db.prepare(`${depositSelect} WHERE d.id = ?`).get(id);
  if (!row) throw notFound('Cash deposit not found');
  row.journal_entry = row.journal_entry_id ? getEntryWithLines(db, row.journal_entry_id) : null;
  row.void_entry = row.void_entry_id ? getEntryWithLines(db, row.void_entry_id) : null;
  return row;
}

function createDeposit(db, payload = {}) {
  return db.transaction(() => {
    const amount = cents(payload.amount_cents, 'Deposit amount', { min: 1 });
    const depositDate = dateISO(payload.deposit_date || todayISO(), 'Deposit date');
    const fromId = Number(payload.from_account_id);
    const toId = Number(payload.to_account_id);
    const from = db.prepare('SELECT * FROM accounts WHERE id = ?').get(fromId);
    const to = db.prepare('SELECT * FROM accounts WHERE id = ?').get(toId);
    if (!from || !to) throw bad('Choose both the cash and bank accounts');
    if (!from.is_active || !to.is_active) throw bad('Both deposit accounts must be active');
    if (from.type !== 'asset' || to.type !== 'asset' || !from.is_cash || !to.is_cash) {
      throw bad('Cash deposits must move between cash or bank accounts');
    }
    if (from.id === to.id) throw bad('Cash and bank accounts must be different');
    const availableOnDate = accountBalanceAsOf(db, from.id, depositDate);
    if (amount > availableOnDate) {
      throw bad(`Deposit exceeds the ${from.name} balance on ${depositDate} of ${(availableOnDate / 100).toFixed(2)}`);
    }
    const availableToday = accountBalanceAsOf(db, from.id, todayISO());
    if (amount > availableToday) {
      throw bad(`Deposit exceeds the available ${from.name} balance of ${(availableToday / 100).toFixed(2)}`);
    }
    const number = allocateNumber(db, 'deposit', depositDate);
    const info = db.prepare(`
      INSERT INTO cash_deposits (
        number, deposit_date, amount_cents, from_account_id, to_account_id,
        reference, notes, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'posted')
    `).run(
      number,
      depositDate,
      amount,
      from.id,
      to.id,
      optionalStr(payload.reference, 'Reference', 200),
      optionalStr(payload.notes, 'Notes', 1000),
    );
    const id = Number(info.lastInsertRowid);
    const entryId = postEntry(db, {
      entry_date: depositDate,
      memo: `Cash deposit ${number} — ${from.name} to ${to.name}`,
      reference: number,
      source_type: 'cash_deposit',
      source_id: id,
      lines: [
        { account_id: to.id, debit_cents: amount, credit_cents: 0, description: `Deposit ${number}` },
        { account_id: from.id, debit_cents: 0, credit_cents: amount, description: `Cash deposit ${number}` },
      ],
    });
    db.prepare('UPDATE cash_deposits SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
    return getDeposit(db, id);
  })();
}

function voidDeposit(db, id, payload = {}) {
  return db.transaction(() => {
    const deposit = db.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(id);
    if (!deposit) throw notFound('Cash deposit not found');
    if (deposit.status === 'void') throw bad('Cash deposit is already void');
    const voidDate = dateISO(payload.void_date || todayISO(), 'Void date');
    if (voidDate < deposit.deposit_date) throw bad('Void date cannot be before the deposit date');
    const voidEntryId = deposit.journal_entry_id
      ? reverseEntry(db, deposit.journal_entry_id, {
          entry_date: voidDate,
          memo: `Void cash deposit ${deposit.number}`,
          source_type: 'void',
        })
      : null;
    db.prepare(`
      UPDATE cash_deposits SET status = 'void', void_entry_id = ? WHERE id = ?
    `).run(voidEntryId, id);
    return getDeposit(db, id);
  })();
}

function listCashAccounts(db) {
  return cashBalances(db).accounts;
}

module.exports = {
  cashBalances,
  listCashAccounts,
  listDeposits,
  getDeposit,
  createDeposit,
  voidDeposit,
};
