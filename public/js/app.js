import { can, refreshMeta, store } from './store.js';
import { initTheme } from './theme.js';
import { ensureSignedIn, signOut } from './auth.js';
import { openChangePassword } from './views/account.js';
import { keepCheckingForUpdates } from './updates.js';
import {
  MENU_GROUPS, SECTION_AREAS, bindPops, buildTopNav, canOpen, getMenuMode, markTopNav, newMenuHtml,
  rememberRecent, searchButtonHtml, visibleGroups,
} from './menu.js';
import { icon, esc, avatar, setHeader, toast } from './ui.js';
import * as dashboardView from './views/dashboard.js';
import * as invoicesView from './views/invoices.js';
import * as invoiceDetailView from './views/invoice-detail.js';
import * as receiptView from './views/receipt.js';
import * as customerReceiptView from './views/customer-receipt.js';
import * as creditsView from './views/credits.js';
import * as creditDetailView from './views/credit-detail.js';
import * as bookingsView from './views/bookings.js';
import * as bookingDetailView from './views/booking-detail.js';
import * as visasView from './views/visas.js';
import * as visaDetailView from './views/visa-detail.js';
import * as cancellationsView from './views/cancellations.js';
import * as cancellationDetailView from './views/cancellation-detail.js';
import * as supplierCreditsView from './views/supplier-credits.js';
import * as supplierCreditDetailView from './views/supplier-credit-detail.js';
import * as portalsView from './views/portals.js';
import * as portalDetailView from './views/portal-detail.js';
import * as portalLedgerView from './views/portal-ledger.js';
import * as portalReconcileView from './views/portal-reconcile.js';
import * as billsView from './views/bills.js';
import * as billDetailView from './views/bill-detail.js';
import * as customersView from './views/customers.js';
import * as customerStatementView from './views/customer-statement.js';
import * as customerBalancesView from './views/customer-balances.js';
import * as customerBalanceDetailView from './views/customer-balance-detail.js';
import * as settlementQueueView from './views/settlement-queue.js';
import * as vendorsView from './views/vendors.js';
import * as vendorStatementView from './views/vendor-statement.js';
import * as journalView from './views/journal.js';
import * as openingBalancesView from './views/opening-balances.js';
import * as refundsView from './views/refunds.js';
import * as refundDetailView from './views/refund-detail.js';
import * as complianceView from './views/compliance.js';
import * as chequesView from './views/cheques.js';
import * as bankingView from './views/banking.js';
import * as pettyCashView from './views/petty-cash.js';
import * as cardSettlementsView from './views/card-settlements.js';
import * as bankReconciliationView from './views/bank-reconciliation.js';
import * as accountsView from './views/accounts.js';
import * as reportsView from './views/reports.js';
import * as auditLogsView from './views/audit-logs.js';
import * as auditChainView from './views/audit-chain.js';
import * as settingsView from './views/settings.js';

// Buttons that add or reverse records hide when the user lacks that right;
// the server refuses the request anyway. One stylesheet covers every screen,
// including buttons drawn later (empty states, lists, modals).
const NEW_ACTION_AREAS = {
  'new-account': 'books',
  'new-batch': 'banking',
  'new-bill': 'suppliers',
  'new-booking': 'bookings',
  'new-compliance': 'compliance',
  'new-deposit': 'banking',
  'new-entry': 'books',
  'new-entry-empty': 'books',
  'new-invoice': 'sales',
  'new-portal': 'portals',
  'new-reconciliation': 'banking',
  'new-refund': 'refunds',
  'new-visa': 'visas',
};
// These mean "new" for whatever screen they are on.
const SECTION_NEW_ACTIONS = ['new-party', 'new-credit'];
const VOID_SELECTORS = [
  '[data-action="void"]', '[data-action="void-credit"]', '[data-action="cancel"]', '[data-action="cancel-job"]',
  '[data-action="delete"]', '[data-delete-payment]', '[data-delete-recon]', '[data-delete]', '[data-void-advance]',
  '[data-void-cheque]', '[data-void-count]', '[data-void-kind]', '[data-void-portal]', '[data-void-settlement]', '[data-void]',
  '[data-deposit-action="void-last"]', '[data-action="reject"]', '[data-action="clear-opening"]',
];

