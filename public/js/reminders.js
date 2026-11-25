// Reminders shared by the Reminders page, the dashboard card, the booking and
// visa pages, and the alert that rings when one is due. Times are local wall
// time (YYYY-MM-DDTHH:MM), compared here in the browser.

import { api } from './api.js';
import { whatsappNumber, whatsappUrl } from './share-links.js';
import { store } from './store.js';
import { esc, fmtDate, fmtMoney, icon, openModal, toast, watchPage } from './ui.js';

const REPEAT_LABELS = { never: 'Once', daily: 'Every day', weekly: 'Every week', monthly: 'Every month' };

const pad = (value) => String(value).padStart(2, '0');

export function localStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayDiff(due) {
  const day = new Date(`${due.slice(0, 10)}T00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((day - today) / 86_400_000);
}

// "Today 10:00", "Tomorrow 09:00", "14 Nov 11:00".
export function whenLabel(due) {
  const diff = dayDiff(due);
  const time = due.slice(11, 16);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  return `${fmtDate(due.slice(0, 10), { short: true })} ${time}`;
}

export function isLate(reminder, now = localStamp()) {
  return reminder.status === 'open' && reminder.due_at <= now;
}

// "late 45 min", "late 3 h", "late 2 days"; or "in 4 h" for later today.
export function distanceLabel(due) {
  const minutes = Math.round((new Date(due) - new Date()) / 60_000);
  const span = Math.abs(minutes);
  const text = span < 60 ? `${span} min` : span < 60 * 24 ? `${Math.round(span / 60)} h` : `${Math.round(span / 1440)} day${Math.round(span / 1440) === 1 ? '' : 's'}`;
  return minutes <= 0 ? `late ${text}` : `in ${text}`;
}

export function repeatLabel(repeat) {
  return REPEAT_LABELS[repeat] || REPEAT_LABELS.never;
}

const LINK_PAGES = { booking: 'bookings', visa: 'visas', invoice: 'invoices', customer: 'customer-balances' };

export function linkHtml(reminder) {
  if (!reminder.link_type || !reminder.link_number) return '';
  const href = `#/${LINK_PAGES[reminder.link_type]}/${reminder.link_id}`;
  return `<a href="${href}">${esc(reminder.link_number)}</a>${reminder.link_name ? ` · ${esc(reminder.link_name)}` : ''}`;
}

// The customer's WhatsApp chat with the reminder as a message: what is owed
// for an invoice or a customer, else the reminder itself. Nothing is sent
// until the user presses Send in WhatsApp.
function reminderMessage(reminder) {
  const company = store.settings?.company_name || '';
  const due = Number(reminder.due_cents || 0);
  let body;
  if (reminder.link_type === 'invoice' && due > 0) {
    body = `a reminder that invoice ${reminder.link_number} for ${fmtMoney(due)}${reminder.invoice_due_date ? ` was due on ${fmtDate(reminder.invoice_due_date, { long: true })}` : ' is open'}. Please arrange the payment.`;
  } else if (reminder.link_type === 'customer' && due > 0) {
    body = `a reminder that ${fmtMoney(due)} is due on your account. Please arrange the payment.`;
  } else {
    body = `${reminder.title}${reminder.link_type && reminder.link_type !== 'customer' ? ` (${reminder.link_number})` : ''}.`;
  }
  return [`Dear ${reminder.customer_name || 'customer'},`, body, company].filter(Boolean).join('\n\n');
}

export function whatsappHtml(reminder) {
  if (!whatsappNumber(reminder.customer_phone)) return '';
  return `<a class="btn btn-secondary btn-sm reminder-whatsapp" href="${esc(whatsappUrl(reminder.customer_phone, reminderMessage(reminder)))}" target="_blank" rel="noopener">${icon('send', 14)} WhatsApp</a>`;
}

export function notifyChanged() {
  window.dispatchEvent(new CustomEvent('reminders-changed'));
}

function askNotificationPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch { /* not available */ }
}

// Quick times for the form: today 17:00 (or the next hour when that is gone),
// tomorrow 10:00, next week 10:00, and the day before travel 10:00.
function at(daysAhead, hour) {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  date.setHours(hour, 0, 0, 0);
  return localStamp(date);
}

function quickTimes(travelDate) {
  const later = new Date(Date.now() + 60 * 60 * 1000);
  later.setMinutes(0, 0, 0);
  const today = at(0, 17) > localStamp() ? at(0, 17) : localStamp(later);
  const times = [['Today', today], ['Tomorrow 10:00', at(1, 10)], ['Next week', at(7, 10)]];
  if (travelDate) {
    const before = new Date(`${travelDate}T10:00`);
    before.setDate(before.getDate() - 1);
    if (localStamp(before) > localStamp()) times.push(['1 day before travel', localStamp(before)]);
  }
  return times;
}

