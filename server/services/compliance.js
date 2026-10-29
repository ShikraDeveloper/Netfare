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
  addDays,
  isTruthy,
} = require('../util');
const { isCashAccount } = require('../accounting');
const billService = require('./bills');

const KINDS = ['recurring_bill', 'filing', 'renewal'];
const STATUSES = ['active', 'paused', 'done'];
const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly', 'once'];

const KIND_LABELS = {
  recurring_bill: 'Recurring bill',
  filing: 'Filing',
  renewal: 'Renewal',
};

const FREQUENCY_LABELS = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  once: 'One-time',
};

const DEFAULT_CATEGORY = {
  recurring_bill: 'Office rent',
  filing: 'Corporate tax',
  renewal: 'Trade licence',
};

const itemSelect = `
  SELECT ci.*, v.name AS vendor_name,
         a.code AS account_code, a.name AS account_name,
         d.code AS auto_debit_account_code, d.name AS auto_debit_account_name,
         (SELECT COUNT(*) FROM compliance_logs l WHERE l.item_id = ci.id) AS log_count
  FROM compliance_items ci
  LEFT JOIN vendors v ON v.id = ci.vendor_id
  LEFT JOIN accounts a ON a.id = ci.account_id
  LEFT JOIN accounts d ON d.id = ci.auto_debit_account_id
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

// Schedule from the original anchor day so a 31st-of-month item does not
// drift permanently to the 28th after passing through February.
function scheduledDate(anchorDate, frequency, index = 0) {
  if (!anchorDate) return null;
  if (frequency === 'weekly') return addDays(anchorDate, 7 * index);
  if (frequency === 'monthly') return addMonths(anchorDate, index);
  if (frequency === 'quarterly') return addMonths(anchorDate, 3 * index);
  if (frequency === 'yearly') return addMonths(anchorDate, 12 * index);
  return null;
}

function nextDate(dateStr, frequency) {
  if (frequency === 'weekly') return addDays(dateStr, 7);
  if (frequency === 'monthly') return addMonths(dateStr, 1);
  if (frequency === 'quarterly') return addMonths(dateStr, 3);
  if (frequency === 'yearly') return addMonths(dateStr, 12);
  return null;
}

function dateDiffDays(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  return Math.round((end - start) / 86_400_000);
}

function dueInfo(item, today = todayISO()) {
  if (item.status === 'paused') return { state: 'paused', days: null, label: 'Paused' };
  if (item.status === 'done') return { state: 'done', days: null, label: 'Done' };
  const days = dateDiffDays(today, item.next_due_date);
  if (days < 0) return { state: 'overdue', days, label: `${Math.abs(days)}d overdue` };
  if (days === 0) return { state: 'due', days, label: 'Due today' };
  if (days <= Number(item.reminder_days || 0)) return { state: 'soon', days, label: `Due in ${days}d` };
  if (days <= 30) return { state: 'upcoming', days, label: `In ${days}d` };
  return { state: 'later', days, label: `In ${days}d` };
}

function monthlyEquivalent(item) {
  if (item.kind !== 'recurring_bill' || item.status !== 'active') return 0;
  const amount = Number(item.amount_cents) || 0;
  if (item.frequency === 'weekly') return Math.round((amount * 52) / 12);
  if (item.frequency === 'monthly') return amount;
  if (item.frequency === 'quarterly') return Math.round(amount / 3);
  if (item.frequency === 'yearly') return Math.round(amount / 12);
  return 0;
}

function serializeItem(item, today = todayISO()) {
  const due = dueInfo(item, today);
  return {
    ...item,
    kind_label: KIND_LABELS[item.kind] || item.kind,
    frequency_label: FREQUENCY_LABELS[item.frequency] || item.frequency,
    due_state: due.state,
    due_label: due.label,
    days_until: due.days,
    monthly_cost_cents: monthlyEquivalent(item),
    auto_create_bill: Boolean(item.auto_create_bill),
    variable_amount: Boolean(item.variable_amount),
  };
}

function rawItems(db) {
  return db.prepare(`${itemSelect}
    ORDER BY CASE ci.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
             ci.next_due_date, ci.name COLLATE NOCASE
  `).all();
}

function summarize(items) {
  const active = items.filter((item) => item.status === 'active');
  const overdue = active.filter((item) => item.due_state === 'overdue');
  const dueSoon = active.filter((item) => ['due', 'soon'].includes(item.due_state));
  const recurring = active.filter((item) => item.kind === 'recurring_bill');
  const calendar = active.filter((item) => item.kind !== 'recurring_bill');
  return {
    active_count: active.length,
    overdue_count: overdue.length,
    due_soon_count: dueSoon.length,
    attention_count: overdue.length + dueSoon.length,
    recurring_count: recurring.length,
    variable_count: recurring.filter((item) => item.variable_amount).length,
    calendar_count: calendar.length,
    recurring_monthly_cents: recurring.reduce((sum, item) => sum + item.monthly_cost_cents, 0),
    next_items: active.slice(0, 6).map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      kind_label: item.kind_label,
      next_due_date: item.next_due_date,
      due_state: item.due_state,
      due_label: item.due_label,
      amount_cents: item.amount_cents,
      vendor_name: item.vendor_name,
    })),
  };
}

function listCompliance(db, { kind, status, due, search, from, to } = {}) {
  const generated = [];
  const errors = [];
  const today = todayISO();
  let items = rawItems(db).map((item) => serializeItem(item, today));

  if (kind && kind !== 'all') {
    if (!KINDS.includes(kind)) throw bad('Invalid compliance type');
    items = items.filter((item) => item.kind === kind);
  }
  if (status && status !== 'all') {
    if (!STATUSES.includes(status)) throw bad('Invalid compliance status');
    items = items.filter((item) => item.status === status);
  }
  if (due && due !== 'all') {
    if (due === 'overdue') items = items.filter((item) => item.due_state === 'overdue');
    else if (due === 'soon') items = items.filter((item) => ['due', 'soon'].includes(item.due_state));
    else if (due === 'upcoming') items = items.filter((item) => ['due', 'soon', 'upcoming'].includes(item.due_state));
    else if (due === 'attention') items = items.filter((item) => ['overdue', 'due', 'soon'].includes(item.due_state));
    else throw bad('Invalid compliance due filter');
  }
  if (from) {
    const start = dateISO(from, 'From date');
    items = items.filter((item) => item.next_due_date >= start);
  }
  if (to) {
    const end = dateISO(to, 'To date');
    items = items.filter((item) => item.next_due_date <= end);
  }
  if (search) {
    const term = String(search).trim().toLowerCase();
    items = items.filter((item) => [
      item.name,
      item.category,
      item.vendor_name,
      item.notes,
      item.kind_label,
      item.frequency_label,
    ].some((value) => String(value || '').toLowerCase().includes(term)));
  }

  return {
    items,
    summary: summarize(rawItems(db).map((item) => serializeItem(item, today))),
    generated,
    errors,
  };
}

function getCompliance(db, id) {
  const row = db.prepare(`${itemSelect} WHERE ci.id = ?`).get(id);
  if (!row) throw notFound('Compliance item not found');
  const item = serializeItem(row);
  item.logs = db.prepare(`
    SELECT l.*, b.number AS bill_number
    FROM compliance_logs l
    LEFT JOIN bills b ON b.id = l.bill_id
    WHERE l.item_id = ?
    ORDER BY l.event_date DESC, l.id DESC
    LIMIT 50
  `).all(id);
  return item;
}

function defaultFrequency(kind) {
  return kind === 'renewal' ? 'yearly' : kind === 'filing' ? 'quarterly' : 'monthly';
}

function normalizePayload(db, payload = {}, existing = null) {
  const kind = String(payload.kind ?? existing?.kind ?? 'recurring_bill');
  if (!KINDS.includes(kind)) throw bad('Choose a valid compliance type');

  const name = str(payload.name ?? existing?.name, 'Name', { max: 200 });
  const category = optionalStr(payload.category ?? existing?.category, 'Category', 80)
    || DEFAULT_CATEGORY[kind];
  const frequency = String(payload.frequency ?? existing?.frequency ?? defaultFrequency(kind));
  if (!FREQUENCIES.includes(frequency)) throw bad('Choose a valid frequency');

  let nextDueDate = dateISO(payload.next_due_date ?? existing?.next_due_date, 'Next due date');
  const reanchor = Boolean(existing)
    && payload.next_due_date !== undefined
    && payload.next_due_date !== existing.next_due_date
    && payload.anchor_date === undefined;
  const anchorDate = dateISO(
    payload.anchor_date ?? (reanchor ? nextDueDate : existing?.anchor_date ?? nextDueDate),
    'Anchor date',
  );
  let periodIndex = payload.period_index !== undefined
    ? Math.round(num(payload.period_index, 'Period index', { min: 0 }))
    : (reanchor ? 0 : Number(existing?.period_index || 0));
  if (!Number.isInteger(periodIndex) || periodIndex < 0) throw bad('Period index must be zero or greater');
  if (existing && payload.frequency !== undefined && payload.frequency !== existing.frequency
    && payload.next_due_date === undefined && payload.anchor_date === undefined) {
    nextDueDate = scheduledDate(anchorDate, frequency, periodIndex) || anchorDate;
  }
  const endRaw = payload.end_date !== undefined ? payload.end_date : existing?.end_date;
  const endDate = endRaw ? dateISO(endRaw, 'End date') : null;
  if (endDate && endDate < nextDueDate) throw bad('End date cannot be before the next due date');

  const status = String(payload.status ?? existing?.status ?? 'active');
  if (!STATUSES.includes(status)) throw bad('Choose a valid status');

  const amount = cents(payload.amount_cents ?? existing?.amount_cents ?? 0, 'Amount');
  const reminderDays = Math.round(num(
    payload.reminder_days ?? existing?.reminder_days ?? 14,
    'Reminder days',
    { min: 0, max: 365 },
  ));
  const notes = optionalStr(payload.notes ?? existing?.notes, 'Notes', 2000);
  const paymentMethod = optionalStr(
    payload.payment_method ?? existing?.payment_method,
    'Payment method',
    100,
  ) || 'Bank transfer';

  let vendor = null;
  const vendorId = payload.vendor_id !== undefined ? payload.vendor_id : existing?.vendor_id;
  if (vendorId != null && vendorId !== '') {
    vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(vendorId));
    if (!vendor) throw bad('Choose a valid vendor');
    if (!vendor.is_active) throw bad('That vendor is archived');
  }

  let account = null;
  const accountId = payload.account_id !== undefined ? payload.account_id : existing?.account_id;
  if (accountId != null && accountId !== '') {
    account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
    if (!account) throw bad('Choose a valid account');
    if (!account.is_active) throw bad('That account is archived');
    if (account.type !== 'expense' && account.code !== '1200') {
      throw bad('Choose an expense account or Prepayments');
    }
  }

  const variableAmount = kind === 'recurring_bill'
    && isTruthy(payload.variable_amount ?? existing?.variable_amount ?? 0);

  if (kind === 'recurring_bill') {
    if (!vendor) throw bad('Choose a vendor for a recurring bill');
    if (!account) throw bad('Choose an expense account for a recurring bill');
    if (!variableAmount && amount <= 0) throw bad('Recurring bill amount must be greater than zero');
  }

  let autoDebitAccount = null;
  const autoDebitId = payload.auto_debit_account_id !== undefined
    ? payload.auto_debit_account_id
    : existing?.auto_debit_account_id;
  if (kind === 'recurring_bill' && autoDebitId != null && autoDebitId !== '') {
    autoDebitAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(autoDebitId));
    if (!autoDebitAccount) throw bad('Choose a valid bank account');
    if (!autoDebitAccount.is_active) throw bad('That bank account is archived');
    if (!isCashAccount(autoDebitAccount)) throw bad('The bank debit account must be a cash or bank account');
  }

  // A fixed amount the bank takes itself is recorded on its date without
  // asking; a variable one waits for the amount to be entered.
  const autoCreateBill = kind === 'recurring_bill'
    && !variableAmount
    && (Boolean(autoDebitAccount) || isTruthy(payload.auto_create_bill ?? existing?.auto_create_bill ?? 0));

  return {
    kind,
    name,
    category,
    vendor_id: vendor ? vendor.id : null,
    account_id: account ? account.id : null,
    amount_cents: amount,
    variable_amount: variableAmount ? 1 : 0,
    payment_method: paymentMethod,
    frequency,
    anchor_date: anchorDate,
    period_index: periodIndex,
    next_due_date: nextDueDate,
    end_date: endDate,
    status,
    auto_create_bill: autoCreateBill ? 1 : 0,
    auto_debit_account_id: autoDebitAccount ? autoDebitAccount.id : null,
    reminder_days: reminderDays,
    notes,
  };
}

function createCompliance(db, payload = {}) {
  return db.transaction(() => {
    const data = normalizePayload(db, payload);
    const info = db.prepare(`
      INSERT INTO compliance_items (
        name, kind, category, vendor_id, account_id, amount_cents, variable_amount,
        payment_method, frequency, anchor_date, period_index, next_due_date, end_date, status,
        auto_create_bill, auto_debit_account_id, reminder_days, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name, data.kind, data.category, data.vendor_id, data.account_id,
      data.amount_cents, data.variable_amount, data.payment_method,
      data.frequency, data.anchor_date, data.period_index,
      data.next_due_date, data.end_date, data.status,
      data.auto_create_bill, data.auto_debit_account_id, data.reminder_days, data.notes,
    );
    const id = Number(info.lastInsertRowid);
    db.prepare(`
      INSERT INTO compliance_logs (item_id, action, event_date, detail)
      VALUES (?, 'created', ?, ?)
    `).run(id, todayISO(), `Created ${data.name}`);
    return getCompliance(db, id);
  })();
}

