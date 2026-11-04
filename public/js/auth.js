// Sign-in screens: first-run admin setup, sign in, the forced password
// change after `npm run reset-admin`, the admin's recovery key and resetting
// a forgotten admin password with it. They cover the whole app until the
// server knows who is using it.

import { api } from './api.js';
import { bindKeyPanel, keyPanelHtml } from './recovery-key.js';
import { esc, icon, replayAnimation } from './ui.js';

const SCREENS = {
  setup: {
    title: 'Create the admin account',
    intro: 'This is the main login for your agency. You will add your staff from Settings.',
    submit: 'Create admin and open Netfare',
    fields: [
      { name: 'full_name', label: 'Your full name', autocomplete: 'name' },
      { name: 'username', label: 'Username', autocomplete: 'username', hint: 'Letters, numbers, dot, dash or underscore' },
      { name: 'password', label: 'Password', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters' },
      { name: 'confirm', label: 'Confirm password', type: 'password', autocomplete: 'new-password' },
    ],
    send: (values) => api.post('/auth/setup', values),
  },
  login: {
    title: 'Sign in',
    intro: 'Use the username and password your admin gave you.',
    submit: 'Sign in',
    fields: [
      { name: 'username', label: 'Username', autocomplete: 'username' },
      { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' },
    ],
    send: (values) => api.post('/auth/login', values),
  },
  change: {
    title: 'Choose a new password',
    intro: 'You signed in with a one-time password. Set your own to continue.',
    submit: 'Save password and continue',
    fields: [
      { name: 'current_password', label: 'One-time password', type: 'password', autocomplete: 'current-password' },
      { name: 'new_password', label: 'New password', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters' },
      { name: 'confirm', label: 'Confirm new password', type: 'password', autocomplete: 'new-password' },
    ],
    send: (values) => api.post('/auth/password', values),
  },
  reset: {
    title: 'Reset admin password',
    intro: 'Enter the recovery key you saved, then choose a new password for the admin.',
    submit: 'Reset password',
    icon: 'key',
    fields: [
      { name: 'recovery_key', label: 'Recovery key', autocomplete: 'off', hint: 'Like NF-7KQM-4XTA-9PMW-2HRC' },
      { name: 'new_password', label: 'New password', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters' },
      { name: 'confirm', label: 'Confirm new password', type: 'password', autocomplete: 'new-password' },
    ],
    send: (values) => api.post('/auth/recovery/reset', values),
    cancel: true,
  },
};

function fieldHtml(field) {
  const id = `auth-${field.name}`;
  return `
    <div class="field">
      <label for="${id}">${esc(field.label)}</label>
      <input class="input" id="${id}" name="${field.name}" type="${field.type || 'text'}" autocomplete="${field.autocomplete}"
        ${field.type === 'password' ? '' : 'autocapitalize="none" spellcheck="false"'} required
        ${field.hint ? `aria-describedby="${id}-hint"` : ''}>
      ${field.hint ? `<div class="hint" id="${id}-hint">${esc(field.hint)}</div>` : ''}
    </div>`;
}

// Puts a card over the app and returns its root element.
function showCard({ iconName, title, intro, body }) {
  document.getElementById('auth-root')?.remove();
  const root = document.createElement('div');
  root.id = 'auth-root';
  root.className = 'auth-screen';
  root.innerHTML = `
    <main class="auth-card" aria-labelledby="auth-title">
      <img class="auth-logo auth-logo-light" src="/brand/netfare-logo.svg" alt="Netfare" width="207" height="72">
      <img class="auth-logo auth-logo-dark" src="/brand/netfare-logo-white.svg" alt="" width="207" height="72">
      <h1 id="auth-title">${icon(iconName, 18)} ${esc(title)}</h1>
      <p class="auth-intro">${intro}</p>
      ${body}
    </main>`;
  document.body.appendChild(root);
  document.body.classList.add('auth-mode');
  return root;
}

function closeCard(root) {
  root.remove();
  document.body.classList.remove('auth-mode');
}

// Shows one screen and resolves with the signed-in user once it succeeds.
// onCancel, for screens with a Cancel button, resolves instead.
function showScreen(kind, { onCancel } = {}) {
  const screen = SCREENS[kind];
  const root = showCard({
    iconName: screen.icon || (kind === 'login' ? 'lock' : 'user'),
    title: screen.title,
    intro: esc(screen.intro),
    body: `
      <form class="auth-form" novalidate>
        ${screen.fields.map(fieldHtml).join('')}
        ${kind === 'login' ? '<button type="button" class="auth-link auth-forgot" data-forgot>Forgot password?</button>' : ''}
        <div class="auth-error" role="alert" hidden></div>
        <button class="btn btn-primary auth-submit" type="submit">${esc(screen.submit)}</button>
        ${screen.cancel ? '<button type="button" class="btn btn-ghost auth-cancel" data-cancel>Cancel</button>' : ''}
      </form>`,
  });
  const form = root.querySelector('form');
  const errorBox = root.querySelector('.auth-error');
  const submit = root.querySelector('.auth-submit');
  setTimeout(() => form.querySelector('input')?.focus(), 30);

  return new Promise((resolve) => {
    root.querySelector('[data-forgot]')?.addEventListener('click', () => resolve(showForgot()));
    root.querySelector('[data-cancel]')?.addEventListener('click', () => resolve(onCancel ? onCancel() : showScreen('login')));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      errorBox.hidden = true;
      try {
        const empty = screen.fields.find((field) => !String(values[field.name] || '').trim());
        if (empty) throw new Error(`Enter ${empty.label.toLowerCase()}`);
        if ('confirm' in values) {
          const chosen = values.password ?? values.new_password;
          if (chosen !== values.confirm) throw new Error('The two passwords do not match');
          delete values.confirm;
        }
        submit.disabled = true;
        submit.classList.add('is-loading');
        const result = await screen.send(values);
        closeCard(root);
        resolve(result.recovery_key ? showKey(result.recovery_key, { afterReset: true }) : result.user);
      } catch (error) {
        errorBox.textContent = error.message || 'Something went wrong';
        errorBox.hidden = false;
        replayAnimation(errorBox, 't-shake');
      } finally {
        submit.disabled = false;
        submit.classList.remove('is-loading');
      }
    });
  });
}

// "Forgot password?": staff ask the admin; the admin uses the recovery key at
// the main computer, where this box also offers the reset itself.
async function showForgot() {
  let mainComputer = false;
  try { ({ main_computer: mainComputer } = await api.get('/auth/recovery')); } catch { /* show the help anyway */ }
  const root = showCard({
    iconName: 'key',
    title: 'Forgot your password?',
    intro: 'Netfare keeps your books on your own computer, so there is no reset by email.',
    body: `
      <ol class="auth-steps">
        <li><strong>Staff:</strong> ask your admin. They open Settings → Users and set a new password for you.</li>
        <li><strong>Admin:</strong> on the main computer, open the Netfare app, choose Help → Reset admin password and enter your recovery key.</li>
      </ol>
      <div class="auth-form">
        ${mainComputer ? '<button type="button" class="btn btn-primary auth-submit" data-reset>Reset admin password</button>' : ''}
        <button type="button" class="btn ${mainComputer ? 'btn-ghost' : 'btn-secondary'} auth-cancel" data-back>Back to sign in</button>
      </div>`,
  });
  setTimeout(() => root.querySelector('button')?.focus(), 30);
  return new Promise((resolve) => {
    root.querySelector('[data-reset]')?.addEventListener('click', () => resolve(showScreen('reset')));
    root.querySelector('[data-back]').addEventListener('click', () => resolve(showScreen('login')));
  });
}

// Shows a new recovery key until the admin ticks that they saved it, then
// resolves with the user.
function showKey(key, { afterReset = false } = {}) {
  const root = showCard({
    iconName: 'key',
    title: afterReset ? 'Password reset. Save your new recovery key' : 'Save your recovery key',
    intro: afterReset
      ? 'Your old key no longer works. Keep this one away from this computer: it is the only way to reset the admin password in the app.'
      : 'If you forget the admin password, this key is the only way to reset it in the app. Keep it away from this computer.',
    body: `
      ${keyPanelHtml(key)}
      <div class="auth-form">
        <div class="auth-error" role="alert" hidden></div>
        <button type="button" class="btn btn-primary auth-submit" data-continue disabled>Continue</button>
      </div>`,
  });
  const button = root.querySelector('[data-continue]');
  const errorBox = root.querySelector('.auth-error');
  bindKeyPanel(root, key, (saved) => { button.disabled = !saved; });
  setTimeout(() => root.querySelector('[data-key-copy]')?.focus(), 30);
  return new Promise((resolve) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const { user } = await api.post('/auth/recovery-key/confirm');
        closeCard(root);
        resolve(user);
      } catch (error) {
        errorBox.textContent = error.message || 'Something went wrong';
        errorBox.hidden = false;
        button.disabled = false;
      }
    });
  });
}

