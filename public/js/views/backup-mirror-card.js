// Settings card (admin only): a second copy of every backup in another
// place — iCloud Drive, Google Drive, OneDrive, Dropbox or a USB drive.

import { api } from '../api.js';
import { esc, fmtDate, icon, toast } from '../ui.js';

const OTHER = '__other__';

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return `${fmtDate(iso.slice(0, 10))} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function statusHtml(status) {
  if (!status.dir) {
    return `<p class="mirror-state warn">${icon('alert', 15)} Backups are only on this computer. If it is lost or breaks, so are they.</p>`;
  }
  if (status.last_error) {
    return `<p class="mirror-state warn">${icon('alert', 15)} Last copy failed: ${esc(status.last_error)}</p>`;
  }
  return `<p class="mirror-state ok">${icon('check', 15)} Copied to <strong>${esc(status.target)}</strong>${status.last_copied_at ? ` · last ${esc(when(status.last_copied_at))}` : ''} · ${status.copies} cop${status.copies === 1 ? 'y' : 'ies'} kept (newest ${status.keep})</p>`;
}

function optionsHtml(status) {
  const known = status.suggestions.some((item) => item.path === status.dir);
  return [
    '<option value="">Not copied anywhere</option>',
    ...status.suggestions.map((item) => `<option value="${esc(item.path)}" ${item.path === status.dir ? 'selected' : ''}>${esc(item.label)}</option>`),
    `<option value="${OTHER}" ${status.dir && !known ? 'selected' : ''}>Another folder…</option>`,
  ].join('');
}

export function backupMirrorCardHtml() {
  return `
    <div class="card" id="mirror-card">
      <div class="card-head">
        <div class="card-title"><h2>Second copy of backups</h2></div>
      </div>
      <form id="mirror-form" class="settings-form" novalidate>
        <div class="card-body">
          <div id="mirror-status"><p class="muted">Loading…</p></div>
          <div class="field" style="margin-top:12px">
            <label for="mirror-place">Copy backups to</label>
            <select class="input" id="mirror-place" name="place"></select>
          </div>
          <div class="field" id="mirror-other" hidden style="margin-top:10px">
            <label for="mirror-path">Folder</label>
            <input class="input" id="mirror-path" name="path" autocomplete="off" spellcheck="false" placeholder="/Volumes/Backup or D:\\">
          </div>
          <div class="form-note" style="margin-top:12px">A cloud folder (iCloud Drive, Google Drive, OneDrive, Dropbox) is safest: it leaves the building.</div>
        </div>
        <div class="settings-actions">
          <button class="btn btn-ghost" type="button" id="mirror-copy">Copy now</button>
          <button class="btn btn-primary" type="submit">Save</button>
        </div>
      </form>
    </div>`;
}

export function bindBackupMirrorCard(container) {
  const form = container.querySelector('#mirror-form');
  const statusEl = container.querySelector('#mirror-status');
  const place = form.elements.place;
  const other = container.querySelector('#mirror-other');
  const copyButton = container.querySelector('#mirror-copy');

  function show(status) {
    statusEl.innerHTML = statusHtml(status);
    place.innerHTML = optionsHtml(status);
    const custom = place.value === OTHER;
    other.hidden = !custom;
    form.elements.path.value = custom ? status.dir : '';
    copyButton.disabled = !status.dir;
  }

  place.addEventListener('change', () => {
    other.hidden = place.value !== OTHER;
    if (!other.hidden) form.elements.path.focus();
  });

  async function busy(action, message) {
    form.querySelectorAll('button, select, input').forEach((field) => { field.disabled = true; });
    try {
      const status = await action();
      show(status);
      if (message) toast(message(status));
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      form.querySelectorAll('button, select, input').forEach((field) => { field.disabled = false; });
      copyButton.disabled = !form.querySelector('#mirror-place').value;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const dir = place.value === OTHER ? form.elements.path.value : place.value;
    busy(() => api.put('/admin/backup-mirror', { dir }), (status) => (status.dir
      ? 'Saved. A backup was copied there just now.'
      : 'Backups stay on this computer only'));
  });
  copyButton.addEventListener('click', () => busy(() => api.post('/admin/backup-mirror/copy'), () => 'Backup made and copied'));

  api.get('/admin/backup-mirror').then(show).catch((error) => {
    statusEl.innerHTML = `<p class="muted">${esc(error.message)}</p>`;
  });
}
