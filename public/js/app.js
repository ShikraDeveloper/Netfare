import { refreshMeta, store } from './store.js';
import { initTheme } from './theme.js';
import { icon, esc, avatar, setHeader, toast } from './ui.js';
import * as dashboardView from './views/dashboard.js';
import * as invoicesView from './views/invoices.js';
import * as invoiceDetailView from './views/invoice-detail.js';
import * as bookingsView from './views/bookings.js';
import * as bookingDetailView from './views/booking-detail.js';
import * as visasView from './views/visas.js';
import * as visaDetailView from './views/visa-detail.js';
import * as portalsView from './views/portals.js';
import * as portalDetailView from './views/portal-detail.js';
import * as portalLedgerView from './views/portal-ledger.js';
import * as portalReconcileView from './views/portal-reconcile.js';
import * as billsView from './views/bills.js';
import * as billDetailView from './views/bill-detail.js';
import * as customersView from './views/customers.js';
import * as vendorsView from './views/vendors.js';
import * as journalView from './views/journal.js';
import * as refundsView from './views/refunds.js';
import * as refundDetailView from './views/refund-detail.js';
import * as complianceView from './views/compliance.js';
import * as chequesView from './views/cheques.js';
import * as bankingView from './views/banking.js';
import * as accountsView from './views/accounts.js';
import * as reportsView from './views/reports.js';
import * as settingsView from './views/settings.js';

const NAV_GROUPS = [
  {
    label: 'Overview',
    items: [
      { section: 'dashboard', href: '#/dashboard', icon: 'dashboard', label: 'Dashboard' },
    ],
  },
  {
    label: 'Travel',
    items: [
      { section: 'bookings', href: '#/bookings', icon: 'plane', label: 'Bookings' },
      { section: 'visas', href: '#/visas', icon: 'visa', label: 'Visas' },
      { section: 'portals', href: '#/portals', icon: 'wallet', label: 'Portals & wallets' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { section: 'invoices', href: '#/invoices', icon: 'invoice', label: 'Invoices' },
      { section: 'customers', href: '#/customers', icon: 'customers', label: 'Customers' },
    ],
  },
  {
    label: 'Purchases',
    items: [
      { section: 'bills', href: '#/bills', icon: 'bill', label: 'Bills & expenses' },
      { section: 'vendors', href: '#/vendors', icon: 'vendors', label: 'Vendors' },
    ],
  },
  {
    label: 'Accounting',
    items: [
      { section: 'journal', href: '#/journal', icon: 'journal', label: 'Journal' },
      { section: 'refunds', href: '#/refunds', icon: 'arrowUp', label: 'Refunds' },
      { section: 'compliance', href: '#/compliance', icon: 'check', label: 'Compliance' },
      { section: 'cheques', href: '#/cheques', icon: 'cheque', label: 'Cheques' },
      { section: 'banking', href: '#/banking', icon: 'cash', label: 'Banking' },
      { section: 'accounts', href: '#/accounts', icon: 'accounts', label: 'Chart of accounts' },
      { section: 'reports', href: '#/reports', icon: 'reports', label: 'Reports' },
    ],
  },
  {
    label: 'System',
    items: [
      { section: 'settings', href: '#/settings', icon: 'settings', label: 'Settings' },
    ],
  },
];

const ROUTES = [
  { pattern: /^\/dashboard$/, view: dashboardView, section: 'dashboard' },
  { pattern: /^\/invoices$/, view: invoicesView, section: 'invoices' },
  { pattern: /^\/invoices\/(\d+)$/, view: invoiceDetailView, section: 'invoices' },
  { pattern: /^\/bookings$/, view: bookingsView, section: 'bookings' },
  { pattern: /^\/bookings\/(\d+)$/, view: bookingDetailView, section: 'bookings' },
  { pattern: /^\/visas$/, view: visasView, section: 'visas' },
  { pattern: /^\/visas\/(\d+)$/, view: visaDetailView, section: 'visas' },
  { pattern: /^\/portals$/, view: portalsView, section: 'portals' },
  { pattern: /^\/portals\/(\d+)\/ledger$/, view: portalLedgerView, section: 'portals' },
  { pattern: /^\/portals\/(\d+)\/reconcile$/, view: portalReconcileView, section: 'portals' },
  { pattern: /^\/portals\/(\d+)$/, view: portalDetailView, section: 'portals' },
  { pattern: /^\/bills$/, view: billsView, section: 'bills' },
  { pattern: /^\/bills\/(\d+)$/, view: billDetailView, section: 'bills' },
  { pattern: /^\/customers$/, view: customersView, section: 'customers' },
  { pattern: /^\/vendors$/, view: vendorsView, section: 'vendors' },
  { pattern: /^\/journal$/, view: journalView, section: 'journal' },
  { pattern: /^\/refunds$/, view: refundsView, section: 'refunds' },
  { pattern: /^\/refunds\/(\d+)$/, view: refundDetailView, section: 'refunds' },
  { pattern: /^\/compliance$/, view: complianceView, section: 'compliance' },
  { pattern: /^\/cheques$/, view: chequesView, section: 'cheques' },
  { pattern: /^\/banking$/, view: bankingView, section: 'banking' },
  { pattern: /^\/accounts$/, view: accountsView, section: 'accounts' },
  { pattern: /^\/reports(?:\/([a-z-]+))?$/, view: reportsView, section: 'reports' },
  { pattern: /^\/settings$/, view: settingsView, section: 'settings' },
];

const sidebar = document.getElementById('sidebar');
const scrim = document.getElementById('sidebar-scrim');

function buildNav() {
  const nav = document.getElementById('main-nav');
  nav.innerHTML = NAV_GROUPS.map((group) => `
    <div class="nav-group-label">${esc(group.label)}</div>
    ${group.items.map((item) => `
      <a class="nav-item" href="${item.href}" data-section="${item.section}">
        ${icon(item.icon, 17)}
        <span>${esc(item.label)}</span>
      </a>
    `).join('')}
  `).join('');

  nav.addEventListener('click', (event) => {
    if (event.target.closest('.nav-item')) closeSidebar();
  });
}

function updateNav(section) {
  document.querySelectorAll('.nav-item').forEach((item) => {
    const active = item.dataset.section === section;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}

function updateSidebarFooter() {
  const foot = document.getElementById('sidebar-foot');
  const name = store.settings?.company_name || 'My Company';
  foot.innerHTML = `
    <div class="company-card">
      ${avatar(name, 34)}
      <div class="company-meta">
        <strong>${esc(name)}</strong>
        <span>Local ledger · v1.0</span>
      </div>
    </div>
  `;
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
    location.hash = '#/dashboard';
    return;
  }

  const match = route.pattern.exec(path);
  const viewEl = document.getElementById('view');
  updateNav(route.section);
  closeSidebar();
  setHeader({ title: '', subtitle: '', actions: '' });
  viewEl.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading…</span></div>';

  try {
    const cleanup = await route.view.render(viewEl, { query, params: match.slice(1), path });
    if (token !== renderToken) return;
    if (typeof cleanup === 'function') currentCleanup = cleanup;
  } catch (error) {
    if (token !== renderToken) return;
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
  buildNav();
  try {
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
  renderRoute();
}

window.addEventListener('hashchange', renderRoute);
window.addEventListener('meta-changed', () => {
  updateSidebarFooter();
});

initTheme();
boot();
