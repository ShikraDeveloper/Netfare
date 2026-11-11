'use strict';

const { bad, notFound } = require('../util');

// The audit chain follows every document linked to a booking, visa or any
// settlement document, then gathers the journal entries, reversals and void
// remarks behind them. It only reads; nothing here posts to the ledger.

const MAX_DOCUMENTS = 400;

const TYPES = {
  booking: { table: 'bookings', label: 'Booking', stage: 1 },
  visa: { table: 'visa_applications', label: 'Visa application', stage: 1 },
  invoice: { table: 'invoices', label: 'Invoice', stage: 2 },
  advance: { table: 'customer_advances', label: 'Customer advance', stage: 3 },
  payment: { table: 'payments', label: 'Customer payment', stage: 3 },
  credit: { table: 'credit_notes', label: 'Credit note', stage: 4 },
  credit_application: { table: 'credit_applications', label: 'Credit application', stage: 4 },
  cancellation: { table: 'cancellations', label: 'Cancellation', stage: 5 },
  refund: { table: 'refunds', label: 'Refund', stage: 6 },
  bill: { table: 'bills', label: 'Supplier bill', stage: 7 },
  bill_payment: { table: 'bill_payments', label: 'Bill payment', stage: 8 },
  supplier_credit: { table: 'supplier_credit_notes', label: 'Supplier credit', stage: 9 },
  supplier_credit_application: { table: 'supplier_credit_applications', label: 'Supplier credit application', stage: 9 },
  portal_credit: { table: 'portal_credits', label: 'Portal wallet credit', stage: 10 },
};

// Journal source types that point at a document row by source_id.
const SOURCE_OWNERS = {
  invoice: 'invoice',
  payment: 'payment',
  advance_apply: 'payment',
  bill: 'bill',
  bill_payment: 'bill_payment',
  portal_settle: 'bill_payment',
  advance: 'advance',
  receipt: 'advance',
  customer_refund: 'refund',
  supplier_refund: 'refund',
  cancellation_refund: 'refund',
  customer_credit_refund: 'refund',
  refund: 'refund',
  credit_note: 'credit',
  credit_applied: 'credit_application',
  supplier_credit: 'supplier_credit',
  supplier_credit_applied: 'supplier_credit_application',
  portal_credit: 'portal_credit',
  cancellation_received: 'cancellation',
  cancellation_charge: 'cancellation',
};

// Audit log entity types mapped to chain document types.
const AUDIT_TYPES = {
  booking: 'booking',
  visa: 'visa',
  invoice: 'invoice',
  payment: 'payment',
  customer_advance: 'advance',
  credit_note: 'credit',
  credit_application: 'credit_application',
  cancellation: 'cancellation',
  refund: 'refund',
  bill: 'bill',
  bill_payment: 'bill_payment',
  supplier_credit: 'supplier_credit',
  supplier_credit_application: 'supplier_credit_application',
  portal_credit: 'portal_credit',
};

const ACTION_LABELS = { void: 'Voided', cancel: 'Cancelled', delete: 'Deleted' };

const keyOf = (type, id) => `${type}-${id}`;

function rowFor(db, type, id) {
  return db.prepare(`SELECT * FROM ${TYPES[type].table} WHERE id = ?`).get(Number(id));
}

function ids(db, sql, ...params) {
  return db.prepare(sql).all(...params).map((row) => row.id);
}

