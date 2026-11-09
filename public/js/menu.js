import { can, store } from './store.js';
import { avatar, esc, icon } from './ui.js';

// The app's menu, shared by the side menu and the top menu. Each screen has a
// one-line description (shown in the top menu's panels and as a tooltip in
// the side menu); each group has quick "New …" actions. The user picks Side or
// Top in Settings → Appearance; phones always use the side drawer.

export const MENU_GROUPS = [
  {
    key: 'home',
    label: 'Home',
    icon: 'home',
    items: [
      { section: 'dashboard', href: '#/dashboard', icon: 'dashboard', label: 'Dashboard', keywords: 'Today at a glance' },
      { section: 'reminders', href: '#/reminders', icon: 'clock', label: 'Reminders', keywords: 'Things to do at a time · alarm' },
    ],
  },
  {
    key: 'travel',
    label: 'Travel',
    icon: 'plane',
    items: [
      { section: 'bookings', href: '#/bookings', icon: 'plane', label: 'Bookings', keywords: 'Tickets, hotels and packages' },
      { section: 'visas', href: '#/visas', icon: 'visa', label: 'Visas', keywords: 'Applications, groups and deposits' },
    ],
    actions: [
      { label: 'New booking', href: '#/bookings?new=1', area: 'bookings' },
      { label: 'New visa', href: '#/visas?new=1', area: 'visas' },
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    icon: 'invoice',
    items: [
      { section: 'invoices', href: '#/invoices', icon: 'invoice', label: 'Invoices', keywords: 'Service invoices and payments' },
      { section: 'customers', href: '#/customers', icon: 'customers', label: 'Customers', keywords: 'Contacts, documents, nationality' },
    ],
    actions: [
      { label: 'New invoice', href: '#/invoices?new=1', area: 'sales' },
      { label: 'New customer', href: '#/customers?new=1', area: 'customers' },
    ],
  },
  {
    key: 'money-back',
    label: 'Money back',
    icon: 'undo',
    items: [
      { section: 'customer-balances', href: '#/customer-balances', icon: 'wallet', label: 'Customer balances', keywords: 'Who owes what · Receive payment' },
      { section: 'settlement-queue', href: '#/settlement-queue', icon: 'clock', label: 'Settlements', keywords: 'Refunds and credits waiting' },
      { section: 'cancellations', href: '#/cancellations', icon: 'x', label: 'Cancellations', keywords: 'Cancelled bookings and visas' },
      { section: 'refunds', href: '#/refunds', icon: 'arrowUp', label: 'Refunds', keywords: 'Money paid back to customers' },
      { section: 'credits', href: '#/credits', icon: 'invoice', label: 'Credit notes', keywords: 'Credit kept for customers' },
    ],
    actions: [
      { label: 'New credit note', href: '#/credits?new=1', area: 'refunds' },
    ],
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    icon: 'truck',
    items: [
      { section: 'vendors', href: '#/vendors', icon: 'vendors', label: 'Suppliers', keywords: 'Airlines, consolidators, agents' },
      { section: 'bills', href: '#/bills', icon: 'bill', label: 'Bills & expenses', keywords: 'What you owe and pay' },
      { section: 'supplier-credits', href: '#/supplier-credits', icon: 'bill', label: 'Supplier credits', keywords: 'Credit held with suppliers' },
      { section: 'portals', href: '#/portals', icon: 'wallet', label: 'Portals & wallets', keywords: 'Top-ups and credit accounts' },
    ],
    actions: [
      { label: 'New bill', href: '#/bills?new=1', area: 'suppliers' },
      { label: 'New supplier', href: '#/vendors?new=1', area: 'suppliers' },
      { label: 'New portal', href: '#/portals?new=1', area: 'portals' },
    ],
  },
  {
    key: 'books',
    label: 'Bank and books',
    icon: 'bank',
    collapsed: true,
    columns: 3,
    items: [
      { section: 'banking', href: '#/banking', icon: 'cash', label: 'Banking', keywords: 'Cash and bank' },
      { section: 'petty-cash', href: '#/petty-cash', icon: 'wallet', label: 'Petty cash', keywords: 'Float and counts' },
      { section: 'card-settlements', href: '#/card-settlements', icon: 'cash', label: 'Card settlements', keywords: 'Gateway payouts' },
      { section: 'bank-reconciliation', href: '#/bank-reconciliation', icon: 'check', label: 'Bank reconciliation', keywords: 'Match bank statements' },
      { section: 'cheques', href: '#/cheques', icon: 'cheque', label: 'Cheques', keywords: 'Post-dated cheques' },
      { section: 'compliance', href: '#/compliance', icon: 'check', label: 'Compliance', keywords: 'Due dates and fees' },
      { section: 'journal', href: '#/journal', icon: 'journal', label: 'Journal', keywords: 'Manual entries' },
      { section: 'opening-balances', href: '#/opening-balances', icon: 'journal', label: 'Opening balances', keywords: 'Starting figures' },
      { section: 'accounts', href: '#/accounts', icon: 'accounts', label: 'Chart of accounts', keywords: 'All accounts' },
      { section: 'audit-logs', href: '#/audit-logs', icon: 'shield', label: 'Audit log', keywords: 'Who did what' },
    ],
    actions: [
      { label: 'New journal entry', href: '#/journal?new=1', area: 'books' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    icon: 'reports',
    items: [
      { section: 'reports', href: '#/reports', icon: 'reports', label: 'Reports', keywords: 'Profit, balance sheet, DSR, aging' },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'settings',
    sideOnly: true,
    items: [
      { section: 'settings', href: '#/settings', icon: 'settings', label: 'Settings', keywords: 'Company, users, backups' },
    ],
  },
];

// The rights area behind each screen (see server/permissions.js). A screen
// opens when the user may view any one of its areas. Settings is always
// open: everyone needs Appearance and their own password.
export const SECTION_AREAS = {
  dashboard: ['dashboard'],
  bookings: ['bookings'],
  visas: ['visas'],
  invoices: ['sales'],
  customers: ['customers'],
  'settlement-queue': ['sales', 'refunds'],
  cancellations: ['refunds'],
  refunds: ['refunds'],
  credits: ['refunds'],
  'customer-balances': ['customers', 'sales'],
  vendors: ['suppliers'],
  bills: ['suppliers'],
  'supplier-credits': ['suppliers'],
  portals: ['portals'],
  reports: ['reports'],
  banking: ['banking'],
  'petty-cash': ['banking'],
  'card-settlements': ['banking'],
  'bank-reconciliation': ['banking'],
  cheques: ['banking'],
  compliance: ['compliance'],
  journal: ['books'],
  'opening-balances': ['books'],
  accounts: ['books'],
  'audit-logs': ['audit'],
};

export function canOpen(section) {
  const areas = SECTION_AREAS[section];
  return !areas || areas.some((area) => can(area));
}

export function visibleGroups({ top = false } = {}) {
  return MENU_GROUPS
    .filter((group) => !(top && group.sideOnly))
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canOpen(item.section)),
      actions: (group.actions || []).filter((action) => can(action.area, 'edit')),
    }))
    .filter((group) => group.items.length);
}