// The admin's first sign-in on a version with recovery keys, or a key that was
// shown but never ticked as saved: show a fresh one.
async function offerRecoveryKey(user) {
  try {
    const { recovery_key: key } = await api.post('/auth/recovery-key');
    return await showKey(key);
  } catch {
    return user;
  }
}

// Resolves with the signed-in user, showing setup, sign-in or the password
// change first when needed. The desktop app's Help → Reset admin password
// opens Netfare with ?reset=admin.
export async function ensureSignedIn() {
  const status = await api.get('/auth/status');
  let user = status.user;
  const resetAsked = new URLSearchParams(location.search).get('reset') === 'admin';
  if (resetAsked) history.replaceState(null, '', `${location.pathname}${location.hash}`);
  if (status.setup_needed) user = await showScreen('setup');
  else if (resetAsked) user = await showScreen('reset', { onCancel: () => user || showScreen('login') });
  else if (!user) user = await showScreen('login');
  if (user.must_change_password) user = await showScreen('change');
  if (user.recovery_key_needed) user = await offerRecoveryKey(user);
  return user;
}

export async function signOut() {
  try { await api.post('/auth/logout'); } catch { /* signed out already */ }
  location.reload();
}

// A session that ends while the app is open (idle too long, disabled by the
// admin, password changed elsewhere) brings back the sign-in screen.
let reauthenticating = false;
window.addEventListener('auth-required', async () => {
  if (reauthenticating) return;
  reauthenticating = true;
  document.querySelectorAll('.modal-overlay').forEach((overlay) => overlay.remove());
  document.body.classList.remove('modal-open');
  await ensureSignedIn();
  location.reload();
});