// Credit notes, supplier credits and advances can be shared by several jobs.
// They only fan out to their other invoices or bills when they are the
// document the chain was opened from; otherwise the chain stays on one job.
function neighbours(db, type, row, isRoot) {
  const out = [];
  const add = (nextType, nextId, expand = true) => {
    if (nextId) out.push({ type: nextType, id: Number(nextId), expand });
  };
  const addAll = (nextType, list, expand = true) => list.forEach((id) => add(nextType, id, expand));
  const jobColumn = type === 'booking' ? 'booking_id' : 'visa_id';

  switch (type) {
    case 'booking':
    case 'visa':
      addAll('invoice', ids(db, `SELECT id FROM invoices WHERE ${jobColumn} = ?`, row.id));
      addAll('bill', ids(db, `SELECT id FROM bills WHERE ${jobColumn} = ?`, row.id));
      addAll('advance', ids(db, `SELECT id FROM customer_advances WHERE ${jobColumn} = ?`, row.id));
      addAll('cancellation', ids(db, 'SELECT id FROM cancellations WHERE source_type = ? AND source_id = ?', type, row.id));
      addAll('supplier_credit', ids(db, `SELECT id FROM supplier_credit_notes WHERE ${jobColumn} = ?`, row.id));
      break;
    case 'invoice':
      add('booking', row.booking_id);
      add('visa', row.visa_id);
      add('cancellation', row.cancellation_id);
      addAll('payment', ids(db, 'SELECT id FROM payments WHERE invoice_id = ?', row.id));
      addAll('credit_application', ids(db, 'SELECT id FROM credit_applications WHERE invoice_id = ?', row.id));
      addAll('refund', ids(db, 'SELECT id FROM refunds WHERE invoice_id = ?', row.id));
      addAll('cancellation', ids(db, 'SELECT id FROM cancellations WHERE invoice_id = ? OR cancellation_invoice_id = ?', row.id, row.id));
      break;
    case 'payment':
      add('invoice', row.invoice_id);
      add('advance', row.advance_id, false);
      addAll('refund', ids(db, 'SELECT id FROM refunds WHERE payment_id = ?', row.id));
      break;
    case 'advance': {
      add('booking', row.booking_id);
      add('visa', row.visa_id);
      addAll('refund', ids(db, 'SELECT id FROM refunds WHERE advance_id = ?', row.id));
      const fanOut = isRoot || (!row.booking_id && !row.visa_id);
      addAll('payment', ids(db, 'SELECT id FROM payments WHERE advance_id = ?', row.id), fanOut);
      break;
    }
    case 'cancellation':
      add(row.source_type === 'visa' ? 'visa' : 'booking', row.source_id);
      add('invoice', row.invoice_id);
      add('invoice', row.cancellation_invoice_id);
      addAll('refund', ids(db, 'SELECT id FROM refunds WHERE cancellation_id = ?', row.id));
      addAll('credit', ids(db, 'SELECT id FROM credit_notes WHERE cancellation_id = ?', row.id));
      addAll('supplier_credit', ids(db, 'SELECT id FROM supplier_credit_notes WHERE cancellation_id = ?', row.id));
      break;
    case 'refund':
      add('invoice', row.invoice_id);
      add('payment', row.payment_id);
      add('bill', row.bill_id);
      add('bill_payment', row.bill_payment_id);
      add('cancellation', row.cancellation_id);
      add('supplier_credit', row.supplier_credit_note_id);
      add('advance', row.advance_id);
      add('credit', row.credit_note_id);
      break;
    case 'credit':
      add('cancellation', row.cancellation_id);
      addAll('refund', ids(db, 'SELECT id FROM refunds WHERE credit_note_id = ?', row.id));
      addAll('credit_application', ids(db, 'SELECT id FROM credit_applications WHERE credit_note_id = ?', row.id), isRoot);
      break;
    case 'credit_application':
      add('credit', row.credit_note_id, false);
      add('invoice', row.invoice_id);
      break;
    case 'bill':
      add('booking', row.booking_id);
      add('visa', row.visa_id);
      addAll('bill_payment', ids(db, 'SELECT id FROM bill_payments WHERE bill_id = ?', row.id));
      addAll('supplier_credit', ids(db, 'SELECT id FROM supplier_credit_notes WHERE bill_id = ?', row.id));
      addAll('supplier_credit_application', ids(db, 'SELECT id FROM supplier_credit_applications WHERE bill_id = ?', row.id));
      addAll('refund', ids(db, 'SELECT id FROM refunds WHERE bill_id = ?', row.id));
      addAll('portal_credit', ids(db, 'SELECT id FROM portal_credits WHERE bill_id = ?', row.id));
      break;
    case 'bill_payment':
      add('bill', row.bill_id);
      addAll('refund', ids(db, 'SELECT id FROM refunds WHERE bill_payment_id = ?', row.id));
      break;
    case 'supplier_credit':
      add('bill', row.bill_id);
      add('booking', row.booking_id);
      add('visa', row.visa_id);
      add('cancellation', row.cancellation_id);
      addAll('refund', ids(db, 'SELECT id FROM refunds WHERE supplier_credit_note_id = ?', row.id));
      addAll('portal_credit', ids(db, 'SELECT id FROM portal_credits WHERE supplier_credit_note_id = ?', row.id));
      addAll('supplier_credit_application', ids(db, 'SELECT id FROM supplier_credit_applications WHERE credit_note_id = ?', row.id), isRoot);
      break;
    case 'supplier_credit_application':
      add('supplier_credit', row.credit_note_id, false);
      add('bill', row.bill_id);
      break;
    case 'portal_credit':
      add('bill', row.bill_id);
      add('supplier_credit', row.supplier_credit_note_id, false);
      break;
    default:
      break;
  }
  return out;
}

