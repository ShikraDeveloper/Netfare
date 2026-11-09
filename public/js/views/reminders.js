import { api } from '../api.js';
import { store } from '../store.js';
import {
  confirmDialog,
  emptyState,
  esc,
  icon,
  segmentedHtml,
  setHeader,
  toast,
} from '../ui.js';
import {
  distanceLabel,
  isLate,
  linkHtml,
  localStamp,
  markDone,
  openReminderForm,
  repeatLabel,
  snooze,
  whenLabel,
} from '../reminders.js';

let tab = 'open';

function rowHtml(reminder) {
  const late = isLate(reminder);
  const mine = store.user?.is_admin || reminder.owner_user_id === store.user?.id;
  const meta = [
    linkHtml(reminder),
    reminder.for_all ? 'Everyone' : (mine ? 'Me' : esc(reminder.owner_name || '')),
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
          ${late ? '<button type="button" class="btn btn-ghost btn-sm" data-rm="snooze">Snooze</button>' : ''}
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
  const rows = await api.get('/reminders', { status: tab });
  const now = localStamp();
  container.innerHTML = `
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
  document.querySelector('[data-action="new-reminder"]')?.addEventListener('click', () => openReminderForm({ onDone: refresh }));
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
        if (action === 'snooze') await snooze(reminder);
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

  const onChange = () => { if (container.querySelector('.reminders-card')) refresh(); };
  window.addEventListener('reminders-changed', onChange, { once: true });
  return () => window.removeEventListener('reminders-changed', onChange);
}
