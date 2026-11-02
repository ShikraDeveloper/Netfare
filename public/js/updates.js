// "A new version is available" banner for the admin, and the What's new
// window it opens. The check itself runs on the server (services/updates.js).

import { api } from './api.js';
import { esc, icon, openModal } from './ui.js';

const DISMISSED_KEY = 'netfare.updateDismissed';

function dismissedVersion() {
  try { return localStorage.getItem(DISMISSED_KEY) || ''; } catch { return ''; }
}

function dismiss(version) {
  try { localStorage.setItem(DISMISSED_KEY, version); } catch { /* per-browser convenience only */ }
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

function renderBanner(status) {
  document.getElementById('update-banner')?.remove();
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner no-print';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <span class="update-text">${icon('download', 16)} <strong>Netfare ${esc(status.latest.version)} is available.</strong> You have ${esc(status.current_version)}.</span>
    <span class="update-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-update="notes">What's new</button>
      ${status.latest.download_url ? `<a class="btn btn-primary btn-sm" data-update="download" href="${esc(status.latest.download_url)}" target="_blank" rel="noopener">Download</a>` : ''}
      <button type="button" class="btn btn-ghost btn-sm" data-update="later">Later</button>
    </span>`;
  banner.querySelector('[data-update="notes"]').addEventListener('click', () => showWhatsNew(status));
  banner.querySelector('[data-update="later"]').addEventListener('click', () => {
    dismiss(status.latest.version);
    banner.remove();
  });
  const main = document.querySelector('.main');
  main.insertBefore(banner, document.getElementById('view'));
}

// Called once after sign-in, for the admin only. "Later" hides this version
// until a newer one comes out.
export async function checkForUpdate() {
  try {
    const status = await api.get('/admin/updates');
    if (status.available && status.latest.version !== dismissedVersion()) renderBanner(status);
    return status;
  } catch {
    return null;
  }
}
