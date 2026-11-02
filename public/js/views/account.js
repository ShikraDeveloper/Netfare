// Your own password, and (for the admin) the staff logins card in Settings.

import { api } from '../api.js';
import { store } from '../store.js';
import {
  confirmDialog,
  esc,
  fmtDate,
  icon,
  openModal,
  toast,
} from '../ui.js';

function passwordFields({ current = false } = {}) {
  return `
    <div class="form-grid">
      ${current ? `
      <div class="field full">
        <label for="pw-current">Current password</label>
        <input class="input" id="pw-current" name="current_password" type="password" autocomplete="current-password" required>
      </div>` : ''}
      <div class="field">
        <label for="pw-new">New password</label>
        <input class="input" id="pw-new" name="password" type="password" autocomplete="new-password" required aria-describedby="pw-new-hint">
        <div class="hint" id="pw-new-hint">At least 8 characters</div>
      </div>
      <div class="field">
        <label for="pw-confirm">Confirm password</label>
        <input class="input" id="pw-confirm" name="confirm" type="password" autocomplete="new-password" required>
      </div>
    </div>`;
}

function chosenPassword(form) {
  const password = form.elements.password.value;
  if (password !== form.elements.confirm.value) throw new Error('The two passwords do not match');
  return password;
}

export function openChangePassword() {
  openModal({
    title: 'Change your password',
    subtitle: 'Other browsers signed in as you will be signed out.',
    size: 'modal-sm',
    body: passwordFields({ current: true }),
    submitLabel: 'Change password',
    onSubmit: async (form) => {
      const newPassword = chosenPassword(form);
      await api.post('/auth/password', { current_password: form.elements.current_password.value, new_password: newPassword });
      toast('Password changed');
    },
  });
}

// The rights areas come from the server (server/permissions.js).
let rightAreas = null;
async function loadRightAreas() {
  if (!rightAreas) rightAreas = await api.get('/users/areas');
  return rightAreas;
}

function rightsHtml(permissions = {}) {
  const rows = rightAreas.map((area) => {
    const current = permissions[area.key] || 'none';
    const radio = (level) => `
      <td class="rights-cell">
        <input type="radio" name="right-${area.key}" value="${level}" ${current === level ? 'checked' : ''}
          aria-label="${esc(area.label)}: ${level === 'none' ? 'No access' : level === 'view' ? 'View' : 'Edit'}">
      </td>`;
    return `
      <tr>
        <th scope="row">${esc(area.label)}</th>
        ${radio('none')}${radio('view')}${area.edit ? radio('edit') : '<td class="rights-cell muted" aria-hidden="true">—</td>'}
      </tr>`;
  }).join('');
  return `
    <fieldset class="rights">
      <legend>Rights</legend>
      <div class="rights-quick" role="group" aria-label="Set every area">
        <span class="muted">Set all:</span>
        <button type="button" class="btn btn-ghost btn-sm" data-rights-all="none">No access</button>
        <button type="button" class="btn btn-ghost btn-sm" data-rights-all="view">View</button>
        <button type="button" class="btn btn-ghost btn-sm" data-rights-all="edit">Edit</button>
      </div>
      <table class="rights-table"><caption class="sr-only">Rights for each area</caption>
        <thead><tr><th scope="col">Area</th><th scope="col">No access</th><th scope="col">View</th><th scope="col">Edit</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <label class="checkbox-row rights-void">
        <input type="checkbox" name="right-void" ${permissions.void ? 'checked' : ''}>
        <span><strong>Void, cancel &amp; delete</strong> — reverse invoices, payments, bills and other entries, cancel bookings and visas, delete drafts. Also needs Edit for that area.</span>
      </label>
    </fieldset>`;
}

function bindRights(overlay) {
  overlay.querySelectorAll('[data-rights-all]').forEach((button) => {
    button.addEventListener('click', () => {
      const level = button.dataset.rightsAll;
      for (const area of rightAreas) {
        const wanted = level === 'edit' && !area.edit ? 'view' : level;
        const input = overlay.querySelector(`input[name="right-${area.key}"][value="${wanted}"]`);
        if (input) input.checked = true;
      }
    });
  });
}