function lookupMaps(db) {
  const map = (sql) => new Map(db.prepare(sql).all().map((row) => [row.id, row]));
  return {
    customers: map('SELECT id, name FROM customers'),
    vendors: map('SELECT id, name FROM vendors'),
    portals: map('SELECT id, name FROM supplier_portals'),
    invoices: map('SELECT id, number FROM invoices'),
    bills: map('SELECT id, number FROM bills'),
    creditNotes: map('SELECT id, number FROM credit_notes'),
    supplierCredits: map('SELECT id, number FROM supplier_credit_notes'),
  };
}

function describe(type, row, maps) {
  const customer = (id) => maps.customers.get(id)?.name || '';
  const vendor = (id) => maps.vendors.get(id)?.name || '';
  const base = { number: row.number || '', date: '', status: row.status || '', amount_cents: 0, party: '', href: '', detail: '' };
  switch (type) {
    case 'booking':
      return { ...base, date: row.booking_date, amount_cents: row.sale_total_cents, party: customer(row.customer_id), href: `#/bookings/${row.id}`, detail: row.destination || '' };
    case 'visa':
      return { ...base, date: row.application_date, amount_cents: row.sale_total_cents, party: customer(row.customer_id), href: `#/visas/${row.id}`, detail: [row.applicant_name, row.destination_country].filter(Boolean).join(' · ') };
    case 'invoice':
      return { ...base, date: row.issue_date, amount_cents: row.total_cents, party: customer(row.customer_id), href: `#/invoices/${row.id}`, detail: row.cancellation_id ? 'Cancellation charges' : '' };
    case 'payment':
      return { ...base, date: row.payment_date, amount_cents: row.amount_cents, party: customer(row.customer_id), href: `#/invoices/${row.invoice_id}`, detail: [row.method, maps.invoices.get(row.invoice_id)?.number].filter(Boolean).join(' · ') };
    case 'advance':
      return { ...base, date: row.advance_date, status: require('../workflows').isVoid(row) ? 'void' : row.status, amount_cents: row.amount_cents, party: customer(row.customer_id), href: row.booking_id ? `#/bookings/${row.booking_id}` : row.visa_id ? `#/visas/${row.visa_id}` : `#/customer-balances/${row.customer_id}`, detail: row.method || '' };
    case 'credit':
      return { ...base, date: row.credit_date, amount_cents: row.amount_cents, party: customer(row.customer_id), href: `#/credits/${row.id}`, detail: row.cancellation_id ? 'From cancellation' : 'Standalone credit' };
    case 'credit_application':
      return { ...base, number: maps.creditNotes.get(row.credit_note_id)?.number || '', date: row.applied_date, status: 'applied', amount_cents: row.amount_cents, href: `#/credits/${row.credit_note_id}`, detail: `Applied to ${maps.invoices.get(row.invoice_id)?.number || 'invoice'}` };
    case 'cancellation':
      return { ...base, date: row.cancellation_date, status: 'cancelled', amount_cents: row.customer_charges_cents, party: customer(row.customer_id), href: `#/cancellations/${row.id}`, detail: `Charges · refund due ${(row.refund_due_cents / 100).toFixed(2)}` };
    case 'refund':
      return { ...base, date: row.refund_date, amount_cents: row.amount_cents, party: row.refund_type === 'customer' ? customer(row.party_id) : vendor(row.party_id), href: `#/refunds/${row.id}`, detail: `${row.refund_type === 'customer' ? 'Paid to customer' : 'Received from supplier'} · ${row.method || ''}`.trim() };
    case 'bill':
      return { ...base, date: row.bill_date, amount_cents: row.total_cents, party: vendor(row.vendor_id), href: `#/bills/${row.id}` };
    case 'bill_payment':
      return { ...base, date: row.payment_date, amount_cents: row.amount_cents, party: vendor(row.vendor_id), href: `#/bills/${row.bill_id}`, detail: [row.portal_id ? 'Portal wallet' : row.method, maps.bills.get(row.bill_id)?.number].filter(Boolean).join(' · ') };
    case 'supplier_credit':
      return { ...base, date: row.credit_date, amount_cents: row.amount_cents, party: vendor(row.vendor_id), href: `#/supplier-credits/${row.id}`, detail: row.cancellation_id ? 'From cancellation' : '' };
    case 'supplier_credit_application':
      return { ...base, number: maps.supplierCredits.get(row.credit_note_id)?.number || '', date: row.applied_date, status: 'applied', amount_cents: row.amount_cents, href: `#/supplier-credits/${row.credit_note_id}`, detail: `Applied to ${maps.bills.get(row.bill_id)?.number || 'bill'}` };
    case 'portal_credit':
      return { ...base, date: row.credit_date, amount_cents: row.amount_cents, party: maps.portals.get(row.portal_id)?.name || '', href: `#/portals/${row.portal_id}`, detail: 'Returned to wallet' };
    default:
      return base;
  }
}

