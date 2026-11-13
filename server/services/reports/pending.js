'use strict';

// The dashboard's "things pending" reminder: everything still waiting on
// someone, grouped, with how many days each item has waited.
//
// Days count from the due date for invoices, bills, cheques and due dates on
// Compliance (0 while not yet due, with due_in for the days left), and from
// the day it started for the rest: a card payment from its date, a draft
// from when it was made. A staff user sees only the groups (and, for drafts,
// the items) of areas they have a right to.

const { todayISO } = require('../../util');
const { parsePermissions } = require('../../permissions');
const { SYSTEM_CODES, accountByCode } = require('../../accounting');
const cardSettlements = require('../card-settlements');
const { listSettlementQueue } = require('../settlement-queue');
const { listDeposits } = require('../visa-deposits');

const ITEMS_SHOWN = 5;
// A bank account is due for reconciling a month after its last statement.
const RECONCILE_EVERY_DAYS = 31;

function daysBetween(from, to) {
  if (!from) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

// Waiting since a date: never negative.
function since(date, today) {
  return { days: Math.max(0, daysBetween(date, today)) };
}

// Due on a date: days overdue, or the days left while not yet due.
function due(date, today) {
  const overdue = daysBetween(date, today);
  return overdue >= 0 ? { days: overdue } : { days: 0, due_in: -overdue };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 2026-08-06 → "6 Aug 2026".
function nice(date) {
  const [year, month, day] = String(date || '').slice(0, 10).split('-').map(Number);
  return year && month && day ? `${day} ${MONTHS[month - 1]} ${year}` : '';
}

function balance(row) {
  return row.total_cents - row.amount_paid_cents - (row.credit_applied_cents || 0);
}

function collect(db, today) {
  return db.prepare(`
    SELECT i.id, i.number, i.issue_date, i.due_date, i.total_cents, i.amount_paid_cents, i.credit_applied_cents, c.name AS party
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.status = 'sent' AND i.total_cents > i.amount_paid_cents + i.credit_applied_cents
  `).all().map((row) => ({
    label: row.party,
    sub: `${row.number} · due ${nice(row.due_date || row.issue_date)}`,
    cents: balance(row),
    ...due(row.due_date || row.issue_date, today),
    href: `#/invoices/${row.id}`,
  }));
}

function pay(db, today) {
  return db.prepare(`
    SELECT b.id, b.number, b.bill_date, b.due_date, b.total_cents, b.amount_paid_cents, b.credit_applied_cents, v.name AS party
    FROM bills b JOIN vendors v ON v.id = b.vendor_id
    WHERE b.status = 'received' AND b.total_cents > b.amount_paid_cents + b.credit_applied_cents
  `).all().map((row) => ({
    label: row.party,
    sub: `${row.number} · due ${nice(row.due_date || row.bill_date)}`,
    cents: balance(row),
    ...due(row.due_date || row.bill_date, today),
    href: `#/bills/${row.id}`,
  }));
}

// Card and payment link money still in 1030, waiting for the gateway payout.
function cardMoney(db, today) {
  const clearing = accountByCode(db, SYSTEM_CODES.CARD_CLEARING);
  if (!clearing) return [];
  return cardSettlements.openItems(db, clearing.id)
    .filter((line) => line.debit_cents > line.credit_cents)
    .map((line) => ({
      label: [line.payment_method, line.customer_name].filter(Boolean).join(' · ') || line.description || line.memo || 'Card payment',
      sub: [line.payment_number || line.reference, nice(line.entry_date)].filter(Boolean).join(' · '),
      cents: line.debit_cents - line.credit_cents,
      ...since(line.entry_date, today),
      href: '#/card-settlements',
    }));
}

function giveBack(db, today) {
  return listSettlementQueue(db, {}).items.map((row) => ({
    label: `${row.type_label} · ${row.party_name}`,
    sub: [row.number, row.detail].filter(Boolean).join(' · '),
    cents: row.remaining_cents,
    ...since(row.date, today),
    href: row.href || '#/settlement-queue',
  }));
}

function depositsToRefund(db, today) {
  return listDeposits(db, { status: 'open' })
    .filter((row) => ['cancelled', 'rejected'].includes(row.visa_status))
    .map((row) => ({
      label: `Visa deposit · ${row.customer_name}`,
      sub: `${row.visa_number} · visa ${row.visa_status}`,
      cents: row.held_cents,
      ...since(row.deposit_date, today),
      href: `#/visas/${row.visa_id}`,
    }));
}

// Cheques whose date has come but that are not cleared yet, and bounced ones.
function cheques(db, today) {
  return db.prepare(`
    SELECT q.cheque_number, q.cheque_date, q.amount_cents, q.status, v.name AS party
    FROM post_dated_cheques q JOIN vendors v ON v.id = q.vendor_id
    WHERE (q.status IN ('planned', 'issued') AND q.cheque_date <= ?) OR q.status = 'bounced'
  `).all(today).map((row) => ({
    label: `Cheque ${row.cheque_number} · ${row.party}`,
    sub: row.status === 'bounced' ? `Bounced · dated ${nice(row.cheque_date)}` : `Dated ${nice(row.cheque_date)} · not cleared yet`,
    cents: row.amount_cents,
    ...due(row.cheque_date, today),
    href: '#/cheques',
  }));
}

// Bank accounts with entries and no statement reconciled for over a month.
function reconciliations(db, today) {
  return db.prepare(`
    SELECT a.id, a.code, a.name,
           (SELECT MAX(r.statement_date) FROM bank_reconciliations r WHERE r.account_id = a.id) AS last_date,
           (SELECT MIN(e.entry_date) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = a.id) AS first_date
    FROM accounts a
    WHERE a.is_cash = 1 AND a.is_active = 1 AND a.code NOT IN ('1000', '1020')
  `).all()
    .filter((row) => row.first_date && daysBetween(row.last_date || row.first_date, today) > RECONCILE_EVERY_DAYS)
    .map((row) => ({
      label: `Reconcile ${row.code} · ${row.name}`,
      sub: row.last_date ? `Last statement ${nice(row.last_date)}` : 'Never reconciled',
      cents: null,
      ...since(row.last_date || row.first_date, today),
      href: '#/bank-reconciliation',
    }));
}

// Backups (admin only): a failed automatic backup, none yet, or the newest
// two days old or more. Nothing while automatic backups are switched off.
function backups(db, today) {
  const status = require('../backup').backupStatus();
  if (!status.enabled) return [];
  const item = { cents: null, href: '#/settings' };
  if (status.failure) {
    return [{ ...item, label: 'Automatic backup failed', sub: status.failure.message, ...since(todayISO(new Date(status.failure.at)), today) }];
  }
  if (!status.latest_at) return [{ ...item, label: 'No backup yet', sub: 'Make one in Settings', days: 0 }];
  // Backup times are UTC; count in the office's own days.
  const saved = todayISO(new Date(status.latest_at));
  const age = daysBetween(saved, today);
  if (age < 2) return [];
  return [{ ...item, label: `Last backup ${age} days ago`, sub: `Last saved ${nice(saved)}`, days: age }];
}

const DRAFTS = [
  { area: 'bookings', sql: "SELECT id, number, created_at, sale_total_cents AS cents FROM bookings WHERE status = 'draft'", kind: 'Booking', href: 'bookings' },
  { area: 'visas', sql: "SELECT id, number, created_at, sale_total_cents AS cents FROM visa_applications WHERE status = 'draft'", kind: 'Visa', href: 'visas' },
  { area: 'sales', sql: "SELECT id, number, created_at, total_cents AS cents FROM invoices WHERE status = 'draft'", kind: 'Invoice', href: 'invoices' },
];

function drafts(db, today, allowed) {
  return DRAFTS.filter((kind) => allowed(kind.area)).flatMap((kind) => db.prepare(kind.sql).all().map((row) => ({
    label: `${kind.kind} ${row.number}`,
    sub: `Draft since ${nice(row.created_at)}`,
    cents: row.cents || null,
    ...since(row.created_at, today),
    href: `#/${kind.href}/${row.id}`,
  })));
}

// Recurring bills to run, and renewals or filings inside their reminder days.
function compliance(db, today) {
  return db.prepare(`
    SELECT name, kind, next_due_date, amount_cents, variable_amount, reminder_days
    FROM compliance_items
    WHERE status = 'active'
      AND (next_due_date <= ? OR (kind <> 'recurring_bill' AND julianday(next_due_date) - julianday(?) <= reminder_days))
  `).all(today, today).map((row) => ({
    label: row.name,
    sub: `${row.kind === 'recurring_bill' ? 'Recurring bill · press Run due bills' : row.kind === 'renewal' ? 'Renewal' : 'Filing'} · due ${nice(row.next_due_date)}`,
    cents: row.variable_amount ? null : row.amount_cents || null,
    ...due(row.next_due_date, today),
    href: '#/compliance',
  }));
}

const GROUPS = [
  { key: 'backup', label: 'Backups', areas: ['admin'], href: '#/settings', tone: 'red', items: backups },
  { key: 'collect', label: 'To collect from customers', areas: ['sales'], href: '#/invoices', tone: 'red', items: collect },
  { key: 'pay', label: 'To pay suppliers', areas: ['suppliers'], href: '#/bills', tone: 'red', items: pay },
  { key: 'card', label: 'Card and link money not in bank', areas: ['banking'], href: '#/card-settlements', tone: 'amber', items: cardMoney },
  { key: 'give_back', label: 'Refunds, credits and advances to settle', areas: ['sales', 'refunds'], href: '#/settlement-queue', tone: 'amber', items: giveBack },
  { key: 'deposits', label: 'Visa deposits to refund', areas: ['visas'], href: '#/reports/visa-deposits', tone: 'amber', items: depositsToRefund },
  { key: 'bank', label: 'Cheques and bank', areas: ['banking'], href: '#/cheques', tone: 'amber', items: (db, today) => [...cheques(db, today), ...reconciliations(db, today)] },
  { key: 'drafts', label: 'Drafts to finish', areas: ['bookings', 'visas', 'sales'], href: '#/bookings', tone: 'blue', items: drafts },
  { key: 'compliance', label: 'Renewals and recurring bills', areas: ['compliance', 'banking'], href: '#/compliance', tone: 'blue', items: compliance },
];

function pendingList(db, user = null, { today = todayISO() } = {}) {
  const permissions = !user || user.is_admin ? null : parsePermissions(user.permissions);
  const allowed = (area) => !permissions || permissions[area] === 'view' || permissions[area] === 'edit';
  const groups = GROUPS.filter((group) => group.areas.some(allowed)).map((group) => {
    const items = group.items(db, today, allowed)
      .sort((a, b) => b.days - a.days || (a.due_in ?? 0) - (b.due_in ?? 0));
    return {
      key: group.key,
      label: group.label,
      href: group.href,
      tone: group.tone,
      count: items.length,
      cents: items.reduce((sum, item) => sum + (item.cents || 0), 0),
      oldest_days: items.length ? items[0].days : 0,
      over_30: items.filter((item) => item.days > 30).length,
      items: items.slice(0, ITEMS_SHOWN),
    };
  }).filter((group) => group.count > 0);
  return {
    as_of: today,
    count: groups.reduce((sum, group) => sum + group.count, 0),
    oldest_days: Math.max(0, ...groups.map((group) => group.oldest_days)),
    over_30: groups.reduce((sum, group) => sum + group.over_30, 0),
    groups,
  };
}

module.exports = { pendingList };
