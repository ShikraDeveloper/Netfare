'use strict';

// Reminders: something to do at a date and time. Each belongs to the user who
// made it, or to everyone. A repeating reminder moves to its next time when
// it is done; a one-off one is closed. Times are local wall time as typed
// (YYYY-MM-DDTHH:MM); the browser decides when one is due.

const { bad, notFound, str, optionalStr, todayISO, addDays } = require('../util');
const { canViewArea } = require('../permissions');

const REPEATS = ['never', 'daily', 'weekly', 'monthly'];
const LINKS = { booking: 'bookings', visa: 'visa_applications', invoice: 'invoices', customer: 'customers' };
const DUE_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// What a reminder is linked to, with the customer's phone and what they owe,
// for the WhatsApp reminder.
const select = `
  SELECT r.*, u.full_name AS owner_name,
         CASE r.link_type WHEN 'booking' THEN bk.number WHEN 'visa' THEN vi.number WHEN 'invoice' THEN inv.number WHEN 'customer' THEN cu.name END AS link_number,
         CASE r.link_type WHEN 'booking' THEN bc.name WHEN 'visa' THEN COALESCE(NULLIF(vi.applicant_name, ''), vc.name) WHEN 'invoice' THEN ic.name END AS link_name,
         CASE r.link_type WHEN 'booking' THEN bc.name WHEN 'visa' THEN vc.name WHEN 'invoice' THEN ic.name WHEN 'customer' THEN cu.name END AS customer_name,
         CASE r.link_type WHEN 'booking' THEN bc.phone WHEN 'visa' THEN vc.phone WHEN 'invoice' THEN ic.phone WHEN 'customer' THEN cu.phone END AS customer_phone,
         CASE r.link_type WHEN 'invoice' THEN inv.due_date END AS invoice_due_date,
         CASE r.link_type
           WHEN 'invoice' THEN CASE WHEN inv.status = 'sent' THEN MAX(0, inv.total_cents - inv.amount_paid_cents - inv.credit_applied_cents) ELSE 0 END
           WHEN 'customer' THEN (SELECT COALESCE(SUM(i.total_cents - i.amount_paid_cents - i.credit_applied_cents), 0)
                                 FROM invoices i WHERE i.customer_id = cu.id AND i.status = 'sent')
         END AS due_cents,
         bk.travel_date AS travel_date
  FROM reminders r
  LEFT JOIN users u ON u.id = r.owner_user_id
  LEFT JOIN bookings bk ON r.link_type = 'booking' AND bk.id = r.link_id
  LEFT JOIN customers bc ON bc.id = bk.customer_id
  LEFT JOIN visa_applications vi ON r.link_type = 'visa' AND vi.id = r.link_id
  LEFT JOIN customers vc ON vc.id = vi.customer_id
  LEFT JOIN invoices inv ON r.link_type = 'invoice' AND inv.id = r.link_id
  LEFT JOIN customers ic ON ic.id = inv.customer_id
  LEFT JOIN customers cu ON r.link_type = 'customer' AND cu.id = r.link_id
`;

function pad(value) {
  return String(value).padStart(2, '0');
}

function localStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dueAt(value) {
  const text = String(value || '').trim().slice(0, 16);
  if (!DUE_AT.test(text) || Number.isNaN(new Date(text).getTime())) throw bad('Choose a date and time');
  return text;
}

// The next time of a repeating reminder, after `from`.
function nextTime(due, repeat) {
  const date = new Date(due);
  if (repeat === 'daily') date.setDate(date.getDate() + 1);
  else if (repeat === 'weekly') date.setDate(date.getDate() + 7);
  else if (repeat === 'monthly') {
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  }
  return localStamp(date);
}

function visible(user) {
  return { clause: '(r.for_all = 1 OR r.owner_user_id = ? OR r.made_by_user_id = ?)', params: [user.id, user.id] };
}

function getReminder(db, user, id) {
  const { clause, params } = visible(user);
  const row = db.prepare(`${select} WHERE r.id = ? AND ${clause}`).get(Number(id), ...params);
  if (!row) throw notFound('Reminder not found');
  return row;
}