// The new or edit form. `link` ({ type, id, label, travel_date }) comes from
// a booking, visa, invoice or customer page.
export async function openReminderForm({ reminder = null, link = null, onDone = null } = {}) {
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const due = reminder ? reminder.due_at : localStamp(new Date(now.setMinutes(0)));
  const linked = reminder?.link_type
    ? { type: reminder.link_type, id: reminder.link_id, label: [reminder.link_number, reminder.link_name].filter(Boolean).join(' · '), travel_date: reminder.travel_date }
    : link;
  const people = await api.get('/reminders/people').catch(() => []);
  const owner = reminder ? (reminder.for_all ? 'all' : String(reminder.owner_user_id)) : String(store.user?.id || '');
  const forOptions = [
    `<option value="${esc(String(store.user?.id || ''))}" ${owner === String(store.user?.id) ? 'selected' : ''}>Me</option>`,
    `<option value="all" ${owner === 'all' ? 'selected' : ''}>Everyone</option>`,
    ...people.filter((person) => person.id !== store.user?.id)
      .map((person) => `<option value="${person.id}" ${owner === String(person.id) ? 'selected' : ''}>${esc(person.full_name)}</option>`),
  ].join('');
  openModal({
    title: reminder ? 'Edit reminder' : 'New reminder',
    submitLabel: 'Save',
    body: `
      <div class="form-grid">
        <div class="field full">
          <label for="rm-title">What</label>
          <input class="input" id="rm-title" name="title" maxlength="200" required value="${esc(reminder?.title || '')}" placeholder="Call the customer about the visa">
        </div>
        <div class="field">
          <label for="rm-date">Date</label>
          <input class="input" id="rm-date" name="date" type="date" required value="${due.slice(0, 10)}">
        </div>
        <div class="field">
          <label for="rm-time">Time</label>
          <input class="input" id="rm-time" name="time" type="time" required value="${due.slice(11, 16)}">
        </div>
        <div class="field full reminder-quick" role="group" aria-label="Quick times">
          ${quickTimes(linked?.travel_date).map(([label, stamp]) => `<button type="button" class="btn btn-ghost btn-sm" data-quick="${stamp}">${esc(label)}</button>`).join('')}
        </div>
        <div class="field">
          <label for="rm-repeat">Repeat</label>
          <select class="input" id="rm-repeat" name="repeat">
            ${Object.entries(REPEAT_LABELS).map(([value, label]) => `<option value="${value}" ${(reminder?.repeat || 'never') === value ? 'selected' : ''}>${value === 'never' ? 'Never' : label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="rm-for">For</label>
          <select class="input" id="rm-for" name="for">${forOptions}</select>
        </div>
        ${linked ? `<div class="field full"><label>Linked to</label><div class="muted">${esc(linked.label)}</div></div>` : ''}
        <div class="field full">
          <label for="rm-notes">Notes</label>
          <textarea class="input" id="rm-notes" name="notes" rows="2" maxlength="1000">${esc(reminder?.notes || '')}</textarea>
        </div>
      </div>
    `,
    onMount(overlay) {
      overlay.querySelectorAll('[data-quick]').forEach((button) => button.addEventListener('click', () => {
        const date = overlay.querySelector('#rm-date');
        const time = overlay.querySelector('#rm-time');
        date.value = button.dataset.quick.slice(0, 10);
        time.value = button.dataset.quick.slice(11, 16);
        date.dispatchEvent(new Event('change', { bubbles: true }));
      }));
    },
    async onSubmit(form) {
      const values = new FormData(form);
      const chosen = values.get('for');
      const payload = {
        title: values.get('title'),
        due_at: `${values.get('date')}T${values.get('time')}`,
        repeat: values.get('repeat'),
        for_all: chosen === 'all',
        assign_to: chosen === 'all' ? null : Number(chosen),
        notes: values.get('notes'),
        link_type: linked?.type || null,
        link_id: linked?.id || null,
      };
      if (reminder) await api.put(`/reminders/${reminder.id}`, payload);
      else await api.post('/reminders', payload);
      askNotificationPermission();
      toast(reminder ? 'Reminder saved' : `Reminder set for ${whenLabel(payload.due_at)}`);
      notifyChanged();
      if (onDone) onDone();
    },
  });
}

export async function markDone(reminder) {
  const saved = await api.post(`/reminders/${reminder.id}/done`, { now: localStamp() });
  toast(saved.status === 'done' ? 'Done' : `Done · next ${whenLabel(saved.due_at)}`);
  notifyChanged();
  return saved;
}

// Snooze for some minutes, or until a time ("tomorrow" = tomorrow 9:00).
export async function snooze(reminder, minutes = 10) {
  const until = minutes === 'tomorrow' ? at(1, 9) : localStamp(new Date(Date.now() + minutes * 60_000));
  const saved = await api.post(`/reminders/${reminder.id}/snooze`, { due_at: until });
  toast(`Snoozed until ${whenLabel(saved.due_at)}`);
  notifyChanged();
  return saved;
}

export const SNOOZES = [[10, '10 minutes'], [60, '1 hour'], ['tomorrow', 'Tomorrow 9:00']];

// The late count on the menu and, in the desktop app, on its icon. The menu
// is drawn again at times (side or top menu), so it is put back on any new
// menu link; only a change touches the page, so this cannot loop.
let lateCount = 0;
function markMenu() {
  document.querySelectorAll('a[data-section="reminders"]').forEach((item) => {
    const badge = item.querySelector('.menu-count');
    if (!lateCount) { badge?.remove(); return; }
    if (badge?.textContent === String(lateCount)) return;
    const mark = badge || item.appendChild(document.createElement('span'));
    mark.className = 'menu-count';
    mark.textContent = String(lateCount);
    mark.setAttribute('aria-label', `${lateCount} late`);
  });
}

function showLateCount(count) {
  lateCount = count;
  markMenu();
  try { window.netfareApp?.setBadge(count); } catch { /* not the desktop app */ }
}

// ---- The alert when a reminder is due ----------------------------------

const CHECK_MS = 20_000;
let audio = null;
let timer = null;
const rung = new Set();

// Browsers only allow sound after the user has clicked or typed once.
function unlockAudio() {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* no sound available */ }
}

// A short two-tone bell, three times.
function ring() {
  try {
    unlockAudio();
    if (!audio) return;
    const start = audio.currentTime + 0.05;
    for (let round = 0; round < 3; round += 1) {
      [[880, 0], [660, 0.18]].forEach(([frequency, offset]) => {
        const at = start + round * 0.7 + offset;
        const tone = audio.createOscillator();
        const gain = audio.createGain();
        tone.type = 'sine';
        tone.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
        tone.connect(gain).connect(audio.destination);
        tone.start(at);
        tone.stop(at + 0.6);
      });
    }
  } catch { /* no sound available */ }
}

function systemNotification(reminder) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) return;
    const note = new Notification(reminder.title, { body: `${reminder.due_at.slice(11, 16)}${reminder.link_number ? ` · ${reminder.link_number}` : ''}`, tag: `reminder-${reminder.id}` });
    note.onclick = () => { window.focus(); note.close(); };
  } catch { /* not available */ }
}

function alertStack() {
  let stack = document.getElementById('reminder-alerts');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'reminder-alerts';
    stack.className = 'reminder-alerts';
    stack.setAttribute('role', 'alert');
    document.body.appendChild(stack);
  }
  return stack;
}

function showAlert(reminder) {
  const stack = alertStack();
  stack.querySelector(`[data-alert="${reminder.id}"]`)?.remove();
  const card = document.createElement('div');
  card.className = 'reminder-alert';
  card.dataset.alert = String(reminder.id);
  card.innerHTML = `
    <span class="reminder-alert-icon">${icon('bell', 18)}</span>
    <div class="reminder-alert-main">
      <strong>${esc(reminder.title)}</strong>
      <span>${esc(reminder.due_at.slice(11, 16))}${reminder.link_number ? ` · ${linkHtml(reminder)}` : ''}</span>
    </div>
    <div class="reminder-alert-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-alert-snooze>Snooze 10 min</button>
      <button type="button" class="btn btn-primary btn-sm" data-alert-done>${icon('check', 14)} Done</button>
    </div>`;
  card.querySelector('[data-alert-snooze]').addEventListener('click', async () => {
    card.remove();
    await snooze(reminder).catch((error) => toast(error.message, 'error'));
  });
  card.querySelector('[data-alert-done]').addEventListener('click', async () => {
    card.remove();
    await markDone(reminder).catch((error) => toast(error.message, 'error'));
  });
  card.querySelector('a')?.addEventListener('click', () => card.remove());
  stack.appendChild(card);
}

async function checkDue() {
  let open;
  try {
    open = await api.get('/reminders', { status: 'open' });
  } catch {
    // Signed out or the session ended: no late count for the next person.
    showLateCount(0);
    return;
  }
  const now = localStamp();
  const due = open.filter((reminder) => reminder.due_at <= now);
  showLateCount(due.length);
  // Alerts for reminders no longer due (done or snoozed elsewhere) go away.
  document.querySelectorAll('#reminder-alerts [data-alert]').forEach((card) => {
    if (!due.some((reminder) => String(reminder.id) === card.dataset.alert)) card.remove();
  });
  let fresh = false;
  for (const reminder of due) {
    const key = `${reminder.id}@${reminder.due_at}`;
    if (rung.has(key)) continue;
    rung.add(key);
    fresh = true;
    showAlert(reminder);
    systemNotification(reminder);
  }
  if (fresh) ring();
}

export function startReminderAlerts() {
  if (timer) return;
  ['pointerdown', 'keydown'].forEach((type) => window.addEventListener(type, unlockAudio, { once: true }));
  window.addEventListener('reminders-changed', () => setTimeout(checkDue, 300));
  watchPage(markMenu);
  checkDue();
  timer = setInterval(checkDue, CHECK_MS);
}
