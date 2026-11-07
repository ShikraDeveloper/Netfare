import { api } from './api.js';

export const store = {
  user: null,
  version: '',
  settings: null,
  accounts: [],
  customers: [],
  vendors: [],
  portals: [],
  loaded: false,
};

export async function refreshMeta() {
  const [health, settings, accounts, customers, vendors, portals] = await Promise.all([
    api.get('/health'),
    api.get('/settings'),
    api.get('/accounts'),
    api.get('/customers'),
    api.get('/vendors'),
    api.get('/portals'),
  ]);
  store.version = health.version;
  store.settings = settings;
  store.accounts = accounts;
  store.customers = customers;
  store.vendors = vendors;
  store.portals = portals;
  store.loaded = true;
  return store;
}

// The admin may do everything; staff have the rights the admin ticked:
// {"bookings":"edit","visas":"view","void":true}.
export function can(area, level = 'view') {
  const permissions = store.user?.permissions;
  if (!store.user) return false;
  if (!permissions) return true;
  if (area === 'void') return Boolean(permissions.void);
  return level === 'edit' ? permissions[area] === 'edit' : Boolean(permissions[area]);
}

export function accountsOfType(...types) {
  return store.accounts.filter((account) => account.is_active && types.includes(account.type));
}

export function assetAccounts() {
  return accountsOfType('asset');
}

export function cashAccounts() {
  return assetAccounts().filter((account) => account.is_cash);
}

export function revenueAccounts() {
  return accountsOfType('revenue');
}

export function expenseAccounts() {
  return accountsOfType('expense', 'asset').filter((account) => !account.is_cash);
}

export function purchaseAccounts() {
  return store.accounts.filter((account) => account.is_active && (
    account.type === 'expense'
    || (account.type === 'asset' && !account.is_system && !account.is_cash)
  ));
}

export function activeCustomers() {
  return store.customers.filter((customer) => customer.is_active);
}

export function activeVendors() {
  return store.vendors.filter((vendor) => vendor.is_active);
}

export function portalForVendorId(vendorId) {
  return store.portals.find((portal) => portal.vendor_id === Number(vendorId) && portal.is_active) || null;
}

export function currency() {
  return 'AED';
}