function applyRightsStyles() {
  if (!store.user?.permissions) return;
  const hidden = Object.entries(NEW_ACTION_AREAS)
    .filter(([, area]) => !can(area, 'edit'))
    .map(([action]) => `[data-action="${action}"]`);
  for (const [section, areas] of Object.entries(SECTION_AREAS)) {
    if (!can(areas[0], 'edit')) hidden.push(...SECTION_NEW_ACTIONS.map((action) => `html[data-section="${section}"] [data-action="${action}"]`));
  }
  if (!can('void')) hidden.push(...VOID_SELECTORS.map((selector) => `.main ${selector}`));
  if (!can('audit')) hidden.push('.main a[href^="#/audit-chain"]', '.main [data-action="audit-chain"]');
  const style = document.createElement('style');
  style.id = 'rights-style';
  style.textContent = hidden.length ? `${hidden.join(',\n')} { display: none !important; }` : '';
  document.getElementById('rights-style')?.remove();
  document.head.appendChild(style);
}

function firstOpenSection() {
  for (const group of MENU_GROUPS) {
    const item = group.items.find((candidate) => canOpen(candidate.section));
    if (item) return item;
  }
  return null;
}

const NAV_GROUPS_KEY = 'ledgerly.nav.groups';

function readNavState() {
  try { return JSON.parse(localStorage.getItem(NAV_GROUPS_KEY) || '{}') || {}; } catch { return {}; }
}

function saveNavState(state) {
  try { localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(state)); } catch { /* per-browser convenience only */ }
}

const ROUTES = [
  { pattern: /^\/dashboard$/, view: dashboardView, section: 'dashboard' },
  { pattern: /^\/invoices$/, view: invoicesView, section: 'invoices' },
  { pattern: /^\/invoices\/(\d+)$/, view: invoiceDetailView, section: 'invoices' },
  { pattern: /^\/receipts\/(\d+)$/, view: receiptView, section: 'invoices' },
  { pattern: /^\/customer-receipts\/(\d+)$/, view: customerReceiptView, section: 'customer-balances' },
  { pattern: /^\/credits$/, view: creditsView, section: 'credits' },
  { pattern: /^\/credits\/(\d+)$/, view: creditDetailView, section: 'credits' },
  { pattern: /^\/bookings$/, view: bookingsView, section: 'bookings' },
  { pattern: /^\/bookings\/(\d+)$/, view: bookingDetailView, section: 'bookings' },
  { pattern: /^\/visas$/, view: visasView, section: 'visas' },
  { pattern: /^\/visas\/(\d+)$/, view: visaDetailView, section: 'visas' },
  { pattern: /^\/cancellations$/, view: cancellationsView, section: 'cancellations' },
  { pattern: /^\/cancellations\/(\d+)$/, view: cancellationDetailView, section: 'cancellations' },
  { pattern: /^\/supplier-credits$/, view: supplierCreditsView, section: 'supplier-credits' },
  { pattern: /^\/supplier-credits\/(\d+)$/, view: supplierCreditDetailView, section: 'supplier-credits' },
  { pattern: /^\/portals$/, view: portalsView, section: 'portals' },
  { pattern: /^\/portals\/(\d+)\/ledger$/, view: portalLedgerView, section: 'portals' },
  { pattern: /^\/portals\/(\d+)\/reconcile$/, view: portalReconcileView, section: 'portals' },
  { pattern: /^\/portals\/(\d+)$/, view: portalDetailView, section: 'portals' },
  { pattern: /^\/bills$/, view: billsView, section: 'bills' },
  { pattern: /^\/bills\/(\d+)$/, view: billDetailView, section: 'bills' },
  { pattern: /^\/customers$/, view: customersView, section: 'customers' },
  { pattern: /^\/customers\/(\d+)\/statement$/, view: customerStatementView, section: 'customers' },
  { pattern: /^\/customer-balances$/, view: customerBalancesView, section: 'customer-balances' },
  { pattern: /^\/customer-balances\/(\d+)$/, view: customerBalanceDetailView, section: 'customer-balances' },
  { pattern: /^\/settlement-queue$/, view: settlementQueueView, section: 'settlement-queue' },
  { pattern: /^\/vendors$/, view: vendorsView, section: 'vendors' },
  { pattern: /^\/vendors\/(\d+)\/statement$/, view: vendorStatementView, section: 'vendors' },
  { pattern: /^\/journal$/, view: journalView, section: 'journal' },
  { pattern: /^\/opening-balances$/, view: openingBalancesView, section: 'opening-balances' },
  { pattern: /^\/refunds$/, view: refundsView, section: 'refunds' },
  { pattern: /^\/refunds\/(\d+)$/, view: refundDetailView, section: 'refunds' },
  { pattern: /^\/compliance$/, view: complianceView, section: 'compliance' },
  { pattern: /^\/cheques$/, view: chequesView, section: 'cheques' },
  { pattern: /^\/banking$/, view: bankingView, section: 'banking' },
  { pattern: /^\/petty-cash$/, view: pettyCashView, section: 'petty-cash' },
  { pattern: /^\/card-settlements$/, view: cardSettlementsView, section: 'card-settlements' },
  { pattern: /^\/bank-reconciliation$/, view: bankReconciliationView, section: 'bank-reconciliation' },
  { pattern: /^\/accounts$/, view: accountsView, section: 'accounts' },
  { pattern: /^\/reports(?:\/([a-z-]+))?$/, view: reportsView, section: 'reports' },
  { pattern: /^\/audit-logs$/, view: auditLogsView, section: 'audit-logs' },
  { pattern: /^\/audit-chain\/([a-z_]+)\/(\d+)$/, view: auditChainView, section: 'audit-logs' },
  { pattern: /^\/settings$/, view: settingsView, section: 'settings' },
];

