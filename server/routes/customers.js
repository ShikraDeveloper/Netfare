'use strict';

const router = require('express').Router();
const db = require('../db');
const { bad, notFound, str, optionalStr, isTruthy } = require('../util');
const statementService = require('../services/statements');
const partyOpening = require('../services/party-opening');
const { canViewArea } = require('../permissions');

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
const PICKER_FIELDS = ['id', 'name', 'is_active', 'nationality'];

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
router.post('/', (req, res) => {
  const body = req.body || {};
  if (body.opening && !req.user?.is_admin) throw bad('Only the admin can enter an opening balance');
  const created = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO customers (name, email, phone, address, notes, nationality)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      str(body.name, 'Customer name', { max: 160 }),
      optionalStr(body.email, 'Email', 200),
      optionalStr(body.phone, 'Phone', 60),
      optionalStr(body.address, 'Address', 500),
      optionalStr(body.notes, 'Notes', 1000),
      optionalStr(body.nationality, 'Nationality', 80),
    );
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
    UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, notes = ?, nationality = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?
  `).run(
    body.name != null ? str(body.name, 'Customer name', { max: 160 }) : existing.name,
    body.email != null ? optionalStr(body.email, 'Email', 200) : existing.email,
    body.phone != null ? optionalStr(body.phone, 'Phone', 60) : existing.phone,
    body.address != null ? optionalStr(body.address, 'Address', 500) : existing.address,
    body.notes != null ? optionalStr(body.notes, 'Notes', 1000) : existing.notes,
    body.nationality != null ? optionalStr(body.nationality, 'Nationality', 80) : existing.nationality,
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
