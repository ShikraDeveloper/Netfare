import { api } from './api.js';

export const store = {
  settings: null,
  accounts: [],
  customers: [],
  vendors: [],
  portals: [],
  loaded: false,
};

export async function refreshMeta() {
  const [settings, accounts, customers, vendors, portals] = await Promise.all([
    api.get('/settings'),
    api.get('/accounts'),
    api.get('/customers'),
    api.get('/vendors'),
    api.get('/portals'),
  ]);
  store.settings = settings;
  store.accounts = accounts;
  store.customers = customers;
  store.vendors = vendors;
  store.portals = portals;
  store.loaded = true;
  return store;
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

export function accountById(id) {
  return store.accounts.find((account) => account.id === Number(id)) || null;
}

export function activeCustomers() {
  return store.customers.filter((customer) => customer.is_active);
}

export function activeVendors() {
  return store.vendors.filter((vendor) => vendor.is_active);
}

export function activePortals() {
  return store.portals.filter((portal) => portal.is_active);
}

export function portalForVendorId(vendorId) {
  return store.portals.find((portal) => portal.vendor_id === Number(vendorId) && portal.is_active) || null;
}

export function currency() {
  return 'AED';
}