function updateCompliance(db, id, payload = {}) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM compliance_items WHERE id = ?').get(id);
    if (!existing) throw notFound('Compliance item not found');
    const data = normalizePayload(db, payload, existing);
    db.prepare(`
      UPDATE compliance_items SET
        name = ?, kind = ?, category = ?, vendor_id = ?, account_id = ?,
        amount_cents = ?, variable_amount = ?, payment_method = ?,
        frequency = ?, anchor_date = ?, period_index = ?, next_due_date = ?, end_date = ?, status = ?,
        auto_create_bill = ?, auto_debit_account_id = ?, reminder_days = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      data.name, data.kind, data.category, data.vendor_id, data.account_id,
      data.amount_cents, data.variable_amount, data.payment_method,
      data.frequency, data.anchor_date, data.period_index,
      data.next_due_date, data.end_date, data.status,
      data.auto_create_bill, data.auto_debit_account_id, data.reminder_days, data.notes, id,
    );
    db.prepare(`
      INSERT INTO compliance_logs (item_id, action, event_date, detail)
      VALUES (?, 'updated', ?, ?)
    `).run(id, todayISO(), `Updated ${data.name}`);
    return getCompliance(db, id);
  })();
}

function deleteCompliance(db, id) {
  return db.transaction(() => {
    const item = db.prepare('SELECT * FROM compliance_items WHERE id = ?').get(id);
    if (!item) throw notFound('Compliance item not found');
    db.prepare('DELETE FROM compliance_items WHERE id = ?').run(id);
    return { deleted: true };
  })();
}

function generateBill(db, id, payload = {}) {
  return db.transaction(() => {
    const item = db.prepare('SELECT * FROM compliance_items WHERE id = ?').get(id);
    if (!item) throw notFound('Compliance item not found');
    if (item.kind !== 'recurring_bill') throw bad('Only recurring bill items can generate a bill');
    if (item.status !== 'active') throw bad('Activate this compliance item before generating a bill');
    if (!item.vendor_id) throw bad('Choose a vendor before generating a bill');
    if (!item.account_id) throw bad('Choose an expense account before generating a bill');
    if (item.variable_amount && payload.amount_cents == null) {
      throw bad('Enter the actual amount for this period');
    }

    const amount = payload.amount_cents != null
      ? cents(payload.amount_cents, 'Amount', { min: 1 })
      : item.amount_cents;
    if (amount <= 0) throw bad('Set an amount greater than zero before generating a bill');
    const billDate = payload.bill_date
      ? dateISO(payload.bill_date, 'Bill date')
      : item.next_due_date;
    const dueDate = payload.due_date
      ? dateISO(payload.due_date, 'Due date')
      : billDate;
    if (dueDate < billDate) throw bad('Due date cannot be before the bill date');

    const bankDebit = Boolean(item.auto_debit_account_id);
    const method = bankDebit ? 'Bank debit' : item.payment_method || 'Bank transfer';
    let bill = billService.createBill(db, {
      vendor_id: item.vendor_id,
      bill_date: billDate,
      due_date: bankDebit ? billDate : dueDate,
      status: bankDebit ? 'received' : 'draft',
      default_payment_method: method,
      notes: `Compliance: ${item.name}${bankDebit ? ' · bank debit' : ''}${payload.notes ? ` · ${payload.notes}` : ''}`,
      items: [{
        description: item.name,
        quantity: 1,
        unit_price_cents: amount,
        account_id: item.account_id,
      }],
    });
    if (bankDebit) {
      billService.recordBillPayment(db, bill.id, {
        amount_cents: amount,
        payment_date: billDate,
        payment_account_id: item.auto_debit_account_id,
        method,
      });
      bill = billService.getBill(db, bill.id);
    }

    const nextPeriod = Number(item.period_index || 0) + 1;
    const next = scheduledDate(item.anchor_date || item.next_due_date, item.frequency, nextPeriod);
    const done = !next || (item.end_date && next > item.end_date);
    db.prepare(`
      UPDATE compliance_items SET
        last_generated_date = ?, period_index = ?, next_due_date = COALESCE(?, next_due_date),
        status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(billDate, nextPeriod, next, done ? 'done' : item.status, id);
    db.prepare(`
      INSERT INTO compliance_logs (item_id, action, event_date, detail, bill_id)
      VALUES (?, 'bill_generated', ?, ?, ?)
    `).run(id, billDate, bankDebit
      ? `Bill ${bill.number} recorded as paid by bank debit`
      : `Draft bill ${bill.number} created`, bill.id);

    return { item: getCompliance(db, id), bill };
  })();
}

