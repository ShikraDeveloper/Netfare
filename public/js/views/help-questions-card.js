// Settings card (admin only): questions staff typed into the help panel that
// found no answer. Done removes one once its help is written or answered.

import { api } from '../api.js';
import { esc, icon, toast } from '../ui.js';

export function helpQuestionsCardHtml() {
  return `
    <div class="card" id="help-questions-card">
      <div class="card-head"><div class="card-title"><h2>Help questions</h2></div></div>
      <div class="card-body">
        <p class="muted" style="margin-top:0">Questions asked in the ${icon('help', 14)} Help panel that had no answer.</p>
        <div data-help-questions><p class="muted">Loading…</p></div>
      </div>
    </div>`;
}

export function bindHelpQuestionsCard(container) {
  const list = container.querySelector('[data-help-questions]');
  const load = async () => {
    try {
      const rows = await api.get('/help-questions');
      list.innerHTML = rows.length ? `<table class="data"><tbody>${rows.map((row) => `
        <tr>
          <td><div class="cell-main">${esc(row.question)}</div>
            <div class="cell-sub">${esc([row.page, row.asked_by, new Date(`${row.created_at.replace(' ', 'T')}Z`).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · '))}</div></td>
          <td class="num"><button type="button" class="btn btn-ghost btn-sm" data-help-done="${row.id}">${icon('check', 14)} Done</button></td>
        </tr>`).join('')}</tbody></table>` : '<p class="muted">No questions waiting.</p>';
    } catch (error) {
      list.innerHTML = `<p class="muted">Could not load: ${esc(error.message)}</p>`;
    }
  };
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-help-done]');
    if (!button) return;
    try {
      await api.del(`/help-questions/${button.dataset.helpDone}`);
      load();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  load();
}
