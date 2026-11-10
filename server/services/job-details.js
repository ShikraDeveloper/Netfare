'use strict';

// Edit details of a posted booking or visa: things that do not touch money
// (travel dates, PNR, reference, notes, passenger names, ticket numbers,
// passport details). Anyone with Edit rights for the area may do this. The
// invoice and bills are not re-posted, so an invoice already printed keeps
// its text; amounts, lines and suppliers change through Correct (admin).
// Each change is logged with the value before and after.

const { bad, notFound, dateISO, optionalStr } = require('../util');
const audit = require('./audit');

const dateOrNull = (value, label) => (value ? dateISO(value, label) : null);

const JOBS = {
  booking: {
    table: 'bookings',
    label: 'booking',
    items: 'booking_items',
    column: 'booking_id',
    fields: {
      travel_date: (value) => dateOrNull(value, 'Travel date'),
      return_date: (value) => dateOrNull(value, 'Return date'),
      destination: (value) => optionalStr(value, 'Destination', 200),
      pnr: (value) => optionalStr(value, 'PNR / ticket number', 60),
      notes: (value) => optionalStr(value, 'Notes', 2000),
    },
    check(row) {
      if (row.travel_date && row.return_date && row.return_date < row.travel_date) throw bad('Return date cannot be before the travel date');
    },
  },
  visa: {
    table: 'visa_applications',
    label: 'visa application',
    items: 'visa_items',
    column: 'visa_id',
    fields: {
      travel_date: (value) => dateOrNull(value, 'Travel date'),
      reference: (value) => optionalStr(value, 'Application reference', 120),
      notes: (value) => optionalStr(value, 'Notes', 2000),
      nationality: (value) => optionalStr(value, 'Nationality', 80),
      passport_number: (value) => optionalStr(value, 'Passport number', 60),
      passport_expiry: (value) => dateOrNull(value, 'Passport expiry'),
      date_of_birth: (value) => dateOrNull(value, 'Date of birth'),
    },
  },
};

// Passenger names and ticket numbers on the lines (bookings only).
function itemChanges(db, config, jobId, items) {
  if (config.items !== 'booking_items' || !Array.isArray(items)) return [];
  const changes = [];
  for (const item of items) {
    const row = db.prepare('SELECT * FROM booking_items WHERE id = ? AND booking_id = ?').get(Number(item.id), jobId);
    if (!row) throw bad('That line is not on this booking');
    for (const [field, label, max] of [['passenger_name', 'Passenger name', 160], ['supplier_ref', 'Ticket number', 120]]) {
      if (item[field] === undefined) continue;
      const value = optionalStr(item[field], label, max);
      if (value !== row[field]) changes.push({ id: row.id, field, before: row[field], after: value });
    }
  }
  return changes;
}

function updateJobDetails(db, sourceType, jobId, payload = {}) {
  const config = JOBS[sourceType];
  if (!config) throw bad('Only bookings and visas have details to edit here');
  return db.transaction(() => {
    const job = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(Number(jobId));
    if (!job) throw notFound(`The ${config.label} was not found`);
    if (job.status === 'draft') throw bad(`A draft ${config.label} is edited in full`);
    if (job.voided_at) throw bad(`This ${config.label} is void`);

    const changed = {};
    for (const [field, clean] of Object.entries(config.fields)) {
      if (payload[field] === undefined) continue;
      const value = clean(payload[field]);
      if (value !== job[field]) changed[field] = { before: job[field], after: value };
    }
    config.check?.({ ...job, ...Object.fromEntries(Object.entries(changed).map(([field, change]) => [field, change.after])) });
    const lines = itemChanges(db, config, job.id, payload.items);
    if (!Object.keys(changed).length && !lines.length) return job;

    if (Object.keys(changed).length) {
      const sets = Object.keys(changed).map((field) => `${field} = ?`).join(', ');
      db.prepare(`UPDATE ${config.table} SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
        .run(...Object.values(changed).map((change) => change.after), job.id);
    }
    for (const line of lines) db.prepare(`UPDATE ${config.items} SET ${line.field} = ? WHERE id = ?`).run(line.after, line.id);

    audit.record(db, {
      entity_type: sourceType,
      entity_id: job.id,
      entity_number: job.number,
      action: 'edit',
      remarks: [
        ...Object.entries(changed).map(([field, change]) => `${field}: ${change.before || '—'} → ${change.after || '—'}`),
        ...lines.map((line) => `${line.field}: ${line.before || '—'} → ${line.after || '—'}`),
      ].join(' · ').slice(0, 2000),
      amount_cents: 0,
      metadata: { fields: changed, lines },
    });
    return db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(job.id);
  })();
}

module.exports = { updateJobDetails };
