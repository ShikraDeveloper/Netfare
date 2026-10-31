'use strict';

// Card and payment link settlements. Money taken by card or payment link
// waits in 1030 Card & Payment Link Clearing. When the gateway pays the batch
// into the bank, less its fee, the chosen items are settled in one entry:
// Dr bank (net) · Dr 6700 Bank Charges (fee) · Cr 1030 (gross).

const { bad, notFound, optionalStr, cents, dateISO, todayISO } = require('../util');
const { postEntry, reverseEntry, accountByCode, isCashAccount, SYSTEM_CODES } = require('../accounting');
const { allocateNumber } = require('./numbering');
const audit = require('./audit');

function clearingAccount(db) {
  const account = accountByCode(db, SYSTEM_CODES.CARD_CLEARING);
  if (!account || !account.is_active) {
    throw bad('Card settlements need the 1030 Card & Payment Link Clearing account. Restore it in Chart of accounts.');
  }
  return account;
}

// Lines on 1030 not yet settled. Entries that were voided (and their
// reversals) drop out, so a voided card payment is never settled.
function openItems(db, accountId) {
  return db.prepare(`
    SELECT l.id, l.entry_id, l.debit_cents, l.credit_cents, l.description,
           e.entry_date, e.memo, e.reference, e.source_type, e.source_id,
           p.method AS payment_method, p.number AS payment_number, c.name AS customer_name
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    LEFT JOIN payments p ON e.source_type = 'payment' AND p.id = e.source_id
    LEFT JOIN customers c ON c.id = p.customer_id
    WHERE l.account_id = ?
      AND e.reversal_of_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of_id = e.id)
      AND NOT EXISTS (
        SELECT 1 FROM card_settlement_lines sl JOIN card_settlements s ON s.id = sl.settlement_id
        WHERE sl.journal_line_id = l.id AND s.status = 'posted'
      )
      AND e.source_type != 'card_settlement'
    ORDER BY e.entry_date, e.id, l.id
  `).all(accountId).map((line) => ({ ...line, amount_cents: line.debit_cents - line.credit_cents }));
}

function getCardSettlements(db) {
  const account = clearingAccount(db);
  const balance = db.prepare(`
    SELECT COALESCE(SUM(debit_cents - credit_cents), 0) AS total FROM journal_lines WHERE account_id = ?
  `).get(account.id).total;
  const items = openItems(db, account.id);
  const settlements = db.prepare(`
    SELECT s.*, a.code AS bank_code, a.name AS bank_name,
           (SELECT COUNT(*) FROM card_settlement_lines sl WHERE sl.settlement_id = s.id) AS item_count
    FROM card_settlements s JOIN accounts a ON a.id = s.bank_account_id
    ORDER BY s.settlement_date DESC, s.id DESC LIMIT 50
  `).all();
  return {
    account,
    in_transit_cents: balance,
    open_total_cents: items.reduce((sum, item) => sum + item.amount_cents, 0),
    items,
    settlements,
  };
}

