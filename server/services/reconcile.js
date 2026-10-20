'use strict';

const { bad, dateISO, optionalStr } = require('../util');
const { portalLedger } = require('./portals');

const MAX_ROWS = 2000;
const MAX_TOLERANCE_DAYS = 31;

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

function referenceKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw bad('Import at least one statement row');
  if (rows.length > MAX_ROWS) throw bad(`Import at most ${MAX_ROWS} statement rows at a time`);

  return rows.map((row, index) => {
    const label = `Statement row ${index + 1}`;
    const date = dateISO(row && row.date, `${label} date`);

    const inRaw = row && row.in_cents != null && row.in_cents !== '' ? Number(row.in_cents) : 0;
    const outRaw = row && row.out_cents != null && row.out_cents !== '' ? Number(row.out_cents) : 0;
    if (!Number.isFinite(inRaw) || !Number.isFinite(outRaw)) throw bad(`${label} has an invalid amount`);

    const inCents = Math.round(Math.abs(inRaw));
    const outCents = Math.round(Math.abs(outRaw));
    if (inCents === 0 && outCents === 0) throw bad(`${label} has no amount`);
    if (inCents > 0 && outCents > 0) throw bad(`${label} has both money in and money out`);

    let balance = null;
    if (row.balance_cents != null && row.balance_cents !== '') {
      const parsed = Number(row.balance_cents);
      if (!Number.isFinite(parsed)) throw bad(`${label} has an invalid balance`);
      balance = Math.round(parsed);
    }

    return {
      index,
      date,
      description: optionalStr(row.description, `${label} description`, 300) || '',
      reference: optionalStr(row.reference, `${label} reference`, 120) || '',
      in_cents: inCents,
      out_cents: outCents,
      amount_cents: inCents || outCents,
      direction: inCents > 0 ? 'in' : 'out',
      balance_cents: balance,
    };
  });
}

function suggestionFor(statement, ledgerRows, tolerance) {
  const statementRef = referenceKey(statement.reference);
  const candidates = [];

  for (const row of ledgerRows) {
    if (row.direction !== statement.direction) continue;
    const sameRef = statementRef && referenceKey(row.reference) === statementRef;
    const gap = Math.abs(daysBetween(statement.date, row.date));
    const sameAmount = row.amount_cents === statement.amount_cents;

    if (sameRef) {
      candidates.push({ ledger: row, reason: 'reference', days_diff: daysBetween(statement.date, row.date) });
    } else if (sameAmount && gap > tolerance) {
      candidates.push({ ledger: row, reason: 'outside-window', days_diff: daysBetween(statement.date, row.date) });
    } else if (sameAmount && gap === 0) {
      candidates.push({ ledger: row, reason: 'same-date', days_diff: 0 });
    }
  }

  candidates.sort((a, b) => Math.abs(a.days_diff) - Math.abs(b.days_diff));
  return candidates.slice(0, 2);
}