function listReminders(db, user, { status = 'open' } = {}) {
  const { clause, params } = visible(user);
  const done = status === 'done';
  return db.prepare(`
    ${select} WHERE r.status = ? AND ${clause}
    ORDER BY ${done ? 'r.done_at DESC, r.id DESC LIMIT 100' : 'r.due_at, r.id'}
  `).all(done ? 'done' : 'open', ...params);
}

function fields(db, payload, current = {}) {
  const repeat = payload.repeat ?? current.repeat ?? 'never';
  if (!REPEATS.includes(repeat)) throw bad('Choose how often it repeats');
  let linkType = payload.link_type !== undefined ? payload.link_type || null : current.link_type || null;
  let linkId = payload.link_id !== undefined ? Number(payload.link_id) || null : current.link_id || null;
  if (linkType) {
    if (!LINKS[linkType] || !linkId) throw bad('Link the reminder to a booking, visa, invoice or customer');
    if (!db.prepare(`SELECT 1 FROM ${LINKS[linkType]} WHERE id = ?`).get(linkId)) throw bad(`That ${linkType} was not found`);
  } else {
    linkType = null;
    linkId = null;
  }
  // Given to one person (any active user), or kept by whoever has it now.
  let owner = current.owner_user_id ?? null;
  if (payload.assign_to !== undefined && payload.assign_to !== null && payload.assign_to !== '') {
    const person = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(Number(payload.assign_to));
    if (!person) throw bad('Choose who the reminder is for');
    owner = person.id;
  }
  return {
    owner_user_id: owner,
    title: str(payload.title ?? current.title, 'What', { max: 200 }),
    notes: optionalStr(payload.notes ?? current.notes, 'Notes', 1000),
    due_at: dueAt(payload.due_at ?? current.due_at),
    repeat,
    for_all: (payload.for_all ?? current.for_all) ? 1 : 0,
    link_type: linkType,
    link_id: linkId,
  };
}