const sidebar = document.getElementById('sidebar');
const scrim = document.getElementById('sidebar-scrim');

// Account codes on booking and visa documents are hidden unless switched on;
// the choice is remembered per browser.
try { if (localStorage.getItem('ledgerly.showAccounting') === '1') document.documentElement.classList.add('show-accounting'); } catch { /* ignore */ }
document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-action="toggle-accounting"]')) return;
  const on = document.documentElement.classList.toggle('show-accounting');
  try { localStorage.setItem('ledgerly.showAccounting', on ? '1' : '0'); } catch { /* ignore */ }
});

// A "More" menu closes when you pick an item or click anywhere else.
document.addEventListener('click', (event) => {
  document.querySelectorAll('details.more-menu[open]').forEach((menu) => {
    const inside = menu.contains(event.target);
    if (!inside || event.target.closest('.more-menu-list .btn, .more-menu-list .icon-btn')) menu.removeAttribute('open');
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') document.querySelectorAll('details.more-menu[open]').forEach((menu) => menu.removeAttribute('open'));
});

document.getElementById('skip-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  document.getElementById('view')?.focus();
});

function navItemsHtml(group) {
  return group.items.map((item) => `
    <a class="nav-item" href="${item.href}" data-section="${item.section}" title="${esc(item.label)}">
      ${icon(item.icon, 17)}
      <span>${esc(item.label)}</span>
    </a>
  `).join('');
}

// The side menu: search and New at the top, then the groups. One-screen
// groups (Dashboard, Reports, Settings) show without a heading; the others
// fold, and the choice is remembered per browser.
function buildNav() {
  const nav = document.getElementById('main-nav');
  const state = readNavState();
  const tools = document.getElementById('side-tools');
  if (tools) {
    tools.innerHTML = `${searchButtonHtml('side-search')}${newMenuHtml()}`;
    bindPops(tools);
  }
  nav.innerHTML = visibleGroups().map((group) => {
    if (group.items.length === 1) return `<div class="nav-group nav-group-single" data-nav-group="${group.key}">${navItemsHtml(group)}</div>`;
    const collapsed = state[group.key] ?? Boolean(group.collapsed);
    return `
      <div class="nav-group ${collapsed ? 'collapsed' : ''}" data-nav-group="${group.key}">
        <button type="button" class="nav-group-label" aria-expanded="${!collapsed}" aria-controls="nav-${group.key}">
          <span>${esc(group.label)}</span>${icon('chevron', 12)}
        </button>
        <div class="nav-group-items" id="nav-${group.key}">${navItemsHtml(group)}</div>
      </div>`;
  }).join('');

  nav.addEventListener('click', (event) => {
    const toggle = event.target.closest('.nav-group-label');
    if (toggle) {
      const group = toggle.closest('[data-nav-group]');
      const collapsed = group.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      saveNavState({ ...readNavState(), [group.dataset.navGroup]: collapsed });
      return;
    }
    if (event.target.closest('.nav-item')) closeSidebar();
  });
}

// Top menu (Settings → Appearance → Menu). The bell moves into it on wide
// screens; phones keep the side drawer and the bell beside the page title.
function buildTopMenu() {
  const root = document.getElementById('top-nav');
  if (!root) return;
  buildTopNav(root, { onPassword: () => openChangePassword(), onSignOut: () => signOut() });
  placeTopbarTools();
}

function placeTopbarTools() {
  const tools = document.getElementById('topbar-tools');
  const slot = document.querySelector('#top-nav [data-tools-slot]');
  const topbar = document.querySelector('.main > .topbar');
  if (!tools) return;
  const useTop = getMenuMode() === 'top' && !mobileNav.matches && slot;
  if (useTop && tools.parentElement !== slot) slot.appendChild(tools);
  if (!useTop && topbar && tools.parentElement !== topbar) topbar.appendChild(tools);
}

window.addEventListener('menu-mode-changed', () => {
  placeTopbarTools();
  syncMenuState();
});

// On phones a bottom tab bar holds the everyday screens; "More" opens the
// full sidebar.
const TABBAR_ITEMS = [
  { section: 'dashboard', href: '#/dashboard', icon: 'dashboard', label: 'Home' },
  { section: 'bookings', href: '#/bookings', icon: 'plane', label: 'Bookings' },
  { section: 'visas', href: '#/visas', icon: 'visa', label: 'Visas' },
  { section: 'invoices', href: '#/invoices', icon: 'invoice', label: 'Invoices' },
];

function buildTabbar() {
  const bar = document.createElement('nav');
  bar.className = 'tabbar no-print';
  bar.setAttribute('aria-label', 'Quick navigation');
  bar.innerHTML = `${TABBAR_ITEMS.filter((item) => canOpen(item.section)).map((item) => `
    <a class="tab-item" href="${item.href}" data-section="${item.section}">${icon(item.icon, 20)}<span>${esc(item.label)}</span></a>
  `).join('')}
    <button type="button" class="tab-item" data-tab-more aria-controls="sidebar" aria-expanded="false" aria-label="Open menu">
      <span class="tab-icons" aria-hidden="true"><span class="tab-icon-open">${icon('more', 20)}</span><span class="tab-icon-close">${icon('x', 20)}</span></span>
      <span class="tab-label-open">More</span><span class="tab-label-close">Close</span>
    </button>`;
  // The tab bar sits above the open sidebar, so this same button closes it.
  bar.querySelector('[data-tab-more]').addEventListener('click', () => {
    if (sidebar.classList.contains('open')) closeSidebar();
    else openSidebar();
  });
  document.body.appendChild(bar);
}

// Phone lists: tables marked .cards-sm become cards; each cell is labelled
// from its column header so the figures still read clearly.
function labelCardTables(root = document) {
  root.querySelectorAll('table.cards-sm').forEach((table) => {
    const heads = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach((row) => {
      Array.from(row.children).forEach((cell, index) => {
        if (!cell.hasAttribute('data-label') && heads[index]) cell.setAttribute('data-label', heads[index]);
      });
    });
  });
}

function updateNav(section) {
  document.documentElement.dataset.section = section;
  markTopNav(section);
  document.querySelectorAll('.tab-item[data-section]').forEach((item) => {
    item.classList.toggle('active', item.dataset.section === section);
  });
  document.querySelectorAll('.nav-item').forEach((item) => {
    const active = item.dataset.section === section;
    item.classList.toggle('active', active);
    if (active) {
      item.setAttribute('aria-current', 'page');
      // Open a collapsed group when you land on one of its pages.
      const group = item.closest('.nav-group.collapsed');
      if (group) {
        group.classList.remove('collapsed');
        group.querySelector('.nav-group-label')?.setAttribute('aria-expanded', 'true');
      }
    } else item.removeAttribute('aria-current');
  });
}

function updateSidebarFooter() {
  const foot = document.getElementById('sidebar-foot');
  const name = store.settings?.company_name || 'My Company';
  const user = store.user;
  foot.innerHTML = `
    <div class="company-card">
      ${avatar(user?.full_name || name, 34)}
      <div class="company-meta">
        <strong>${esc(user?.full_name || name)}</strong>
        <span>${esc(user ? `${user.is_admin ? 'Admin' : 'Staff'} · ${name}` : 'Local ledger · v1.0')}</span>
      </div>
      <div class="company-actions">
        <button type="button" class="icon-btn" data-account="password" aria-label="Change your password" title="Change your password">${icon('lock', 16)}</button>
        <button type="button" class="icon-btn" data-account="signout" aria-label="Sign out" title="Sign out">${icon('logout', 16)}</button>
      </div>
    </div>
  `;
  foot.querySelector('[data-account="password"]').addEventListener('click', () => openChangePassword());
  foot.querySelector('[data-account="signout"]').addEventListener('click', () => signOut());
}

function openSidebar() {
  sidebar.classList.add('open');
  scrim.classList.add('visible');
  document.body.classList.add('nav-open');
  syncMenuState();
}

function closeSidebar() {
  sidebar.classList.remove('open');
  scrim.classList.remove('visible');
  document.body.classList.remove('nav-open');
  syncMenuState();
}

const menuBtn = document.getElementById('menu-btn');
// On phones the hamburger reappears at the top of the open sidebar and turns
// into ✕; it closes the sidebar.
document.getElementById('sidebar-close')?.addEventListener('click', () => closeSidebar());
const mobileNav = window.matchMedia('(max-width: 900px)');
const NAV_STATE_KEY = 'ledgerly.navCollapsed';

function desktopNavCollapsed() {
  return document.documentElement.classList.contains('nav-collapsed');
}

function syncMenuState() {
  const expanded = mobileNav.matches
    ? sidebar.classList.contains('open')
    : !desktopNavCollapsed();
  menuBtn.setAttribute('aria-expanded', String(expanded));
  const tabMore = document.querySelector('[data-tab-more]');
  if (tabMore) {
    const open = sidebar.classList.contains('open');
    tabMore.setAttribute('aria-expanded', String(open));
    tabMore.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  menuBtn.setAttribute('aria-label', expanded ? 'Hide navigation' : 'Show navigation');
  menuBtn.title = expanded ? 'Hide navigation' : 'Show navigation';
}

function toggleDesktopNav() {
  const collapsed = document.documentElement.classList.toggle('nav-collapsed');
  try {
    localStorage.setItem(NAV_STATE_KEY, collapsed ? '1' : '0');
  } catch (error) { /* storage unavailable */ }
  syncMenuState();
}

menuBtn.addEventListener('click', () => {
  if (mobileNav.matches) {
    if (sidebar.classList.contains('open')) closeSidebar();
    else openSidebar();
  } else {
    toggleDesktopNav();
  }
});
scrim.addEventListener('click', closeSidebar);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sidebar.classList.contains('open')) closeSidebar();
});