function advanceAfterDate(db, id, action, eventDate, detail) {
  const item = db.prepare('SELECT * FROM compliance_items WHERE id = ?').get(id);
  if (!item) throw notFound('Compliance item not found');
  if (item.status !== 'active') throw bad('Activate this compliance item first');
  const nextPeriod = Number(item.period_index || 0) + 1;
  const next = scheduledDate(item.anchor_date || item.next_due_date, item.frequency, nextPeriod);
  const done = !next || (item.end_date && next > item.end_date);
  db.prepare(`
    UPDATE compliance_items SET
      period_index = ?,
      next_due_date = COALESCE(?, next_due_date),
      status = ?,
      ${action === 'completed' ? 'last_completed_date = ?,' : ''}
      updated_at = datetime('now')
    WHERE id = ?
  `).run(...(
    action === 'completed'
      ? [nextPeriod, next, done ? 'done' : item.status, eventDate, id]
      : [nextPeriod, next, done ? 'done' : item.status, id]
  ));
  db.prepare(`
    INSERT INTO compliance_logs (item_id, action, event_date, detail)
    VALUES (?, ?, ?, ?)
  `).run(id, action, eventDate, detail || (action === 'completed' ? 'Marked complete' : 'Skipped this period'));
  return getCompliance(db, id);
}

