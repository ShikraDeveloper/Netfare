'use strict';

// Reminders: something to do at a date and time. Each belongs to the user who
// made it, or to everyone. A repeating reminder moves to its next time when
// it is done; a one-off one is closed. Times are local wall time as typed
// (YYYY-MM-DDTHH:MM); the browser decides when one is due.

const { bad, notFound, str, optionalStr } = require('../util');

const REPEATS = ['never', 'daily', 'weekly', 'monthly'];
const LINKS = { booking: 'bookings', visa: 'visa_applications' };
const DUE_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const select = `
  SELECT r.*, u.full_name AS owner_name,
         CASE r.link_type WHEN 'booking' THEN bk.number WHEN 'visa' THEN vi.number END AS link_number,
         CASE r.link_type WHEN 'booking' THEN bc.name WHEN 'visa' THEN COALESCE(NULLIF(vi.applicant_name, ''), vc.name) END AS link_name
  FROM reminders r
  LEFT JOIN users u ON u.id = r.owner_user_id
  LEFT JOIN bookings bk ON r.link_type = 'booking' AND bk.id = r.link_id
  LEFT JOIN customers bc ON bc.id = bk.customer_id
  LEFT JOIN visa_applications vi ON r.link_type = 'visa' AND vi.id = r.link_id
  LEFT JOIN customers vc ON vc.id = vi.customer_id
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
  return { clause: '(r.for_all = 1 OR r.owner_user_id = ?)', params: [user.id] };
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
    if (!LINKS[linkType] || !linkId) throw bad('Link the reminder to a booking or visa');
    if (!db.prepare(`SELECT 1 FROM ${LINKS[linkType]} WHERE id = ?`).get(linkId)) throw bad(`That ${linkType} was not found`);
  } else {
    linkType = null;
    linkId = null;
  }
  return {
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
    INSERT INTO reminders (title, notes, due_at, repeat, for_all, owner_user_id, link_type, link_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.title, row.notes, row.due_at, row.repeat, row.for_all, user.id, row.link_type, row.link_id, user.full_name || '');
  return getReminder(db, user, info.lastInsertRowid);
}

// Only the person who made a reminder (or the admin) changes or deletes it;
// anyone who sees it can mark it done or snooze it.
function assertOwner(user, reminder) {
  if (!user.is_admin && reminder.owner_user_id !== user.id) throw bad(`Only ${reminder.owner_name || 'the person who made it'} can change this reminder`);
}

function updateReminder(db, user, id, payload = {}) {
  const current = getReminder(db, user, id);
  assertOwner(user, current);
  const row = fields(db, payload, current);
  db.prepare(`
    UPDATE reminders SET title = ?, notes = ?, due_at = ?, repeat = ?, for_all = ?, link_type = ?, link_id = ? WHERE id = ?
  `).run(row.title, row.notes, row.due_at, row.repeat, row.for_all, row.link_type, row.link_id, current.id);
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

module.exports = {
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