function createSettlement(db, payload = {}) {
  return db.transaction(() => {
    const clearing = clearingAccount(db);
    const ids = [...new Set((payload.line_ids || []).map(Number))].filter(Boolean);
    if (!ids.length) throw bad('Choose the card or payment link items in this settlement');
    const open = new Map(openItems(db, clearing.id).map((item) => [item.id, item]));
    const chosen = ids.map((id) => {
      const item = open.get(id);
      if (!item) throw bad('One of the chosen items is already settled or was voided. Reload and try again.');
      return item;
    });
    const gross = chosen.reduce((sum, item) => sum + item.amount_cents, 0);
    if (gross <= 0) throw bad('The chosen items must add up to more than zero');
    const net = cents(payload.net_cents, 'Amount received in the bank', { min: 1 });
    if (net > gross) throw bad('The bank cannot receive more than the items settled');
    const fee = gross - net;
    const date = dateISO(payload.settlement_date || todayISO(), 'Settlement date');
    const latest = chosen.reduce((max, item) => (item.entry_date > max ? item.entry_date : max), '');
    if (date < latest) throw bad(`The settlement date cannot be before the last item (${latest})`);
    const bank = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payload.bank_account_id));
    if (!isCashAccount(bank) || bank.id === clearing.id) throw bad('Choose the bank account the money arrived in');
    const feeAccount = fee ? accountByCode(db, SYSTEM_CODES.BANK_CHARGES) : null;
    if (fee && (!feeAccount || !feeAccount.is_active)) throw bad('Add the 6700 Bank Charges expense account first');

    const number = allocateNumber(db, 'card_settlement', date);
    const info = db.prepare(`
      INSERT INTO card_settlements (number, settlement_date, bank_account_id, gross_cents, fee_cents, net_cents, reference, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      number, date, bank.id, gross, fee, net,
      optionalStr(payload.reference, 'Reference', 200), optionalStr(payload.notes, 'Notes', 1000),
    );
    const id = Number(info.lastInsertRowid);
    const insertLine = db.prepare('INSERT INTO card_settlement_lines (settlement_id, journal_line_id, amount_cents) VALUES (?, ?, ?)');
    for (const item of chosen) insertLine.run(id, item.id, item.amount_cents);
    const entryId = postEntry(db, {
      entry_date: date,
      memo: `Card settlement ${number} — ${chosen.length} item${chosen.length === 1 ? '' : 's'}${fee ? `, fee ${(fee / 100).toFixed(2)}` : ''}`,
      reference: number,
      source_type: 'card_settlement',
      source_id: id,
      lines: [
        { account_id: bank.id, debit_cents: net, credit_cents: 0, description: `Card settlement ${number}` },
        ...(fee ? [{ account_id: feeAccount.id, debit_cents: fee, credit_cents: 0, description: `Card / payment link fees · ${number}` }] : []),
        { account_id: clearing.id, debit_cents: 0, credit_cents: gross, description: `Card settlement ${number}` },
      ],
    });
    db.prepare('UPDATE card_settlements SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
    return db.prepare('SELECT * FROM card_settlements WHERE id = ?').get(id);
  })();
}

// Voiding a settlement reverses its entry and puts its items back to open.
function voidSettlement(db, id, payload = {}) {
  return db.transaction(() => {
    const settlement = db.prepare('SELECT * FROM card_settlements WHERE id = ?').get(id);
    if (!settlement) throw notFound('Card settlement not found');
    if (settlement.status === 'void') throw bad('That settlement is already void');
    const reconciled = db.prepare(`
      SELECT 1 FROM bank_reconciliation_lines rl JOIN journal_lines l ON l.id = rl.journal_line_id
      WHERE l.entry_id = ? LIMIT 1
    `).get(settlement.journal_entry_id);
    if (reconciled) throw bad('This settlement is ticked in a bank reconciliation. Void that reconciliation first.');
    const remarks = optionalStr(payload.remarks ?? '', 'Void remarks', 2000);
    const voidEntryId = settlement.journal_entry_id
      ? reverseEntry(db, settlement.journal_entry_id, {
        entry_date: todayISO(),
        memo: audit.withRemarks(`Void card settlement ${settlement.number}`, remarks),
        source_type: 'void',
      })
      : null;
    db.prepare("UPDATE card_settlements SET status = 'void', void_entry_id = ? WHERE id = ?").run(voidEntryId, id);
    audit.record(db, {
      entity_type: 'card_settlement',
      entity_id: id,
      entity_number: settlement.number,
      action: 'void',
      remarks: remarks || `Voided card settlement ${settlement.number}`,
      amount_cents: settlement.gross_cents,
    });
    return db.prepare('SELECT * FROM card_settlements WHERE id = ?').get(id);
  })();
}

module.exports = {
  openItems,
  getCardSettlements,
  createSettlement,
  voidSettlement,
};
