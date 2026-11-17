import { api } from './api.js';
import { can, portalForVendorId, store } from './store.js';
import { esc, openModal, PORTAL_TYPES, toast } from './ui.js';

// A new customer or supplier made from inside another form's list (the
// picker's "Add new…" row): a small form on top; the form below stays open.
// A supplier can get its portal (wallet or credit account) in the same step.
const KINDS = {
  customer: { noun: 'customer', path: '/customers', list: 'customers', area: 'customers' },
  vendor: { noun: 'supplier', path: '/vendors', list: 'vendors', area: 'suppliers' },
};

export const quickAddNoun = (kind) => KINDS[kind]?.noun || '';

// Only for people allowed to create customers or suppliers.
export function canQuickAdd(kind) {
  return Boolean(KINDS[kind]) && can(KINDS[kind].area, 'edit');
}

// "Emirates Consolidator — wallet": how supplier lists name a supplier with a portal.
export function partyLabel(kind, party) {
  const portal = kind === 'vendor' ? portalForVendorId(party.id) : null;
  return portal ? `${party.name} — ${portal.settlement === 'prepaid' ? 'wallet' : 'credit'}` : party.name;
}

const sameName = (a, b) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

function portalFieldsHtml() {
  return `
    <div class="field full"><label class="checkbox-row"><input type="checkbox" id="qa-portal"> This supplier has a portal (wallet or credit account)</label></div>
    <div class="field" data-qa-portal hidden><label for="qa-type">Portal type</label>
      <select class="input" id="qa-type">${PORTAL_TYPES.map(([value, label]) => `<option value="${value}" ${value === 'consolidator' ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>
    <div class="field" data-qa-portal hidden><label for="qa-settlement">How you settle</label>
      <select class="input" id="qa-settlement"><option value="prepaid">Prepaid wallet</option><option value="credit">Credit account</option></select></div>`;
}

// Resolves with the saved customer or supplier, or null when cancelled.
export function quickAdd(kind, name = '') {
  const { noun, path, list } = KINDS[kind];
  const portalAllowed = kind === 'vendor' && can('portals', 'edit');
  return new Promise((resolve) => {
    let saved = null;
    openModal({
      title: `New ${noun}`,
      size: 'modal-sm',
      submitLabel: `Save ${noun}`,
      body: `<div class="form-grid">
        <div class="field full"><label for="qa-name">Name</label><input class="input" id="qa-name" required autocomplete="off" value="${esc(name)}"></div>
        <div class="field"><label for="qa-phone">Phone</label><input class="input" id="qa-phone" data-phone autocomplete="off"></div>
        <div class="field"><label for="qa-email">Email</label><input class="input" id="qa-email" type="email" autocomplete="off"></div>
        ${portalAllowed ? portalFieldsHtml() : ''}
      </div>`,
      onMount(overlay) {
        const box = overlay.querySelector('#qa-portal');
        box?.addEventListener('change', () => overlay.querySelectorAll('[data-qa-portal]').forEach((field) => { field.hidden = !box.checked; }));
      },
      async onSubmit(form) {
        const value = (selector) => form.querySelector(selector).value.trim();
        const typed = value('#qa-name');
        if (!typed) throw new Error('Enter a name');
        // The same name twice splits one party's balance over two records (and
        // a second supplier is not linked to the first one's portal). The list
        // comes from the server: a colleague may have added the name since sign-in.
        store[list] = await api.get(path);
        const existing = store[list].find((row) => sameName(row.name, typed));
        if (existing) throw new Error(`${partyLabel(kind, existing)}${existing.number ? ` (${existing.number})` : ''} already exists. Choose it from the list.`);
        saved = await api.post(path, { name: typed, phone: value('#qa-phone'), email: value('#qa-email') });
        store[list] = [...store[list], saved].sort((a, b) => a.name.localeCompare(b.name));
        if (form.querySelector('#qa-portal')?.checked) {
          try {
            const portal = await api.post('/portals', {
              name: saved.name, vendor_id: saved.id, portal_type: value('#qa-type'), settlement: value('#qa-settlement'),
            });
            store.portals = [...store.portals, portal];
          } catch (error) {
            toast(`${saved.name} was saved, but not its portal: ${error.message}. Add it on the Portals page.`, 'error');
            return;
          }
        }
        toast(`${saved.number ? `${saved.number} · ` : ''}${partyLabel(kind, saved)} added`);
      },
      onClose: () => resolve(saved),
    });
  });
}