function reconcilePortal(db, portalId, payload = {}) {
  const ledger = portalLedger(db, portalId, payload);
  if (ledger.mode === 'credit') {
    throw bad('Reconciliation is for prepaid portal wallets. Credit accounts use the supplier ledger.');
  }
  const tolerance = payload.tolerance_days == null
    ? 7
    : Math.max(0, Math.min(MAX_TOLERANCE_DAYS, Math.round(Number(payload.tolerance_days) || 0)));

  const statementRows = normalizeRows(payload.rows);

  const ledgerRows = ledger.rows.map((row) => ({
    key: row.key,
    kind: row.kind,
    date: row.date,
    reference: row.reference,
    description: row.description,
    detail: row.detail,
    in_cents: row.debit_cents,
    out_cents: row.credit_cents,
    amount_cents: row.debit_cents || row.credit_cents,
    direction: row.debit_cents > 0 ? 'in' : 'out',
    running_balance_cents: row.balance_cents,
    entry_id: row.entry_id,
    bill_id: row.bill_id || null,
    booking_id: row.booking_id || null,
  }));

  const used = new Set();
  const matched = [];
  const matchedStatement = new Set();

  // Pass 1: same direction and amount, inside the date window. Prefer a
  // matching reference, then the closest date.
  for (const statement of statementRows) {
    const statementRef = referenceKey(statement.reference);
    const candidates = ledgerRows.filter((row) => (
      !used.has(row.key)
      && row.direction === statement.direction
      && row.amount_cents === statement.amount_cents
      && Math.abs(daysBetween(statement.date, row.date)) <= tolerance
    ));

    if (!candidates.length) continue;

    candidates.sort((a, b) => {
      const aRef = statementRef && referenceKey(a.reference) === statementRef ? 0 : 1;
      const bRef = statementRef && referenceKey(b.reference) === statementRef ? 0 : 1;
      if (aRef !== bRef) return aRef - bRef;
      const aGap = Math.abs(daysBetween(statement.date, a.date));
      const bGap = Math.abs(daysBetween(statement.date, b.date));
      if (aGap !== bGap) return aGap - bGap;
      return a.key.localeCompare(b.key);
    });

    const best = candidates[0];
    used.add(best.key);
    matchedStatement.add(statement.index);
    matched.push({
      statement,
      ledger: best,
      days_diff: daysBetween(statement.date, best.date),
      reference_matched: Boolean(statementRef) && referenceKey(best.reference) === statementRef,
    });
  }

  const missingInBooks = statementRows
    .filter((row) => !matchedStatement.has(row.index))
    .map((row) => ({ ...row, suggestions: suggestionFor(row, ledgerRows.filter((item) => !used.has(item.key)), tolerance) }));

  const missingOnStatement = ledgerRows.filter((row) => !used.has(row.key));

  const statementIn = statementRows.reduce((sum, row) => sum + row.in_cents, 0);
  const statementOut = statementRows.reduce((sum, row) => sum + row.out_cents, 0);

  // Cross-check the running balance printed on the statement, if it has one.
  const withBalance = statementRows
    .map((row, order) => ({ row, order }))
    .filter(({ row }) => row.balance_cents != null)
    .sort((a, b) => {
      if (a.row.date !== b.row.date) return a.row.date < b.row.date ? -1 : 1;
      return a.order - b.order;
    });
  const statementOpening = withBalance.length
    ? withBalance[0].row.balance_cents - withBalance[0].row.in_cents + withBalance[0].row.out_cents
    : null;
  const statementClosing = withBalance.length
    ? withBalance[withBalance.length - 1].row.balance_cents
    : null;

  return {
    portal: ledger.portal,
    from: ledger.from,
    to: ledger.to,
    tolerance_days: tolerance,
    generated_at: new Date().toISOString(),
    summary: {
      statement_rows: statementRows.length,
      ledger_rows: ledgerRows.length,
      matched: matched.length,
      missing_in_books: missingInBooks.length,
      missing_on_statement: missingOnStatement.length,
      statement_in_cents: statementIn,
      statement_out_cents: statementOut,
      ledger_in_cents: ledger.total_debit_cents,
      ledger_out_cents: ledger.total_credit_cents,
    },
    balance: {
      statement_opening_cents: statementOpening,
      statement_closing_cents: statementClosing,
      ledger_opening_cents: ledger.opening_cents,
      ledger_closing_cents: ledger.closing_cents,
      opening_difference_cents: statementOpening == null ? null : statementOpening - ledger.opening_cents,
      closing_difference_cents: statementClosing == null ? null : statementClosing - ledger.closing_cents,
    },
    statement_rows: statementRows,
    ledger_rows: ledgerRows,
    matched,
    missing_in_books: missingInBooks,
    missing_on_statement: missingOnStatement,
  };
}

module.exports = { reconcilePortal, daysBetween };
