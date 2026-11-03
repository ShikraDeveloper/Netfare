// The admin's notification bell ("a new version is available"), and the
// What's new window it opens. The check itself runs on the server
// (services/updates.js).

import { api } from './api.js';
import { esc, icon, openModal } from './ui.js';

// The bell's red dot shows until the admin opens the bell for that version.
const SEEN_KEY = 'netfare.updateSeen';

function seenVersion() {
  try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; }
}

function markSeen(version) {
  try { localStorage.setItem(SEEN_KEY, version); } catch { /* per-browser convenience only */ }
}

export function installSteps() {
  return `
    <ol class="update-steps">
      <li>Download the new version and open the downloaded file.</li>
      <li>Quit Netfare, then drag the new Netfare into Applications and choose Replace.</li>
      <li>Open Netfare. If macOS says it cannot check the app, open System Settings → Privacy &amp; Security and choose Open Anyway.</li>
    </ol>
    <p class="muted" style="font-size:12px">Your books are kept in Netfare's own folder, not inside the app, and Netfare makes a backup before it updates them.</p>`;
}

export function showWhatsNew(status) {
  const { latest } = status;
  openModal({
    title: `What's new in Netfare ${latest.version}`,
    subtitle: latest.released ? `Released ${latest.released} · you have ${status.current_version}` : `You have ${status.current_version}`,
    size: 'modal-md',
    body: `
      ${latest.notes.length ? `<ul class="update-notes">${latest.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : '<p class="muted">No notes for this version.</p>'}
      <h3 class="update-subhead">How to update</h3>
      ${installSteps()}`,
    submitLabel: latest.download_url ? 'Download' : 'Close',
    onSubmit: async () => {
      if (latest.download_url) window.open(latest.download_url, '_blank', 'noopener');
    },
  });
}

function bellLabel(unseen) {
  return unseen ? 'Notifications, 1 new' : 'Notifications';
}

function renderBell(status) {
  const tools = document.getElementById('topbar-tools');
  if (!tools || tools.querySelector('details[open]')) return;
  const update = status?.available ? status.latest : null;
  const unseen = Boolean(update) && update.version !== seenVersion();
  tools.innerHTML = `
    <details class="more-menu notify-menu">
      <summary class="icon-btn notify-btn" aria-label="${bellLabel(unseen)}" title="Notifications">
        ${icon('bell', 18)}${unseen ? '<span class="notify-dot" aria-hidden="true"></span>' : ''}
      </summary>
      <div class="notify-list">
        <p class="notify-head">Notifications</p>
        ${update ? `
          <div class="notify-item">
            <span class="notify-icon">${icon('download', 16)}</span>
            <div>
              <strong>Netfare ${esc(update.version)} is available</strong>
              <p class="muted">You have ${esc(status.current_version)}${update.released ? ` · released ${esc(update.released)}` : ''}</p>
              <div class="notify-actions">
                <button type="button" class="btn btn-ghost btn-sm" data-update="notes">What's new</button>
                ${update.download_url ? `<a class="btn btn-primary btn-sm" data-update="download" href="${esc(update.download_url)}" target="_blank" rel="noopener">Download</a>` : ''}
              </div>
            </div>
          </div>` : '<p class="notify-empty muted">No new notifications</p>'}
      </div>
    </details>`;
  const menu = tools.querySelector('details');
  menu.addEventListener('toggle', () => {
    if (!menu.open || !unseen) return;
    markSeen(update.version);
    menu.querySelector('.notify-dot')?.remove();
    menu.querySelector('summary').setAttribute('aria-label', bellLabel(false));
  });
  menu.querySelector('[data-update="notes"]')?.addEventListener('click', () => {
    menu.removeAttribute('open');
    showWhatsNew(status);
  });
  menu.querySelector('[data-update="download"]')?.addEventListener('click', () => menu.removeAttribute('open'));
}

// The app may stay open for days, so ask again every hour; the server only
// goes to the internet every few hours.
const RECHECK_MS = 60 * 60 * 1000;
let recheckTimer = null;

export function keepCheckingForUpdates() {
  checkForUpdate();
  if (!recheckTimer) recheckTimer = setInterval(checkForUpdate, RECHECK_MS);
}

// For the admin only: fills the bell, which stays in the top bar.
export async function checkForUpdate() {
  try {
    const status = await api.get('/admin/updates');
    renderBell(status);
    return status;
  } catch {
    if (!document.querySelector('#topbar-tools details')) renderBell(null);
    return null;
  }
}