// Crossing the breakpoint should never leave the mobile overlay (or its
// scroll lock) behind.
mobileNav.addEventListener('change', () => {
  placeTopbarTools();
  if (!mobileNav.matches) {
    sidebar.classList.remove('open');
    scrim.classList.remove('visible');
    document.body.classList.remove('nav-open');
  }
  syncMenuState();
});

syncMenuState();
requestAnimationFrame(() => {
  requestAnimationFrame(() => document.documentElement.classList.add('nav-ready'));
});

let currentCleanup = null;
let renderToken = 0;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/dashboard';
  const [path, queryString = ''] = raw.split('?');
  return { path: path || '/dashboard', query: new URLSearchParams(queryString) };
}

async function renderRoute() {
  const token = ++renderToken;
  const { path, query } = parseHash();

  if (currentCleanup) {
    try { currentCleanup(); } catch { /* ignore */ }
    currentCleanup = null;
  }

  const route = ROUTES.find((candidate) => candidate.pattern.test(path));
  if (!route) {
    location.hash = firstOpenSection()?.href || '#/settings';
    return;
  }
  // The home screen without Dashboard rights: open the first allowed one.
  if (route.section === 'dashboard' && !canOpen('dashboard')) {
    location.hash = firstOpenSection()?.href || '#/settings';
    return;
  }

  const match = route.pattern.exec(path);
  const viewEl = document.getElementById('view');
  updateNav(route.section);
  closeSidebar();
  setHeader({ title: '', subtitle: '', actions: '' });
  viewEl.setAttribute('aria-busy', 'true');
  viewEl.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading…</span></div>';
  window.scrollTo(0, 0);

  if (!canOpen(route.section)) {
    setHeader({ title: 'No access', subtitle: '', actions: '' });
    viewEl.setAttribute('aria-busy', 'false');
    viewEl.innerHTML = `
      <div class="card">
        <div class="error-state">
          <h3>${icon('lock', 18)} You do not have access to this screen</h3>
          <p>Ask the admin to give you View rights for it in Settings → Users &amp; logins.</p>
        </div>
      </div>`;
    return;
  }

  try {
    const cleanup = await route.view.render(viewEl, { query, params: match.slice(1), path });
    if (token !== renderToken) return;
    viewEl.setAttribute('aria-busy', 'false');
    // Gentle fade as the new page appears.
    viewEl.classList.remove('t-page-enter');
    void viewEl.offsetWidth;
    viewEl.classList.add('t-page-enter');
    viewEl.focus({ preventScroll: true });
    if (typeof cleanup === 'function') currentCleanup = cleanup;
    rememberRecent({ hash: location.hash, title: document.getElementById('page-title')?.textContent.trim(), section: route.section });
  } catch (error) {
    if (token !== renderToken) return;
    viewEl.setAttribute('aria-busy', 'false');
    viewEl.innerHTML = `
      <div class="card">
        <div class="error-state">
          <h3>Could not load this page</h3>
          <p>${esc(error.message || 'Unknown error')}</p>
          <button class="btn btn-secondary" id="reload-page" style="margin-top:16px">Try again</button>
        </div>
      </div>`;
    const reload = document.getElementById('reload-page');
    if (reload) reload.addEventListener('click', renderRoute);
    if (!error.status || error.status >= 500) toast(error.message || 'Could not load this page', 'error');
  }
}

async function boot() {
  new MutationObserver(() => labelCardTables(document.getElementById('view')))
    .observe(document.getElementById('view'), { childList: true, subtree: true });
  try {
    store.user = await ensureSignedIn();
    document.documentElement.classList.toggle('is-admin', store.user.is_admin);
    // The menu shows only the screens this user may open.
    if (!document.querySelector('#main-nav .nav-group')) {
      buildNav();
      buildTabbar();
    }
    applyRightsStyles();
    await refreshMeta();
  } catch (error) {
    document.getElementById('view').innerHTML = `
      <div class="card">
        <div class="error-state">
          <h3>Could not connect to your ledger</h3>
          <p>${esc(error.message)}</p>
          <button class="btn btn-primary" id="retry-boot" style="margin-top:16px">Retry</button>
        </div>
      </div>`;
    const retry = document.getElementById('retry-boot');
    if (retry) retry.addEventListener('click', boot);
    return;
  }
  updateSidebarFooter();
  buildTopMenu();
  renderRoute();
  if (store.user.is_admin) keepCheckingForUpdates();
}

window.addEventListener('hashchange', renderRoute);
window.addEventListener('meta-changed', () => {
  updateSidebarFooter();
});

initTheme();
boot();
