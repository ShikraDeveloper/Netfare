'use strict';

// What each staff user may do. The admin ticks View or Edit for each area,
// plus a separate right to cancel bookings and reject visas. Voiding,
// correcting and deleting are for the admin only. Every API request is
// matched to an area here; the admin is never limited.

const AREAS = [
  { key: 'dashboard', label: 'Dashboard', edit: false },
  { key: 'bookings', label: 'Bookings', prefixes: ['/bookings'] },
  { key: 'visas', label: 'Visas & security deposits', prefixes: ['/visas', '/visa-deposits'] },
  { key: 'customers', label: 'Customers & balances', prefixes: ['/customers', '/customer-balances'] },
  { key: 'sales', label: 'Invoices, payments & advances', prefixes: ['/invoices', '/advances', '/settlement-queue'] },
  { key: 'refunds', label: 'Cancellations, refunds & credit notes', prefixes: ['/cancellations', '/refunds', '/credits'] },
  { key: 'suppliers', label: 'Suppliers, bills & supplier credits', prefixes: ['/vendors', '/bills', '/supplier-credits'] },
  { key: 'portals', label: 'Supplier portals', prefixes: ['/portals'] },
  { key: 'banking', label: 'Cash, bank, cheques & card settlements', prefixes: ['/cash', '/cheques', '/petty-cash', '/card-settlements', '/bank-reconciliations'] },
  { key: 'books', label: 'Journal, chart of accounts & opening balances', prefixes: ['/journal-entries', '/accounts', '/opening-balances'] },
  { key: 'compliance', label: 'Compliance', prefixes: ['/compliance'] },
  { key: 'reports', label: 'Reports', edit: false, prefixes: ['/reports'] },
  { key: 'audit', label: 'Audit log', edit: false, prefixes: ['/audit-logs', '/audit-chain'] },
  { key: 'settings', label: 'Company settings', prefixes: ['/settings'] },
];
const AREA_KEYS = new Set(AREAS.map((area) => area.key));

// Screens show related records from other areas: a booking shows its
// invoice and the portals, a bill shows its journal entry. These areas may
// also read (or, for advances, write) under a prefix.
const READ_ALSO = {
  '/invoices': ['bookings', 'visas', 'refunds', 'customers'],
  '/portals': ['bookings', 'visas', 'suppliers', 'banking'],
  '/bookings': ['suppliers', 'refunds'],
  '/visas': ['suppliers', 'refunds'],
  '/cancellations': ['bookings', 'visas'],
  '/compliance': ['banking'],
  '/customer-balances': ['sales'],
  '/settlement-queue': ['refunds'],
  '/journal-entries': ['sales', 'suppliers', 'bookings', 'visas', 'banking', 'refunds'],
};
// For these, the other areas may open one record (a document's journal
// entry), not the whole list.
const READ_ALSO_ONE_RECORD = new Set(['/journal-entries']);
const WRITE_ALSO = {
  '/advances': ['bookings', 'visas'],
};

// Lists every screen loads for its pickers; reading them needs no right.
const SHARED_READS = new Set(['/settings', '/accounts', '/customers', '/vendors', '/portals']);
const DASHBOARD_READS = new Set(['/reports/dashboard', '/reports/reconciliation']);

const ATTACHMENT_AREAS = {
  invoice: 'sales',
  bill: 'suppliers',
  booking: 'bookings',
  visa: 'visas',
  cancellation: 'refunds',
  refund: 'refunds',
  credit_note: 'refunds',
  supplier_credit: 'suppliers',
  customer: 'customers',
};

function areaForPrefix(prefix) {
  return AREAS.find((area) => area.prefixes?.includes(prefix))?.key || null;
}

// Stored as {"bookings":"edit","visas":"view","cancel":true}; anything
// unknown or above what an area allows is dropped. The old "void" right
// (void, cancel and delete) becomes "cancel": voiding is now admin-only.
function cleanPermissions(input = {}) {
  const clean = {};
  for (const area of AREAS) {
    const level = input?.[area.key];
    if (level === 'view' || (level === 'edit' && area.edit !== false)) clean[area.key] = level;
  }
  if (input?.cancel === true || input?.void === true) clean.cancel = true;
  return clean;
}

function parsePermissions(text) {
  try {
    return cleanPermissions(JSON.parse(text || '{}'));
  } catch {
    return {};
  }
}