function collectDocuments(db, rootType, rootId) {
  const documents = new Map();
  const queue = [{ type: rootType, id: Number(rootId), expand: true, root: true }];
  while (queue.length && documents.size < MAX_DOCUMENTS) {
    const item = queue.shift();
    const key = keyOf(item.type, item.id);
    const existing = documents.get(key);
    if (existing && (existing.expanded || !item.expand)) continue;
    const row = existing?.row || rowFor(db, item.type, item.id);
    if (!row) continue;
    documents.set(key, { key, type: item.type, row, expanded: item.expand });
    if (item.expand) queue.push(...neighbours(db, item.type, row, item.root));
  }
  return { documents: [...documents.values()], truncated: queue.length > 0 };
}

function collectEntries(db, documents) {
  const owners = new Map();
  const claim = (entryId, key) => {
    if (entryId && !owners.has(entryId)) owners.set(entryId, key);
  };
  const byType = new Map();
  const numbers = { invoice: [], bill: [] };
  for (const doc of documents) {
    claim(doc.row.journal_entry_id, doc.key);
    claim(doc.row.void_entry_id, doc.key);
    if (!byType.has(doc.type)) byType.set(doc.type, []);
    byType.get(doc.type).push(doc.row.id);
    if (numbers[doc.type]) numbers[doc.type].push(doc.row.number);
  }

  // Entries that only carry a source pointer, such as cancellation postings.
  for (const [sourceType, ownerType] of Object.entries(SOURCE_OWNERS)) {
    const list = byType.get(ownerType);
    if (!list?.length) continue;
    const placeholders = list.map(() => '?').join(',');
    for (const entry of db.prepare(`
      SELECT id, source_id FROM journal_entries WHERE source_type = ? AND source_id IN (${placeholders})
    `).all(sourceType, ...list)) {
      claim(entry.id, keyOf(ownerType, entry.source_id));
    }
  }

  // Applications are deleted when reversed; their postings keep the invoice or
  // bill number as reference, so they are still traced to the chain.
  const orphanSources = [
    ['credit_applied', 'invoice', numbers.invoice],
    ['supplier_credit_applied', 'bill', numbers.bill],
  ];
  for (const [sourceType, ownerType, refs] of orphanSources) {
    if (!refs.length) continue;
    const placeholders = refs.map(() => '?').join(',');
    for (const entry of db.prepare(`
      SELECT id, reference FROM journal_entries WHERE source_type = ? AND reference IN (${placeholders})
    `).all(sourceType, ...refs)) {
      const owner = documents.find((doc) => doc.type === ownerType && doc.row.number === entry.reference);
      if (owner) claim(entry.id, owner.key);
    }
  }

  // Reversals belong to the document of the entry they reverse.
  let added = true;
  while (added) {
    added = false;
    const known = [...owners.keys()];
    if (!known.length) break;
    const placeholders = known.map(() => '?').join(',');
    for (const entry of db.prepare(`
      SELECT id, reversal_of_id FROM journal_entries WHERE reversal_of_id IN (${placeholders})
    `).all(...known)) {
      if (!owners.has(entry.id)) {
        owners.set(entry.id, owners.get(entry.reversal_of_id));
        added = true;
      }
    }
  }

  const entryIds = [...owners.keys()];
  if (!entryIds.length) return [];
  const placeholders = entryIds.map(() => '?').join(',');
  const entries = db.prepare(`
    SELECT * FROM journal_entries WHERE id IN (${placeholders}) ORDER BY entry_date, id
  `).all(...entryIds);
  const lines = db.prepare(`
    SELECT l.entry_id, l.debit_cents, l.credit_cents, l.description, a.code AS account_code, a.name AS account_name
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.entry_id IN (${placeholders})
    ORDER BY l.entry_id, l.sort_order, l.id
  `).all(...entryIds);
  const linesByEntry = new Map();
  for (const line of lines) {
    if (!linesByEntry.has(line.entry_id)) linesByEntry.set(line.entry_id, []);
    linesByEntry.get(line.entry_id).push(line);
  }
  return entries.map((entry) => {
    const entryLines = linesByEntry.get(entry.id) || [];
    return {
      id: entry.id,
      entry_date: entry.entry_date,
      memo: entry.memo,
      reference: entry.reference,
      source_type: entry.source_type,
      reversal_of_id: entry.reversal_of_id || null,
      is_reversal: Boolean(entry.reversal_of_id),
      owner_key: owners.get(entry.id),
      total_cents: entryLines.reduce((sum, line) => sum + line.debit_cents, 0),
      lines: entryLines,
    };
  });
}