function completeCompliance(db, id, payload = {}) {
  return db.transaction(() => {
    const completedDate = payload.completed_date
      ? dateISO(payload.completed_date, 'Completed date')
      : todayISO();
    return advanceAfterDate(db, id, 'completed', completedDate, payload.notes);
  })();
}

function skipCompliance(db, id, payload = {}) {
  return db.transaction(() => {
    const eventDate = payload.event_date ? dateISO(payload.event_date, 'Event date') : todayISO();
    return advanceAfterDate(db, id, 'skipped', eventDate, payload.notes);
  })();
}

function runDueBills(db, { today = todayISO(), limit = 24 } = {}) {
  const generated = [];
  const errors = [];
  const items = db.prepare(`
    SELECT id, name FROM compliance_items
    WHERE kind = 'recurring_bill' AND status = 'active' AND auto_create_bill = 1
      AND variable_amount = 0 AND next_due_date <= ?
    ORDER BY next_due_date, id
  `).all(today);

  for (const item of items) {
    for (let i = 0; i < limit; i += 1) {
      const current = db.prepare('SELECT * FROM compliance_items WHERE id = ?').get(item.id);
      if (!current || current.status !== 'active' || !current.auto_create_bill) break;
      if (current.variable_amount) break;
      if (current.kind !== 'recurring_bill' || current.next_due_date > today) break;
      try {
        const result = generateBill(db, item.id, { bill_date: current.next_due_date });
        generated.push({
          item_id: item.id,
          name: current.name,
          bill_id: result.bill.id,
          bill_number: result.bill.number,
          bill_date: result.bill.bill_date,
        });
      } catch (error) {
        errors.push({ item_id: item.id, name: current.name, error: error.message });
        break;
      }
    }
  }

  return { generated, errors };
}

function complianceStats(db) {
  const today = todayISO();
  const items = rawItems(db).map((item) => serializeItem(item, today));
  return summarize(items);
}

module.exports = {
  KINDS,
  STATUSES,
  FREQUENCIES,
  listCompliance,
  getCompliance,
  createCompliance,
  updateCompliance,
  deleteCompliance,
  generateBill,
  completeCompliance,
  skipCompliance,
  runDueBills,
  complianceStats,
  nextDate,
  scheduledDate,
};
