import { api } from './api.js';
import { can, store } from './store.js';
import { esc, openModal, toast } from './ui.js';

// A new customer or supplier made from inside another form's list (the
// picker's "Add new…" row): a small form on top; the form below stays open.
const KINDS = {
  customer: { noun: 'customer', path: '/customers', list: 'customers', area: 'customers' },
  vendor: { noun: 'supplier', path: '/vendors', list: 'vendors', area: 'suppliers' },
};

export const quickAddNoun = (kind) => KINDS[kind]?.noun || '';

// Only for people allowed to create customers or suppliers.
export function canQuickAdd(kind) {
  return Boolean(KINDS[kind]) && can(KINDS[kind].area, 'edit');
}

// Resolves with the saved customer or supplier, or null when cancelled.
export function quickAdd(kind, name = '') {
  const { noun, path, list } = KINDS[kind];
  return new Promise((resolve) => {
    let saved = null;
    openModal({
      title: `New ${noun}`,
      size: 'modal-sm',
      submitLabel: `Save ${noun}`,
      body: `<div class="form-grid">
        <div class="field full"><label for="qa-name">Name</label><input class="input" id="qa-name" required autocomplete="off" value="${esc(name)}"></div>
        <div class="field"><label for="qa-phone">Phone</label><input class="input" id="qa-phone" type="tel" autocomplete="off"></div>
        <div class="field"><label for="qa-email">Email</label><input class="input" id="qa-email" type="email" autocomplete="off"></div>
      </div>`,
      async onSubmit(form) {
        const value = (selector) => form.querySelector(selector).value.trim();
        if (!value('#qa-name')) throw new Error('Enter a name');
        saved = await api.post(path, { name: value('#qa-name'), phone: value('#qa-phone'), email: value('#qa-email') });
        store[list] = [...store[list], saved].sort((a, b) => a.name.localeCompare(b.name));
        toast(`${saved.number ? `${saved.number} · ` : ''}${saved.name} added`);
      },
      onClose: () => resolve(saved),
    });
  });
}
