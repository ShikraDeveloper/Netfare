'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, notFound, str, optionalStr, isTruthy } = require('../util');

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const DEBIT_TYPES = ['asset', 'expense'];

function normalBalance(type) {
  return DEBIT_TYPES.includes(type) ? 'debit' : 'credit';
}

function listAccounts({ includeInactive = false } = {}) {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)
       FROM journal_lines l WHERE l.account_id = a.id) AS debit_net
    FROM accounts a
    ORDER BY a.code
  `).all();
  return rows
    .filter((row) => includeInactive || row.is_active)
    .map((row) => ({
      ...row,
      balance_cents: row.normal_balance === 'debit' ? row.debit_net : -row.debit_net,
    }));
}

router.get('/', (req, res) => {
  res.json(listAccounts({ includeInactive: isTruthy(req.query.include_inactive) }));
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const code = str(body.code, 'Account code', { max: 20 });
  const name = str(body.name, 'Account name', { max: 120 });
  const type = str(body.type, 'Account type');
  if (!ACCOUNT_TYPES.includes(type)) throw bad('Account type is not valid');
  if (db.prepare('SELECT 1 FROM accounts WHERE code = ?').get(code)) {
    throw bad(`Account code ${code} is already in use`);
  }
  const info = db.prepare(`
    INSERT INTO accounts (code, name, type, subtype, normal_balance, is_cash, is_system, description)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    code,
    name,
    type,
    optionalStr(body.subtype, 'Subtype', 60),
    normalBalance(type),
    isTruthy(body.is_cash) ? 1 : 0,
    optionalStr(body.description, 'Description', 500),
  );
  res.status(201).json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!existing) throw notFound('Account not found');
  const body = req.body || {};

  const name = body.name != null ? str(body.name, 'Account name', { max: 120 }) : existing.name;
  const description = body.description != null
    ? optionalStr(body.description, 'Description', 500)
    : existing.description;
  const isCash = body.is_cash != null ? (isTruthy(body.is_cash) ? 1 : 0) : existing.is_cash;
  const isActive = body.is_active != null ? (isTruthy(body.is_active) ? 1 : 0) : existing.is_active;
  let code = existing.code;
  let type = existing.type;
  let normal = existing.normal_balance;

  if (body.code != null) {
    code = str(body.code, 'Account code', { max: 20 });
    if (existing.is_system && code !== existing.code) {
      throw bad('System account codes cannot be changed');
    }
    const duplicate = db.prepare('SELECT id FROM accounts WHERE code = ? AND id <> ?').get(code, id);
    if (duplicate) throw bad(`Account code ${code} is already in use`);
  }

  if (body.type != null && body.type !== existing.type) {
    if (existing.is_system) throw bad('System account types cannot be changed');
    const used = db.prepare('SELECT COUNT(*) AS c FROM journal_lines WHERE account_id = ?').get(id).c;
    if (used > 0) throw bad('This account already has transactions, so its type cannot be changed');
    type = str(body.type, 'Account type');
    if (!ACCOUNT_TYPES.includes(type)) throw bad('Account type is not valid');
    normal = normalBalance(type);
  }

  if (!isActive && existing.is_system) {
    throw bad('System accounts cannot be archived');
  }

  db.prepare(`
    UPDATE accounts SET code = ?, name = ?, type = ?, normal_balance = ?, is_cash = ?, is_active = ?, description = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(code, name, type, normal, isCash, isActive, description, id);

  res.json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!account) throw notFound('Account not found');
  if (account.is_system) throw bad('System accounts cannot be deleted');

  const references = [
    ['journal_lines', 'account_id'],
    ['invoice_items', 'account_id'],
    ['bill_items', 'account_id'],
    ['payments', 'deposit_account_id'],
    ['bill_payments', 'payment_account_id'],
  ];
  for (const [table, column] of references) {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`).get(id).c;
    if (count > 0) throw bad('This account is used by existing transactions. Archive it instead.');
  }
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  res.json({ deleted: true });
});

module.exports = router;
module.exports.listAccounts = listAccounts;
