// Settings card (admin only): the installed version, where Netfare looks for
// new versions, and a Check now button.

import { api } from '../api.js';
import { esc, fmtDate, toast } from '../ui.js';
import { installSteps, showWhatsNew } from '../updates.js';

function statusHtml(status) {
  if (!status.enabled) return '<p class="muted">Checking for new versions is off.</p>';
  if (status.error) return `<p class="update-error">Last check failed: ${esc(status.error)}</p>`;
  const checked = status.checked_at ? ` · checked ${esc(fmtDate(status.checked_at.slice(0, 10)))}` : '';
  if (status.available) {
    return `<p><strong>Netfare ${esc(status.latest.version)} is available.</strong>${checked}
      <button type="button" class="btn btn-secondary btn-sm" data-update-card="notes" style="margin-left:6px">What's new &amp; download</button></p>`;
  }
  return `<p class="muted">You have the newest version${checked}.</p>`;
}

export function updatesCardHtml() {
  return `
    <div class="card" id="updates-card">
      <div class="card-head">
        <div class="card-title"><h2>Updates</h2><p>Be told when a new version of Netfare is out</p></div>
      </div>
      <form id="updates-form" class="settings-form" novalidate>
        <div class="card-body">
          <div class="about-list" style="margin-bottom:10px">
            <div><span>Installed version</span><strong id="update-current">—</strong></div>
          </div>
          <div id="update-status"><p class="muted">Loading…</p></div>
          <label class="checkbox-row" style="margin-top:12px">
            <input type="checkbox" name="enabled" id="update-enabled">
            <span><strong>Check for new versions</strong> once a day. Only the admin sees the notice.</span>
          </label>
          <div class="field" style="margin-top:12px">
            <label for="update-feed">Update address (optional)</label>
            <input class="input" id="update-feed" name="feed_url" type="url" autocomplete="off" spellcheck="false"
              placeholder="Blank: Netfare releases on GitHub" aria-describedby="update-feed-hint">
            <div class="hint" id="update-feed-hint">Leave blank to use Netfare's own releases on GitHub. Only change it if your agency publishes Netfare somewhere else.</div>
          </div>
          <details class="update-howto" style="margin-top:12px">
            <summary>How updating works</summary>
            ${installSteps()}
          </details>
        </div>
        <div class="settings-actions">
          <button class="btn btn-ghost" type="button" id="update-check">Check now</button>
          <button class="btn btn-primary" type="submit">Save</button>
        </div>
      </form>
    </div>`;
}

export function bindUpdatesCard(container) {
  const form = container.querySelector('#updates-form');
  const statusEl = container.querySelector('#update-status');

  function show(status) {
    container.querySelector('#update-current').textContent = status.current_version;
    form.elements.enabled.checked = status.enabled;
    form.elements.feed_url.value = status.feed_url || '';
    statusEl.innerHTML = statusHtml(status);
    statusEl.querySelector('[data-update-card="notes"]')?.addEventListener('click', () => showWhatsNew(status));
  }

  async function busy(action) {
    form.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      show(await action());
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      form.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    busy(async () => {
      const status = await api.put('/admin/updates', {
        enabled: form.elements.enabled.checked,
        feed_url: form.elements.feed_url.value,
      });
      toast(status.enabled ? 'Update settings saved' : 'Checking for new versions is off');
      return status;
    });
  });
  container.querySelector('#update-check').addEventListener('click', () => busy(() => api.get('/admin/updates', { force: 1 })));
  api.get('/admin/updates').then(show).catch((error) => {
    statusEl.innerHTML = `<p class="muted">${esc(error.message)}</p>`;
  });
}
