// Sign-in screens: first-run admin setup, sign in, and the forced password
// change after `npm run reset-admin`. They cover the whole app until the
// server knows who is using it.

import { api } from './api.js';
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

// Shows one screen and resolves with the signed-in user once it succeeds.
function showScreen(kind) {
  const screen = SCREENS[kind];
  document.getElementById('auth-root')?.remove();
  const root = document.createElement('div');
  root.id = 'auth-root';
  root.className = 'auth-screen';
  root.innerHTML = `
    <main class="auth-card" aria-labelledby="auth-title">
      <img class="auth-logo auth-logo-light" src="/brand/netfare-logo.svg" alt="Netfare" width="207" height="72">
      <img class="auth-logo auth-logo-dark" src="/brand/netfare-logo-white.svg" alt="" width="207" height="72">
      <h1 id="auth-title">${icon(kind === 'login' ? 'lock' : 'user', 18)} ${esc(screen.title)}</h1>
      <p class="auth-intro">${esc(screen.intro)}</p>
      <form class="auth-form" novalidate>
        ${screen.fields.map(fieldHtml).join('')}
        <div class="auth-error" role="alert" hidden></div>
        <button class="btn btn-primary auth-submit" type="submit">${esc(screen.submit)}</button>
      </form>
    </main>`;
  document.body.appendChild(root);
  document.body.classList.add('auth-mode');
  const form = root.querySelector('form');
  const errorBox = root.querySelector('.auth-error');
  const submit = root.querySelector('.auth-submit');
  setTimeout(() => form.querySelector('input')?.focus(), 30);

  return new Promise((resolve) => {
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
        const { user } = await screen.send(values);
        root.remove();
        document.body.classList.remove('auth-mode');
        resolve(user);
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

// Resolves with the signed-in user, showing setup, sign-in or the password
// change first when needed.
export async function ensureSignedIn() {
  const status = await api.get('/auth/status');
  let user = status.user;
  if (status.setup_needed) user = await showScreen('setup');
  else if (!user) user = await showScreen('login');
  if (user.must_change_password) user = await showScreen('change');
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