function readRights(form) {
  const permissions = {};
  for (const area of rightAreas) {
    const level = form.querySelector(`input[name="right-${area.key}"]:checked`)?.value;
    if (level === 'view' || level === 'edit') permissions[area.key] = level;
  }
  if (form.elements['right-void'].checked) permissions.void = true;
  return permissions;
}

function rightsSummary(user) {
  if (user.is_admin) return 'Every right';
  const levels = Object.entries(user.permissions || {}).filter(([key]) => key !== 'void');
  if (!levels.length) return 'No rights yet';
  const edit = levels.filter(([, level]) => level === 'edit').length;
  const view = levels.length - edit;
  return [edit ? `Edit ${edit}` : '', view ? `View ${view}` : '', user.permissions.void ? 'Void' : ''].filter(Boolean).join(' · ');
}

function userRow(user) {
  const status = user.is_active
    ? '<span class="badge badge-active">Active</span>'
    : '<span class="badge badge-draft">Disabled</span>';
  const actions = user.is_admin ? '' : `
    <div class="row-actions">
      <button type="button" class="icon-btn" data-user-rights="${user.id}" aria-label="Rights for ${esc(user.full_name)}" title="Rights">${icon('shield', 16)}</button>
      <button type="button" class="icon-btn" data-user-edit="${user.id}" aria-label="Rename ${esc(user.full_name)}" title="Rename">${icon('edit', 16)}</button>
      <button type="button" class="icon-btn" data-user-password="${user.id}" aria-label="Set a new password for ${esc(user.full_name)}" title="Set a new password">${icon('lock', 16)}</button>
      <button type="button" class="icon-btn" data-user-active="${user.id}" aria-label="${user.is_active ? 'Disable' : 'Enable'} ${esc(user.full_name)}" title="${user.is_active ? 'Disable' : 'Enable'}">${icon(user.is_active ? 'archive' : 'refresh', 16)}</button>
    </div>`;
  return `
    <tr ${user.is_active ? '' : 'style="opacity:.6"'}>
      <td>
        <div class="cell-main">${esc(user.full_name)} ${user.is_admin ? '<span class="chip">Admin</span>' : ''}${user.id === store.user?.id ? ' <span class="chip">You</span>' : ''}</div>
        <div class="cell-sub">${esc(user.username)}</div>
      </td>
      <td>${status}</td>
      <td class="muted">${esc(rightsSummary(user))}</td>
      <td class="nowrap muted">${user.last_login_at ? esc(fmtDate(user.last_login_at.slice(0, 10))) : 'Never'}</td>
      <td>${actions}</td>
    </tr>`;
}

export function usersCardHtml() {
  return `
    <div class="card" id="users-card">
      <div class="card-head">
        <div class="card-title"><h2>Users &amp; logins</h2><p>Each person on your staff signs in with their own username</p></div>
        <button type="button" class="btn btn-secondary btn-sm" id="user-new">${icon('plus', 15)} New user</button>
      </div>
      <div class="table-wrap">
        <table class="data cards-sm"><caption class="sr-only">Users</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Rights</th><th scope="col">Last sign-in</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody id="users-body"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
        </table>
      </div>
      <div class="card-body">
        <div class="form-note">Each user sees only the screens you give them. View lets them look; Edit lets them add and change; Void, cancel &amp; delete is a separate right. Bookings and visas also show their invoices, portals and journal postings. Users, backups, restore and Clear all data always stay with the admin. Disabled users cannot sign in, and their past entries keep their name.</div>
      </div>
    </div>`;
}

