// Reminders shared by the Reminders page, the dashboard card, the booking and
// visa pages, and the alert that rings when one is due. Times are local wall
// time (YYYY-MM-DDTHH:MM), compared here in the browser.

import { api } from './api.js';
import { esc, fmtDate, icon, openModal, toast } from './ui.js';

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

export function linkHtml(reminder) {
  if (!reminder.link_type || !reminder.link_number) return '';
  const href = `#/${reminder.link_type === 'booking' ? 'bookings' : 'visas'}/${reminder.link_id}`;
  return `<a href="${href}">${esc(reminder.link_number)}</a>${reminder.link_name ? ` · ${esc(reminder.link_name)}` : ''}`;
}

export function notifyChanged() {
  window.dispatchEvent(new CustomEvent('reminders-changed'));
}

function askNotificationPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch { /* not available */ }
}

// The new or edit form. `link` ({ type, id, label }) comes from a booking or
// visa page.
export function openReminderForm({ reminder = null, link = null, onDone = null } = {}) {
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const due = reminder ? reminder.due_at : localStamp(new Date(now.setMinutes(0)));
  const linked = reminder?.link_type
    ? { type: reminder.link_type, id: reminder.link_id, label: [reminder.link_number, reminder.link_name].filter(Boolean).join(' · ') }
    : link;
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
        <div class="field">
          <label for="rm-repeat">Repeat</label>
          <select class="input" id="rm-repeat" name="repeat">
            ${Object.entries(REPEAT_LABELS).map(([value, label]) => `<option value="${value}" ${(reminder?.repeat || 'never') === value ? 'selected' : ''}>${value === 'never' ? 'Never' : label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="rm-for">For</label>
          <select class="input" id="rm-for" name="for_all">
            <option value="0">Me</option>
            <option value="1" ${reminder?.for_all ? 'selected' : ''}>Everyone</option>
          </select>
        </div>
        ${linked ? `<div class="field full"><label>Linked to</label><div class="muted">${esc(linked.label)}</div></div>` : ''}
        <div class="field full">
          <label for="rm-notes">Notes</label>
          <textarea class="input" id="rm-notes" name="notes" rows="2" maxlength="1000">${esc(reminder?.notes || '')}</textarea>
        </div>
      </div>
    `,
    async onSubmit(form) {
      const values = new FormData(form);
      const payload = {
        title: values.get('title'),
        due_at: `${values.get('date')}T${values.get('time')}`,
        repeat: values.get('repeat'),
        for_all: values.get('for_all') === '1',
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

export async function snooze(reminder, minutes = 10) {
  const saved = await api.post(`/reminders/${reminder.id}/snooze`, { due_at: localStamp(new Date(Date.now() + minutes * 60_000)) });
  toast(`Snoozed until ${saved.due_at.slice(11, 16)}`);
  notifyChanged();
  return saved;
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
    return;
  }
  const now = localStamp();
  const due = open.filter((reminder) => reminder.due_at <= now);
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
  checkDue();
  timer = setInterval(checkDue, CHECK_MS);
}