function canView(permissions, area) {
  return permissions[area] === 'view' || permissions[area] === 'edit';
}

function canEdit(permissions, area) {
  return permissions[area] === 'edit';
}

// Requests that reverse, correct or remove a posted record: admin only.
// Express matches routes without regard to case, so this does too: /VOID
// must not pass as an edit. void-last undoes a deposit step.
const ADMIN_ENDINGS = /\/(void|void-last|correct)$/i;
// Cancelling a booking or visa, and a visa rejection: everyday work, for
// staff with the Cancel right.
const CANCEL_ENDINGS = /\/(cancel|reject)$/i;

// Saving opening balances with no amounts reverses the posted entry, the
// same as Clear, so it is admin only too.
function clearsOpeningBalances(req, path) {
  if (req.method !== 'POST' || !/^\/opening-balances$/i.test(path)) return false;
  const rows = Array.isArray(req.body?.balances) ? req.body.balances : [];
  return !rows.some((row) => Number(row?.debit_cents) > 0 || Number(row?.credit_cents) > 0);
}

function isAdminOnly(req, path) {
  return req.method === 'DELETE' || ADMIN_ENDINGS.test(path) || clearsOpeningBalances(req, path);
}

// Why a request is refused, or null when the user may make it.
function refusal(db, user, req) {
  if (user.is_admin) return null;
  const permissions = parsePermissions(user.permissions);
  const path = req.path.replace(/\/+$/, '') || '/';
  const prefix = `/${path.split('/')[1] || ''}`;
  // Everyone keeps their own reminders; the service limits each user to
  // theirs and the ones for everyone.
  if (prefix === '/reminders') return null;
  const reading = req.method === 'GET' || req.method === 'HEAD';

  if (reading && SHARED_READS.has(path)) return null;

  let areas;
  if (prefix === '/attachments') {
    // A file's area comes from its stored row. The id must be plain digits:
    // req.path is not decoded but the route's :id is, so %35 would skip the
    // lookup here and still open file 5.
    let entityType = req.query.entity_type;
    const idPart = path.split('/')[2];
    if (idPart !== undefined && !/^\d+$/.test(idPart)) return 'You do not have access to this file';
    const id = Number(idPart);
    if (id) entityType = db.prepare('SELECT entity_type FROM attachments WHERE id = ?').get(id)?.entity_type;
    const area = ATTACHMENT_AREAS[entityType];
    if (!area) return 'You do not have access to this file';
    // A customer's documents (passport, Emirates ID) need Edit, not just View.
    if (area === 'customers' && !canEdit(permissions, 'customers')) {
      return 'You need Edit rights for Customers to open customer documents. Ask the admin.';
    }
    areas = [area];
  } else if (reading && DASHBOARD_READS.has(path)) {
    areas = ['dashboard', 'reports'];
  } else {
    const area = areaForPrefix(prefix);
    if (!area) return 'Only the admin can do this';
    const oneRecord = /^\/[^/]+\/\d+$/.test(path);
    const also = reading
      ? (!READ_ALSO_ONE_RECORD.has(prefix) || oneRecord ? READ_ALSO[prefix] : null)
      : WRITE_ALSO[prefix];
    areas = [area, ...(also || [])];
  }
  const label = AREAS.find((area) => area.key === areas[0]).label;

  if (reading) {
    return areas.some((area) => canView(permissions, area)) ? null : `You do not have View rights for ${label}. Ask the admin.`;
  }
  if (!areas.some((area) => canEdit(permissions, area))) return `You do not have Edit rights for ${label}. Ask the admin.`;
  // A file on a record may be removed by anyone who may edit that record.
  if (prefix !== '/attachments' && isAdminOnly(req, path)) {
    return 'Only the admin can void, correct or delete. Ask the admin.';
  }
  if (CANCEL_ENDINGS.test(path) && !permissions.cancel) {
    return 'You do not have the right to cancel or reject. Ask the admin.';
  }
  return null;
}

// True when the user may see an area at all (the admin always may).
function canViewArea(user, area) {
  return Boolean(user?.is_admin) || canView(parsePermissions(user?.permissions), area);
}

module.exports = {
  AREAS,
  AREA_KEYS,
  canViewArea,
  cleanPermissions,
  parsePermissions,
  refusal,
};