export function bindUsersCard(container) {
  const body = container.querySelector('#users-body');
  let users = [];

  async function load() {
    users = await api.get('/users');
    body.innerHTML = users.map(userRow).join('');
  }

  function find(id) {
    return users.find((user) => user.id === Number(id));
  }

  container.querySelector('#user-new').addEventListener('click', async () => {
    await loadRightAreas();
    openModal({
      title: 'New user',
      subtitle: 'Give these details to the staff member. They can change the password later.',
      size: 'modal-lg',
      onMount: bindRights,
      body: `
        <div class="form-grid">
          <div class="field">
            <label for="user-name">Full name</label>
            <input class="input" id="user-name" name="full_name" autocomplete="off" required>
          </div>
          <div class="field">
            <label for="user-username">Username</label>
            <input class="input" id="user-username" name="username" autocomplete="off" autocapitalize="none" spellcheck="false" required aria-describedby="user-username-hint">
            <div class="hint" id="user-username-hint">Letters, numbers, dot, dash or underscore</div>
          </div>
        </div>
        ${passwordFields()}
        ${rightsHtml({ dashboard: 'view' })}`,
      submitLabel: 'Create user',
      onSubmit: async (form) => {
        const password = chosenPassword(form);
        const user = await api.post('/users', {
          full_name: form.elements.full_name.value,
          username: form.elements.username.value,
          password,
          permissions: readRights(form),
        });
        toast(`${user.full_name} can now sign in as ${user.username}`);
        await load();
      },
    });
  });

  body.addEventListener('click', async (event) => {
    const rights = event.target.closest('[data-user-rights]');
    if (rights) {
      const user = find(rights.dataset.userRights);
      await loadRightAreas();
      openModal({
        title: `Rights for ${user.full_name}`,
        subtitle: 'Changes apply to their next click; they stay signed in.',
        size: 'modal-lg',
        onMount: bindRights,
        body: rightsHtml(user.permissions || {}),
        submitLabel: 'Save rights',
        onSubmit: async (form) => {
          await api.put(`/users/${user.id}`, { permissions: readRights(form) });
          toast(`Rights saved for ${user.full_name}`);
          await load();
        },
      });
      return;
    }
    const edit = event.target.closest('[data-user-edit]');
    const password = event.target.closest('[data-user-password]');
    const active = event.target.closest('[data-user-active]');
    if (edit) {
      const user = find(edit.dataset.userEdit);
      openModal({
        title: `Rename ${user.full_name}`,
        size: 'modal-sm',
        body: `
          <div class="field">
            <label for="user-rename">Full name</label>
            <input class="input" id="user-rename" name="full_name" value="${esc(user.full_name)}" required>
          </div>`,
        onSubmit: async (form) => {
          await api.put(`/users/${user.id}`, { full_name: form.elements.full_name.value });
          toast('Name saved');
          await load();
        },
      });
    } else if (password) {
      const user = find(password.dataset.userPassword);
      openModal({
        title: `New password for ${user.full_name}`,
        subtitle: 'They are signed out everywhere and use this password next time.',
        size: 'modal-sm',
        body: passwordFields(),
        submitLabel: 'Set password',
        onSubmit: async (form) => {
          await api.post(`/users/${user.id}/password`, { password: chosenPassword(form) });
          toast(`New password set for ${user.full_name}`);
          await load();
        },
      });
    } else if (active) {
      const user = find(active.dataset.userActive);
      const disabling = user.is_active;
      confirmDialog({
        title: disabling ? `Disable ${user.full_name}?` : `Enable ${user.full_name}?`,
        message: disabling
          ? 'They are signed out at once and cannot sign in until you enable them again. Their past entries are kept.'
          : 'They can sign in again with their existing password.',
        confirmLabel: disabling ? 'Disable' : 'Enable',
        danger: disabling,
      }).then(async (ok) => {
        if (!ok) return;
        await api.put(`/users/${user.id}`, { is_active: !disabling });
        toast(disabling ? `${user.full_name} is disabled` : `${user.full_name} is enabled`);
        await load();
      }).catch((error) => toast(error.message, 'error'));
    }
  });

  load().catch((error) => {
    body.innerHTML = `<tr><td colspan="5" class="muted">${esc(error.message)}</td></tr>`;
  });
}