export function newActions() {
  return visibleGroups().flatMap((group) => group.actions);
}

// ---------------------------------------------------------------------------
// Side or top, per device (like the theme). theme-boot.js sets the class
// before the first paint so the page does not jump.

const MENU_KEY = 'netfare.menu';

export function getMenuMode() {
  try { return localStorage.getItem(MENU_KEY) === 'top' ? 'top' : 'side'; } catch { return 'side'; }
}

export function setMenuMode(mode) {
  const next = mode === 'top' ? 'top' : 'side';
  try { localStorage.setItem(MENU_KEY, next); } catch { /* per-device convenience only */ }
  document.documentElement.classList.toggle('menu-top', next === 'top');
  window.dispatchEvent(new CustomEvent('menu-mode-changed', { detail: { mode: next } }));
  return next;
}

// ---------------------------------------------------------------------------
// Recently opened records (a booking, an invoice, a customer…), per device.

const RECENT_KEY = 'netfare.recent';
const RECENT_MAX = 20;

function readRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((row) => row && row.hash && row.title); } catch { return []; }
}

export function rememberRecent({ hash, title, section }) {
  if (!hash || !title || !/\/\d+/.test(hash)) return;
  const rows = [{ hash, title: String(title).slice(0, 80), section }, ...readRecent().filter((row) => row.hash !== hash)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(rows)); } catch { /* per-device convenience only */ }
}

