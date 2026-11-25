import { api } from '../api.js';
import { store } from '../store.js';
import {
  confirmDialog,
  emptyState,
  esc,
  fmtDate,
  fmtMoney,
  icon,
  segmentedHtml,
  setHeader,
  toast,
} from '../ui.js';
import {
  SNOOZES,
  distanceLabel,
  isLate,
  linkHtml,
  localStamp,
  markDone,
  notifyChanged,
  openReminderForm,
  repeatLabel,
  snooze,
  whatsappHtml,
  whenLabel,
} from '../reminders.js';

// What the books suggest (see the service): each one, its icon and the
// reminder made when Remind is clicked.
const SUGGESTED = {
  invoice: { icon: 'invoice', title: 'Payment reminder', detail: (row) => `${fmtMoney(row.due_cents)} · due ${fmtDate(row.date, { short: true })}` },
  booking: { icon: 'plane', title: 'Issue the tickets', detail: (row) => `Travels ${row.date === localStamp().slice(0, 10) ? 'today' : 'tomorrow'} · a ticket number is missing` },
  visa: { icon: 'visa', title: 'Follow up the visa', detail: (row) => `Open since ${fmtDate(row.date, { short: true })} · no result yet` },
};

function suggestionHtml(row) {
  return `
        <div class="reminder-row" data-suggestion="${esc(row.key)}">
          <div class="reminder-when">${icon(SUGGESTED[row.link_type].icon, 16)}</div>
          <div class="reminder-main">
            <strong>${esc(row.number)} · ${esc(row.name || '')}</strong>
            <span>${esc(SUGGESTED[row.link_type].detail(row))}</span>
          </div>
          <div class="reminder-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-suggest="remind">Remind</button>
            <button type="button" class="btn btn-ghost btn-sm" data-suggest="ignore">Ignore</button>
          </div>
        </div>`;
}

// The first five; the rest wait behind "N more" so the reminders stay in view.
function suggestedHtml(rows) {
  if (!rows.length) return '';
  const rest = rows.slice(5);
  return `
    <div class="card reminders-suggested">
      <div class="card-head"><div class="card-title"><h2>Suggested</h2></div></div>
      <div class="reminder-list">${rows.slice(0, 5).map(suggestionHtml).join('')}</div>
      ${rest.length ? `<details class="suggested-more"><summary class="btn btn-ghost btn-sm">${rest.length} more</summary><div class="reminder-list">${rest.map(suggestionHtml).join('')}</div></details>` : ''}
    </div>`;
}

function tomorrowAt10() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(10, 0, 0, 0);
  return localStamp(date);
}

let tab = 'open';