function parseMetadata(value) {
  if (!value) return {};
  try {
    return JSON.parse(value) || {};
  } catch {
    return {};
  }
}

function collectAudit(db, documents) {
  const present = new Set(documents.map((doc) => doc.key));
  const rows = db.prepare(`
    SELECT * FROM audit_logs WHERE entity_type IN (${Object.keys(AUDIT_TYPES).map(() => '?').join(',')})
    ORDER BY created_at, id
  `).all(...Object.keys(AUDIT_TYPES));
  const result = [];
  for (const row of rows) {
    const type = AUDIT_TYPES[row.entity_type];
    let owner = present.has(keyOf(type, row.entity_id)) ? keyOf(type, row.entity_id) : null;
    if (!owner && ['credit_application', 'supplier_credit_application'].includes(type)) {
      // Reversed applications are deleted; match them through their metadata.
      const meta = parseMetadata(row.metadata);
      const candidates = [
        keyOf('credit', meta.credit_note_id),
        keyOf('invoice', meta.invoice_id),
        keyOf('supplier_credit', meta.supplier_credit_id ?? meta.supplier_credit_note_id),
        keyOf('bill', meta.bill_id),
      ];
      owner = candidates.find((key) => present.has(key)) || null;
    }
    if (!owner) continue;
    result.push({
      id: row.id,
      owner_key: owner,
      entity_type: row.entity_type,
      entity_number: row.entity_number,
      action: row.action,
      remarks: row.remarks,
      amount_cents: row.amount_cents,
      created_at: row.created_at,
    });
  }
  return result;
}

