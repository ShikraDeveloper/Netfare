'use strict';

// Petty cash: a cash float (1020 Petty Cash) topped up from the bank or the
// cash drawer, spent through quick expenses, and counted from time to time.
// A count that differs from the books posts the shortage or overage to
// 6900 Other Expenses.

const { bad, notFound, optionalStr, cents, dateISO, todayISO } = require('../util');
const { postEntry, reverseEntry, accountByCode } = require('../accounting');
const cashDeposits = require('./cash-deposits');
const audit = require('./audit');

const OVER_SHORT_CODE = '6900';

function pettyCashAccount(db) {
  const account = accountByCode(db, cashDeposits.PETTY_CASH_CODE);
  if (!account || !account.is_active || account.type !== 'asset' || !account.is_cash) {
    throw bad('Petty cash needs the 1020 Petty Cash account (an active cash account). Restore it in Chart of accounts.');
  }
  return account;
}

function getPettyCash(db, { from, to } = {}) {
  const account = pettyCashAccount(db);
  const end = to ? dateISO(to, 'To date') : todayISO();
  const start = from ? dateISO(from, 'From date') : `${end.slice(0, 7)}-01`;
  const balance = cashDeposits.accountBalanceAsOf(db, account.id, '9999-12-31');
  const floatCents = db.prepare('SELECT petty_cash_float_cents AS f FROM settings WHERE id = 1').get()?.f || 0;
  const opening = cashDeposits.accountBalanceAsOf(db, account.id, prevDay(start));
  let running = opening;
  const lines = db.prepare(`
    SELECT l.id, l.debit_cents, l.credit_cents, l.description,
           e.id AS entry_id, e.entry_date, e.memo, e.reference, e.source_type, e.source_id
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.account_id = ? AND e.entry_date >= ? AND e.entry_date <= ?
    ORDER BY e.entry_date, e.id, l.id
  `).all(account.id, start, end).map((line) => {
    running += line.debit_cents - line.credit_cents;
    return { ...line, balance_cents: running };
  });
  const totals = lines.reduce((sum, line) => ({
    in_cents: sum.in_cents + line.debit_cents,
    out_cents: sum.out_cents + line.credit_cents,
  }), { in_cents: 0, out_cents: 0 });
  const counts = db.prepare('SELECT * FROM petty_cash_counts ORDER BY count_date DESC, id DESC LIMIT 20').all();
  return {
    account,
    balance_cents: balance,
    float_cents: floatCents,
    top_up_cents: floatCents > balance ? floatCents - balance : 0,
    period: { from: start, to: end },
    opening_cents: opening,
    closing_cents: running,
    ...totals,
    lines,
    counts,
    last_count: counts.find((row) => row.status === 'posted') || null,
  };
}

function prevDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function setFloat(db, payload = {}) {
  const amount = cents(payload.float_cents ?? 0, 'Float amount');
  db.prepare('UPDATE settings SET petty_cash_float_cents = ? WHERE id = 1').run(amount);
  return getPettyCash(db);
}

// Moves money from the bank or the cash drawer into petty cash.
function topUp(db, payload = {}) {
  const account = pettyCashAccount(db);
  return cashDeposits.createDeposit(db, {
    amount_cents: payload.amount_cents,
    deposit_date: payload.date || todayISO(),
    from_account_id: payload.from_account_id,
    to_account_id: account.id,
    reference: payload.reference,
    notes: payload.notes || 'Petty cash top-up',
  });
}

function recordCount(db, payload = {}) {
  return db.transaction(() => {
    const account = pettyCashAccount(db);
    const date = dateISO(payload.count_date || todayISO(), 'Count date');
    if (date > todayISO()) throw bad('The count date cannot be in the future');
    const counted = cents(payload.counted_cents, 'Cash counted');
    const book = cashDeposits.accountBalanceAsOf(db, account.id, date);
    const difference = counted - book;
    const notes = optionalStr(payload.notes, 'Notes', 1000);
    const info = db.prepare(`
      INSERT INTO petty_cash_counts (count_date, counted_cents, book_cents, difference_cents, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(date, counted, book, difference, notes);
    const id = Number(info.lastInsertRowid);
    if (difference !== 0) {
      const overShort = accountByCode(db, OVER_SHORT_CODE);
      if (!overShort || !overShort.is_active) throw bad('Add the 6900 Other Expenses account first');
      const label = difference < 0 ? 'shortage' : 'overage';
      const amount = Math.abs(difference);
      const entryId = postEntry(db, {
        entry_date: date,
        memo: `Petty cash count — ${label}${notes ? ` · ${notes}` : ''}`,
        reference: `Count #${id}`,
        source_type: 'petty_cash_count',
        source_id: id,
        lines: difference < 0
          ? [
            { account_id: overShort.id, debit_cents: amount, credit_cents: 0, description: 'Petty cash shortage' },
            { account_id: account.id, debit_cents: 0, credit_cents: amount, description: 'Petty cash shortage' },
          ]
          : [
            { account_id: account.id, debit_cents: amount, credit_cents: 0, description: 'Petty cash overage' },
            { account_id: overShort.id, debit_cents: 0, credit_cents: amount, description: 'Petty cash overage' },
          ],
      });
      db.prepare('UPDATE petty_cash_counts SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
    }
    return db.prepare('SELECT * FROM petty_cash_counts WHERE id = ?').get(id);
  })();
}

function voidCount(db, id, payload = {}) {
  return db.transaction(() => {
    const count = db.prepare('SELECT * FROM petty_cash_counts WHERE id = ?').get(id);
    if (!count) throw notFound('Petty cash count not found');
    if (count.status === 'void') throw bad('That count is already void');
    const remarks = optionalStr(payload.remarks ?? '', 'Void remarks', 2000);
    const voidEntryId = count.journal_entry_id
      ? reverseEntry(db, count.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void petty cash count #${id}`, remarks),
        source_type: 'void',
      })
      : null;
    db.prepare("UPDATE petty_cash_counts SET status = 'void', void_entry_id = ? WHERE id = ?").run(voidEntryId, id);
    audit.record(db, {
      entity_type: 'petty_cash_count',
      entity_id: id,
      entity_number: `Count #${id}`,
      action: 'void',
      remarks: remarks || `Voided petty cash count #${id}`,
      amount_cents: Math.abs(count.difference_cents),
    });
    return db.prepare('SELECT * FROM petty_cash_counts WHERE id = ?').get(id);
  })();
}

module.exports = {
  getPettyCash,
  setFloat,
  topUp,
  recordCount,
  voidCount,
};