function rowHtml(reminder) {
  const late = isLate(reminder);
  const me = store.user?.id;
  const mine = store.user?.is_admin || reminder.owner_user_id === me || reminder.made_by_user_id === me;
  const meta = [
    linkHtml(reminder),
    reminder.for_all ? 'Everyone' : (reminder.owner_user_id === me ? 'Me' : esc(reminder.owner_name || '')),
    reminder.repeat !== 'never' ? repeatLabel(reminder.repeat) : '',
    reminder.status === 'done' && reminder.done_by ? `done by ${esc(reminder.done_by)}` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="reminder-row${late ? ' late' : ''}" data-reminder="${reminder.id}">
      <div class="reminder-when">
        <strong>${esc(whenLabel(reminder.due_at))}</strong>
        ${reminder.status === 'open' ? `<span>${esc(distanceLabel(reminder.due_at))}</span>` : ''}
      </div>
      <div class="reminder-main">
        <strong>${esc(reminder.title)}</strong>
        ${meta ? `<span>${meta}</span>` : ''}
        ${reminder.notes ? `<span class="muted">${esc(reminder.notes)}</span>` : ''}
      </div>
      <div class="reminder-actions">
        ${reminder.status === 'open' ? `
          ${whatsappHtml(reminder)}
          <details class="snooze-menu">
            <summary class="btn btn-ghost btn-sm">Snooze</summary>
            <div class="snooze-list">${SNOOZES.map(([value, label]) => `<button type="button" class="btn btn-ghost btn-sm" data-rm="snooze" data-minutes="${value}">${esc(label)}</button>`).join('')}</div>
          </details>
          <button type="button" class="btn btn-secondary btn-sm" data-rm="done">${icon('check', 14)} Done</button>
          ${mine ? `<button type="button" class="icon-btn" data-rm="edit" title="Edit reminder">${icon('edit', 16)}</button>` : ''}
        ` : '<button type="button" class="btn btn-ghost btn-sm" data-rm="reopen">Open again</button>'}
        ${mine ? `<button type="button" class="icon-btn danger" data-rm="delete" title="Delete reminder">${icon('trash', 16)}</button>` : ''}
      </div>
    </div>`;
}

export async function render(container) {
  setHeader({
    title: 'Reminders',
    actions: `<button class="btn btn-primary" data-action="new-reminder">${icon('plus', 16)}<span>New reminder</span></button>`,
  });
  // Bound before waiting: two refreshes at once must not both bind this button.
  document.querySelector('[data-action="new-reminder"]')?.addEventListener('click', () => openReminderForm({ onDone: () => render(container) }));
  const [rows, suggested] = await Promise.all([
    api.get('/reminders', { status: tab }),
    tab === 'open' ? api.get('/reminders/suggestions').catch(() => []) : [],
  ]);
  const now = localStamp();
  container.innerHTML = `
    ${suggestedHtml(suggested)}
    <div class="card reminders-card">
      <div class="card-head">
        ${segmentedHtml('reminders', [{ value: 'open', label: 'Upcoming' }, { value: 'done', label: 'Done' }], tab)}
        ${tab === 'open' && rows.some((row) => row.due_at <= now) ? `<span class="badge badge-overdue">${rows.filter((row) => row.due_at <= now).length} late</span>` : ''}
      </div>
      <div class="reminder-list">
        ${rows.length ? rows.map(rowHtml).join('') : emptyState({ iconName: 'clock', title: tab === 'open' ? 'No reminders coming up' : 'Nothing done yet' })}
      </div>
    </div>`;

  const refresh = () => render(container);
  container.querySelectorAll('[data-seg-value]').forEach((button) => button.addEventListener('click', () => {
    tab = button.dataset.segValue;
    refresh();
  }));
  container.querySelectorAll('[data-reminder]').forEach((row) => {
    const reminder = rows.find((item) => String(item.id) === row.dataset.reminder);
    row.querySelectorAll('[data-rm]').forEach((button) => button.addEventListener('click', async () => {
      try {
        const action = button.dataset.rm;
        if (action === 'done') await markDone(reminder);
        if (action === 'snooze') await snooze(reminder, button.dataset.minutes === 'tomorrow' ? 'tomorrow' : Number(button.dataset.minutes));
        if (action === 'edit') return openReminderForm({ reminder, onDone: refresh });
        if (action === 'reopen') {
          await api.post(`/reminders/${reminder.id}/reopen`);
          toast('Reminder opened again');
        }
        if (action === 'delete') {
          const ok = await confirmDialog({ title: 'Delete this reminder?', message: reminder.title, confirmLabel: 'Delete' });
          if (!ok) return null;
          await api.del(`/reminders/${reminder.id}`);
          toast('Reminder deleted');
        }
        return refresh();
      } catch (error) {
        toast(error.message, 'error');
        return null;
      }
    }));
  });

  container.querySelectorAll('[data-suggestion]').forEach((row) => {
    const item = suggested.find((entry) => entry.key === row.dataset.suggestion);
    row.querySelectorAll('[data-suggest]').forEach((button) => button.addEventListener('click', async () => {
      try {
        if (button.dataset.suggest === 'remind') {
          await api.post('/reminders', { title: SUGGESTED[item.link_type].title, due_at: tomorrowAt10(), link_type: item.link_type, link_id: item.link_id });
          toast(`Reminder set for ${whenLabel(tomorrowAt10())}`);
          notifyChanged();
        } else {
          await api.post('/reminders/suggestions/dismiss', { key: item.key });
        }
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    }));
  });

  const onChange = () => { if (container.querySelector('.reminders-card')) refresh(); };
  window.addEventListener('reminders-changed', onChange, { once: true });
  return () => window.removeEventListener('reminders-changed', onChange);
}