function createReminder(db, user, payload = {}) {
  const row = fields(db, payload);
  const info = db.prepare(`
    INSERT INTO reminders (title, notes, due_at, repeat, for_all, owner_user_id, link_type, link_id, created_by, made_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.title, row.notes, row.due_at, row.repeat, row.for_all, row.owner_user_id ?? user.id, row.link_type, row.link_id, user.full_name || '', user.id);
  return getReminder(db, user, info.lastInsertRowid);
}

// Only the person it is for, the one who made it, or the admin changes or
// deletes it; anyone who sees it can mark it done or snooze it.
function assertOwner(user, reminder) {
  if (!user.is_admin && reminder.owner_user_id !== user.id && reminder.made_by_user_id !== user.id) {
    throw bad(`Only ${reminder.owner_name || 'the person who made it'} can change this reminder`);
  }
}

function updateReminder(db, user, id, payload = {}) {
  const current = getReminder(db, user, id);
  assertOwner(user, current);
  const row = fields(db, payload, current);
  db.prepare(`
    UPDATE reminders SET title = ?, notes = ?, due_at = ?, repeat = ?, for_all = ?, owner_user_id = ?, link_type = ?, link_id = ? WHERE id = ?
  `).run(row.title, row.notes, row.due_at, row.repeat, row.for_all, row.owner_user_id, row.link_type, row.link_id, current.id);
  return getReminder(db, user, current.id);
}

function doneReminder(db, user, id, { now } = {}) {
  const current = getReminder(db, user, id);
  if (current.status === 'done') return current;
  if (current.repeat !== 'never') {
    // Move on to the next time that is still ahead.
    const nowStamp = now ? dueAt(now) : localStamp();
    let next = nextTime(current.due_at, current.repeat);
    while (next <= nowStamp) next = nextTime(next, current.repeat);
    db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(next, current.id);
  } else {
    db.prepare(`UPDATE reminders SET status = 'done', done_at = datetime('now'), done_by = ? WHERE id = ?`)
      .run(user.full_name || '', current.id);
  }
  return getReminder(db, user, current.id);
}

function snoozeReminder(db, user, id, { due_at: until } = {}) {
  const current = getReminder(db, user, id);
  if (current.status === 'done') throw bad('This reminder is done');
  db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(dueAt(until), current.id);
  return getReminder(db, user, current.id);
}

function reopenReminder(db, user, id) {
  const current = getReminder(db, user, id);
  db.prepare(`UPDATE reminders SET status = 'open', done_at = NULL, done_by = '' WHERE id = ?`).run(current.id);
  return getReminder(db, user, current.id);
}

function deleteReminder(db, user, id) {
  const current = getReminder(db, user, id);
  assertOwner(user, current);
  db.prepare('DELETE FROM reminders WHERE id = ?').run(current.id);
  return { ok: true };
}

// Who a reminder can be given to: every active user (names only).
function people(db) {
  return db.prepare('SELECT id, full_name FROM users WHERE is_active = 1 ORDER BY full_name COLLATE NOCASE').all();
}

// Reminders the books suggest, each made only when someone clicks Remind:
// invoices past their due date, bookings travelling today or tomorrow with a
// passenger's ticket number missing, and visas submitted 10 days ago or more.
// One already linked to an open reminder, or ignored in the last week, is
// left out.
function suggestions(db, user, today = todayISO()) {
  const skip = new Set([
    // An ignored one comes back after a week if it is still open.
    ...db.prepare("SELECT key FROM reminder_dismissals WHERE dismissed_at >= datetime('now', '-7 days')").all().map((row) => row.key),
    ...db.prepare("SELECT link_type || ':' || link_id AS key FROM reminders WHERE status = 'open' AND link_type IS NOT NULL").all().map((row) => row.key),
  ]);
  const rows = [];
  if (canViewArea(user, 'sales')) {
    rows.push(...db.prepare(`
      SELECT 'invoice' AS link_type, i.id AS link_id, i.number, c.name, i.due_date AS date,
             i.total_cents - i.amount_paid_cents - i.credit_applied_cents AS due_cents
      FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.status = 'sent' AND i.due_date < ? AND i.total_cents > i.amount_paid_cents + i.credit_applied_cents
      ORDER BY i.due_date, i.id LIMIT 20
    `).all(today));
  }
  if (canViewArea(user, 'bookings')) {
    rows.push(...db.prepare(`
      SELECT 'booking' AS link_type, b.id AS link_id, b.number, c.name, b.travel_date AS date, NULL AS due_cents
      FROM bookings b JOIN customers c ON c.id = b.customer_id
      WHERE b.status = 'confirmed' AND b.travel_date BETWEEN ? AND ?
        AND EXISTS (SELECT 1 FROM booking_items bi WHERE bi.booking_id = b.id AND bi.item_type = 'cost'
                    AND bi.passenger_name <> '' AND TRIM(COALESCE(bi.supplier_ref, '')) = '')
      ORDER BY b.travel_date, b.id
    `).all(today, addDays(today, 1)));
  }
  if (canViewArea(user, 'visas')) {
    rows.push(...db.prepare(`
      SELECT 'visa' AS link_type, v.id AS link_id, v.number, COALESCE(NULLIF(v.applicant_name, ''), c.name) AS name,
             i.issue_date AS date, NULL AS due_cents
      FROM visa_applications v JOIN customers c ON c.id = v.customer_id JOIN invoices i ON i.id = v.invoice_id
      WHERE v.status = 'submitted' AND i.issue_date <= ?
      ORDER BY i.issue_date, v.id LIMIT 20
    `).all(addDays(today, -10)));
  }
  return rows.map((row) => ({ ...row, key: `${row.link_type}:${row.link_id}` })).filter((row) => !skip.has(row.key));
}

function dismissSuggestion(db, key) {
  if (!/^(invoice|booking|visa):\d+$/.test(String(key || ''))) throw bad('Choose a suggestion');
  db.prepare("INSERT INTO reminder_dismissals (key) VALUES (?) ON CONFLICT(key) DO UPDATE SET dismissed_at = datetime('now')").run(String(key));
  return { ok: true };
}

module.exports = {
  people,
  suggestions,
  dismissSuggestion,
  listReminders,
  getReminder,
  createReminder,
  updateReminder,
  doneReminder,
  snoozeReminder,
  reopenReminder,
  deleteReminder,
  nextTime,
};
