'use strict';

const { normalizePhone } = require('../phone');

const router = require('express').Router();
const db = require('../db');
const { bad, notFound, str, optionalStr, isTruthy } = require('../util');
const statementService = require('../services/statements');
const partyOpening = require('../services/party-opening');
const { canViewArea } = require('../permissions');
const { markCreated } = require('../created-by');
const { assignPartyNumber } = require('../party-numbers');

function listCustomers() {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id) AS invoice_count,
      (SELECT COALESCE(SUM(i.total_cents - i.amount_paid_cents - i.credit_applied_cents), 0)
       FROM invoices i WHERE i.customer_id = c.id AND i.status = 'sent') AS outstanding_cents,
      (SELECT COALESCE(SUM(i.total_cents), 0)
       FROM invoices i WHERE i.customer_id = c.id AND i.status <> 'void') AS total_billed_cents
    FROM customers c
    ORDER BY c.name COLLATE NOCASE
  `).all();
}

// Every screen loads this list for its customer pickers. Staff without the
// Customers right get only what a picker needs, not contact details or notes.
// The payment days set a new document's due date.
const PICKER_FIELDS = ['id', 'name', 'is_active', 'nationality', 'payment_days'];

router.get('/', (req, res) => {
  const includeInactive = isTruthy(req.query.include_inactive);
  const rows = listCustomers().filter((row) => includeInactive || row.is_active);
  if (canViewArea(req.user, 'customers')) return res.json(rows);
  res.json(rows.map((row) => Object.fromEntries(PICKER_FIELDS.map((key) => [key, row[key]]))));
});

router.get('/:id/statement', (req, res) => {
  res.json(statementService.customerStatement(db, req.params.id, req.query));
});

// Only the admin may give a new record an opening balance.
// The opening balance after the record exists: shown to all, changed by the admin only.
router.get('/:id/opening', (req, res) => {
  res.json(partyOpening.openingStatus(db, 'customer', Number(req.params.id)));
});

router.post('/:id/opening', (req, res) => {
  if (!req.user?.is_admin) throw bad('Only the admin can change an opening balance');
  res.json(partyOpening.setOpening(db, 'customer', Number(req.params.id), req.body || {}));
});

// Person or company, the company's contact, and the customer's own payment
// days (empty: the usual terms in Settings). A person has no contact person.
function customerExtras(body, existing = {}) {
  const has = (key) => body[key] !== undefined;
  const kind = has('kind') ? String(body.kind) : (existing.kind || 'person');
  if (!['person', 'company'].includes(kind)) throw bad('Customer type must be a person or a company');
  let days = existing.payment_days ?? null;
  if (has('payment_days')) {
    const raw = body.payment_days;
    days = raw === null || raw === '' ? null : Number(raw);
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365)) throw bad('Payment days must be a whole number from 0 to 365');
  }
  const company = kind === 'company';
  return {
    kind,
    contact_name: company ? (has('contact_name') ? optionalStr(body.contact_name, 'Contact person', 160) : existing.contact_name || '') : '',
    contact_phone: company ? (has('contact_phone') ? normalizePhone(optionalStr(body.contact_phone, 'Contact phone', 60), 'Contact phone') : existing.contact_phone || '') : '',
    payment_days: days,
  };
}

router.post('/', (req, res) => {
  const body = req.body || {};
  if (body.opening && !req.user?.is_admin) throw bad('Only the admin can enter an opening balance');
  const created = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO customers (name, email, phone, address, notes, nationality, trn, kind, contact_name, contact_phone, payment_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, @kind, @contact_name, @contact_phone, @payment_days)
    `).run(customerExtras(body),
      str(body.name, 'Customer name', { max: 160 }),
      optionalStr(body.email, 'Email', 200),
      normalizePhone(optionalStr(body.phone, 'Phone', 60)),
      optionalStr(body.address, 'Address', 500),
      optionalStr(body.notes, 'Notes', 1000),
      optionalStr(body.nationality, 'Nationality', 80),
      optionalStr(body.trn, 'TRN', 30),
    );
    markCreated(db, 'customers', info.lastInsertRowid);
    assignPartyNumber(db, 'customers', info.lastInsertRowid);
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
    return { ...row, opening: partyOpening.forCustomer(db, row, body.opening) };
  })();
  res.status(201).json(created);
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!existing) throw notFound('Customer not found');
  const body = req.body || {};
  db.prepare(`
    UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, notes = ?, nationality = ?, trn = ?, is_active = ?,
      kind = @kind, contact_name = @contact_name, contact_phone = @contact_phone, payment_days = @payment_days, updated_at = datetime('now') WHERE id = ?
  `).run(customerExtras(body, existing),
    body.name != null ? str(body.name, 'Customer name', { max: 160 }) : existing.name,
    body.email != null ? optionalStr(body.email, 'Email', 200) : existing.email,
    body.phone != null ? normalizePhone(optionalStr(body.phone, 'Phone', 60)) : existing.phone,
    body.address != null ? optionalStr(body.address, 'Address', 500) : existing.address,
    body.notes != null ? optionalStr(body.notes, 'Notes', 1000) : existing.notes,
    body.nationality != null ? optionalStr(body.nationality, 'Nationality', 80) : existing.nationality,
    body.trn != null ? optionalStr(body.trn, 'TRN', 30) : existing.trn,
    body.is_active != null ? (isTruthy(body.is_active) ? 1 : 0) : existing.is_active,
    id,
  );
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!existing) throw notFound('Customer not found');
  const count = db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE customer_id = ?').get(id).c;
  if (count > 0) throw bad('This customer has invoices. Archive them instead of deleting.');
  db.transaction(() => {
    // Their documents (Emirates ID, passport…) go with them.
    db.prepare("DELETE FROM attachments WHERE entity_type = 'customer' AND entity_id = ?").run(id);
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  })();
  res.json({ deleted: true });
});

module.exports = router;
module.exports.listCustomers = listCustomers;