function getAuditChain(db, { type, id } = {}) {
  const rootType = String(type || '');
  if (!TYPES[rootType]) {
    throw bad(`Audit chain type must be one of: ${Object.keys(TYPES).join(', ')}`);
  }
  const rootId = Number(id);
  if (!Number.isInteger(rootId) || rootId <= 0) throw bad('Choose a valid document');
  if (!rowFor(db, rootType, rootId)) throw notFound(`${TYPES[rootType].label} not found`);

  const { documents: raw, truncated } = collectDocuments(db, rootType, rootId);
  const maps = lookupMaps(db);
  const documents = raw.map((doc) => ({
    key: doc.key,
    type: doc.type,
    type_label: TYPES[doc.type].label,
    stage: TYPES[doc.type].stage,
    id: doc.row.id,
    ...describe(doc.type, doc.row, maps),
  })).sort((a, b) => (a.stage - b.stage)
    || String(a.date).localeCompare(String(b.date))
    || a.id - b.id);
  const labels = new Map(documents.map((doc) => [doc.key, doc]));

  const entries = collectEntries(db, raw).map((entry) => ({
    ...entry,
    owner_label: labels.get(entry.owner_key)
      ? `${labels.get(entry.owner_key).type_label} ${labels.get(entry.owner_key).number}`.trim()
      : '',
  }));
  const audit = collectAudit(db, raw).map((event) => ({
    ...event,
    owner_label: labels.get(event.owner_key)
      ? `${labels.get(event.owner_key).type_label} ${labels.get(event.owner_key).number}`.trim()
      : '',
  }));

  // Job status changes (created, confirmed, travelled, approved, cancelled…).
  const statusEvents = [];
  for (const doc of raw.filter((item) => item.type === 'booking' || item.type === 'visa')) {
    for (const row of db.prepare(`
      SELECT * FROM job_status_history WHERE source_type = ? AND source_id = ? ORDER BY created_at, id
    `).all(doc.type, doc.row.id)) {
      const owner = labels.get(doc.key);
      statusEvents.push({
        id: row.id,
        owner_key: doc.key,
        owner_label: owner ? `${owner.type_label} ${owner.number}`.trim() : '',
        event_date: row.event_date,
        title: row.from_status ? `Status ${row.from_status} → ${row.to_status}` : `Created as ${row.to_status}`,
        remarks: row.remarks,
      });
    }
  }

  const effect = new Map();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const row = effect.get(line.account_code) || {
        account_code: line.account_code,
        account_name: line.account_name,
        debit_cents: 0,
        credit_cents: 0,
      };
      row.debit_cents += line.debit_cents;
      row.credit_cents += line.credit_cents;
      effect.set(line.account_code, row);
    }
  }
  const accountEffect = [...effect.values()]
    .map((row) => ({ ...row, net_cents: row.debit_cents - row.credit_cents }))
    .sort((a, b) => a.account_code.localeCompare(b.account_code));

  const timeline = [
    ...entries.map((entry) => ({
      kind: 'journal',
      date: entry.entry_date,
      sort: `${entry.entry_date} 1 ${String(entry.id).padStart(10, '0')}`,
      owner_key: entry.owner_key,
      owner_label: entry.owner_label,
      title: entry.memo,
      amount_cents: entry.total_cents,
      journal_entry_id: entry.id,
      is_reversal: entry.is_reversal,
    })),
    ...statusEvents.map((event) => ({
      kind: 'status',
      date: event.event_date,
      sort: `${event.event_date} 0 ${String(event.id).padStart(10, '0')}`,
      owner_key: event.owner_key,
      owner_label: event.owner_label,
      title: event.title,
      remarks: event.remarks,
      amount_cents: null,
    })),
    ...audit.map((event) => ({
      kind: 'audit',
      date: String(event.created_at || '').slice(0, 10),
      sort: `${String(event.created_at || '').slice(0, 10)} 2 ${String(event.id).padStart(10, '0')}`,
      owner_key: event.owner_key,
      owner_label: event.owner_label,
      title: `${ACTION_LABELS[event.action] || event.action} ${event.entity_number || ''}`.trim(),
      remarks: event.remarks,
      amount_cents: event.amount_cents,
    })),
  ].sort((a, b) => a.sort.localeCompare(b.sort))
    .map(({ sort, ...item }) => item);

  const debit = entries.reduce((sum, entry) => sum + entry.lines.reduce((s, line) => s + line.debit_cents, 0), 0);
  const credit = entries.reduce((sum, entry) => sum + entry.lines.reduce((s, line) => s + line.credit_cents, 0), 0);
  const root = labels.get(keyOf(rootType, rootId));

  return {
    root,
    documents,
    journal_entries: entries,
    audit_events: audit,
    status_events: statusEvents,
    timeline,
    account_effect: accountEffect,
    totals: {
      document_count: documents.length,
      journal_entry_count: entries.length,
      reversal_count: entries.filter((entry) => entry.is_reversal).length,
      void_count: audit.filter((event) => event.action === 'void').length,
      debit_cents: debit,
      credit_cents: credit,
      balanced: debit === credit,
    },
    truncated,
  };
}

module.exports = {
  getAuditChain,
};