export function recentFor(sections, limit = 3) {
  return readRecent().filter((row) => !sections || sections.includes(row.section)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Pieces of HTML used by both menus.

function panelItemHtml(item) {
  return `
    <a class="tn-item" href="${item.href}" data-section="${item.section}">
      <span class="tn-item-icon">${icon(item.icon, 16)}</span>
      <span class="tn-item-text"><strong>${esc(item.label)}</strong></span>
    </a>`;
}

function actionLinksHtml(actions, className = 'tn-action') {
  return actions.map((action) => `<a class="${className}" href="${action.href}">${icon('plus', 13)}<span>${esc(action.label)}</span></a>`).join('');
}

export function newMenuHtml() {
  const actions = newActions();
  if (!actions.length) return '';
  return `
    <div class="tn-pop" data-pop="new">
      <button type="button" class="btn btn-primary btn-sm tn-new" aria-expanded="false" aria-haspopup="true">${icon('plus', 14)}<span>New</span></button>
      <div class="tn-panel tn-panel-new" hidden>
        <div class="tn-panel-head">Create</div>
        <div class="tn-new-grid">${actionLinksHtml(actions, 'tn-new-item')}</div>
      </div>
    </div>`;
}

export function searchButtonHtml(className = 'tn-search') {
  return `<button type="button" class="${className}" data-open-search aria-label="Search screens, customers and suppliers">${icon('search', 15)}<span>Search</span><kbd>/</kbd></button>`;
}

// ---------------------------------------------------------------------------
// The top menu.

export function buildTopNav(root, { onPassword, onSignOut } = {}) {
  const company = store.settings?.company_name || 'My Company';
  const user = store.user;
  const groups = visibleGroups({ top: true });
  root.innerHTML = `
    <a class="tn-org" href="#/dashboard" title="Home">
      <img class="tn-logo" src="/brand/netfare-icon.svg" alt="" width="30" height="30">
      <span class="tn-org-text"><strong>${esc(company)}</strong><small>Netfare</small></span>
    </a>
    <nav class="tn-groups" aria-label="Main navigation">
      ${groups.map((group) => {
    if (group.items.length === 1 && !group.actions.length) {
      const item = group.items[0];
      return `<a class="tn-link" href="${item.href}" data-tn-group="${group.key}" data-section="${item.section}">${icon(group.icon, 16)}<span>${esc(group.label)}</span></a>`;
    }
    return `
          <div class="tn-pop tn-group" data-pop="${group.key}" data-tn-group="${group.key}">
            <button type="button" class="tn-trigger" aria-expanded="false" aria-haspopup="true" aria-controls="tn-panel-${group.key}">
              ${icon(group.icon, 16)}<span>${esc(group.label)}</span><span class="tn-caret">${icon('chevron', 12)}</span>
            </button>
            <div class="tn-panel" id="tn-panel-${group.key}" hidden>
              <div class="tn-panel-main">
                <div class="tn-panel-head">${esc(group.label)}</div>
                <div class="tn-items" style="--tn-cols:${group.columns || 2}">${group.items.map(panelItemHtml).join('')}</div>
                ${group.actions.length ? `<div class="tn-actions">${actionLinksHtml(group.actions)}</div>` : ''}
              </div>
              <div class="tn-recent" data-recent-for="${group.items.map((item) => item.section).join(' ')}"></div>
            </div>
          </div>`;
  }).join('')}
    </nav>
    <div class="tn-right">
      ${searchButtonHtml()}
      ${newMenuHtml()}
      <div class="tn-tools" data-tools-slot></div>
      <a class="icon-btn tn-icon" href="#/settings" data-section="settings" aria-label="Settings" title="Settings">${icon('settings', 17)}</a>
      <div class="tn-pop" data-pop="account">
        <button type="button" class="tn-account" aria-expanded="false" aria-haspopup="true" title="Your account"><span aria-hidden="true">${avatar(user?.full_name || company, 30)}</span><span class="sr-only">Your account</span></button>
        <div class="tn-panel tn-panel-account" hidden>
          <div class="tn-account-head">
            <strong>${esc(user?.full_name || company)}</strong>
            <small>${esc(user ? `${user.is_admin ? 'Admin' : 'Staff'} · ${company}` : company)}</small>
          </div>
          <button type="button" class="tn-account-item" data-account-action="password">${icon('lock', 15)}<span>Change your password</span></button>
          <button type="button" class="tn-account-item" data-account-action="signout">${icon('logout', 15)}<span>Sign out</span></button>
        </div>
      </div>
    </div>`;

  root.querySelector('[data-account-action="password"]')?.addEventListener('click', () => { closePops(); onPassword?.(); });
  root.querySelector('[data-account-action="signout"]')?.addEventListener('click', () => { closePops(); onSignOut?.(); });
  bindPops(root);
}

// Panels open on click (not hover), close on Escape, on a click outside and
// when a link inside is chosen.
function closePops(except = null) {
  document.querySelectorAll('.tn-pop.open').forEach((pop) => {
    if (pop === except) return;
    pop.classList.remove('open');
    pop.querySelector(':scope > button')?.setAttribute('aria-expanded', 'false');
    const panel = pop.querySelector(':scope > .tn-panel');
    if (panel) panel.hidden = true;
  });
}

function fillRecent(pop) {
  const box = pop.querySelector('.tn-recent');
  if (!box) return;
  const rows = recentFor(box.dataset.recentFor.split(' '));
  box.innerHTML = `<div class="tn-panel-head">Recent</div>${rows.length
    ? rows.map((row) => `<a class="tn-recent-item" href="${esc(row.hash)}">${esc(row.title)}</a>`).join('')
    : '<span class="tn-recent-empty">Records you open show here.</span>'}`;
}

export function bindPops(root) {
  root.querySelectorAll('.tn-pop').forEach((pop) => {
    const button = pop.querySelector(':scope > button');
    const panel = pop.querySelector(':scope > .tn-panel');
    if (!button || !panel || button.dataset.bound) return;
    button.dataset.bound = '1';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = !pop.classList.contains('open');
      closePops(pop);
      pop.classList.toggle('open', opening);
      button.setAttribute('aria-expanded', String(opening));
      panel.hidden = !opening;
      if (opening) fillRecent(pop);
    });
    panel.addEventListener('click', (event) => {
      if (event.target.closest('a')) closePops();
    });
  });
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('.tn-pop')) closePops();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const open = document.querySelector('.tn-pop.open');
  if (!open) return;
  closePops();
  open.querySelector(':scope > button')?.focus();
});

