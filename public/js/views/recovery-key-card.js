// Settings card (admin only): when the recovery key was made, and Make a new
// key. Replacing a saved key needs the admin's password, and the old key
// stops working at once, so a key someone saw is useless straight away.

import { api } from '../api.js';
import { bindKeyPanel, keyPanelHtml } from '../recovery-key.js';
import { esc, fmtDate, icon, openModal, toast } from '../ui.js';

function statusHtml(status) {
  if (!status.exists) return '<p class="muted">No recovery key saved yet. Make one now and keep it somewhere safe.</p>';
  const uses = status.uses === 1 ? 'Used once' : status.uses ? `Used ${status.uses} times` : 'Never used';
  return `<p>Made on <strong>${esc(fmtDate(String(status.created_at).slice(0, 10)))}</strong> · ${uses}.</p>`;
}

export function recoveryKeyCardHtml() {
  return `
    <div class="card" id="recovery-key-card">
      <div class="card-head">
        <div class="card-title"><h2>Recovery key</h2><p>Resets a forgotten admin password at the main computer</p></div>
        <button type="button" class="btn btn-secondary btn-sm" id="recovery-key-new">${icon('refresh', 15)} Make a new key</button>
      </div>
      <div class="card-body">
        <div id="recovery-key-status"><p class="muted">Loading…</p></div>
        <p class="hint">Lost the key, or someone saw it? Make a new one: the old key stops working at once.
          Every reset and new key is written to the audit log.</p>
      </div>
    </div>`;
}

function showNewKey(key, onDone) {
  openModal({
    title: 'Save your new recovery key',
    subtitle: 'The old key no longer works. Keep this one away from this computer.',
    size: 'modal-sm',
    body: keyPanelHtml(key),
    submitLabel: 'Done',
    cancelLabel: 'Close',
    onMount: (overlay) => {
      const done = overlay.querySelector('[data-submit]');
      done.disabled = true;
      bindKeyPanel(overlay, key, (saved) => { done.disabled = !saved; });
    },
    onSubmit: async () => {
      await api.post('/auth/recovery-key/confirm');
      toast('Recovery key saved');
      onDone();
    },
    onClose: onDone,
  });
}

export function bindRecoveryKeyCard(container) {
  const box = container.querySelector('#recovery-key-status');
  let status = null;
  const load = async () => {
    try {
      status = await api.get('/auth/recovery-key');
      box.innerHTML = statusHtml(status);
    } catch (error) {
      box.innerHTML = `<p class="update-error">${esc(error.message)}</p>`;
    }
  };
  container.querySelector('#recovery-key-new').addEventListener('click', () => {
    openModal({
      title: 'Make a new recovery key',
      subtitle: status?.exists ? 'Enter your password. The old key stops working at once.' : 'You will see the key once. Save it somewhere safe.',
      size: 'modal-sm',
      body: status?.exists ? `
        <div class="field">
          <label for="rk-password">Your password</label>
          <input class="input" id="rk-password" name="current_password" type="password" autocomplete="current-password" required>
        </div>` : '',
      submitLabel: 'Make a new key',
      onSubmit: async (form) => {
        const password = form.elements.current_password?.value;
        if (status?.exists && !password) throw new Error('Enter your password');
        const { recovery_key: key } = await api.post('/auth/recovery-key', { current_password: password });
        // Opened after this modal has closed.
        setTimeout(() => showNewKey(key, load), 250);
      },
    });
  });
  load();
}