// Marks the group and item of the screen that is open.
export function markTopNav(section) {
  document.querySelectorAll('#top-nav [data-tn-group]').forEach((node) => {
    const active = node.matches(`[data-section="${section}"]`) || Boolean(node.querySelector(`.tn-item[data-section="${section}"]`));
    node.classList.toggle('active', active);
  });
  document.querySelectorAll('#top-nav .tn-item, #top-nav .tn-link, #top-nav .tn-icon').forEach((node) => {
    const active = node.dataset.section === section;
    node.classList.toggle('current', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
}

// ---------------------------------------------------------------------------
// Search: press "/" (or Ctrl/⌘ K) anywhere to jump to a screen, start a new
// record, or open a customer, supplier or portal by name.

function searchSources() {
  const rows = [];
  for (const group of visibleGroups()) {
    // keywords are not shown; they let a search for "gateway" find Card settlements.
    for (const item of group.items) rows.push({ kind: 'Screen', label: item.label, sub: '', terms: item.keywords, href: item.href, icon: item.icon });
    for (const action of group.actions) rows.push({ kind: 'Create', label: action.label, sub: group.label, href: action.href, icon: 'plus' });
  }
  for (const row of recentFor(null, 8)) rows.push({ kind: 'Recent', label: row.title, sub: '', href: row.hash, icon: 'clock' });
  if (canOpen('customer-balances')) {
    for (const customer of store.customers || []) {
      if (customer.is_active) rows.push({ kind: 'Customer', label: customer.name, sub: customer.nationality || '', href: `#/customer-balances/${customer.id}`, icon: 'customers' });
    }
  }
  if (canOpen('vendors')) {
    for (const vendor of store.vendors || []) {
      if (vendor.is_active) rows.push({ kind: 'Supplier', label: vendor.name, sub: 'Statement', href: `#/vendors/${vendor.id}/statement`, icon: 'vendors' });
    }
  }
  if (canOpen('portals')) {
    for (const portal of store.portals || []) {
      if (portal.is_active) rows.push({ kind: 'Portal', label: portal.name, sub: portal.vendor_name || '', href: `#/portals/${portal.id}`, icon: 'wallet' });
    }
  }
  return rows;
}

export function openSearch() {
  if (document.getElementById('nf-search')) return;
  const overlay = document.createElement('div');
  overlay.id = 'nf-search';
  overlay.className = 'nf-search-overlay';
  overlay.innerHTML = `
    <div class="nf-search" role="dialog" aria-modal="true" aria-label="Search">
      <div class="nf-search-box">${icon('search', 18)}
        <input type="search" id="nf-search-input" placeholder="Search screens, customers, suppliers…" autocomplete="off" spellcheck="false"
          role="combobox" aria-expanded="true" aria-controls="nf-search-list" aria-autocomplete="list">
        <kbd>Esc</kbd>
      </div>
      <div class="nf-search-list" id="nf-search-list" role="listbox"></div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('input');
  const list = overlay.querySelector('.nf-search-list');
  const sources = searchSources();
  let results = [];
  let cursor = 0;
  const lastFocus = document.activeElement;

  const close = () => {
    overlay.remove();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  };
  const go = (row) => {
    if (!row) return;
    close();
    location.hash = row.href;
  };
  const paint = () => {
    const term = input.value.trim().toLowerCase();
    results = (term
      ? sources.filter((row) => `${row.label} ${row.sub} ${row.kind} ${row.terms || ''}`.toLowerCase().includes(term))
      : sources.filter((row) => row.kind !== 'Customer' && row.kind !== 'Supplier' && row.kind !== 'Portal')
    ).slice(0, 12);
    cursor = Math.min(cursor, Math.max(0, results.length - 1));
    list.innerHTML = results.length
      ? results.map((row, index) => `
          <a class="nf-search-row ${index === cursor ? 'is-active' : ''}" href="${esc(row.href)}" role="option" id="nf-opt-${index}" aria-selected="${index === cursor}" data-index="${index}">
            <span class="nf-search-icon">${icon(row.icon, 15)}</span>
            <span class="nf-search-text"><strong>${esc(row.label)}</strong>${row.sub ? `<small>${esc(row.sub)}</small>` : ''}</span>
            <span class="nf-search-kind">${esc(row.kind)}</span>
          </a>`).join('')
      : `<div class="nf-search-empty">Nothing matches "${esc(input.value.trim())}".</div>`;
    input.setAttribute('aria-activedescendant', results.length ? `nf-opt-${cursor}` : '');
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => { cursor = 0; paint(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); cursor = Math.min(results.length - 1, cursor + 1); paint(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); cursor = Math.max(0, cursor - 1); paint(); }
    if (event.key === 'Enter') { event.preventDefault(); go(results[cursor]); }
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  list.addEventListener('click', (event) => {
    const row = event.target.closest('[data-index]');
    if (!row) return;
    event.preventDefault();
    go(results[Number(row.dataset.index)]);
  });
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  paint();
  input.focus();
}

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-open-search]')) openSearch();
});
document.addEventListener('keydown', (event) => {
  const typing = event.target.closest?.('input, textarea, select, [contenteditable="true"]');
  const modalOpen = document.querySelector('.modal-overlay, #nf-search');
  if (!store.user || modalOpen) return;
  if ((event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey)
    || (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey))) {
    event.preventDefault();
    openSearch();
  }
});
